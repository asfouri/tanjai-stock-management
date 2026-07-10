import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const workbookName = '2026 Globalship - Fulfillment orders details.xlsx';
const workbookPath = process.env.AUDIT_WORKBOOK_PATH || findWorkbook('C:/Users/Pc', workbookName);

if (!workbookPath) {
  throw new Error(`Globalship workbook was not found under C:/Users/Pc: ${workbookName}`);
}

process.env.AUDIT_WORKBOOK_PATH = workbookPath;
process.env.AUDIT_REPORT_FILE = 'AUDIT_REPORT_GLOBALSHIP.md';
process.env.AUDIT_RESULTS_FILE = 'audit-globalship-results.json';
process.env.AUDIT_MISMATCHES_FILE = 'audit-globalship-mismatches.csv';
process.env.AUDIT_RELATIONSHIP_MAP_FILE = 'relationship-map-globalship.md';
process.env.AUDIT_REPORT_TITLE = 'Globalship Excel Import Audit Report';
process.env.AUDIT_LABEL = 'globalship-audit';

await import('./audit-excel-import.mjs');

function findWorkbook(root, targetName) {
  const queue = [root];
  const maxDirectories = 12000;
  let visited = 0;

  while (queue.length > 0 && visited < maxDirectories) {
    const current = queue.shift();
    visited += 1;

    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && entry.name === targetName) {
        return fullPath;
      }
      if (
        entry.isDirectory() &&
        !['node_modules', '.git', 'AppData', 'WindowsApps'].includes(entry.name)
      ) {
        try {
          if (statSync(fullPath).isDirectory()) queue.push(fullPath);
        } catch {
          // Ignore folders that OneDrive or Windows denies during traversal.
        }
      }
    }
  }

  return '';
}
