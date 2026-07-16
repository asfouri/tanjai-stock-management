# TanjAI Stock Management App - Architecture and Flow

## Overview
This app is a two-part project:
- `backend/`: a NestJS API with Prisma database access and XLSX import processing.
- `frontend/`: a Next.js dashboard with Supabase-based sign-in and inventory/reporting views.

The main idea: users log in, upload Excel files, preview imported stock/order/invoice data, confirm imports, and then explore dashboard sections backed by the database.

---

## Backend Architecture

### `backend/package.json`
- Defines the backend dependencies and commands.
- Notable scripts:
  - `start:dev`: runs NestJS in watch mode.
  - `prisma:generate`: generates Prisma client.
  - `prisma:migrate`: applies database migrations.
  - `seed:dev-users`: seeds dev user credentials.

### `backend/src/main.ts`
- Bootstraps the NestJS app.
- Enables CORS for allowed origins.
- Listens on port `3005` or `process.env.PORT`.
- Uses `FRONTEND_URL` / `FRONTEND_URLS` and localhost defaults.

### `backend/src/app.module.ts`
- Registers the core providers and controllers.
- Includes:
  - `AppController`
  - `AppService`
  - `ExcelImportService`
  - `PrismaService`
  - `SupabaseAuthGuard`

### `backend/src/app.controller.ts`
The main API surface of the backend.

Routes:
- `GET /`: simple health route returning `Hello World!`.
- `POST /auth/login`: local development login using env credentials.
- `GET /dashboard/summary`: protected summary data.
- `GET /dashboard/section/:section`: protected section-specific data.
- `POST /imports/excel/preview`: protected upload preview.
- `POST /imports/excel/preview-local`: protected preview from local Excel file path.
- `POST /imports/excel/confirm`: protected confirm preview import.
- `GET /imports/excel/history`: protected list import batches.
- `POST /imports/excel/remove`: protected remove saved import batch.
- `POST /imports/excel/replace`: protected replace an import batch with a new file.

Important helpers:
- `getDevUser(...)`: checks the submitted email/password against env vars.
- `readRequestBuffer(...)`: reads raw request body to handle Excel binary upload.

### `backend/src/auth/supabase-auth.guard.ts`
- Protects API endpoints with authorization.
- Accepts either:
  - `local-dev:<email>` token for dev environment login
  - Supabase JWT token validated against Supabase service key
- Throws unauthorized errors if token is missing or invalid.

### `backend/src/prisma.service.ts`
- Wraps Prisma client initialization.
- Provides delegates for all Prisma models.
- Offers `$transaction(...)` support.
- Handles missing Prisma generation gracefully by providing placeholder errors.

### `backend/src/app.service.ts`
- Provides dashboard data logic.
- Has two main operations:
  - `getDashboardSection(section, filters)`
  - `getDashboardSummary(filters)`

Key behavior:
- Normalizes filters for brand, store, dates, SKU, invoices, order number, tracking number.
- Queries Prisma for brands, stores, orders, invoices, shipments, lines, stock movements, wallet transactions, anomalies, and SKU aliases.
- Builds summary charts and counts.
- Supports filtering by store, brand, date range, SKU, tracking number, invoice, and order number.
- Uses helper functions to group data by date, by store, by severity, and create filter option lists.

### `backend/src/import/excel-import.service.ts`
This service manages Excel import preview and confirmation.

Key phases:
- `preview(file)`
  - Checks `.xlsx` extension.
  - Reads file and computes SHA256 hash.
  - Parses workbook using `parseXlsxWorkbook(...)`.
  - Builds a parsed import model.
  - Detects duplicate records and warnings.
  - Stores a preview token in memory for confirmation.
- `previewLocalFile(fileName)`
  - Loads a file from a configured local directory.
  - Uses same preview flow.
- `confirm(token)`
  - Retrieves parsed preview from memory.
  - If `EXCEL_IMPORT_STORAGE !== prisma`, saves locally.
  - Otherwise, performs a Prisma transaction to persist the batch.
  - Creates or updates brands, stores, products, orders, shipments, order lines, invoices, stock purchases, inventory movements, wallet transactions, and anomalies.
  - Builds or resolves product SKU aliases.
- `removeImportBatch(importBatchId)`
  - Deletes one import batch and all associated records.
  - Cleans up orphan products and SKU aliases.
- `replaceImportBatch(importBatchId, token)`
  - Deletes the old batch and confirms the new preview.
- `listImportBatches()`
  - Returns stored import batches with summary counts.

Supporting files:
- `backend/src/import/import.types.ts`: defines the data shapes for parsed Excel import records, preview results, warnings, and sheet metadata.
- `backend/src/import/excel-openxml.ts`: an XLSX parser implemented without external Excel libraries.
  - Reads the XLSX ZIP container.
  - Parses shared strings, workbook relationships, sheet XML.
  - Extracts rows, cells, comments, and images.

### `backend/prisma/schema.prisma`
Defines the PostgreSQL data model for imports and inventory data.

Key models:
- `ImportBatch`: stores file metadata, summary, warnings, duplicates.
- `Brand` / `Store`: basic brand and store catalog data.
- `Product` / `ProductSkuAlias`: product catalog and SKU alias lookup.
- `Order`, `OrderLine`, `Shipment`: order fulfillment data.
- `FulfillmentInvoice`: invoice totals and costs.
- `StockPurchase`, `InventoryMovement`, `WalletTransaction`: inventory and wallet flows.
- `Anomaly`: warnings and errors imported from Excel.

### `backend/prisma/excel_import_tables.sql`
- Provides DDL for the same schema in raw SQL.
- Useful if the database is created without Prisma migrations.
- Matches the Prisma models and indexes.

---

## Frontend Architecture

### `frontend/package.json`
- Uses Next.js 16 with React 19.
- Uses `recharts` for charts.
- Uses Supabase JS for authentication.
- Includes Tailwind CSS via PostCSS.

### `frontend/next.config.ts`
- Allows one specific dev origin for local testing.

### Client-side Auth and API helper

#### `frontend/src/lib/supabase/client.ts`
- Creates a Supabase browser client using `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Wraps fetch errors to return a friendly auth network error response.

#### `frontend/src/app/dashboard/api.ts`
- Computes the API base URL.
- If running locally against `localhost`, the frontend proxies to `/api/backend`.
- Offers:
  - `getSessionWithTimeout(...)`: fetches a Supabase session with a timeout.
  - `apiFetch(url, options)`: sends authenticated requests with the Supabase token.
  - `responseErrorMessage(...)`: extracts friendly error messages from backend responses.

### `frontend/src/app/api/login/route.ts`
- Handles login from the browser form.
- First tries the backend local login endpoint.
- If backend login fails, falls back to Supabase auth:
  - Issues `POST /auth/v1/token?grant_type=password`
  - Stores `tanjai_access_token` as an HTTP-only cookie.
- Redirects to `/dashboard` on success.
- Redirects back to `/login` on failure.

### `frontend/src/app/api/logout/route.ts`
- Removes the `tanjai_access_token` cookie.
- Redirects to `/login`.

### `frontend/src/app/page.tsx`
- Redirects the top-level route `/` to `/login`.

### `frontend/src/app/login/page.tsx`
- Server component that renders login page.
- Reads query string values for `email`, `password`, and `message`.
- Passes them to the `LoginClient` for rendering.

### `frontend/src/app/login/LoginClient.tsx`
- Client-side login form UI.
- Signs in with Supabase browser auth.
- Stores the session token in a local cache and redirects to `/dashboard`.
- Automatically checks for an existing session and redirects if already signed in.
- Includes form validation and password show/hide.

### `frontend/src/app/dashboard/page.tsx`
The main dashboard UI and user experience.

Key features:
- Sidebar navigation for:
  - Dashboard
  - Imports
  - Products
  - Orders
  - Inventory
  - Stores
  - Invoices
  - Payments
- Uses internal state to track active section, filters, loaded data, import preview, and errors.
- On initial load, fetches `GET /dashboard/summary`.
- When a section is selected, fetches `GET /dashboard/section/:section` or `GET /imports/excel/history`.
- Supports filters for brand, store, date range, SKU, invoice, order number, and tracking number.
- Uploads Excel files directly to backend using `POST /imports/excel/preview`.
- Shows preview modal after upload, then confirms import with `POST /imports/excel/confirm`.
- Supports removing or replacing import batches.
- Handles logout by signing out from Supabase and clearing tokens.

### `frontend/src/app/dashboard/types.ts`
- Defines data shapes for dashboard summary, filters, preview result, section rows, and product details.
- Aligns the frontend with backend response structures.

### `frontend/src/app/dashboard/utils.ts`
- Provides formatting helpers for currency, numbers, dates.
- Defines `emptySummary()` default values.
- Provides deduplication helpers and stable row key functions.

### `frontend/src/app/dashboard/components/FilterBar.tsx`
- Provides reusable filter inputs and selects.
- Normalizes options and renders dropdowns.

### `frontend/src/app/dashboard/components/Panel.tsx`
- Simple panel wrapper used throughout the dashboard.

### `frontend/src/app/dashboard/components/ProductImage.tsx`
- Renders product images or a placeholder if missing.

---

## High-level Data Flow

### Login path
1. User opens `/login`.
2. `LoginClient` checks for existing Supabase session.
3. User submits credentials.
4. `/api/login` tries backend local auth first.
5. If backend local auth fails, it uses Supabase auth.
6. On success, a cookie is stored and the user is redirected to `/dashboard`.

### Protected API access
- Dashboard and import routes require `Authorization: Bearer <token>`.
- The frontend `apiFetch(...)` attaches the Supabase token from session or cached token.
- `SupabaseAuthGuard` verifies the token.
- Local dev login tokens simply use `local-dev:<email>`.

### Excel import flow
1. User chooses an `.xlsx` file in the dashboard.
2. Frontend uploads the file to `POST /imports/excel/preview`.
3. Backend parses the XLSX file and returns a preview with counts, warnings, and duplicate data.
4. User confirms import in the preview modal.
5. Frontend sends `POST /imports/excel/confirm` with the preview token.
6. Backend persists the parsed file into the database in one transaction.
7. Dashboard refreshes and import history updates.
8. User can remove or replace import batches later.

### Dashboard summary flow
1. Dashboard page fetches `GET /dashboard/summary`.
2. The backend collects metrics from orders, invoices, shipments, inventory movements, wallet transactions, anomalies, and SKU alias data.
3. The backend builds charts and filter options.
4. The frontend renders summary cards, charts, tables, and filters.

---

## Important files and their roles

Backend:
- `backend/src/main.ts`: app startup and CORS.
- `backend/src/app.module.ts`: module wiring.
- `backend/src/app.controller.ts`: routes and request handling.
- `backend/src/app.service.ts`: dashboard data and summary logic.
- `backend/src/import/excel-import.service.ts`: Excel import preview and persistence.
- `backend/src/import/excel-openxml.ts`: XLSX parsing logic.
- `backend/src/import/import.types.ts`: import data structures.
- `backend/src/prisma.service.ts`: Prisma client wrapper.
- `backend/src/auth/supabase-auth.guard.ts`: route protection.
- `backend/prisma/schema.prisma`: database model.
- `backend/prisma/excel_import_tables.sql`: raw SQL table definitions.

Frontend:
- `frontend/src/app/page.tsx`: top-level redirect to login.
- `frontend/src/app/login/page.tsx`: login page shell.
- `frontend/src/app/login/LoginClient.tsx`: login UI and Supabase session flow.
- `frontend/src/app/api/login/route.ts`: login API route.
- `frontend/src/app/api/logout/route.ts`: logout API route.
- `frontend/src/app/dashboard/page.tsx`: dashboard UI and section loading.
- `frontend/src/app/dashboard/api.ts`: API helper and token handling.
- `frontend/src/app/dashboard/types.ts`: frontend type definitions.
- `frontend/src/app/dashboard/utils.ts`: formatting and utility helpers.
- `frontend/src/app/dashboard/components/FilterBar.tsx`: filter components.
- `frontend/src/app/dashboard/components/Panel.tsx`: panel UI wrapper.
- `frontend/src/app/dashboard/components/ProductImage.tsx`: product image display.

---

## Understanding the app step by step

1. Start the backend and frontend separately.
2. Login using the local dev credentials stored in environment variables, or Supabase auth if configured.
3. Use the dashboard filters to narrow data.
4. Upload Excel files to preview the import results before committing them.
5. Confirm import to persist data into the database.
6. Use import history to remove or replace import batches.
7. Explore dashboard sections for products, orders, inventory, stores, invoices, and payments.

This map is designed to help you read the app from the entry points outward, following the main flows rather than each detail in isolation.
