# Refresh benchmark: full-replace vs incremental

Compare how long an Excel refresh takes in the two modes, on your real data.

## Quick one-shot (recommended)

`scripts/benchmark-refresh.mjs` times both modes back to back against the same
file, each inside a transaction that is **rolled back** — nothing is written. No
backend restart, no flag flipping, no editing the workbook.

```
cd backend
npm run build
node ../scripts/benchmark-refresh.mjs                 # full replace + incremental
node ../scripts/benchmark-refresh.mjs --incremental-only   # incremental only (faster, safer)
```

Optional args: `node ../scripts/benchmark-refresh.mjs <importBatchId> <pathToXlsx>`.
It prints a per-phase breakdown plus the two totals.

Note: the full-replace run holds a large (~2 min) transaction and can occasionally
drop the Supabase connection; `--incremental-only` avoids that and is enough to
validate the incremental path.

## Manual measurement (live runs)

If you prefer to measure real live refreshes, both numbers come from the
**backend terminal logs** — keep it visible.

## What you're comparing

- **Full replace** (`EXCEL_INCREMENTAL_REFRESH=false`, the default): deletes every
  row of the import batch and re-inserts the whole workbook. For the current file
  that is ~9,200 orders + ~9,800 lines + ~9,200 shipments + ~1,750 other rows —
  roughly **28k deletes + 28k inserts** every refresh, plus re-registering all
  shipments with 17TRACK.
- **Incremental** (`EXCEL_INCREMENTAL_REFRESH=true`): diffs the workbook against
  what is already stored and writes only the changed rows, keeping shipment
  tracking state. On a typical edit that is a handful of rows.

Parsing the file itself is ~1 second in both modes (measured); the difference is
entirely the database work.

## How to read the numbers

- Full replace: the last `[excel-import] confirm …` line prints `(<N>ms total)`.
  That `total` is the database time. Add ~1s parse for the end-to-end figure.
- Incremental: one line — `[excel-import] INCREMENTAL refresh total: <N>ms
  (orders +a ~b -c)`.

## Procedure

Run each mode against a **real change** (a refresh is a no-op if the file hash
is unchanged), so edit the workbook and save between runs.

### A. Full replace

1. In `backend/.env` set `EXCEL_INCREMENTAL_REFRESH=false` (or leave it unset).
2. Restart the backend (`npm run start:dev`) — env is read once at startup.
3. Edit one cell in the workbook and **save** (wait for OneDrive to show synced).
4. In the app, open **Imports** and click **Refresh** on the batch.
5. In the terminal, read the `total` on the last `[excel-import] confirm …` line.

### B. Incremental

1. Set `EXCEL_INCREMENTAL_REFRESH=true` in `backend/.env`.
2. Restart the backend.
3. Edit one cell and **save** again (so the hash differs from step A).
4. Click **Refresh** again.
5. Read `[excel-import] INCREMENTAL refresh total: <N>ms`.

### Compare

Put the two `total` values side by side. Expect full replace to be seconds→minutes
(dominated by the ~56k row writes + 17TRACK re-registration) and incremental to be
well under a second for a small edit.

## Notes

- The **first** incremental refresh after data was created by full-replace still
  reads all existing rows to diff them, but writes only what changed — so it is
  fast even though the batch is large.
- Incremental is opt-in until you've validated a few refreshes match a full
  re-import. Once satisfied, leave `EXCEL_INCREMENTAL_REFRESH=true`.
- Manual **Refresh** always runs immediately; automatic refresh is throttled by
  `EXCEL_MIN_AUTO_REFRESH_INTERVAL_SECONDS` (default 600s).
