import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from './auth/supabase-auth.guard';
import { PrismaService } from './prisma.service';

const allowedProofTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const maxProofBytes = 5 * 1024 * 1024;

@Injectable()
export class DepositRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    input: {
      date?: string;
      amount?: number;
      proof?: { fileName?: string; mimeType?: string; base64?: string };
    },
    user: AuthenticatedUser,
  ) {
    if (user.role !== 'BRAND_OWNER') {
      throw new ForbiddenException(
        'Only a Brand Owner can submit a deposit request.',
      );
    }

    const transactionDate = this.parseDate(input.date);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      throw new BadRequestException('Enter a valid deposit amount.');
    }

    const proofFileName = this.proofFileName(input.proof?.fileName);
    const proofMimeType = input.proof?.mimeType?.trim().toLowerCase() ?? '';
    if (!allowedProofTypes.has(proofMimeType)) {
      throw new BadRequestException(
        'The proof must be a PDF, JPG, PNG, or WEBP file.',
      );
    }
    const base64 = (input.proof?.base64 ?? '')
      .replace(/^data:[^;]+;base64,/i, '')
      .replace(/\s+/g, '');
    if (!base64 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
      throw new BadRequestException('A valid deposit proof is required.');
    }
    const proofData = Buffer.from(base64, 'base64');
    if (proofData.length === 0 || proofData.length > maxProofBytes) {
      throw new BadRequestException(
        'The deposit proof must be no larger than 5 MB.',
      );
    }
    if (!this.proofMatchesMimeType(proofData, proofMimeType)) {
      throw new BadRequestException(
        'The proof file content does not match its file type.',
      );
    }

    const request = await this.prisma.depositRequest.create({
      data: {
        requestedByUserId: user.id,
        requestedByEmail: user.email.toLowerCase(),
        transactionDate,
        amount,
        proofFileName,
        proofMimeType,
        proofData,
      },
    });
    return this.response(request);
  }

  async list(user: AuthenticatedUser, requestedStatus?: string) {
    if (!['TANJAI_ADMIN', 'BRAND_OWNER'].includes(user.role)) {
      throw new ForbiddenException(
        'Your role cannot access deposit requests.',
      );
    }

    const status = requestedStatus?.trim().toUpperCase();
    if (status && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Select a valid deposit request status.');
    }
    const requests = await this.prisma.depositRequest.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(user.role === 'BRAND_OWNER'
          ? {
              OR: [
                ...(user.id ? [{ requestedByUserId: user.id }] : []),
                { requestedByEmail: user.email.toLowerCase() },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
    });
    return requests.map((request) => this.response(request));
  }

  async review(
    id: string,
    input: { decision?: string; reason?: string },
    admin: AuthenticatedUser,
  ) {
    if (admin.role !== 'TANJAI_ADMIN') {
      throw new ForbiddenException(
        'Only a TanjAI administrator can review deposits.',
      );
    }
    const decision = input.decision?.trim().toUpperCase() ?? '';
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw new BadRequestException('Choose Approve or Reject.');
    }
    const reason = input.reason?.trim().replace(/\s+/g, ' ') ?? '';
    if (decision === 'REJECTED' && reason.length < 3) {
      throw new BadRequestException('Enter a rejection reason.');
    }

    const updated = await this.prisma.depositRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: decision,
        reviewedByUserId: admin.id,
        reviewedByEmail: admin.email.toLowerCase(),
        reviewedAt: new Date(),
        rejectionReason: decision === 'REJECTED' ? reason : null,
      },
    });
    if (updated.count === 0) {
      const existing = await this.prisma.depositRequest.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!existing) throw new NotFoundException('Deposit request not found.');
      throw new ConflictException(
        `This deposit request is already ${existing.status.toLowerCase()}.`,
      );
    }

    const request = await this.prisma.depositRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Deposit request not found.');
    return this.response(request);
  }

  async proof(id: string, user: AuthenticatedUser) {
    const request = await this.prisma.depositRequest.findUnique({
      where: { id },
      select: {
        requestedByUserId: true,
        requestedByEmail: true,
        proofFileName: true,
        proofMimeType: true,
        proofData: true,
      },
    });
    if (!request) throw new NotFoundException('Deposit proof not found.');

    const ownsRequest =
      user.role === 'BRAND_OWNER' &&
      ((user.id && user.id === request.requestedByUserId) ||
        user.email.toLowerCase() === request.requestedByEmail.toLowerCase());
    if (user.role !== 'TANJAI_ADMIN' && !ownsRequest) {
      throw new ForbiddenException('You cannot access this deposit proof.');
    }

    return {
      fileName: request.proofFileName,
      mimeType: request.proofMimeType,
      data: Buffer.from(request.proofData),
    };
  }

  private parseDate(value: string | undefined) {
    const dateText = value?.trim() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      throw new BadRequestException('Enter a valid deposit date.');
    }
    const date = new Date(`${dateText}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
      throw new BadRequestException('Enter a valid deposit date.');
    }
    return date;
  }

  private proofFileName(value: string | undefined) {
    const fileName = (value ?? '')
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .slice(0, 180);
    if (!fileName) throw new BadRequestException('Deposit proof is required.');
    return fileName;
  }

  private proofMatchesMimeType(data: Buffer, mimeType: string) {
    if (mimeType === 'application/pdf') {
      return data.subarray(0, 5).toString('ascii') === '%PDF-';
    }
    if (mimeType === 'image/jpeg') {
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    }
    if (mimeType === 'image/png') {
      return data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    if (mimeType === 'image/webp') {
      return (
        data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    }
    return false;
  }

  private response(request: {
    id: string;
    requestedByEmail: string;
    transactionDate: Date;
    amount: number;
    proofFileName: string;
    proofMimeType: string;
    status: string;
    reviewedByEmail: string | null;
    reviewedAt: Date | null;
    rejectionReason: string | null;
    createdAt: Date;
  }) {
    return {
      id: request.id,
      requestedByEmail: request.requestedByEmail,
      transactionDate: request.transactionDate,
      amount: request.amount,
      proofFileName: request.proofFileName,
      proofMimeType: request.proofMimeType,
      proofAvailable: true,
      status: request.status,
      reviewedByEmail: request.reviewedByEmail,
      reviewedAt: request.reviewedAt,
      rejectionReason: request.rejectionReason,
      createdAt: request.createdAt,
    };
  }
}
