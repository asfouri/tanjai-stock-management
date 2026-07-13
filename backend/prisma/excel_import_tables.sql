create extension if not exists pgcrypto;

create table if not exists public.excel_import_batches (
  id text primary key default gen_random_uuid()::text,
  "fileName" text not null,
  "fileHash" text not null,
  status text not null default 'CONFIRMED',
  summary jsonb not null,
  warnings jsonb not null,
  duplicates jsonb not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_import_batches_file_hash_key
  on public.excel_import_batches ("fileHash");

create table if not exists public.excel_brands (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_brands_name_key
  on public.excel_brands (name);

create table if not exists public.excel_stores (
  id text primary key default gen_random_uuid()::text,
  "brandId" text not null references public.excel_brands(id),
  name text not null,
  "normalizedName" text not null,
  country text,
  platform text,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_stores_brand_id_normalized_name_key
  on public.excel_stores ("brandId", "normalizedName");

create index if not exists excel_stores_normalized_name_idx
  on public.excel_stores ("normalizedName");

create table if not exists public.excel_products (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  description text,
  weight double precision,
  quotation jsonb,
  "imageUrl" text,
  "createdAt" timestamptz not null default now()
);

alter table public.excel_products
  add column if not exists quotation jsonb,
  add column if not exists "imageUrl" text;

create unique index if not exists excel_products_name_key
  on public.excel_products (name);

create table if not exists public.excel_product_sku_aliases (
  id text primary key default gen_random_uuid()::text,
  "productId" text not null references public.excel_products(id),
  "storeId" text references public.excel_stores(id),
  sku text not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_product_sku_aliases_sku_key
  on public.excel_product_sku_aliases (sku);

create index if not exists excel_product_sku_aliases_sku_idx
  on public.excel_product_sku_aliases (sku);

create table if not exists public.excel_product_aliases (
  id text primary key default gen_random_uuid()::text,
  "productId" text not null references public.excel_products(id),
  "aliasName" text not null,
  "normalizedName" text not null,
  "sourceSheet" text,
  confidence double precision not null default 1,
  "confirmedByAdmin" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create unique index if not exists excel_product_aliases_normalized_name_key
  on public.excel_product_aliases ("normalizedName");

create index if not exists excel_product_aliases_alias_name_idx
  on public.excel_product_aliases ("aliasName");

create table if not exists public.excel_orders (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "storeId" text not null references public.excel_stores(id),
  "externalOrderNumber" text not null,
  "orderDate" timestamptz,
  "invoiceReference" text not null,
  country text,
  status text not null default 'CONFIRMED',
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_orders_store_id_external_order_number_invoice_reference_key
  on public.excel_orders ("storeId", "externalOrderNumber", "invoiceReference");

create index if not exists excel_orders_external_order_number_idx
  on public.excel_orders ("externalOrderNumber");

create table if not exists public.excel_order_lines (
  id text primary key default gen_random_uuid()::text,
  "orderId" text not null references public.excel_orders(id) on delete cascade,
  "productId" text references public.excel_products(id),
  sku text not null,
  quantity double precision not null,
  "productCost" double precision not null default 0,
  "shippingCost" double precision not null default 0,
  "handlingCost" double precision not null default 0,
  "totalCost" double precision not null default 0,
  "lineType" text not null default 'product',
  "sourceSheet" text not null,
  "sourceRow" integer not null
);

create index if not exists excel_order_lines_sku_idx
  on public.excel_order_lines (sku);

create table if not exists public.excel_shipments (
  id text primary key default gen_random_uuid()::text,
  "orderId" text not null references public.excel_orders(id) on delete cascade,
  "trackingNumber" text not null,
  "sourceSheet" text not null,
  "sourceRow" integer not null
);

create unique index if not exists excel_shipments_order_id_tracking_number_key
  on public.excel_shipments ("orderId", "trackingNumber");

create index if not exists excel_shipments_tracking_number_idx
  on public.excel_shipments ("trackingNumber");

create table if not exists public.excel_fulfillment_invoices (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "storeId" text not null references public.excel_stores(id),
  "invoiceReference" text not null,
  "invoiceDate" timestamptz,
  subtotal double precision not null default 0,
  refunds double precision not null default 0,
  adjustments double precision not null default 0,
  "otherCost" double precision not null default 0,
  total double precision not null default 0,
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_fulfillment_invoices_store_id_invoice_reference_key
  on public.excel_fulfillment_invoices ("storeId", "invoiceReference");

create index if not exists excel_fulfillment_invoices_invoice_date_idx
  on public.excel_fulfillment_invoices ("invoiceDate");

create table if not exists public.excel_stock_purchases (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "productId" text references public.excel_products(id),
  "purchaseDate" timestamptz,
  sku text,
  quantity double precision not null,
  "unitCost" double precision,
  "totalCost" double precision not null,
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

create index if not exists excel_stock_purchases_sku_idx
  on public.excel_stock_purchases (sku);

create table if not exists public.excel_inventory_movements (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "productId" text references public.excel_products(id),
  "storeId" text references public.excel_stores(id),
  "stockName" text,
  "movementDate" timestamptz,
  "movementType" text not null,
  quantity double precision not null,
  reference text,
  comment text,
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

alter table public.excel_inventory_movements
  add column if not exists "stockName" text;

create index if not exists excel_inventory_movements_movement_type_idx
  on public.excel_inventory_movements ("movementType");

create table if not exists public.excel_inventory_items (
  id text primary key default gen_random_uuid()::text,
  "stockName" text not null,
  "stockSku" text,
  "normalizedName" text not null,
  "sourceSheet" text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

alter table public.excel_inventory_items
  add column if not exists "stockSku" text;

create unique index if not exists excel_inventory_items_import_normalized_key
  on public.excel_inventory_items ("importBatchId", "normalizedName");

create index if not exists excel_inventory_items_normalized_name_idx
  on public.excel_inventory_items ("normalizedName");

create table if not exists public.excel_inventory_product_links (
  id text primary key default gen_random_uuid()::text,
  "inventoryItemId" text not null references public.excel_inventory_items(id),
  "productId" text references public.excel_products(id),
  "relationType" text not null,
  "quantityPerProduct" double precision not null default 1,
  confidence double precision not null default 0,
  "confirmedByAdmin" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists excel_inventory_product_links_confirmed_idx
  on public.excel_inventory_product_links ("confirmedByAdmin");

create index if not exists excel_inventory_product_links_relation_type_idx
  on public.excel_inventory_product_links ("relationType");

create table if not exists public.excel_wallet_transactions (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "storeId" text references public.excel_stores(id),
  "transactionDate" timestamptz,
  "transactionType" text not null,
  "invoiceReference" text,
  amount double precision not null,
  "runningBalance" double precision,
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

create index if not exists excel_wallet_transactions_invoice_reference_idx
  on public.excel_wallet_transactions ("invoiceReference");

create index if not exists excel_wallet_transactions_transaction_date_idx
  on public.excel_wallet_transactions ("transactionDate");

alter table public.excel_wallet_transactions
  add column if not exists "exchangeRate" double precision;

create table if not exists public.deposit_requests (
  id text primary key default gen_random_uuid()::text,
  "requestedByUserId" text,
  "requestedByEmail" text not null,
  "transactionDate" timestamptz not null,
  amount double precision not null check (amount > 0),
  "proofFileName" text not null,
  "proofMimeType" text not null,
  "proofData" bytea not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  "reviewedByUserId" text,
  "reviewedByEmail" text,
  "reviewedAt" timestamptz,
  "rejectionReason" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists deposit_requests_requested_by_user_idx
  on public.deposit_requests ("requestedByUserId");

create index if not exists deposit_requests_requested_by_email_idx
  on public.deposit_requests ("requestedByEmail");

create index if not exists deposit_requests_status_idx
  on public.deposit_requests (status);

create index if not exists deposit_requests_transaction_date_idx
  on public.deposit_requests ("transactionDate");

create table if not exists public.excel_anomalies (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text references public.excel_import_batches(id),
  severity text not null,
  message text not null,
  "sourceSheet" text,
  "sourceRow" integer,
  "createdAt" timestamptz not null default now()
);

alter table public.excel_orders
  add column if not exists status text not null default 'CONFIRMED';

alter table public.excel_orders
  add column if not exists country text;

create index if not exists excel_orders_country_idx
  on public.excel_orders (country);

alter table public.excel_order_lines
  add column if not exists "lineType" text not null default 'product';

alter table public.excel_fulfillment_invoices
  add column if not exists "otherCost" double precision not null default 0;
