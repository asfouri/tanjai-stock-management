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

create table if not exists public.excel_product_groups (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  "normalizedName" text not null,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists excel_product_groups_name_key
  on public.excel_product_groups (name);

create unique index if not exists excel_product_groups_normalized_name_key
  on public.excel_product_groups ("normalizedName");

create table if not exists public.excel_products (
  id text primary key default gen_random_uuid()::text,
  "groupId" text references public.excel_product_groups(id),
  name text not null,
  description text,
  weight double precision,
  quotation jsonb,
  "imageUrl" text,
  "createdAt" timestamptz not null default now()
);

alter table public.excel_products
  add column if not exists "groupId" text,
  add column if not exists quotation jsonb,
  add column if not exists "imageUrl" text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'excel_products_group_id_fkey'
  ) then
    alter table public.excel_products
      add constraint excel_products_group_id_fkey
      foreign key ("groupId") references public.excel_product_groups(id);
  end if;
end $$;

create unique index if not exists excel_products_name_key
  on public.excel_products (name);

create index if not exists excel_products_group_id_idx
  on public.excel_products ("groupId");

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

create index if not exists excel_inventory_product_links_inventory_item_idx
  on public.excel_inventory_product_links ("inventoryItemId");

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

create table if not exists public.shopify_connections (
  id text primary key default gen_random_uuid()::text,
  "brandId" text references public.excel_brands(id),
  "internalStoreId" text references public.excel_stores(id),
  "connectedByUserId" text,
  "shopDomain" text unique,
  "encryptedAccessToken" text,
  scopes text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED', 'NEEDS_ASSIGNMENT')),
  "oauthStateHash" text unique,
  "oauthStateExpiresAt" timestamptz,
  "connectedAt" timestamptz,
  "lastSyncAt" timestamptz,
  "disconnectedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

alter table public.shopify_connections
  add column if not exists "brandId" text references public.excel_brands(id),
  add column if not exists "internalStoreId" text references public.excel_stores(id),
  add column if not exists "connectedByUserId" text,
  add column if not exists "encryptedAccessToken" text,
  add column if not exists "oauthStateExpiresAt" timestamptz,
  add column if not exists "lastSyncAt" timestamptz,
  add column if not exists "disconnectedAt" timestamptz;

alter table public.shopify_connections
  alter column "shopDomain" drop not null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shopify_connections'
      and column_name = 'userId'
  ) then
    execute 'update public.shopify_connections
      set "connectedByUserId" = "userId"
      where "connectedByUserId" is null and "userId" is not null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shopify_connections'
      and column_name = 'userEmail'
  ) then
    execute 'alter table public.shopify_connections
      alter column "userEmail" drop not null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shopify_connections'
      and column_name = 'stateExpiresAt'
  ) then
    execute 'update public.shopify_connections
      set "oauthStateExpiresAt" = "stateExpiresAt"
      where "oauthStateExpiresAt" is null and "stateExpiresAt" is not null';
  end if;
end $$;

update public.shopify_connections
set status = 'NEEDS_ASSIGNMENT'
where status = 'CONNECTED'
  and "internalStoreId" is null;

alter table public.shopify_connections
  drop constraint if exists shopify_connections_status_check;

alter table public.shopify_connections
  add constraint shopify_connections_status_check
  check (status in ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED', 'NEEDS_ASSIGNMENT'));

create unique index if not exists shopify_connections_internal_store_key
  on public.shopify_connections ("internalStoreId");

create index if not exists shopify_connections_brand_idx
  on public.shopify_connections ("brandId");

create index if not exists shopify_connections_connected_by_user_idx
  on public.shopify_connections ("connectedByUserId");

create index if not exists shopify_connections_status_idx
  on public.shopify_connections (status);

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

-- 17TRACK shipment tracking. Existing shipment rows remain valid and are
-- registered only through explicit/import-triggered flows, never on startup.
alter table public.excel_shipments
  add column if not exists "publicId" text default gen_random_uuid()::text,
  add column if not exists "trackingProvider" text default '17TRACK',
  add column if not exists "normalizedTrackingNumber" text,
  add column if not exists "carrierCode" integer,
  add column if not exists "carrierName" text,
  add column if not exists "trackingRegistrationStatus" text not null default 'UNREGISTERED',
  add column if not exists "trackingStatus" text,
  add column if not exists "trackingSubStatus" text,
  add column if not exists "trackingTag" text,
  add column if not exists "trackingRegisteredAt" timestamptz,
  add column if not exists "trackingLastRequestedAt" timestamptz,
  add column if not exists "trackingLastWebhookAt" timestamptz,
  add column if not exists "trackingLatestEventAt" timestamptz,
  add column if not exists "trackingLatestEventDescription" text,
  add column if not exists "trackingLatestEventLocation" text,
  add column if not exists "trackingDeliveredAt" timestamptz,
  add column if not exists "trackingStoppedAt" timestamptz,
  add column if not exists "trackingLastErrorCode" text,
  add column if not exists "trackingLastErrorMessage" text,
  add column if not exists "trackingRawData" jsonb,
  add column if not exists "createdAt" timestamptz not null default now(),
  add column if not exists "updatedAt" timestamptz not null default now();

update public.excel_shipments
set "publicId" = gen_random_uuid()::text
where "publicId" is null;

alter table public.excel_shipments
  alter column "publicId" set not null;

create unique index if not exists excel_shipments_public_id_key
  on public.excel_shipments ("publicId");
create unique index if not exists excel_shipments_tracking_identity_key
  on public.excel_shipments ("normalizedTrackingNumber", "carrierCode");
create index if not exists excel_shipments_normalized_tracking_idx
  on public.excel_shipments ("normalizedTrackingNumber");
create index if not exists excel_shipments_registration_status_idx
  on public.excel_shipments ("trackingRegistrationStatus");
create index if not exists excel_shipments_tracking_status_idx
  on public.excel_shipments ("trackingStatus");

create table if not exists public.shipment_tracking_events (
  id text primary key default gen_random_uuid()::text,
  "shipmentId" text not null references public.excel_shipments(id) on delete cascade,
  fingerprint text not null,
  "eventTime" timestamptz,
  "eventTimeUtc" timestamptz,
  description text,
  "translatedDescription" text,
  location text,
  stage text,
  "subStatus" text,
  country text,
  state text,
  city text,
  "postalCode" text,
  "rawData" jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create unique index if not exists shipment_tracking_events_fingerprint_key
  on public.shipment_tracking_events ("shipmentId", fingerprint);
create index if not exists shipment_tracking_events_time_idx
  on public.shipment_tracking_events ("shipmentId", "eventTimeUtc");

-- WooCommerce integration. These additions preserve all existing Excel and
-- Shopify data and can be applied repeatedly.
create table if not exists public.woocommerce_pending_connections (
  id text primary key default gen_random_uuid()::text,
  "publicTokenHash" text not null unique,
  "userId" text not null,
  "brandId" text not null references public.excel_brands(id),
  "internalStoreId" text not null references public.excel_stores(id),
  "siteUrl" text not null,
  status text not null default 'PENDING',
  "expiresAt" timestamptz not null,
  "consumedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists woocommerce_pending_user_idx
  on public.woocommerce_pending_connections ("userId");
create index if not exists woocommerce_pending_brand_idx
  on public.woocommerce_pending_connections ("brandId");
create index if not exists woocommerce_pending_store_idx
  on public.woocommerce_pending_connections ("internalStoreId");
create index if not exists woocommerce_pending_status_idx
  on public.woocommerce_pending_connections (status);

create table if not exists public.woocommerce_connections (
  id text primary key default gen_random_uuid()::text,
  "publicId" text not null unique default gen_random_uuid()::text,
  "brandId" text not null references public.excel_brands(id),
  "internalStoreId" text not null references public.excel_stores(id),
  "connectedByUserId" text not null,
  "siteUrl" text not null,
  "encryptedConsumerKey" text,
  "encryptedConsumerSecret" text,
  "keyPermissions" text not null,
  status text not null default 'CONNECTED',
  "orderCreatedWebhookId" text,
  "orderUpdatedWebhookId" text,
  "orderDeletedWebhookId" text,
  "encryptedWebhookSecret" text,
  "connectedAt" timestamptz not null default now(),
  "lastSyncAt" timestamptz,
  "disconnectedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create unique index if not exists woocommerce_connections_store_key
  on public.woocommerce_connections ("internalStoreId");
create unique index if not exists woocommerce_connections_site_key
  on public.woocommerce_connections ("siteUrl");
create index if not exists woocommerce_connections_brand_idx
  on public.woocommerce_connections ("brandId");
create index if not exists woocommerce_connections_user_idx
  on public.woocommerce_connections ("connectedByUserId");
create index if not exists woocommerce_connections_status_idx
  on public.woocommerce_connections (status);

alter table public.excel_orders
  add column if not exists provider text not null default 'EXCEL',
  add column if not exists "wooCommerceConnectionId" text references public.woocommerce_connections(id),
  add column if not exists "externalOrderId" text,
  add column if not exists currency text,
  add column if not exists "orderTotal" double precision,
  add column if not exists "externalModifiedAt" timestamptz,
  add column if not exists "integrationData" jsonb;

create unique index if not exists excel_orders_provider_connection_external_key
  on public.excel_orders (provider, "wooCommerceConnectionId", "externalOrderId");
create index if not exists excel_orders_woocommerce_connection_idx
  on public.excel_orders ("wooCommerceConnectionId");

alter table public.excel_order_lines
  add column if not exists "externalProductId" text,
  add column if not exists "externalVariationId" text,
  add column if not exists "unitPrice" double precision,
  add column if not exists "integrationData" jsonb;

alter table public.excel_order_lines
  add column if not exists "lineType" text not null default 'product';

alter table public.excel_fulfillment_invoices
  add column if not exists "otherCost" double precision not null default 0;
