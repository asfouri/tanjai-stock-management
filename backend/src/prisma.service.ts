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

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaRuntime | null;

  readonly importBatch: any;
  readonly brand: any;
  readonly store: any;
  readonly product: any;
  readonly productSkuAlias: any;
  readonly productAlias: any;
  readonly order: any;
  readonly orderLine: any;
  readonly shipment: any;
  readonly fulfillmentInvoice: any;
  readonly stockPurchase: any;
  readonly inventoryMovement: any;
  readonly inventoryItem: any;
  readonly inventoryProductLink: any;
  readonly walletTransaction: any;
  readonly depositRequest: any;
  readonly anomaly: any;

  constructor() {
    this.client = this.createClient();
    this.importBatch =
      this.client?.importBatch ?? createMissingDelegate('importBatch');
    this.brand = this.client?.brand ?? createMissingDelegate('brand');
    this.store = this.client?.store ?? createMissingDelegate('store');
    this.product = this.client?.product ?? createMissingDelegate('product');
    this.productSkuAlias =
      this.client?.productSkuAlias ?? createMissingDelegate('productSkuAlias');
    this.productAlias =
      this.client?.productAlias ?? createMissingDelegate('productAlias');
    this.order = this.client?.order ?? createMissingDelegate('order');
    this.orderLine =
      this.client?.orderLine ?? createMissingDelegate('orderLine');
    this.shipment = this.client?.shipment ?? createMissingDelegate('shipment');
    this.fulfillmentInvoice =
      this.client?.fulfillmentInvoice ??
      createMissingDelegate('fulfillmentInvoice');
    this.stockPurchase =
      this.client?.stockPurchase ?? createMissingDelegate('stockPurchase');
    this.inventoryMovement =
      this.client?.inventoryMovement ??
      createMissingDelegate('inventoryMovement');
    this.inventoryItem =
      this.client?.inventoryItem ?? createMissingDelegate('inventoryItem');
    this.inventoryProductLink =
      this.client?.inventoryProductLink ??
      createMissingDelegate('inventoryProductLink');
    this.walletTransaction =
      this.client?.walletTransaction ??
      createMissingDelegate('walletTransaction');
    this.depositRequest =
      this.client?.depositRequest ?? createMissingDelegate('depositRequest');
    this.anomaly = this.client?.anomaly ?? createMissingDelegate('anomaly');
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

  private createClient(): PrismaRuntime | null {
    try {
      const { PrismaClient } = requireFromHere('@prisma/client') as {
        PrismaClient: new (options?: Record<string, unknown>) => PrismaRuntime;
      };

      return new PrismaClient({
        transactionOptions: {
          maxWait: 20000,
          timeout: 300000,
        },
      });
    } catch {
      return null;
    }
  }
}
