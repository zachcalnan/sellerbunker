import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClerkService } from '../clerk/clerk.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(
    private readonly clerkService: ClerkService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();
    const authHeader = req.headers['authorization'] as string | undefined;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    const verified = await this.clerkService.verifyToken(token);
    const devImpersonateHeaderRaw =
      (req.headers['x-impersonate-clerk-id'] as string | undefined) ??
      (req.headers['x-impersonate-user-id'] as string | undefined);
    const devImpersonateHeader = devImpersonateHeaderRaw?.trim();
    const devImpersonateQuery =
      typeof req.query?.impersonate === 'string' ? req.query.impersonate.trim() : undefined;
    const devImpersonate = devImpersonateHeader || devImpersonateQuery;
    // Many local Nest runs don't set NODE_ENV. Treat anything except explicit production as dev.
    const isDev = process.env.NODE_ENV !== 'production';
    const clerkUserId =
      isDev && devImpersonate ? devImpersonate : verified.clerkUserId;
    const tokenEmail = verified.email;

    if (isDev && devImpersonate) {
      // eslint-disable-next-line no-console
      console.log('[DEV] impersonation header active', {
        url: req.url,
        tokenSub: verified.clerkUserId,
        impersonateSub: devImpersonate,
        source: devImpersonateHeader ? 'header' : 'query',
      });
    }

    let user = await this.usersService.findByClerkId(clerkUserId);
    if (!user) {
      // In dev impersonation we expect the user to already exist in DB; do not create phantom users.
      if (isDev && devImpersonate) {
        throw new UnauthorizedException(
          `Impersonated Clerk user (${clerkUserId}) not found in DB`,
        );
      }
      user = await this.usersService.createFromClerk({
        clerkId: clerkUserId,
        email: tokenEmail,
      });
    }

    const activeOrgId = await this.usersService.ensureActiveOrg(
      user.id,
      user.email,
    );

    const headerOrgIdRaw =
      (req.headers['x-org-id'] as string | undefined) ??
      (req.headers['x-organization-id'] as string | undefined);
    const headerOrgId = headerOrgIdRaw?.trim();

    let orgId = activeOrgId;
    if (headerOrgId) {
      const ok = await this.usersService.isOrgMember(user.id, headerOrgId);
      if (!ok) {
        throw new UnauthorizedException('Not a member of requested org');
      }
      orgId = headerOrgId;
    }

    const marketplaceIdRaw = req.headers['x-marketplace-id'] as string | undefined;
    const marketplaceId = marketplaceIdRaw?.trim() || undefined;
    req.user = {
      userId: user.id,
      email: user.email,
      orgId,
      clerkId: user.clerkId ?? undefined,
      marketplaceId,
    };
    return true;
  }
}
