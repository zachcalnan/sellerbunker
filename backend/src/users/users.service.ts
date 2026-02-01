import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async createUser(params: {
    email: string;
    passwordHash: string;
    name?: string;
  }): Promise<User> {
    const { email, passwordHash, name } = params;
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });
  }

  async findByClerkId(clerkId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { clerkId: clerkId },
    });
  }

  async createFromClerk(params: {
    clerkId: string;
    email?: string;
  }): Promise<User> {
    const { clerkId, email } = params;
    // Fallback email if Clerk token doesn't include one yet.
    // This keeps the schema happy (email is required & unique) while
    // still keying identity off clerkId.
    const emailToUse =
      email && email.length > 0 ? email : `${clerkId}@placeholder.local`;

    return this.prisma.user.create({
      data: {
        clerkId: clerkId,
        email: emailToUse,
        passwordHash: '',
      },
    });
  }

  /**
   * Ensure the user has an active org and membership. Creates a personal org
   * on first use. Returns the active org id.
   */
  async ensureActiveOrg(userId: string, email: string): Promise<string> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, activeOrgId: true, email: true },
    })) as any;

    if (user?.activeOrgId) {
      // Ensure membership exists (defensive)
      await (this.prisma as any).organizationMembership.upsert({
        where: {
          orgId_userId: {
            orgId: user.activeOrgId,
            userId,
          },
        },
        update: {},
        create: {
          orgId: user.activeOrgId,
          userId,
          role: 'owner',
        },
      });
      return user.activeOrgId as string;
    }

    const baseName = email?.includes('@') ? email.split('@')[0] : 'Personal';
    const orgName = `${baseName} org`;

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await (tx as any).organization.create({
        data: {
          name: orgName,
        },
        select: { id: true },
      });

      await (tx as any).organizationMembership.create({
        data: {
          orgId: org.id,
          userId,
          role: 'owner',
        },
      });

      await (tx.user as any).update({
        where: { id: userId },
        data: { activeOrgId: org.id },
      });

      return org.id as string;
    });

    return result;
  }

  async isOrgMember(userId: string, orgId: string): Promise<boolean> {
    const row = await (this.prisma as any).organizationMembership.findUnique({
      where: {
        orgId_userId: { orgId, userId },
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  async isOrgOwner(userId: string, orgId: string): Promise<boolean> {
    const row = await (this.prisma as any).organizationMembership.findUnique({
      where: {
        orgId_userId: { orgId, userId },
      },
      select: { role: true },
    });
    return row?.role === 'owner';
  }

  async getOrgMemberUserIds(orgId: string): Promise<string[]> {
    const rows = await (this.prisma as any).organizationMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    return (rows ?? []).map((r: any) => r.userId);
  }

  async listOrgsForUser(userId: string) {
    const memberships = await (
      this.prisma as any
    ).organizationMembership.findMany({
      where: { userId },
      select: {
        role: true,
        org: {
          select: { id: true, name: true, createdAt: true, updatedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeOrgId: true },
    })) as any;

    return {
      activeOrgId: user?.activeOrgId ?? null,
      orgs: memberships.map((m: any) => ({ ...m.org, role: m.role })),
    };
  }

  async setActiveOrg(userId: string, orgId: string) {
    const ok = await this.isOrgMember(userId, orgId);
    if (!ok) {
      throw new NotFoundException('Not a member of this org');
    }
    const updated = await (this.prisma.user as any).update({
      where: { id: userId },
      data: { activeOrgId: orgId },
      select: { activeOrgId: true },
    });
    return { activeOrgId: updated.activeOrgId as string };
  }

  async addMemberToOrg(
    orgId: string,
    memberUserId: string,
    role: 'owner' | 'member' = 'member',
  ) {
    return (this.prisma as any).organizationMembership.upsert({
      where: { orgId_userId: { orgId, userId: memberUserId } },
      update: { role },
      create: { orgId, userId: memberUserId, role },
    });
  }
}
