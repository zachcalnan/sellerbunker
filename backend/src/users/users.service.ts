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
    if (!clerkId || typeof clerkId !== 'string') {
      throw new Error('createFromClerk requires a non-empty clerkId');
    }
    // Fallback email if Clerk token doesn't include one yet.
    const emailToUse =
      email && email.length > 0 ? email : `${clerkId}@placeholder.local`;

    // 1) Already have a user with this clerkId -> return them
    const byClerk = await this.prisma.user.findUnique({
      where: { clerkId },
    });
    if (byClerk) return byClerk;

    // 2) A user with this email already exists (e.g. from earlier sign-up) -> link clerkId and return
    const byEmail = await this.prisma.user.findUnique({
      where: { email: emailToUse },
    });
    if (byEmail) {
      const updated = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { clerkId },
      });
      return updated;
    }

    // 3) New user -> create
    return this.prisma.user.create({
      data: {
        clerkId,
        email: emailToUse,
        passwordHash: '',
      },
    });
  }

  /**
   * Ensure the user has an active org and membership. Creates a personal org
   * on first use. Returns the active org id.
   * If the user's activeOrgId points to a deleted org, we clear it and create a new org.
   */
  async ensureActiveOrg(userId: string, email: string): Promise<string> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, activeOrgId: true, email: true },
    })) as any;

    if (user?.activeOrgId) {
      const orgExists = await (this.prisma as any).organization.findUnique({
        where: { id: user.activeOrgId },
        select: { id: true },
      });
      if (orgExists) {
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
      // Org was deleted (e.g. manual DB delete); clear stale reference so we create a new org below
      await (this.prisma.user as any).update({
        where: { id: userId },
        data: { activeOrgId: null },
      });
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

  /**
   * Get VAT settings for an org (caller must be a member).
   */
  async getOrgVatSettings(orgId: string, userId: string) {
    const isMember = await this.isOrgMember(userId, orgId);
    if (!isMember) throw new NotFoundException('Not a member of this org');
    const org = await (this.prisma as any).organization.findUnique({
      where: { id: orgId },
      select: {
        vatRegistrationType: true,
        vatEffectiveDate: true,
        vatFlatRatePct: true,
        vatRatePct: true,
        vatCostsIncludeVat: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return {
      vatRegistrationType: org.vatRegistrationType ?? null,
      vatEffectiveDate: org.vatEffectiveDate?.toISOString?.() ?? null,
      vatFlatRatePct: org.vatFlatRatePct != null ? Number(org.vatFlatRatePct) : null,
      vatRatePct: org.vatRatePct != null ? Number(org.vatRatePct) : null,
      vatCostsIncludeVat: org.vatCostsIncludeVat ?? null,
    };
  }

  /**
   * Update VAT settings for an org (caller must be a member).
   */
  async updateOrgVatSettings(
    orgId: string,
    userId: string,
    data: {
      vatRegistrationType?: string;
      vatEffectiveDate?: string;
      vatFlatRatePct?: number;
      vatRatePct?: number;
      vatCostsIncludeVat?: boolean;
    },
  ) {
    const isMember = await this.isOrgMember(userId, orgId);
    if (!isMember) throw new NotFoundException('Not a member of this org');
    const payload: Record<string, unknown> = {};
    if (data.vatRegistrationType !== undefined)
      payload.vatRegistrationType = data.vatRegistrationType;
    if (data.vatEffectiveDate !== undefined)
      payload.vatEffectiveDate = data.vatEffectiveDate ? new Date(data.vatEffectiveDate) : null;
    if (data.vatFlatRatePct !== undefined) payload.vatFlatRatePct = data.vatFlatRatePct;
    if (data.vatRatePct !== undefined) payload.vatRatePct = data.vatRatePct;
    if (data.vatCostsIncludeVat !== undefined) payload.vatCostsIncludeVat = data.vatCostsIncludeVat;
    await (this.prisma as any).organization.update({
      where: { id: orgId },
      data: payload,
    });
    return this.getOrgVatSettings(orgId, userId);
  }

  /**
   * Get fixed costs for an org (caller must be a member).
   */
  async getOrgFixedCosts(orgId: string, userId: string) {
    const isMember = await this.isOrgMember(userId, orgId);
    if (!isMember) throw new NotFoundException('Not a member of this org');
    const org = await (this.prisma as any).organization.findUnique({
      where: { id: orgId },
      select: {
        fixedCostsSoftware: true,
        fixedCostsOtherSubs: true,
        fixedCostsOther: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return {
      softwareCosts: org.fixedCostsSoftware != null ? Number(org.fixedCostsSoftware) : null,
      otherSubscriptions: org.fixedCostsOtherSubs != null ? Number(org.fixedCostsOtherSubs) : null,
      otherFixedCosts: org.fixedCostsOther != null ? Number(org.fixedCostsOther) : null,
    };
  }

  /**
   * Update fixed costs for an org (caller must be a member).
   */
  async updateOrgFixedCosts(
    orgId: string,
    userId: string,
    data: {
      softwareCosts?: number;
      otherSubscriptions?: number;
      otherFixedCosts?: number;
    },
  ) {
    const isMember = await this.isOrgMember(userId, orgId);
    if (!isMember) throw new NotFoundException('Not a member of this org');
    const payload: Record<string, unknown> = {};
    if (data.softwareCosts !== undefined) payload.fixedCostsSoftware = data.softwareCosts;
    if (data.otherSubscriptions !== undefined) payload.fixedCostsOtherSubs = data.otherSubscriptions;
    if (data.otherFixedCosts !== undefined) payload.fixedCostsOther = data.otherFixedCosts;
    await (this.prisma as any).organization.update({
      where: { id: orgId },
      data: payload,
    });
    return this.getOrgFixedCosts(orgId, userId);
  }
}
