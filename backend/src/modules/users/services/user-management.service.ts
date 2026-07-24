import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClient, type User } from '@supabase/supabase-js';
import type { AuthenticatedUser } from '../../auth/guards/supabase-auth.guard';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

const managedRoles = ['TANJAI_ADMIN', 'BRAND_OWNER', 'UFULFILL'] as const;

@Injectable()
export class UserManagementService {
  constructor(private readonly prisma: PrismaService) {}

  listStoreOptions() {
    return this.prisma.store.findMany({
      select: { id: true, name: true, brand: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async listUsers() {
    const supabase = this.adminClient();
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (error) {
      throw new ServiceUnavailableException(
        `Unable to list users: ${error.message}`,
      );
    }

    return data.users
      .map((user) => this.userResponse(user))
      .sort((first, second) => first.email.localeCompare(second.email));
  }

  async createUser(input: {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    storeIds?: string[];
  }) {
    const name = input.name?.trim().replace(/\s+/g, ' ') ?? '';
    const email = input.email?.trim().toLowerCase() ?? '';
    const password = input.password ?? '';
    const role = input.role?.trim().toUpperCase() ?? '';
    const requestedStoreIds = [
      ...new Set(
        (Array.isArray(input.storeIds) ? input.storeIds : [])
          .map((storeId) => String(storeId).trim())
          .filter(Boolean),
      ),
    ];

    if (!email || !email.includes('@')) {
      throw new BadRequestException('Enter a valid email address.');
    }
    if (password.length < 8) {
      throw new BadRequestException(
        'The temporary password must contain at least 8 characters.',
      );
    }
    if (!managedRoles.includes(role as (typeof managedRoles)[number])) {
      throw new BadRequestException('Select a valid user role.');
    }

    let storeIds: string[] = [];
    if (role === 'BRAND_OWNER') {
      if (requestedStoreIds.length === 0) {
        throw new BadRequestException(
          'Select at least one store for the Brand Owner.',
        );
      }
      const stores = await this.prisma.store.findMany({
        where: { id: { in: requestedStoreIds } },
        select: { id: true },
      });
      if (stores.length !== requestedStoreIds.length) {
        throw new BadRequestException('One or more selected stores are invalid.');
      }
      storeIds = stores.map((store) => store.id);
    }

    const supabase = this.adminClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role, store_ids: storeIds },
      user_metadata: { full_name: name },
    });

    if (error) {
      if (
        error.message.toLowerCase().includes('already') ||
        error.message.toLowerCase().includes('registered')
      ) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw new BadRequestException(`Unable to create user: ${error.message}`);
    }

    return this.userResponse(data.user);
  }

  async updatePassword(userId: string, password: string | undefined) {
    if (!userId) throw new BadRequestException('User ID is required.');
    if (!password || password.length < 8) {
      throw new BadRequestException(
        'The new password must contain at least 8 characters.',
      );
    }

    const { data, error } = await this.adminClient().auth.admin.updateUserById(
      userId,
      { password },
    );
    if (error || !data.user) {
      if (error?.message.toLowerCase().includes('not found')) {
        throw new NotFoundException('User was not found.');
      }
      throw new BadRequestException(
        `Unable to change password: ${error?.message ?? 'Unknown error'}`,
      );
    }

    return { id: data.user.id, passwordUpdated: true };
  }

  async updateUser(
    userId: string,
    input: {
      name?: string;
      email?: string;
      password?: string;
      role?: string;
      storeIds?: string[];
    },
  ) {
    if (!userId) throw new BadRequestException('User ID is required.');

    const name = input.name?.trim().replace(/\s+/g, ' ') ?? '';
    const email = input.email?.trim().toLowerCase() ?? '';
    const password = input.password ?? '';
    const role = input.role?.trim().toUpperCase() ?? '';
    const requestedStoreIds = [
      ...new Set(
        (Array.isArray(input.storeIds) ? input.storeIds : [])
          .map((storeId) => String(storeId).trim())
          .filter(Boolean),
      ),
    ];

    if (!email || !email.includes('@')) {
      throw new BadRequestException('Enter a valid email address.');
    }
    if (password && password.length < 8) {
      throw new BadRequestException(
        'The new password must contain at least 8 characters.',
      );
    }
    if (!managedRoles.includes(role as (typeof managedRoles)[number])) {
      throw new BadRequestException('Select a valid user role.');
    }

    let storeIds: string[] = [];
    if (role === 'BRAND_OWNER') {
      if (requestedStoreIds.length === 0) {
        throw new BadRequestException(
          'Select at least one store for the Brand Owner.',
        );
      }
      const stores = await this.prisma.store.findMany({
        where: { id: { in: requestedStoreIds } },
        select: { id: true },
      });
      if (stores.length !== requestedStoreIds.length) {
        throw new BadRequestException('One or more selected stores are invalid.');
      }
      storeIds = stores.map((store) => store.id);
    }

    const supabase = this.adminClient();
    const { data: existingData, error: existingError } =
      await supabase.auth.admin.getUserById(userId);
    const existingUser = existingData.user;
    if (existingError || !existingUser) {
      throw new NotFoundException('User was not found.');
    }

    if (
      this.userRole(existingUser) === 'TANJAI_ADMIN' &&
      role !== 'TANJAI_ADMIN'
    ) {
      const { data: usersData, error: usersError } =
        await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) {
        throw new ServiceUnavailableException(
          `Unable to verify administrators: ${usersError.message}`,
        );
      }
      const adminCount = usersData.users.filter(
        (user) => this.userRole(user) === 'TANJAI_ADMIN',
      ).length;
      if (adminCount <= 1) {
        throw new ForbiddenException(
          'The last TanjAI administrator cannot be demoted.',
        );
      }
    }

    const { data, error } = await supabase.auth.admin.updateUserById(userId, {
      email,
      email_confirm: true,
      ...(password ? { password } : {}),
      app_metadata: {
        ...existingUser.app_metadata,
        role,
        store_ids: storeIds,
      },
      user_metadata: {
        ...existingUser.user_metadata,
        full_name: name,
      },
    });

    if (error || !data.user) {
      if (
        error?.message.toLowerCase().includes('already') ||
        error?.message.toLowerCase().includes('registered')
      ) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw new BadRequestException(
        `Unable to update user: ${error?.message ?? 'Unknown error'}`,
      );
    }

    return this.userResponse(data.user);
  }

  async deleteUser(userId: string, currentUser: AuthenticatedUser) {
    if (!userId) throw new BadRequestException('User ID is required.');

    const supabase = this.adminClient();
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    const target = data.user;
    if (error || !target) throw new NotFoundException('User was not found.');

    const targetEmail = target.email?.toLowerCase() ?? '';
    if (
      currentUser.id === target.id ||
      currentUser.email.toLowerCase() === targetEmail
    ) {
      throw new ForbiddenException('You cannot remove your own account.');
    }
    if (
      targetEmail &&
      targetEmail === process.env.TANJAI_ADMIN_EMAIL?.toLowerCase()
    ) {
      throw new ForbiddenException(
        'The configured primary TanjAI admin cannot be removed.',
      );
    }

    if (this.userRole(target) === 'TANJAI_ADMIN') {
      const { data: usersData, error: usersError } =
        await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) {
        throw new ServiceUnavailableException(
          `Unable to verify administrators: ${usersError.message}`,
        );
      }
      const adminCount = usersData.users.filter(
        (user) => this.userRole(user) === 'TANJAI_ADMIN',
      ).length;
      if (adminCount <= 1) {
        throw new ForbiddenException(
          'The last TanjAI administrator cannot be removed.',
        );
      }
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
    if (deleteError) {
      throw new BadRequestException(
        `Unable to remove user: ${deleteError.message}`,
      );
    }

    return { id: userId, deleted: true };
  }

  private adminClient() {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      throw new ServiceUnavailableException(
        'Supabase user management is not configured.',
      );
    }

    return createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  private userResponse(user: User) {
    const fullName =
      typeof user.user_metadata.full_name === 'string'
        ? user.user_metadata.full_name.trim()
        : typeof user.user_metadata.name === 'string'
          ? user.user_metadata.name.trim()
          : [user.user_metadata.first_name, user.user_metadata.last_name]
              .filter((value) => typeof value === 'string' && value.trim())
              .join(' ');

    return {
      id: user.id,
      name: fullName,
      email: user.email ?? '',
      role: this.userRole(user),
      storeIds: this.userStoreIds(user),
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at ?? null,
    };
  }

  private userRole(user: User) {
    const metadataRole =
      typeof user.app_metadata.role === 'string'
        ? user.app_metadata.role.toUpperCase()
        : '';
    if (metadataRole) return metadataRole;

    const email = user.email?.toLowerCase();
    if (email === process.env.TANJAI_ADMIN_EMAIL?.toLowerCase()) {
      return 'TANJAI_ADMIN';
    }
    if (email === process.env.BRAND_OWNER_EMAIL?.toLowerCase()) {
      return 'BRAND_OWNER';
    }
    if (email === process.env.UFULFILL_EMAIL?.toLowerCase()) return 'UFULFILL';
    return '';
  }

  private userStoreIds(user: User) {
    const storeIds = user.app_metadata.store_ids;
    if (!Array.isArray(storeIds)) return [];
    return [...new Set(storeIds.map(String).map((value) => value.trim()))].filter(
      Boolean,
    );
  }
}
