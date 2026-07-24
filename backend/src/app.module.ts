import { Module } from '@nestjs/common';
import { PrismaService } from './infrastructure/database/prisma.service';
import { SupabaseAuthGuard } from './modules/auth/guards/supabase-auth.guard';
import { TanjaiAdminGuard } from './modules/auth/guards/tanjai-admin.guard';
import { DashboardService } from './modules/dashboard/services/dashboard.service';
import { ExcelImportService } from './modules/imports/services/excel-import.service';
import { DepositRequestService } from './modules/payments/services/deposit-request.service';
import { ApplicationApiController } from './modules/platform/controllers/application-api.controller';
import { ShopifyService } from './modules/shopify/services/shopify.service';
import { Track17Service } from './modules/tracking/services/track17.service';
import { UserManagementService } from './modules/users/services/user-management.service';
import { WooCommerceService } from './modules/woocommerce/services/woocommerce.service';

@Module({
  controllers: [ApplicationApiController],
  providers: [
    DashboardService,
    ExcelImportService,
    PrismaService,
    SupabaseAuthGuard,
    TanjaiAdminGuard,
    UserManagementService,
    DepositRequestService,
    ShopifyService,
    WooCommerceService,
    Track17Service,
  ],
})
export class AppModule {}
