import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AuthenticatedUser } from '../../auth/guards/supabase-auth.guard';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Track17Service } from '../../tracking/services/track17.service';

type WooConfig = {
  appName: string;
  callbackUrl: string;
  returnUrl: string;
  webhookBaseUrl: string;
  encryptionKey: string;
};

type WooOrder = Record<string, any> & {
  id?: number | string;
  number?: string;
  status?: string;
  currency?: string;
  total?: string;
  date_created?: string;
  date_created_gmt?: string;
  date_modified?: string;
  date_modified_gmt?: string;
  line_items?: Array<Record<string, any>>;
  shipping_lines?: Array<Record<string, any>>;
};

@Injectable()
export class WooCommerceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly track17Service: Track17Service,
  ) {}

  async listConnections(user: AuthenticatedUser) {
    const stores = await this.ownedStores(user);
    return {
      configured: this.isConfigured(),
      stores: stores.map((store: any) => ({
        internalStoreId: store.id,
        name: store.name,
        connected: store.wooCommerceConnection?.status === 'CONNECTED',
        siteUrl: store.wooCommerceConnection?.siteUrl ?? null,
        status: store.wooCommerceConnection?.status ?? 'NOT_CONNECTED',
        connectedAt: store.wooCommerceConnection?.connectedAt ?? null,
        lastSyncAt: store.wooCommerceConnection?.lastSyncAt ?? null,
      })),
    };
  }

  async startConnection(
    internalStoreId: string | undefined,
    siteUrlInput: string | undefined,
    user: AuthenticatedUser,
  ) {
    const config = this.config();
    const store = await this.ownedStore(internalStoreId, user);
    const siteUrl = await normalizeAndValidateSiteUrl(siteUrlInput);
    const existingSite = await this.prisma.wooCommerceConnection.findUnique({
      where: { siteUrl },
      select: { internalStoreId: true, status: true },
    });
    if (
      existingSite?.status === 'CONNECTED' &&
      existingSite.internalStoreId !== store.id
    ) {
      throw new ConflictException(
        'This WooCommerce website is already connected to another internal store.',
      );
    }
    const existingStore = await this.prisma.wooCommerceConnection.findUnique({
      where: { internalStoreId: store.id },
      select: { status: true },
    });
    if (existingStore?.status === 'CONNECTED') {
      throw new ConflictException(
        'Disconnect the current WooCommerce website before connecting another one.',
      );
    }

    const publicToken = randomBytes(32).toString('base64url');
    const principalId = authenticatedPrincipalId(user);
    await this.prisma.wooCommercePendingConnection.updateMany({
      where: {
        userId: principalId,
        internalStoreId: store.id,
        status: 'PENDING',
      },
      data: { status: 'EXPIRED' },
    });
    await this.prisma.wooCommercePendingConnection.create({
      data: {
        publicTokenHash: hashToken(publicToken),
        userId: principalId,
        brandId: store.brandId,
        internalStoreId: store.id,
        siteUrl,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const authorizationUrl = new URL('/wc-auth/v1/authorize', `${siteUrl}/`);
    authorizationUrl.searchParams.set('app_name', config.appName);
    authorizationUrl.searchParams.set('scope', 'read_write');
    authorizationUrl.searchParams.set('user_id', publicToken);
    authorizationUrl.searchParams.set('return_url', config.returnUrl);
    authorizationUrl.searchParams.set('callback_url', config.callbackUrl);
    return { authorizationUrl: authorizationUrl.toString() };
  }

  async credentialsCallback(body: Record<string, unknown>) {
    const publicToken = cleanString(body.user_id);
    const consumerKey = cleanString(body.consumer_key);
    const consumerSecret = cleanString(body.consumer_secret);
    const keyPermissions = cleanString(body.key_permissions);
    if (!publicToken || !consumerKey.startsWith('ck_') || !consumerSecret.startsWith('cs_')) {
      throw new BadRequestException('WooCommerce credentials callback is invalid.');
    }
    if (keyPermissions !== 'read_write') {
      throw new BadRequestException('WooCommerce read/write permission is required.');
    }

    const pending = await this.prisma.wooCommercePendingConnection.findUnique({
      where: { publicTokenHash: hashToken(publicToken) },
    });
    this.assertPending(pending);
    await normalizeAndValidateSiteUrl(pending!.siteUrl);
    await this.fetchWoo(
      pending!.siteUrl,
      '/wp-json/wc/v3/orders?per_page=1',
      consumerKey,
      consumerSecret,
    );

    const config = this.config();
    const duplicateSite = await this.prisma.wooCommerceConnection.findUnique({
      where: { siteUrl: pending!.siteUrl },
      select: { id: true, internalStoreId: true },
    });
    const existingStore = await this.prisma.wooCommerceConnection.findUnique({
      where: { internalStoreId: pending!.internalStoreId },
      select: { id: true },
    });
    if (
      duplicateSite &&
      duplicateSite.internalStoreId !== pending!.internalStoreId
    ) {
      throw new ConflictException(
        'This WooCommerce website is already connected to another internal store.',
      );
    }

    const webhookSecret = randomBytes(32).toString('base64url');
    const credentialData = {
      brandId: pending!.brandId,
      connectedByUserId: pending!.userId,
      siteUrl: pending!.siteUrl,
      encryptedConsumerKey: encryptSecret(consumerKey, config.encryptionKey),
      encryptedConsumerSecret: encryptSecret(
        consumerSecret,
        config.encryptionKey,
      ),
      keyPermissions,
      status: 'PENDING',
      encryptedWebhookSecret: encryptSecret(
        webhookSecret,
        config.encryptionKey,
      ),
      connectedAt: new Date(),
      disconnectedAt: null,
    };
    const connection = existingStore
      ? await this.prisma.wooCommerceConnection.update({
          where: { id: existingStore.id },
          data: credentialData,
        })
      : await this.prisma.wooCommerceConnection.create({
          data: {
            ...credentialData,
            internalStoreId: pending!.internalStoreId,
          },
        });

    try {
      const webhookIds = await this.registerWebhooks(
        connection,
        consumerKey,
        consumerSecret,
        webhookSecret,
      );
      await this.prisma.wooCommerceConnection.update({
        where: { id: connection.id },
        data: { ...webhookIds, status: 'CONNECTED' },
      });
      await this.syncConnection(connection.id, true);
      await this.prisma.wooCommercePendingConnection.update({
        where: { id: pending!.id },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
    } catch (error) {
      await this.prisma.wooCommerceConnection.update({
        where: { id: connection.id },
        data: { status: 'ERROR' },
      });
      throw error;
    }
    return { success: true };
  }

  async browserReturn(
    success: string | undefined,
    publicToken: string | undefined,
  ) {
    const config = this.config();
    const dashboard = new URL('/dashboard', new URL(config.returnUrl).origin);
    dashboard.searchParams.set('section', 'integrations');
    const token = cleanString(publicToken);
    if (!token || success !== '1') {
      dashboard.searchParams.set('woocommerce', 'failed');
      return dashboard.toString();
    }
    const pending = await this.prisma.wooCommercePendingConnection.findUnique({
      where: { publicTokenHash: hashToken(token) },
    });
    if (!pending || pending.expiresAt.getTime() < Date.now()) {
      dashboard.searchParams.set('woocommerce', 'failed');
      return dashboard.toString();
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const connection = await this.prisma.wooCommerceConnection.findUnique({
        where: { internalStoreId: pending.internalStoreId },
        select: { status: true },
      });
      if (connection?.status === 'CONNECTED') {
        dashboard.searchParams.set('woocommerce', 'connected');
        dashboard.searchParams.set('storeId', pending.internalStoreId);
        return dashboard.toString();
      }
      if (connection?.status === 'ERROR') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    dashboard.searchParams.set('woocommerce', 'failed');
    return dashboard.toString();
  }

  async syncStore(internalStoreId: string | undefined, user: AuthenticatedUser) {
    const store = await this.ownedStore(internalStoreId, user);
    const connection = await this.prisma.wooCommerceConnection.findUnique({
      where: { internalStoreId: store.id },
      select: { id: true, status: true },
    });
    if (!connection || connection.status !== 'CONNECTED') {
      throw new ConflictException('This store is not connected to WooCommerce.');
    }
    return this.syncConnection(connection.id, false);
  }

  async disconnectStore(
    internalStoreId: string | undefined,
    user: AuthenticatedUser,
  ) {
    const store = await this.ownedStore(internalStoreId, user);
    const connection = await this.prisma.wooCommerceConnection.findUnique({
      where: { internalStoreId: store.id },
    });
    if (!connection) {
      throw new NotFoundException('This store has no WooCommerce connection.');
    }
    await this.deleteWebhooksBestEffort(connection);
    const disconnectedAt = new Date();
    await this.prisma.wooCommerceConnection.update({
      where: { id: connection.id },
      data: {
        encryptedConsumerKey: null,
        encryptedConsumerSecret: null,
        encryptedWebhookSecret: null,
        orderCreatedWebhookId: null,
        orderUpdatedWebhookId: null,
        orderDeletedWebhookId: null,
        status: 'DISCONNECTED',
        disconnectedAt,
      },
    });
    return { internalStoreId: store.id, status: 'DISCONNECTED', disconnectedAt };
  }

  async receiveWebhook(
    connectionPublicId: string | undefined,
    signature: string | undefined,
    topic: string | undefined,
    rawBody: Buffer | undefined,
  ) {
    const publicId = cleanString(connectionPublicId);
    if (!publicId || !rawBody?.length) {
      throw new BadRequestException('WooCommerce webhook body is required.');
    }
    const connection = await this.prisma.wooCommerceConnection.findUnique({
      where: { publicId },
    });
    if (
      !connection ||
      connection.status !== 'CONNECTED' ||
      !connection.encryptedWebhookSecret
    ) {
      throw new NotFoundException('WooCommerce webhook connection not found.');
    }
    const secret = decryptSecret(
      connection.encryptedWebhookSecret,
      this.config().encryptionKey,
    );
    verifyWebhookSignature(rawBody, cleanString(signature), secret);
    let payload: WooOrder;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WooOrder;
    } catch {
      throw new BadRequestException('WooCommerce webhook JSON is invalid.');
    }
    const normalizedTopic = cleanString(topic).toLowerCase();
    if (normalizedTopic === 'order.deleted') {
      await this.markOrderDeleted(connection.id, payload.id);
    } else if (
      normalizedTopic === 'order.created' ||
      normalizedTopic === 'order.updated'
    ) {
      await this.upsertOrder(connection, payload);
    }
    return { received: true };
  }

  private async syncConnection(connectionId: string, allowPending: boolean) {
    const connection = await this.prisma.wooCommerceConnection.findUnique({
      where: { id: connectionId },
    });
    if (
      !connection ||
      (!allowPending && connection.status !== 'CONNECTED') ||
      !connection.encryptedConsumerKey ||
      !connection.encryptedConsumerSecret
    ) {
      throw new ConflictException('WooCommerce connection is not available.');
    }
    const config = this.config();
    const consumerKey = decryptSecret(
      connection.encryptedConsumerKey,
      config.encryptionKey,
    );
    const consumerSecret = decryptSecret(
      connection.encryptedConsumerSecret,
      config.encryptionKey,
    );
    let page = 1;
    let totalPages = 1;
    let created = 0;
    let updated = 0;
    let processed = 0;
    do {
      const response = await this.fetchWoo(
        connection.siteUrl,
        `/wp-json/wc/v3/orders?status=any&per_page=100&page=${page}`,
        consumerKey,
        consumerSecret,
      );
      const orders = (await response.json()) as WooOrder[];
      totalPages = Math.max(
        1,
        Number.parseInt(response.headers.get('x-wp-totalpages') ?? '1', 10) || 1,
      );
      for (const order of orders) {
        const result = await this.upsertOrder(connection, order);
        created += result.created ? 1 : 0;
        updated += result.created ? 0 : 1;
        processed += 1;
      }
      page += 1;
    } while (page <= totalPages);
    const lastSyncAt = new Date();
    await this.prisma.wooCommerceConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt },
    });
    return {
      internalStoreId: connection.internalStoreId,
      processed,
      created,
      updated,
      lastSyncAt,
    };
  }

  private async upsertOrder(connection: any, order: WooOrder) {
    const externalOrderId = cleanString(order.id);
    if (!externalOrderId) {
      throw new BadRequestException('WooCommerce order has no ID.');
    }
    const existing = await this.prisma.order.findUnique({
      where: {
        provider_wooCommerceConnectionId_externalOrderId: {
          provider: 'WOOCOMMERCE',
          wooCommerceConnectionId: connection.id,
          externalOrderId,
        },
      },
      select: { id: true },
    });
    const importBatch = await this.prisma.importBatch.upsert({
      where: { fileHash: `woocommerce:${connection.id}` },
      update: { status: 'CONFIRMED' },
      create: {
        id: `woocommerce:${connection.id}`,
        fileName: `WooCommerce ${connection.siteUrl}`,
        fileHash: `woocommerce:${connection.id}`,
        status: 'CONFIRMED',
        summary: { provider: 'WOOCOMMERCE' },
        warnings: [],
        duplicates: [],
      },
      select: { id: true },
    });
    const createdAt = parseWooDate(order.date_created_gmt ?? order.date_created);
    const modifiedAt = parseWooDate(
      order.date_modified_gmt ?? order.date_modified,
    );
    const orderData = {
      importBatchId: importBatch.id,
      storeId: connection.internalStoreId,
      externalOrderNumber: cleanString(order.number) || externalOrderId,
      orderDate: createdAt,
      invoiceReference: `woocommerce:${connection.publicId}:${externalOrderId}`,
      country:
        cleanString(order.shipping?.country) ||
        cleanString(order.billing?.country) ||
        null,
      status: cleanString(order.status).toUpperCase() || 'UNKNOWN',
      sourceSheet: 'WooCommerce API',
      sourceRow: safeInt(order.id),
      provider: 'WOOCOMMERCE',
      wooCommerceConnectionId: connection.id,
      externalOrderId,
      currency: cleanString(order.currency) || null,
      orderTotal: numberValue(order.total),
      externalModifiedAt: modifiedAt,
      integrationData: {
        billing: order.billing ?? null,
        shipping: order.shipping ?? null,
        customerId: order.customer_id ?? null,
        customerNote: order.customer_note ?? null,
        paymentMethod: order.payment_method ?? null,
        paymentMethodTitle: order.payment_method_title ?? null,
        transactionId: order.transaction_id ?? null,
        shippingLines: order.shipping_lines ?? [],
        metaData: order.meta_data ?? [],
      },
    };
    const saved = await this.prisma.order.upsert({
      where: {
        provider_wooCommerceConnectionId_externalOrderId: {
          provider: 'WOOCOMMERCE',
          wooCommerceConnectionId: connection.id,
          externalOrderId,
        },
      },
      update: orderData,
      create: orderData,
      select: { id: true },
    });

    const lines: any[] = [];
    let sourceRow = 1;
    for (const line of Array.isArray(order.line_items) ? order.line_items : []) {
      const name = cleanString(line.name) || `WooCommerce product ${line.product_id}`;
      const product = await this.prisma.product.upsert({
        where: { name },
        update: {},
        create: { name },
        select: { id: true },
      });
      const quantity = numberValue(line.quantity) || 0;
      const total = numberValue(line.total) || 0;
      lines.push({
        orderId: saved.id,
        productId: product.id,
        sku:
          cleanString(line.sku) ||
          `woo-${cleanString(line.product_id)}-${cleanString(line.variation_id) || '0'}`,
        quantity,
        productCost: total,
        shippingCost: 0,
        handlingCost: 0,
        totalCost: total,
        lineType: 'product',
        sourceSheet: 'WooCommerce API',
        sourceRow: sourceRow++,
        externalProductId: cleanString(line.product_id) || null,
        externalVariationId: cleanString(line.variation_id) || null,
        unitPrice: numberValue(line.price) ?? (quantity ? total / quantity : 0),
        integrationData: { lineItemId: line.id ?? null, metaData: line.meta_data ?? [] },
      });
    }
    for (const line of Array.isArray(order.shipping_lines)
      ? order.shipping_lines
      : []) {
      const total = numberValue(line.total) || 0;
      lines.push({
        orderId: saved.id,
        productId: null,
        sku: `shipping:${cleanString(line.method_id) || cleanString(line.id)}`,
        quantity: 1,
        productCost: 0,
        shippingCost: total,
        handlingCost: 0,
        totalCost: total,
        lineType: 'shipping',
        sourceSheet: 'WooCommerce API',
        sourceRow: sourceRow++,
        externalProductId: null,
        externalVariationId: null,
        unitPrice: total,
        integrationData: { methodTitle: line.method_title ?? null },
      });
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.orderLine.deleteMany({ where: { orderId: saved.id } });
      if (lines.length) {
        await transaction.orderLine.createMany({ data: lines });
      }
    });
    await this.track17Service.captureExplicitOrderShipments(
      saved.id,
      explicitWooTrackingNumbers(order),
      'WooCommerce API',
    );
    return { created: !existing };
  }

  private async markOrderDeleted(connectionId: string, externalId: unknown) {
    const externalOrderId = cleanString(externalId);
    if (!externalOrderId) return;
    await this.prisma.order.updateMany({
      where: {
        provider: 'WOOCOMMERCE',
        wooCommerceConnectionId: connectionId,
        externalOrderId,
      },
      data: { status: 'DELETED', externalModifiedAt: new Date() },
    });
  }

  private async registerWebhooks(
    connection: any,
    consumerKey: string,
    consumerSecret: string,
    secret: string,
  ) {
    const config = this.config();
    const deliveryUrl = `${config.webhookBaseUrl.replace(/\/$/, '')}/${connection.publicId}`;
    const topics = [
      ['order.created', 'orderCreatedWebhookId'],
      ['order.updated', 'orderUpdatedWebhookId'],
      ['order.deleted', 'orderDeletedWebhookId'],
    ] as const;
    const result: Record<string, string> = {};
    for (const [topic, field] of topics) {
      const response = await this.fetchWoo(
        connection.siteUrl,
        '/wp-json/wc/v3/webhooks',
        consumerKey,
        consumerSecret,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `TanjAI ${topic}`,
            topic,
            delivery_url: deliveryUrl,
            secret,
            status: 'active',
          }),
        },
      );
      const body = (await response.json()) as { id?: number | string };
      if (!body.id) {
        throw new BadGatewayException('WooCommerce did not create a webhook.');
      }
      result[field] = String(body.id);
    }
    return result;
  }

  private async deleteWebhooksBestEffort(connection: any) {
    if (!connection.encryptedConsumerKey || !connection.encryptedConsumerSecret) return;
    const config = this.config();
    let key: string;
    let secret: string;
    try {
      key = decryptSecret(connection.encryptedConsumerKey, config.encryptionKey);
      secret = decryptSecret(
        connection.encryptedConsumerSecret,
        config.encryptionKey,
      );
    } catch {
      return;
    }
    const ids = [
      connection.orderCreatedWebhookId,
      connection.orderUpdatedWebhookId,
      connection.orderDeletedWebhookId,
    ].filter(Boolean);
    await Promise.allSettled(
      ids.map((id) =>
        this.fetchWoo(
          connection.siteUrl,
          `/wp-json/wc/v3/webhooks/${encodeURIComponent(id)}?force=true`,
          key,
          secret,
          { method: 'DELETE' },
        ),
      ),
    );
  }

  private async fetchWoo(
    siteUrl: string,
    path: string,
    consumerKey: string,
    consumerSecret: string,
    init: RequestInit = {},
  ) {
    let response: Response;
    try {
      response = await fetch(`${siteUrl}${path}`, {
        ...init,
        redirect: 'manual',
        headers: {
          Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BadGatewayException('Unable to reach the WooCommerce website.');
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `WooCommerce request failed with status ${response.status}.`,
      );
    }
    return response;
  }

  private assertPending(pending: any) {
    if (!pending || pending.status !== 'PENDING' || pending.consumedAt) {
      throw new BadRequestException('WooCommerce connection token is invalid.');
    }
    if (pending.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('WooCommerce connection token expired.');
    }
  }

  private async ownedStores(user: AuthenticatedUser) {
    this.assertTanjaiAdmin(user);
    const stores = await this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: { wooCommerceConnection: true },
    });
    return stores;
  }

  private async ownedStore(
    internalStoreId: string | undefined,
    user: AuthenticatedUser,
  ) {
    this.assertTanjaiAdmin(user);
    const id = cleanString(internalStoreId);
    if (!id) throw new BadRequestException('An internal store is required.');
    const store = await this.prisma.store.findUnique({
      where: { id },
      select: { id: true, brandId: true, name: true },
    });
    if (!store) throw new NotFoundException('Internal store not found.');
    return store;
  }

  private assertTanjaiAdmin(user: AuthenticatedUser) {
    if (user.role !== 'TANJAI_ADMIN') {
      throw new ForbiddenException(
        'Only TanjAI Admin accounts can manage WooCommerce connections.',
      );
    }
  }

  private isConfigured() {
    return Boolean(
      process.env.WOOCOMMERCE_APP_NAME?.trim() &&
        process.env.WOOCOMMERCE_CALLBACK_URL?.trim() &&
        process.env.WOOCOMMERCE_RETURN_URL?.trim() &&
        process.env.WOOCOMMERCE_WEBHOOK_BASE_URL?.trim() &&
        process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY?.trim(),
    );
  }

  private config(): WooConfig {
    const config = {
      appName: process.env.WOOCOMMERCE_APP_NAME?.trim() ?? '',
      callbackUrl: process.env.WOOCOMMERCE_CALLBACK_URL?.trim() ?? '',
      returnUrl: process.env.WOOCOMMERCE_RETURN_URL?.trim() ?? '',
      webhookBaseUrl:
        process.env.WOOCOMMERCE_WEBHOOK_BASE_URL?.trim() ?? '',
      encryptionKey:
        process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY?.trim() ?? '',
    };
    const missing = Object.entries(config)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length) {
      throw new ServiceUnavailableException(
        `WooCommerce integration is not configured. Missing: ${missing.join(', ')}.`,
      );
    }
    for (const publicUrl of [
      config.callbackUrl,
      config.returnUrl,
      config.webhookBaseUrl,
    ]) {
      let parsed: URL;
      try {
        parsed = new URL(publicUrl);
      } catch {
        throw new ServiceUnavailableException(
          'WooCommerce public URLs are invalid.',
        );
      }
      if (parsed.protocol !== 'https:') {
        throw new ServiceUnavailableException(
          'WooCommerce public URLs must use HTTPS.',
        );
      }
    }
    if (config.encryptionKey.length < 32) {
      throw new ServiceUnavailableException(
        'WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY must be at least 32 characters.',
      );
    }
    return config;
  }
}

async function normalizeAndValidateSiteUrl(input: string | undefined) {
  let url: URL;
  try {
    url = new URL(cleanString(input));
  } catch {
    throw new BadRequestException('Enter a valid WooCommerce website URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new BadRequestException(
      'WooCommerce website URL must be a public HTTPS address.',
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new BadRequestException('Private WooCommerce websites are not allowed.');
  }
  if (isPrivateAddress(hostname)) {
    throw new BadRequestException('Private WooCommerce websites are not allowed.');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException('WooCommerce website hostname cannot be resolved.');
  }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new BadRequestException('Private WooCommerce websites are not allowed.');
  }
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}${
    url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  }`;
}

function isPrivateAddress(input: string) {
  const value = input.toLowerCase();
  if (!isIP(value)) return false;
  if (value === '::1' || value === '::' || value.startsWith('fe80:')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function verifyWebhookSignature(body: Buffer, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64');
  } catch {
    throw new ForbiddenException('WooCommerce webhook signature is invalid.');
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ForbiddenException('WooCommerce webhook signature is invalid.');
  }
}

function encryptSecret(value: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSecret(value: string, secret: string) {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) {
    throw new ServiceUnavailableException('Stored WooCommerce credentials are invalid.');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ServiceUnavailableException('Stored WooCommerce credentials cannot be decrypted.');
  }
}

function encryptionKey(secret: string) {
  return createHash('sha256').update(secret).digest();
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function authenticatedPrincipalId(user: AuthenticatedUser) {
  return cleanString(user.id) || user.email.trim().toLowerCase();
}

function cleanString(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function explicitWooTrackingNumbers(order: WooOrder) {
  const values: unknown[] = [order.tracking_number];
  if (Array.isArray(order.tracking_numbers)) {
    values.push(...order.tracking_numbers);
  }
  const shipmentTracking = order.shipment_tracking;
  if (shipmentTracking && typeof shipmentTracking === 'object') {
    values.push((shipmentTracking as Record<string, unknown>).tracking_number);
  }
  if (Array.isArray(order.shipment_trackings)) {
    for (const item of order.shipment_trackings) {
      if (item && typeof item === 'object') {
        values.push((item as Record<string, unknown>).tracking_number);
      }
    }
  }
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWooDate(value: unknown) {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text.endsWith('Z') ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeInt(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 2_147_483_647
    ? number
    : 0;
}
