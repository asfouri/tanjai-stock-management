import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const rawAuthHeader = request.headers.authorization ?? '';
    const authHeader = Array.isArray(rawAuthHeader)
      ? rawAuthHeader[0]
      : rawAuthHeader;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      throw new UnauthorizedException('Missing authorization token.');
    }

    if (isValidLocalDevToken(token)) {
      return true;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new UnauthorizedException('Auth service is not configured.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    return true;
  }
}

function isValidLocalDevToken(token: string) {
  if (!token.startsWith('local-dev:')) return false;

  const email = token.slice('local-dev:'.length).trim().toLowerCase();
  return [
    process.env.TANJAI_ADMIN_EMAIL,
    process.env.BRAND_OWNER_EMAIL,
    process.env.UFULFILL_EMAIL,
  ].some((candidate) => candidate?.toLowerCase() === email);
}
