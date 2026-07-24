import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const backendRoot = resolve(import.meta.dirname, '..');
process.loadEnvFile(resolve(backendRoot, '.env'));

const connectionUrl = new URL(process.env.DATABASE_URL);
connectionUrl.searchParams.delete('sslmode');

const client = new Client({
  connectionString: connectionUrl.toString(),
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  const sql = await readFile(
    resolve(backendRoot, 'prisma/excel-import-tables.sql'),
    'utf8',
  );
  await client.query(sql);

  const verification = await client.query(
    `select
       exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'excel_product_groups'
       ) as "groupTable",
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'excel_products'
           and column_name = 'groupId'
       ) as "groupColumn"`,
  );
  console.log(JSON.stringify(verification.rows[0]));
} finally {
  await client.end();
}
