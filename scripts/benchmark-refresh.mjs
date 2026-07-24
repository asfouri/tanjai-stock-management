/**
 * One-shot refresh benchmark.
 *
 * Times a full-replace-equivalent refresh against an incremental refresh for the
 * SAME workbook, back to back, each inside a transaction that is rolled back — so
 * it changes nothing in the database. No backend restart, no flag flipping.
 *
 * Usage (from backend/, after `npm run build`):
 *   node ../scripts/benchmark-refresh.mjs [importBatchId] [pathToXlsx]
 *
 *   - importBatchId omitted -> uses the most recently created import batch.
 *   - pathToXlsx omitted     -> uses EXCEL_IMPORT_DIR + the batch's file name.
 *
 * Run it from the backend directory so the compiled dist/ and node_modules
 * resolve, e.g.:  cd backend && node ../scripts/benchmark-refresh.mjs
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function distImport(relPath) {
  return import(pathToFileURL(resolve('dist', relPath)).href);
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

async function main() {
  loadLocalEnv();
  if (process.env.EXCEL_IMPORT_STORAGE !== 'prisma') {
    console.error('EXCEL_IMPORT_STORAGE must be "prisma" to benchmark refresh.');
    process.exit(1);
  }

  const { PrismaService } = await distImport(
    'infrastructure/database/prisma.service.js',
  );
  const { ExcelImportService } = await distImport(
    'modules/imports/services/excel-import.service.js',
  );

  const prisma = new PrismaService();
  const svc = new ExcelImportService(prisma, {
    registerByImportBatch: async () => {},
  });

  const args = process.argv.slice(2);
  const incrementalOnly = args.includes('--incremental-only');
  const [batchIdArg, pathArg] = args.filter((a) => !a.startsWith('--'));

  const batch = batchIdArg
    ? await prisma.importBatch.findUnique({
        where: { id: batchIdArg },
        select: { id: true, fileName: true },
      })
    : await prisma.importBatch.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, fileName: true },
      });

  if (!batch) {
    console.error('No import batch found. Import a workbook first.');
    process.exit(1);
  }

  const importDir = process.env.EXCEL_IMPORT_DIR?.trim();
  const filePath = pathArg
    ? resolve(pathArg)
    : importDir
      ? resolve(importDir, basename(batch.fileName))
      : null;
  if (!filePath) {
    console.error(
      'No file path. Pass one as the 2nd argument or set EXCEL_IMPORT_DIR.',
    );
    process.exit(1);
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const buffer = await readFile(filePath);
  const { parsed, preview } = await svc.parseFileForBenchmark({
    originalname: basename(filePath),
    buffer,
    size: buffer.length,
  });

  const lines = parsed.orders.reduce((n, o) => n + o.lines.length, 0);
  const shipments = parsed.orders.reduce((n, o) => n + o.shipments.length, 0);

  console.log('');
  console.log('Refresh benchmark (both runs rolled back — no data changed)');
  console.log('-----------------------------------------------------------');
  console.log(`batch      : ${batch.id}`);
  console.log(`file       : ${filePath}`);
  console.log(`modified   : ${fileStat.mtime.toISOString()}`);
  console.log(
    `parsed     : ${parsed.orders.length} orders, ${lines} lines, ${shipments} shipments, ` +
      `${parsed.invoices.length} invoices, ${parsed.walletTransactions.length} wallet, ` +
      `${parsed.inventoryMovements.length} movements`,
  );
  console.log('');

  const { fullReplace, incremental } = await svc.benchmarkRefresh(
    batch.id,
    parsed,
    preview,
    { skipFullReplace: incrementalOnly },
  );

  const inc = incremental.changes.orders;
  if (fullReplace) {
    const fr = fullReplace.changes.orders;
    console.log(
      `FULL REPLACE  : ${fmt(fullReplace.ms).padStart(9)}   ` +
        `(rewrites all orders: +${fr.inserted})`,
    );
  }
  console.log(
    `INCREMENTAL   : ${fmt(incremental.ms).padStart(9)}   ` +
      `(orders +${inc.inserted} ~${inc.updated} -${inc.deleted})`,
  );

  if (fullReplace && incremental.ms > 0) {
    console.log('');
    console.log(
      `-> incremental is ${(fullReplace.ms / Math.max(1, incremental.ms)).toFixed(1)}x faster for this change`,
    );
  }
  if (inc.inserted === 0 && inc.updated === 0 && inc.deleted === 0) {
    console.log(
      '   (no order changes detected — edit a cell and re-run to see a typical change)',
    );
  }
  console.log('');

  await prisma.onModuleDestroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
