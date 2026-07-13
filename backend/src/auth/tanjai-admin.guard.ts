import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './supabase-auth.guard';

@Injectable()
export class TanjaiAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    if (request.authUser?.role !== 'TANJAI_ADMIN') {
      throw new ForbiddenException(
        'Only a TanjAI administrator can perform this action.',
      );
    }

    return true;
  }
}
