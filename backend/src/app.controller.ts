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
  StreamableFile,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseAuthGuard } from './auth/supabase-auth.guard';
import type { AuthenticatedRequest } from './auth/supabase-auth.guard';
import { TanjaiAdminGuard } from './auth/tanjai-admin.guard';
import { ExcelImportService } from './import/excel-import.service';
import { UserManagementService } from './user-management.service';
import { DepositRequestService } from './deposit-request.service';
import type { IncomingMessage } from 'node:http';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly excelImportService: ExcelImportService,
    private readonly userManagementService: UserManagementService,
    private readonly depositRequestService: DepositRequestService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('auth/login')
  login(
    @Body('email') email: string | undefined,
    @Body('password') password: string | undefined,
  ) {
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
    return this.appService.getDashboardSummary(filters, user);
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
    return this.appService.getDashboardSection(section, filters, user);
  }

  @Get('auth/me')
  @UseGuards(SupabaseAuthGuard)
  getCurrentUser(@Req() request: AuthenticatedRequest) {
    return request.authUser;
  }

  @Get('notifications')
  @UseGuards(SupabaseAuthGuard)
  getNotifications(@Req() request: AuthenticatedRequest) {
    return this.appService.getNotifications(requireManagedUser(request));
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
    return this.appService.getDashboardProduct(id, user);
  }

  @Get('dashboard/inventory-item/:id')
  @UseGuards(SupabaseAuthGuard)
  getDashboardInventoryItem(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const user = requireManagedUser(request);
    assertSectionAccess(user.role, 'products-without-skus');
    return this.appService.getDashboardInventoryItem(id);
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
}

const sectionRoles: Record<string, readonly string[]> = {
  products: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  'products-without-skus': ['TANJAI_ADMIN', 'UFULFILL'],
  orders: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  stores: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  invoices: ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'],
  payments: ['TANJAI_ADMIN', 'BRAND_OWNER'],
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
