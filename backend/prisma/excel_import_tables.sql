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
  "createdAt" timestamptz not null default now()
);

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

create table if not exists public.excel_orders (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text not null references public.excel_import_batches(id),
  "storeId" text not null references public.excel_stores(id),
  "externalOrderNumber" text not null,
  "orderDate" timestamptz,
  "invoiceReference" text not null,
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
  "movementDate" timestamptz,
  "movementType" text not null,
  quantity double precision not null,
  reference text,
  comment text,
  "sourceSheet" text not null,
  "sourceRow" integer not null,
  "createdAt" timestamptz not null default now()
);

create index if not exists excel_inventory_movements_movement_type_idx
  on public.excel_inventory_movements ("movementType");

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

create table if not exists public.excel_anomalies (
  id text primary key default gen_random_uuid()::text,
  "importBatchId" text references public.excel_import_batches(id),
  severity text not null,
  message text not null,
  "sourceSheet" text,
  "sourceRow" integer,
  "createdAt" timestamptz not null default now()
);
