import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRequire } from 'node:module';

type PrismaRuntime = {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(
    callback: (tx: any) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
  [key: string]: any;
};

type PrismaPgAdapter = object;

type PrismaPgPoolConfig = {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  keepAlive?: boolean;
  keepAliveInitialDelayMillis?: number;
  maxLifetimeSeconds?: number;
};

type PrismaPgConstructor = new (
  options: PrismaPgPoolConfig,
  adapterOptions?: {
    schema?: string;
    onPoolError?: (error: Error) => void;
    onConnectionError?: (error: Error) => void;
  },
) => PrismaPgAdapter;

const requireFromHere = createRequire(__filename);

function createMissingDelegate(name: string) {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(
            `Prisma delegate "${name}" is unavailable. Run npm install and npm run prisma:generate in backend.`,
          );
        };
      },
    },
  );
}

const retryableReadMethods = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

function createResilientDelegate(
  name: string,
  delegate: Record<string, unknown>,
) {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property !== 'string' ||
        typeof value !== 'function' ||
        !retryableReadMethods.has(property)
      ) {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          if (!isTransientDatabaseConnectionError(error)) throw error;
          console.warn(
            `[database] ${name}.${property} lost its connection; retrying once.`,
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          return value.apply(target, args);
        }
      };
    },
  });
}

function isTransientDatabaseConnectionError(error: unknown) {
  const record =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown })
      : null;
  const code = String(record?.code ?? '').toUpperCase();
  const message = String(record?.message ?? error ?? '').toLowerCase();
  return (
    ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', 'P1001', 'P1017'].includes(
      code,
    ) ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('server has closed the connection unexpectedly') ||
    message.includes('connection reset by peer') ||
    message.includes('connection closed')
  );
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaRuntime | null;

  readonly importBatch: any;
  readonly brand: any;
  readonly store: any;
  readonly productGroup: any;
  readonly product: any;
  readonly productSkuAlias: any;
  readonly productAlias: any;
  readonly order: any;
  readonly orderLine: any;
  readonly shipment: any;
  readonly shipmentTrackingEvent: any;
  readonly fulfillmentInvoice: any;
  readonly stockPurchase: any;
  readonly inventoryMovement: any;
  readonly inventoryItem: any;
  readonly inventoryProductLink: any;
  readonly walletTransaction: any;
  readonly depositRequest: any;
  readonly shopifyConnection: any;
  readonly wooCommercePendingConnection: any;
  readonly wooCommerceConnection: any;
  readonly anomaly: any;

  constructor() {
    this.client = this.createClient();
    this.importBatch = this.delegate('importBatch');
    this.brand = this.delegate('brand');
    this.store = this.delegate('store');
    this.productGroup = this.delegate('productGroup');
    this.product = this.delegate('product');
    this.productSkuAlias = this.delegate('productSkuAlias');
    this.productAlias = this.delegate('productAlias');
    this.order = this.delegate('order');
    this.orderLine = this.delegate('orderLine');
    this.shipment = this.delegate('shipment');
    this.shipmentTrackingEvent = this.delegate('shipmentTrackingEvent');
    this.fulfillmentInvoice = this.delegate('fulfillmentInvoice');
    this.stockPurchase = this.delegate('stockPurchase');
    this.inventoryMovement = this.delegate('inventoryMovement');
    this.inventoryItem = this.delegate('inventoryItem');
    this.inventoryProductLink = this.delegate('inventoryProductLink');
    this.walletTransaction = this.delegate('walletTransaction');
    this.depositRequest = this.delegate('depositRequest');
    this.shopifyConnection = this.delegate('shopifyConnection');
    this.wooCommercePendingConnection = this.delegate(
      'wooCommercePendingConnection',
    );
    this.wooCommerceConnection = this.delegate('wooCommerceConnection');
    this.anomaly = this.delegate('anomaly');
  }

  async onModuleInit() {}

  async onModuleDestroy() {
    if (process.env.DATABASE_URL && this.client) {
      await this.client.$disconnect();
    }
  }

  async $transaction<T>(
    callback: (tx: any) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) {
    if (!this.client) {
      throw new Error(
        'Prisma is unavailable. Run npm install and npm run prisma:generate in backend.',
      );
    }

    return this.client.$transaction(callback, options);
  }

  private delegate(name: string) {
    const delegate = this.client?.[name];
    return delegate && typeof delegate === 'object'
      ? createResilientDelegate(name, delegate)
      : createMissingDelegate(name);
  }

  private createClient(): PrismaRuntime | null {
    try {
      const { PrismaClient } = requireFromHere('@prisma/client') as {
        PrismaClient: new (options?: Record<string, unknown>) => PrismaRuntime;
      };

      const options: Record<string, unknown> = {
        transactionOptions: {
          maxWait: 20000,
          timeout: 300000,
        },
      };

      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        const { PrismaPg } = requireFromHere('@prisma/adapter-pg') as {
          PrismaPg: PrismaPgConstructor;
        };
        const connectionUrl = new URL(databaseUrl);
        const schema = connectionUrl.searchParams.get('schema') ?? undefined;
        const configuredLimit = Number(
          connectionUrl.searchParams.get('connection_limit'),
        );
        const connectionLimit =
          Number.isInteger(configuredLimit) && configuredLimit > 0
            ? configuredLimit
            : 5;
        const sslMode = connectionUrl.searchParams
          .get('sslmode')
          ?.toLowerCase();
        connectionUrl.searchParams.delete('schema');
        connectionUrl.searchParams.delete('connection_limit');
        if (sslMode === 'require') {
          connectionUrl.searchParams.delete('sslmode');
        }

        const poolConfig: PrismaPgPoolConfig = {
          connectionString: connectionUrl.toString(),
          max: connectionLimit,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 10000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
          maxLifetimeSeconds: 300,
          ...(sslMode === 'require'
            ? { ssl: { rejectUnauthorized: false } }
            : {}),
        };
        options.adapter = new PrismaPg(poolConfig, {
          schema,
          onPoolError: (error) =>
            console.warn(
              `[database] idle pool connection closed: ${error.message}`,
            ),
          onConnectionError: (error) =>
            console.warn(`[database] connection error: ${error.message}`),
        });
      }

      return new PrismaClient(options);
    } catch (error) {
      console.error(
        '[database] unable to initialize Prisma client:',
        error instanceof Error ? error.message : error,
      );
      if (process.env.DATABASE_URL) throw error;
      return null;
    }
  }
}
