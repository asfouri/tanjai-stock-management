import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseAuthGuard } from './auth/supabase-auth.guard';
import { ExcelImportService } from './import/excel-import.service';
import type { IncomingMessage } from 'node:http';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly excelImportService: ExcelImportService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('dashboard/summary')
  @UseGuards(SupabaseAuthGuard)
  getDashboardSummary(@Query() filters: Record<string, string>) {
    return this.appService.getDashboardSummary(filters);
  }

  @Get('dashboard/section/:section')
  @UseGuards(SupabaseAuthGuard)
  getDashboardSection(
    @Param('section') section: string,
    @Query() filters: Record<string, string>,
  ) {
    return this.appService.getDashboardSection(section, filters);
  }

  @Post('imports/excel/preview')
  @UseGuards(SupabaseAuthGuard)
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
  @UseGuards(SupabaseAuthGuard)
  previewLocalExcelImport(@Body('fileName') fileName: string) {
    return this.excelImportService.previewLocalFile(fileName);
  }

  @Post('imports/excel/confirm')
  @UseGuards(SupabaseAuthGuard)
  confirmExcelImport(@Body('token') token: string) {
    return this.excelImportService.confirm(token);
  }

  @Get('imports/excel/history')
  @UseGuards(SupabaseAuthGuard)
  listExcelImports() {
    return this.excelImportService.listImportBatches();
  }

  @Post('imports/excel/remove')
  @UseGuards(SupabaseAuthGuard)
  removeExcelImport(@Body('importBatchId') importBatchId: string) {
    return this.excelImportService.removeImportBatch(importBatchId);
  }

  @Post('imports/excel/replace')
  @UseGuards(SupabaseAuthGuard)
  replaceExcelImport(
    @Body('importBatchId') importBatchId: string,
    @Body('token') token: string,
  ) {
    return this.excelImportService.replaceImportBatch(importBatchId, token);
  }
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
