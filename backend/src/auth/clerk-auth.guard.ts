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

    const { clerkUserId, email } = await this.clerkService.verifyToken(token);

    let user = await this.usersService.findByClerkId(clerkUserId);
    if (!user) {
      user = await this.usersService.createFromClerk({
        clerkId: clerkUserId,
        email,
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

    req.user = { userId: user.id, email: user.email, orgId };
    return true;
  }
}
