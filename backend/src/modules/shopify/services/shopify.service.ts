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
import type { AuthenticatedUser } from '../../auth/guards/supabase-auth.guard';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

type ShopifyConfig = {
  clientId: string;
  clientSecret: string;
  scopes: string;
  appUrl: string;
  redirectUri: string;
  installUrl: string;
};

type ShopifyTokenResponse = {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

@Injectable()
export class ShopifyService {
  constructor(private readonly prisma: PrismaService) {}

  async getBrandStatus(user: AuthenticatedUser) {
    const brand = await this.ownedBrand(user);
    const connection = await this.prisma.shopifyConnection.findFirst({
      where: { brandId: brand.id, internalStoreId: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        status: true,
        shopDomain: true,
        scopes: true,
        connectedAt: true,
        lastSyncAt: true,
        disconnectedAt: true,
      },
    });
    return { configured: this.isConfigured(), brand, connection };
  }

  async prepareBrandInstallation(user: AuthenticatedUser) {
    const config = this.getConfig();
    const brand = await this.ownedBrand(user);
    const currentConnection = await this.prisma.shopifyConnection.findFirst({
      where: { brandId: brand.id, internalStoreId: null },
      orderBy: { updatedAt: 'desc' },
    });
    if (currentConnection?.status === 'CONNECTED') {
      throw new ConflictException(
        'Disconnect the current Shopify account before starting another installation.',
      );
    }

    const nonce = randomBytes(32).toString('base64url');
    const data = {
      brandId: brand.id,
      internalStoreId: null,
      connectedByUserId: authenticatedPrincipalId(user),
      shopDomain: null,
      scopes: config.scopes,
      status: 'PENDING',
      oauthStateHash: hashState(nonce),
      oauthStateExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };
    if (currentConnection) {
      await this.prisma.shopifyConnection.update({
        where: { id: currentConnection.id },
        data,
      });
    } else {
      await this.prisma.shopifyConnection.create({ data });
    }
    return { redirectUrl: config.installUrl, nonce };
  }

  async listStoreStatuses(user: AuthenticatedUser) {
    const stores = await this.ownedStores(user);
    return {
      configured: this.isConfigured(),
      stores: stores.map((store: any) => ({
        id: store.id,
        name: store.name,
        brandId: store.brandId,
        brandName: store.brand.name,
        connection: store.shopifyConnection
          ? {
              status: store.shopifyConnection.status,
              shopDomain: store.shopifyConnection.shopDomain,
              scopes: store.shopifyConnection.scopes,
              connectedAt: store.shopifyConnection.connectedAt,
              lastSyncAt: store.shopifyConnection.lastSyncAt,
              disconnectedAt: store.shopifyConnection.disconnectedAt,
            }
          : null,
      })),
    };
  }

  async prepareInstallation(
    storeId: string | undefined,
    user: AuthenticatedUser,
  ) {
    const config = this.getConfig();
    const store = await this.ownedStore(storeId, user);
    const currentConnection =
      await this.prisma.shopifyConnection.findUnique({
        where: { internalStoreId: store.id },
        select: { status: true },
      });
    if (currentConnection?.status === 'CONNECTED') {
      throw new ConflictException(
        'Disconnect the current Shopify account before starting another installation.',
      );
    }

    const nonce = randomBytes(32).toString('base64url');
    const oauthStateExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const data = {
      brandId: store.brandId,
      connectedByUserId: authenticatedPrincipalId(user),
      shopDomain: null,
      scopes: config.scopes,
      status: 'PENDING',
      oauthStateHash: hashState(nonce),
      oauthStateExpiresAt,
    };

    if (currentConnection) {
      await this.prisma.shopifyConnection.update({
        where: { internalStoreId: store.id },
        data,
      });
    } else {
      await this.prisma.shopifyConnection.create({
        data: { ...data, internalStoreId: store.id },
      });
    }

    return { redirectUrl: config.installUrl, nonce };
  }

  async continueInstallation(
    rawUrl: string,
    pendingNonce: string | undefined,
  ) {
    const config = this.getConfig();
    const launchUrl = new URL(rawUrl, config.appUrl);
    const shopDomain = normalizeShopDomain(
      launchUrl.searchParams.get('shop') ?? undefined,
    );
    assertFreshShopifyTimestamp(launchUrl.searchParams.get('timestamp'));
    if (!verifyShopifyHmac(launchUrl.searchParams, config.clientSecret)) {
      throw new BadRequestException('Shopify installation HMAC validation failed.');
    }
    if (!pendingNonce) {
      throw new BadRequestException(
        'No pending TanjAI store connection was found in this browser.',
      );
    }

    const connection = await this.prisma.shopifyConnection.findFirst({
      where: {
        oauthStateHash: hashState(pendingNonce),
        status: 'PENDING',
      },
    });
    if (!connection?.brandId || !connection.oauthStateExpiresAt) {
      throw new BadRequestException('The pending Shopify connection is invalid.');
    }
    if (new Date(connection.oauthStateExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException(
        'The pending Shopify connection expired. Start again from TanjAI Stores.',
      );
    }
    await this.pendingConnectionTarget(connection);
    const domainConnection = await this.prisma.shopifyConnection.findUnique({
      where: { shopDomain },
      select: { id: true, internalStoreId: true },
    });
    if (domainConnection && domainConnection.id !== connection.id) {
      throw new ConflictException(
        domainConnection.internalStoreId
          ? 'This Shopify domain is already connected to another internal store.'
          : 'This Shopify domain requires manual assignment before it can be connected.',
      );
    }

    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: { shopDomain },
    });

    const authorizationUrl = new URL(
      `https://${shopDomain}/admin/oauth/authorize`,
    );
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('scope', config.scopes);
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizationUrl.searchParams.set('state', pendingNonce);
    return authorizationUrl.toString();
  }

  async completeOAuth(
    rawUrl: string,
    pendingNonce: string | undefined,
  ) {
    const config = this.getConfig();
    const callbackUrl = new URL(rawUrl, config.appUrl);
    const shopDomain = normalizeShopDomain(
      callbackUrl.searchParams.get('shop') ?? undefined,
    );
    const code = callbackUrl.searchParams.get('code')?.trim();
    const state = callbackUrl.searchParams.get('state')?.trim();

    if (!code || !state) {
      throw new BadRequestException(
        'Shopify OAuth callback is missing the authorization code or state.',
      );
    }
    assertFreshShopifyTimestamp(callbackUrl.searchParams.get('timestamp'));
    if (!pendingNonce || !safeStringEqual(pendingNonce, state)) {
      throw new BadRequestException('Shopify OAuth browser state validation failed.');
    }
    if (!verifyShopifyHmac(callbackUrl.searchParams, config.clientSecret)) {
      throw new BadRequestException('Shopify OAuth HMAC validation failed.');
    }

    const connection = await this.prisma.shopifyConnection.findFirst({
      where: { shopDomain, oauthStateHash: hashState(state) },
    });
    if (!connection?.brandId || !connection.oauthStateExpiresAt) {
      throw new BadRequestException(
        'Shopify OAuth state is invalid or has no brand assignment.',
      );
    }
    if (new Date(connection.oauthStateExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException(
        'Shopify OAuth state has expired. Start the integration again.',
      );
    }
    const target = await this.pendingConnectionTarget(connection);

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(
        `https://${shopDomain}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new BadGatewayException(
        'Unable to reach Shopify while exchanging the authorization code.',
      );
    }

    const tokenBody = (await tokenResponse.json().catch(() => null)) as
      | ShopifyTokenResponse
      | null;
    if (!tokenResponse.ok || !tokenBody?.access_token) {
      await this.prisma.shopifyConnection.update({
        where: { id: connection.id },
        data: {
          status: connection.status === 'CONNECTED' ? 'CONNECTED' : 'ERROR',
          oauthStateHash: null,
          oauthStateExpiresAt: null,
        },
      });
      throw new BadGatewayException(
        tokenBody?.error_description ||
          tokenBody?.error ||
          'Shopify rejected the OAuth token exchange.',
      );
    }

    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        encryptedAccessToken: encryptToken(
          tokenBody.access_token,
          config.clientSecret,
        ),
        scopes: tokenBody.scope || config.scopes,
        status: 'CONNECTED',
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        connectedAt: new Date(),
        disconnectedAt: null,
      },
    });

    return `${config.appUrl}/dashboard?section=integrations&shopify=connected&brand=${encodeURIComponent(target.brandId)}`;
  }

  async syncBrand(user: AuthenticatedUser) {
    const config = this.getConfig();
    const brand = await this.ownedBrand(user);
    const connection = await this.prisma.shopifyConnection.findFirst({
      where: { brandId: brand.id, internalStoreId: null, status: 'CONNECTED' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!connection?.shopDomain || !connection.encryptedAccessToken) {
      throw new ConflictException('This brand is not connected to Shopify.');
    }
    const accessToken = decryptToken(connection.encryptedAccessToken, config.clientSecret);
    let response: Response;
    try {
      response = await fetch(
        `https://${connection.shopDomain}/admin/api/2026-04/orders.json?status=any&limit=1`,
        {
          headers: { 'X-Shopify-Access-Token': accessToken },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new BadGatewayException('Unable to reach Shopify for synchronization.');
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `Shopify synchronization failed with status ${response.status}.`,
      );
    }
    const lastSyncAt = new Date();
    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt },
    });
    return { brandId: brand.id, shopDomain: connection.shopDomain, lastSyncAt };
  }

  async disconnectBrand(user: AuthenticatedUser) {
    const brand = await this.ownedBrand(user);
    const connection = await this.prisma.shopifyConnection.findFirst({
      where: { brandId: brand.id, internalStoreId: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!connection) {
      throw new NotFoundException('This brand has no Shopify connection.');
    }
    const disconnectedAt = new Date();
    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        encryptedAccessToken: null,
        status: 'DISCONNECTED',
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        disconnectedAt,
      },
    });
    return { brandId: brand.id, status: 'DISCONNECTED', disconnectedAt };
  }

  async syncStore(storeId: string | undefined, user: AuthenticatedUser) {
    const config = this.getConfig();
    const store = await this.ownedStore(storeId, user);
    const connection = await this.prisma.shopifyConnection.findUnique({
      where: { internalStoreId: store.id },
    });
    if (
      !connection ||
      connection.status !== 'CONNECTED' ||
      !connection.shopDomain ||
      !connection.encryptedAccessToken
    ) {
      throw new ConflictException('This internal store is not connected to Shopify.');
    }

    const accessToken = decryptToken(
      connection.encryptedAccessToken,
      config.clientSecret,
    );
    let response: Response;
    try {
      response = await fetch(
        `https://${connection.shopDomain}/admin/api/2026-04/orders.json?status=any&limit=1`,
        {
          headers: { 'X-Shopify-Access-Token': accessToken },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new BadGatewayException('Unable to reach Shopify for synchronization.');
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `Shopify synchronization failed with status ${response.status}.`,
      );
    }

    const lastSyncAt = new Date();
    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt },
    });
    return { storeId: store.id, shopDomain: connection.shopDomain, lastSyncAt };
  }

  async disconnectStore(storeId: string | undefined, user: AuthenticatedUser) {
    const store = await this.ownedStore(storeId, user);
    const connection = await this.prisma.shopifyConnection.findUnique({
      where: { internalStoreId: store.id },
      select: { id: true },
    });
    if (!connection) {
      throw new NotFoundException('This internal store has no Shopify connection.');
    }

    const disconnectedAt = new Date();
    await this.prisma.shopifyConnection.update({
      where: { id: connection.id },
      data: {
        encryptedAccessToken: null,
        status: 'DISCONNECTED',
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        disconnectedAt,
      },
    });
    return { storeId: store.id, status: 'DISCONNECTED', disconnectedAt };
  }

  private async ownedStores(user: AuthenticatedUser) {
    this.assertTanjaiAdmin(user);
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        brandId: true,
        brand: { select: { name: true } },
        shopifyConnection: {
          select: {
            status: true,
            shopDomain: true,
            scopes: true,
            connectedAt: true,
            lastSyncAt: true,
            disconnectedAt: true,
          },
        },
      },
    });
  }

  private async ownedStore(
    storeIdInput: string | undefined,
    user: AuthenticatedUser,
  ) {
    this.assertTanjaiAdmin(user);
    const storeId = (storeIdInput ?? '').trim();
    if (!storeId) throw new BadRequestException('An internal store is required.');

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, brandId: true },
    });
    if (!store) throw new NotFoundException('Internal store not found.');
    return store;
  }

  private async pendingConnectionTarget(connection: {
    brandId: string | null;
    connectedByUserId: string | null;
    internalStoreId: string | null;
  }) {
    if (!connection.connectedByUserId || !connection.brandId) {
      throw new BadRequestException(
        'The pending Shopify connection has no authenticated user or brand.',
      );
    }
    const brand = await this.prisma.brand.findUnique({
      where: { id: connection.brandId },
      select: { id: true },
    });
    if (!brand) {
      throw new BadRequestException(
        'The brand saved with this Shopify connection no longer exists.',
      );
    }
    if (connection.internalStoreId) {
      const store = await this.prisma.store.findUnique({
        where: { id: connection.internalStoreId },
        select: { brandId: true },
      });
      if (!store || store.brandId !== brand.id) {
        throw new BadRequestException(
          'The internal store saved with this Shopify connection is invalid.',
        );
      }
    }
    return { brandId: brand.id };
  }

  private async ownedBrand(
    user: AuthenticatedUser,
  ): Promise<{ id: string; name: string }> {
    this.assertTanjaiAdmin(user);
    const stores = await this.prisma.store.findMany({
      select: { brand: { select: { id: true, name: true } } },
    });
    const brands = new Map<string, { id: string; name: string }>(
      stores.map((store: { brand: { id: string; name: string } }) => [
        store.brand.id,
        store.brand,
      ]),
    );
    if (brands.size !== 1) {
      throw new ForbiddenException(
        'A brand-level Shopify connection requires exactly one brand.',
      );
    }
    return [...brands.values()][0];
  }

  private assertTanjaiAdmin(user: AuthenticatedUser) {
    if (user.role !== 'TANJAI_ADMIN') {
      throw new ForbiddenException(
        'Only TanjAI Admin accounts can manage Shopify connections.',
      );
    }
  }

  private isConfigured() {
    return Boolean(
      process.env.SHOPIFY_CLIENT_ID?.trim() &&
        process.env.SHOPIFY_CLIENT_SECRET?.trim() &&
        process.env.SHOPIFY_SCOPES?.trim() &&
        process.env.SHOPIFY_APP_URL?.trim() &&
        process.env.SHOPIFY_REDIRECT_URI?.trim(),
    );
  }

  private getConfig(): ShopifyConfig {
    const config = {
      clientId: process.env.SHOPIFY_CLIENT_ID?.trim() ?? '',
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? '',
      scopes: process.env.SHOPIFY_SCOPES?.trim() ?? '',
      appUrl: process.env.SHOPIFY_APP_URL?.trim().replace(/\/$/, '') ?? '',
      redirectUri: process.env.SHOPIFY_REDIRECT_URI?.trim() ?? '',
      installUrl:
        process.env.SHOPIFY_INSTALL_URL?.trim() ||
        'https://dev.shopify.com/dashboard',
    };
    const missing = Object.entries(config)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new ServiceUnavailableException(
        `Shopify OAuth is not configured. Missing: ${missing.join(', ')}.`,
      );
    }
    return config;
  }
}

function authenticatedPrincipalId(user: AuthenticatedUser) {
  return user.id ?? `email:${user.email.toLowerCase()}`;
}

function normalizeShopDomain(value: string | undefined) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw new BadRequestException(
      'Enter a valid Shopify domain such as store-name.myshopify.com.',
    );
  }
  return normalized;
}

function hashState(state: string) {
  return createHash('sha256').update(state).digest('hex');
}

function assertFreshShopifyTimestamp(value: string | null) {
  const timestamp = Number(value);
  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(timestamp) ||
    timestamp <= 0 ||
    Math.abs(nowInSeconds - timestamp) > 5 * 60
  ) {
    throw new BadRequestException(
      'Shopify installation timestamp is missing or expired.',
    );
  }
}

function safeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function encryptionKey(secret: string) {
  return createHash('sha256').update(secret).digest();
}

function encryptToken(token: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, encrypted]
    .map((value) => (typeof value === 'string' ? value : value.toString('base64url')))
    .join('.');
}

function decryptToken(value: string, secret: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new ServiceUnavailableException(
      'The stored Shopify token cannot be decrypted. Reconnect this store.',
    );
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ServiceUnavailableException(
      'The stored Shopify token cannot be decrypted. Reconnect this store.',
    );
  }
}

function verifyShopifyHmac(params: URLSearchParams, secret: string) {
  const providedHmac = params.get('hmac')?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(providedHmac)) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const expectedHmac = createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  return timingSafeEqual(
    Buffer.from(providedHmac, 'hex'),
    Buffer.from(expectedHmac, 'hex'),
  );
}
