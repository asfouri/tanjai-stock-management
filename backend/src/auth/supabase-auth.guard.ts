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
      .getRequest<AuthenticatedRequest>();
    const rawAuthHeader = request.headers.authorization ?? '';
    const authHeader = Array.isArray(rawAuthHeader)
      ? rawAuthHeader[0]
      : rawAuthHeader;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      throw new UnauthorizedException('Missing authorization token.');
    }

    const localUser = await getLocalDevUser(token);
    if (localUser) {
      request.authUser = localUser;
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

    request.authUser = {
      id: data.user.id,
      email: data.user.email ?? '',
      role: getSupabaseUserRole(data.user.email, data.user.app_metadata),
      storeIds: getSupabaseStoreIds(data.user.app_metadata),
    };

    return true;
  }
}

export type AuthenticatedUser = {
  id?: string;
  email: string;
  role: string;
  storeIds: string[];
};

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  authUser?: AuthenticatedUser;
};

async function getLocalDevUser(
  token: string,
): Promise<AuthenticatedUser | null> {
  if (!token.startsWith('local-dev:')) return null;

  const email = token.slice('local-dev:'.length).trim().toLowerCase();
  const candidates = [
    { email: process.env.TANJAI_ADMIN_EMAIL, role: 'TANJAI_ADMIN' },
    { email: process.env.BRAND_OWNER_EMAIL, role: 'BRAND_OWNER' },
    { email: process.env.UFULFILL_EMAIL, role: 'UFULFILL' },
  ];
  const match = candidates.find(
    (candidate) => candidate.email?.toLowerCase() === email,
  );

  if (!match?.email) return null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseServiceKey) {
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    const supabaseUser = data.users.find(
      (user) => user.email?.toLowerCase() === email,
    );
    if (supabaseUser) {
      return {
        id: supabaseUser.id,
        email: supabaseUser.email ?? match.email,
        role: getSupabaseUserRole(
          supabaseUser.email,
          supabaseUser.app_metadata,
        ),
        storeIds: getSupabaseStoreIds(supabaseUser.app_metadata),
      };
    }
  }

  return { email: match.email, role: match.role, storeIds: [] };
}

function getSupabaseStoreIds(appMetadata: Record<string, unknown>) {
  if (!Array.isArray(appMetadata.store_ids)) return [];
  return appMetadata.store_ids
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getSupabaseUserRole(
  email: string | undefined,
  appMetadata: Record<string, unknown>,
) {
  const role = typeof appMetadata.role === 'string' ? appMetadata.role : '';
  if (role) return role.toUpperCase();
  if (
    email &&
    process.env.TANJAI_ADMIN_EMAIL?.toLowerCase() === email.toLowerCase()
  ) {
    return 'TANJAI_ADMIN';
  }
  return '';
}
