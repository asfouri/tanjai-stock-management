import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DashboardService } from '../../dashboard/services/dashboard.service';
import { SupabaseAuthGuard } from '../../auth/guards/supabase-auth.guard';
import { isLocalDevAuthEnabled } from '../../auth/guards/supabase-auth.guard';
import type { AuthenticatedRequest } from '../../auth/guards/supabase-auth.guard';
import { TanjaiAdminGuard } from '../../auth/guards/tanjai-admin.guard';
import { ExcelImportService } from '../../imports/services/excel-import.service';
import { UserManagementService } from '../../users/services/user-management.service';
import { DepositRequestService } from '../../payments/services/deposit-request.service';
import { ShopifyService } from '../../shopify/services/shopify.service';
import { WooCommerceService } from '../../woocommerce/services/woocommerce.service';
import { Track17Service } from '../../tracking/services/track17.service';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';

@Controller()
export class ApplicationApiController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly excelImportService: ExcelImportService,
    private readonly userManagementService: UserManagementService,
    private readonly depositRequestService: DepositRequestService,
    private readonly shopifyService: ShopifyService,
    private readonly wooCommerceService: WooCommerceService,
    private readonly track17Service: Track17Service,
  ) {}

  @Get()
  getHello(): string {
    return this.dashboardService.getHello();
  }

  @Post('auth/login')
  login(
    @Body('email') email: string | undefined,
    @Body('password') password: string | undefined,
  ) {
    if (!isLocalDevAuthEnabled()) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const user = getDevUser(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return {
      accessToken: `local-dev:${user.email}`,
      expiresIn: 24 * 60 * 60,
      user: { email: user.email, role: user.role },
    };
  }

  @Get('dashboard/summary')
  @UseGuards(SupabaseAuthGuard)
  getDashboardSummary(
    @Query() filters: Record<string, string>,
    @Req() request: AuthenticatedRequest,
  ) {
    const user = requireManagedUser(request);
    return this.dashboardService.getDashboardSummary(filters, user);
  }

  @Get('dashboard/section/:section')
  @UseGuards(SupabaseAuthGuard)
  getDashboardSection(
    @Param('section') section: string,
    @Query() filters: Record<string, string>,
    @Req() request: AuthenticatedRequest,
  ) {
    const user = requireManagedUser(request);
    assertSectionAccess(user.role, section);
    return this.dashboardService.getDashboardSection(section, filters, user);
  }

  @Get('auth/me')
  @UseGuards(SupabaseAuthGuard)
  getCurrentUser(@Req() request: AuthenticatedRequest) {
    return request.authUser;
  }

  @Get('shopify/stores')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listShopifyStoreStatuses(@Req() request: AuthenticatedRequest) {
    const user = requireTanjaiAdmin(request);
    return this.shopifyService.listStoreStatuses(user);
  }

  @Get('shopify/status')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  getShopifyStatus(@Req() request: AuthenticatedRequest) {
    return this.shopifyService.getBrandStatus(requireTanjaiAdmin(request));
  }

  @Post('shopify/install')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  async prepareBrandShopifyInstallation(
    @Req() request: ShopifyRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const pending = await this.shopifyService.prepareBrandInstallation(
      requireTanjaiAdmin(request),
    );
    setShopifyPendingCookie(response, request, pending.nonce);
    return { redirectUrl: pending.redirectUrl };
  }

  @Post('shopify/sync')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  syncBrandShopify(@Req() request: AuthenticatedRequest) {
    return this.shopifyService.syncBrand(requireTanjaiAdmin(request));
  }

  @Delete('shopify')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  disconnectBrandShopify(@Req() request: AuthenticatedRequest) {
    return this.shopifyService.disconnectBrand(requireTanjaiAdmin(request));
  }

  @Get('shopify/start')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  async startShopifyInstallation(
    @Query('storeId') storeId: string | undefined,
    @Req() request: ShopifyRequest,
    @Res() response: Response,
  ) {
    const user = requireTanjaiAdmin(request);
    const pending = await this.shopifyService.prepareInstallation(
      storeId,
      user,
    );
    setShopifyPendingCookie(response, request, pending.nonce);
    return response.redirect(302, pending.redirectUrl);
  }

  @Post('shopify/stores/:storeId/install')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  async prepareShopifyInstallation(
    @Param('storeId') storeId: string,
    @Req() request: ShopifyRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const pending = await this.shopifyService.prepareInstallation(
      storeId,
      requireTanjaiAdmin(request),
    );
    setShopifyPendingCookie(response, request, pending.nonce);
    return { redirectUrl: pending.redirectUrl };
  }

  @Get('shopify/launch')
  async launchShopifyOAuth(
    @Req() request: ShopifyRequest,
    @Res() response: Response,
  ) {
    const authorizationUrl = await this.shopifyService.continueInstallation(
      request.originalUrl ?? request.url ?? '/shopify/launch',
      readCookie(request.headers.cookie, 'tanjai_shopify_pending'),
    );
    return response.redirect(302, authorizationUrl);
  }

  @Post('shopify/stores/:storeId/sync')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  syncShopifyStore(
    @Param('storeId') storeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.shopifyService.syncStore(storeId, requireTanjaiAdmin(request));
  }

  @Delete('shopify/stores/:storeId')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  disconnectShopifyStore(
    @Param('storeId') storeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.shopifyService.disconnectStore(
      storeId,
      requireTanjaiAdmin(request),
    );
  }

  @Get('shopify/callback')
  async completeShopifyOAuth(
    @Req() request: ShopifyRequest,
    @Res() response: Response,
  ) {
    const redirectUrl = await this.shopifyService.completeOAuth(
      request.originalUrl ?? request.url ?? '/shopify/callback',
      readCookie(request.headers.cookie, 'tanjai_shopify_pending'),
    );
    response.clearCookie('tanjai_shopify_pending', { path: '/shopify' });
    return response.redirect(302, redirectUrl);
  }

  @Get('woocommerce/connections')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listWooCommerceConnections(@Req() request: AuthenticatedRequest) {
    return this.wooCommerceService.listConnections(requireTanjaiAdmin(request));
  }

  @Post('woocommerce/connect/start')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  startWooCommerceConnection(
    @Body('internalStoreId') internalStoreId: string | undefined,
    @Body('siteUrl') siteUrl: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.wooCommerceService.startConnection(
      internalStoreId,
      siteUrl,
      requireTanjaiAdmin(request),
    );
  }

  @Post('woocommerce/callback')
  receiveWooCommerceCredentials(@Body() body: Record<string, unknown>) {
    return this.wooCommerceService.credentialsCallback(body);
  }

  @Get('woocommerce/return')
  async returnFromWooCommerce(
    @Query('success') success: string | undefined,
    @Query('user_id') publicToken: string | undefined,
    @Res() response: Response,
  ) {
    const redirectUrl = await this.wooCommerceService.browserReturn(
      success,
      publicToken,
    );
    return response.redirect(302, redirectUrl);
  }

  @Post('woocommerce/stores/:storeId/sync')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  syncWooCommerceStore(
    @Param('storeId') storeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.wooCommerceService.syncStore(
      storeId,
      requireTanjaiAdmin(request),
    );
  }

  @Delete('woocommerce/stores/:storeId/connection')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  disconnectWooCommerceStore(
    @Param('storeId') storeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.wooCommerceService.disconnectStore(
      storeId,
      requireTanjaiAdmin(request),
    );
  }

  @Post('webhooks/woocommerce/:connectionPublicId')
  receiveWooCommerceWebhook(
    @Param('connectionPublicId') connectionPublicId: string,
    @Headers('x-wc-webhook-signature') signature: string | undefined,
    @Headers('x-wc-webhook-topic') topic: string | undefined,
    @Req() request: WooCommerceWebhookRequest,
  ) {
    return this.wooCommerceService.receiveWebhook(
      connectionPublicId,
      signature,
      topic,
      request.rawBody,
    );
  }

  @Get('track17/status')
  @UseGuards(SupabaseAuthGuard)
  getTrack17Status(@Req() request: AuthenticatedRequest) {
    return this.track17Service.status(requireManagedUser(request));
  }

  @Post('track17/register-pending')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  registerPendingTrack17Shipments(
    @Body('maxRecords') maxRecords: number | undefined,
  ) {
    return this.track17Service.registerPending(maxRecords);
  }

  @Post('track17/shipments/:shipmentId/register')
  @UseGuards(SupabaseAuthGuard)
  registerTrack17Shipment(
    @Param('shipmentId') shipmentId: string,
    @Body('carrierCode') carrierCode: number | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.track17Service.registerShipment(
      shipmentId,
      requireManagedUser(request),
      carrierCode,
    );
  }

  @Post('track17/shipments/:shipmentId/refresh')
  @UseGuards(SupabaseAuthGuard)
  refreshTrack17Shipment(
    @Param('shipmentId') shipmentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.track17Service.refreshShipment(
      shipmentId,
      requireManagedUser(request),
    );
  }

  @Post('webhooks/17track')
  receiveTrack17Webhook(
    @Headers('sign') signature: string | undefined,
    @Req() request: RawWebhookRequest,
  ) {
    return this.track17Service.receiveWebhook(request.rawBody, signature);
  }

  @Get('notifications')
  @UseGuards(SupabaseAuthGuard)
  getNotifications(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.getNotifications(requireManagedUser(request));
  }

  @Get('users')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listUsers() {
    return this.userManagementService.listUsers();
  }

  @Get('users/store-options')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listUserStoreOptions() {
    return this.userManagementService.listStoreOptions();
  }

  @Post('users')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  createUser(
    @Body('name') name: string | undefined,
    @Body('email') email: string | undefined,
    @Body('password') password: string | undefined,
    @Body('role') role: string | undefined,
    @Body('storeIds') storeIds: string[] | undefined,
  ) {
    return this.userManagementService.createUser({
      name,
      email,
      password,
      role,
      storeIds,
    });
  }

  @Patch('users/:id/password')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  updateUserPassword(
    @Param('id') userId: string,
    @Body('password') password: string | undefined,
  ) {
    return this.userManagementService.updatePassword(userId, password);
  }

  @Patch('users/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  updateUser(
    @Param('id') userId: string,
    @Body('name') name: string | undefined,
    @Body('email') email: string | undefined,
    @Body('password') password: string | undefined,
    @Body('role') role: string | undefined,
    @Body('storeIds') storeIds: string[] | undefined,
  ) {
    return this.userManagementService.updateUser(userId, {
      name,
      email,
      password,
      role,
      storeIds,
    });
  }

  @Delete('users/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  deleteUser(
    @Param('id') userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.userManagementService.deleteUser(
      userId,
      request.authUser as NonNullable<AuthenticatedRequest['authUser']>,
    );
  }

  @Get('dashboard/product/:id')
  @UseGuards(SupabaseAuthGuard)
  getDashboardProduct(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const user = requireManagedUser(request);
    assertSectionAccess(user.role, 'products');
    return this.dashboardService.getDashboardProduct(id, user);
  }

  @Get('products/:id/picture')
  @UseGuards(SupabaseAuthGuard)
  async getProductPicture(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = requireManagedUser(request);
    assertSectionAccess(user.role, 'products');
    const picture = await this.dashboardService.getProductPicture(id, user);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(picture.data, { type: picture.mimeType });
  }

  @Post('products')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  @UseInterceptors(
    FileInterceptor('picture', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  createProduct(
    @Body()
    input: {
      name?: string;
      groupId?: string;
      sku?: string;
      storeId?: string;
      quantity?: number | string;
      unitPrice?: number | string;
      weight?: number | string;
      freightFR?: number | string;
      freightDE?: number | string;
      freightGB?: number | string;
      freightUSA?: number | string;
      serviceFee?: number | string;
      sellingPrice?: number | string;
      deliveryTime?: string;
      skuAssignments?: string;
      quotationRows?: string;
    },
    @UploadedFile()
    picture?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    return this.dashboardService.createProduct(input, picture);
  }

  @Patch('products/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  @UseInterceptors(
    FileInterceptor('picture', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  updateProduct(
    @Param('id') id: string,
    @Body()
    input: {
      name?: string;
      groupId?: string;
      quantity?: number | string;
      unitPrice?: number | string;
      weight?: number | string;
      freightFR?: number | string;
      freightDE?: number | string;
      freightGB?: number | string;
      freightUSA?: number | string;
      serviceFee?: number | string;
      sellingPrice?: number | string;
      deliveryTime?: string;
      skuAssignments?: string;
      quotationRows?: string;
    },
    @UploadedFile()
    picture?: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
  ) {
    return this.dashboardService.updateProduct(id, input, picture);
  }

  @Delete('products/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  deleteProduct(@Param('id') id: string) {
    return this.dashboardService.deleteProduct(id);
  }

  @Get('product-groups')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listProductGroups() {
    return this.dashboardService.listProductGroups();
  }

  @Post('product-groups')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  createProductGroup(@Body() input: { name?: string }) {
    return this.dashboardService.createProductGroup(input);
  }

  @Post('stores')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  createStore(
    @Body()
    input: {
      name?: string;
      brandName?: string;
      country?: string;
      platform?: string;
    },
  ) {
    return this.dashboardService.createStore(input);
  }

  @Patch('stores/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  updateStore(
    @Param('id') id: string,
    @Body()
    input: {
      name?: string;
      brandName?: string;
      country?: string;
      platform?: string;
    },
  ) {
    return this.dashboardService.updateStore(id, input);
  }

  @Delete('stores/:id')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  deleteStore(@Param('id') id: string) {
    return this.dashboardService.deleteStore(id);
  }

  @Get('dashboard/inventory-item/:id')
  @UseGuards(SupabaseAuthGuard)
  getDashboardInventoryItem(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const user = requireManagedUser(request);
    assertSectionAccess(user.role, 'products-without-skus');
    return this.dashboardService.getDashboardInventoryItem(id);
  }

  @Post('deposit-requests')
  @UseGuards(SupabaseAuthGuard)
  createDepositRequest(
    @Body('date') date: string | undefined,
    @Body('amount') amount: number | undefined,
    @Body('proof') proof:
      | { fileName?: string; mimeType?: string; base64?: string }
      | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.depositRequestService.create(
      { date, amount, proof },
      requireManagedUser(request),
    );
  }

  @Get('deposit-requests')
  @UseGuards(SupabaseAuthGuard)
  listDepositRequests(
    @Query('status') status: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.depositRequestService.list(requireManagedUser(request), status);
  }

  @Patch('deposit-requests/:id/review')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  reviewDepositRequest(
    @Param('id') id: string,
    @Body('decision') decision: string | undefined,
    @Body('reason') reason: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.depositRequestService.review(
      id,
      { decision, reason },
      requireManagedUser(request),
    );
  }

  @Get('deposit-requests/:id/proof')
  @UseGuards(SupabaseAuthGuard)
  async getDepositProof(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const proof = await this.depositRequestService.proof(
      id,
      requireManagedUser(request),
    );
    const encodedName = encodeURIComponent(proof.fileName);
    return new StreamableFile(proof.data, {
      type: proof.mimeType,
      disposition: `inline; filename*=UTF-8''${encodedName}`,
    });
  }

  @Post('imports/excel/preview')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  async previewExcelImport(
    @Req() request: IncomingMessage,
    @Headers('x-file-name') fileName = '',
  ) {
    const originalname = decodeURIComponent(fileName || 'import.xlsx');
    const buffer = await readRequestBuffer(request, 75 * 1024 * 1024);

    return this.excelImportService.preview({
      originalname,
      buffer,
      size: buffer.length,
    });
  }

  @Post('imports/excel/preview-local')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  previewLocalExcelImport(@Body('fileName') fileName: string) {
    return this.excelImportService.previewLocalFile(fileName);
  }

  @Post('imports/excel/confirm')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  confirmExcelImport(@Body('token') token: string) {
    return this.excelImportService.confirm(token);
  }

  @Get('imports/excel/history')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  listExcelImports() {
    return this.excelImportService.listImportBatches();
  }

  @Post('imports/excel/remove')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  removeExcelImport(@Body('importBatchId') importBatchId: string) {
    return this.excelImportService.removeImportBatch(importBatchId);
  }

  @Post('imports/excel/replace')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  replaceExcelImport(
    @Body('importBatchId') importBatchId: string,
    @Body('token') token: string,
  ) {
    return this.excelImportService.replaceImportBatch(importBatchId, token);
  }

  @Post('imports/excel/refresh')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  refreshExcelImport(@Body('importBatchId') importBatchId: string) {
    return this.excelImportService.startRefreshImportBatch(importBatchId);
  }

  @Get('imports/excel/refresh/:importBatchId')
  @UseGuards(SupabaseAuthGuard, TanjaiAdminGuard)
  refreshExcelImportStatus(@Param('importBatchId') importBatchId: string) {
    return this.excelImportService.getRefreshImportBatchStatus(importBatchId);
  }
}

type ShopifyRequest = IncomingMessage &
  AuthenticatedRequest & { originalUrl?: string };

type WooCommerceWebhookRequest = IncomingMessage & { rawBody?: Buffer };
type RawWebhookRequest = IncomingMessage & { rawBody?: Buffer };

function readCookie(
  rawCookie: string | string[] | undefined,
  name: string,
) {
  const cookieHeader = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const encodedValue = cookieHeader
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return encodedValue ? decodeURIComponent(encodedValue) : undefined;
}

function setShopifyPendingCookie(
  response: Response,
  request: ShopifyRequest,
  nonce: string,
) {
  response.cookie('tanjai_shopify_pending', nonce, {
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    path: '/shopify',
    sameSite: 'lax',
    secure: request.headers['x-forwarded-proto'] === 'https',
  });
}

const sectionRoles: Record<string, readonly string[]> = {
  products: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  'products-without-skus': ['TANJAI_ADMIN', 'UFULFILL'],
  orders: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  stores: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  invoices: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  payments: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
};

function requireManagedUser(request: AuthenticatedRequest) {
  const user = request.authUser;
  if (
    !user ||
    !['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'].includes(user.role)
  ) {
    throw new ForbiddenException('This account does not have an assigned role.');
  }
  return user;
}

function requireTanjaiAdmin(request: AuthenticatedRequest) {
  const user = requireManagedUser(request);
  if (user.role !== 'TANJAI_ADMIN') {
    throw new ForbiddenException(
      'Only TanjAI Admin accounts can manage store integrations.',
    );
  }
  return user;
}

function assertSectionAccess(role: string, section: string) {
  if (!sectionRoles[section]?.includes(role)) {
    throw new ForbiddenException(
      'Your role does not have access to this section.',
    );
  }
}

function getDevUser(email: string | undefined, password: string | undefined) {
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const candidates = [
    {
      email: process.env.TANJAI_ADMIN_EMAIL,
      password: process.env.TANJAI_ADMIN_PASSWORD,
      role: 'TANJAI_ADMIN',
    },
    {
      email: process.env.BRAND_OWNER_EMAIL,
      password: process.env.BRAND_OWNER_PASSWORD,
      role: 'BRAND_OWNER',
    },
    {
      email: process.env.UFULFILL_EMAIL,
      password: process.env.UFULFILL_PASSWORD,
      role: 'UFULFILL',
    },
  ];

  return candidates.find(
    (candidate) =>
      candidate.email?.toLowerCase() === normalizedEmail &&
      candidate.password &&
      candidate.password === password,
  );
}

function readRequestBuffer(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BadRequestException('Excel file is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (total === 0) {
        reject(new BadRequestException('Excel file body is required.'));
        return;
      }
      resolve(Buffer.concat(chunks, total));
    });

    request.on('error', (error) => reject(error));
  });
}
