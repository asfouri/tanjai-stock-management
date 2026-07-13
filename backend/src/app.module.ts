import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseAuthGuard } from './auth/supabase-auth.guard';
import { TanjaiAdminGuard } from './auth/tanjai-admin.guard';
import { ExcelImportService } from './import/excel-import.service';
import { PrismaService } from './prisma.service';
import { UserManagementService } from './user-management.service';
import { DepositRequestService } from './deposit-request.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    ExcelImportService,
    PrismaService,
    SupabaseAuthGuard,
    TanjaiAdminGuard,
    UserManagementService,
    DepositRequestService,
  ],
})
export class AppModule {}
