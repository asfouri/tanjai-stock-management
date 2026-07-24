# Tanjai Stock Management Backend

NestJS API for the Tanjai stock-management dashboard, Excel imports, Supabase authentication, and Prisma-backed reporting data.

## Setup

```bash
npm install
cp .env.example .env
npm run prisma:generate
```

Fill `.env` with the database URL and Supabase credentials required by the API.

### Automatic Excel refresh

When `EXCEL_AUTO_REFRESH=true`, `EXCEL_IMPORT_STORAGE=prisma`, and
`EXCEL_IMPORT_DIR` points to the synchronized workbook folder, the backend
checks for stable workbook changes and applies them once every 12 hours by
default. `EXCEL_MIN_AUTO_REFRESH_INTERVAL_SECONDS=43200` controls that cadence.
The dashboard's manual **Refresh now** action remains available between
scheduled refreshes.

## Development

```bash
npm run start:dev
```

The frontend expects the API at `NEXT_PUBLIC_API_URL`, defaulting to `http://localhost:3005`.

## Useful Scripts

```bash
npm run build
npm run lint
npm run prisma:generate
npm run seed:dev-users
```

## Database

Prisma models live in `prisma/schema.prisma`. The SQL bootstrap/update script for the Excel import tables lives in `prisma/excel-import-tables.sql`.
