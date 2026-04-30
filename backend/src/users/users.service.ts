import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { ClerkService } from '../clerk/clerk.service';
import { AffiliateService } from '../affiliate/affiliate.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clerkService: ClerkService,
    private readonly affiliateService: AffiliateService,
  ) {}

  async listAllUserEmails(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      select: { email: true },
    });
    return (rows ?? [])
      .map((r) => String(r.email ?? '').trim())
      .filter((e) => e.includes('@'));
  }

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

  private async resolveReferralFromClerk(clerkId: string): Promise<{
    referredBy: string | null;
    referredAffiliateId: string | null;
  }> {
    const refRaw = await this.clerkService.getReferralCodeFromClerkUser(clerkId);
    if (!refRaw) return { referredBy: null, referredAffiliateId: null };
    const affiliate = await this.affiliateService.getAffiliateByCode(refRaw);
    const normalized = this.affiliateService.normalizeReferralCode(refRaw);
    if (!affiliate) {
      return { referredBy: normalized || null, referredAffiliateId: null };
    }
    return { referredBy: affiliate.referralCode, referredAffiliateId: affiliate.id };
  }

  async createFromClerk(params: {
    clerkId: string;
    email?: string;
  }): Promise<User> {
    const { clerkId, email } = params;
    if (!clerkId || typeof clerkId !== 'string') {
      throw new Error('createFromClerk requires a non-empty clerkId');
    }
    const isProd = process.env.NODE_ENV === 'production';

    // Prefer the email from the token, but if missing fetch from Clerk API
    // (avoids creating placeholder users when token payload lacks email).
    let emailToUse = (email ?? '').trim();
    let nameFromClerk: string | null = null;
    if (!emailToUse) {
      const fromClerk =
        await this.clerkService.getPrimaryEmailAndNameFromClerkUser(clerkId);
      if (fromClerk.email) emailToUse = fromClerk.email;
      nameFromClerk = fromClerk.name;
    }

    if (!emailToUse) {
      if (isProd) {
        // In production, do not create junk placeholder accounts.
        throw new Error(
          `Clerk user (${clerkId}) has no email available yet; refusing to create placeholder user`,
        );
      }
      emailToUse = `${clerkId}@placeholder.local`;
    }

    // 1) Already have a user with this clerkId -> return them
    const byClerk = await this.prisma.user.findUnique({
      where: { clerkId },
    });
    if (byClerk) return byClerk;

    const referral = await this.resolveReferralFromClerk(clerkId);

    // 2) A user with this email already exists (e.g. from earlier sign-up) -> link clerkId and return
    const byEmail = await this.prisma.user.findUnique({
      where: { email: emailToUse },
    });
    if (byEmail) {
      const patch: {
        clerkId: string;
        referredBy?: string | null;
        referredAffiliateId?: string | null;
      } = { clerkId };
      if (!byEmail.referredAffiliateId && referral.referredAffiliateId) {
        patch.referredBy = referral.referredBy;
        patch.referredAffiliateId = referral.referredAffiliateId;
      }
      const updated = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: patch,
      });
      return updated;
    }

    // 3) New user -> create
    return this.prisma.user.create({
      data: {
        clerkId,
        email: emailToUse,
        passwordHash: '',
        name: nameFromClerk || undefined,
        referredBy: referral.referredBy,
        referredAffiliateId: referral.referredAffiliateId,
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
        fixedCostsSoftwareItems: true,
        fixedCostsOtherSubsItems: true,
        fixedCostsOtherItems: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');
    const normItems = (v: unknown): Array<{ name: string; monthlyCost: number }> => {
      const arr = Array.isArray(v) ? v : [];
      const out: Array<{ name: string; monthlyCost: number }> = [];
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const name = String((it as any).name ?? '').trim();
        const mc = Number((it as any).monthlyCost);
        if (!name) continue;
        if (!Number.isFinite(mc) || mc < 0) continue;
        out.push({ name: name.slice(0, 80), monthlyCost: Math.round(mc * 100) / 100 });
      }
      return out;
    };
    const softwareCostItems = normItems(org.fixedCostsSoftwareItems);
    const otherSubscriptionItems = normItems(org.fixedCostsOtherSubsItems);
    const otherFixedCostItems = normItems(org.fixedCostsOtherItems);

    const sum = (items: Array<{ monthlyCost: number }>) =>
      Math.round(items.reduce((a, b) => a + (Number(b.monthlyCost) || 0), 0) * 100) / 100;

    const fallbackItem = (label: string, total: unknown) => {
      const n = total != null ? Number(total) : null;
      if (n == null || !Number.isFinite(n) || n <= 0) return [];
      return [{ name: label, monthlyCost: Math.round(n * 100) / 100 }];
    };

    const softwareTotal = org.fixedCostsSoftware != null ? Number(org.fixedCostsSoftware) : null;
    const otherSubsTotal = org.fixedCostsOtherSubs != null ? Number(org.fixedCostsOtherSubs) : null;
    const otherFixedTotal = org.fixedCostsOther != null ? Number(org.fixedCostsOther) : null;

    const softwareItemsOut =
      softwareCostItems.length > 0 ? softwareCostItems : fallbackItem('Software', softwareTotal);
    const otherSubsItemsOut =
      otherSubscriptionItems.length > 0
        ? otherSubscriptionItems
        : fallbackItem('Subscription', otherSubsTotal);
    const otherFixedItemsOut =
      otherFixedCostItems.length > 0 ? otherFixedCostItems : fallbackItem('Fixed cost', otherFixedTotal);

    return {
      softwareCosts: softwareTotal,
      softwareCostItems: softwareItemsOut,
      otherSubscriptions: otherSubsTotal,
      otherSubscriptionItems: otherSubsItemsOut,
      otherFixedCosts: otherFixedTotal,
      otherFixedCostItems: otherFixedItemsOut,
      totals: {
        softwareCosts: sum(softwareItemsOut),
        otherSubscriptions: sum(otherSubsItemsOut),
        otherFixedCosts: sum(otherFixedItemsOut),
        totalFixedCosts:
          Math.round((sum(softwareItemsOut) + sum(otherSubsItemsOut) + sum(otherFixedItemsOut)) * 100) /
          100,
      },
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
      softwareCostItems?: Array<{ name: string; monthlyCost: number }>;
      otherSubscriptions?: number;
      otherSubscriptionItems?: Array<{ name: string; monthlyCost: number }>;
      otherFixedCosts?: number;
      otherFixedCostItems?: Array<{ name: string; monthlyCost: number }>;
    },
  ) {
    const isMember = await this.isOrgMember(userId, orgId);
    if (!isMember) throw new NotFoundException('Not a member of this org');
    const payload: Record<string, unknown> = {};
    const normItems = (v: unknown): Array<{ name: string; monthlyCost: number }> => {
      const arr = Array.isArray(v) ? v : [];
      const out: Array<{ name: string; monthlyCost: number }> = [];
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const name = String((it as any).name ?? '').trim();
        const mc = Number((it as any).monthlyCost);
        if (!name) continue;
        if (!Number.isFinite(mc) || mc < 0) continue;
        out.push({ name: name.slice(0, 80), monthlyCost: Math.round(mc * 100) / 100 });
      }
      return out;
    };
    const sum = (items: Array<{ monthlyCost: number }>) =>
      Math.round(items.reduce((a, b) => a + (Number(b.monthlyCost) || 0), 0) * 100) / 100;

    const softwareItems = normItems(data.softwareCostItems);
    const otherSubsItems = normItems(data.otherSubscriptionItems);
    const otherFixedItems = normItems(data.otherFixedCostItems);

    if (data.softwareCosts !== undefined) payload.fixedCostsSoftware = data.softwareCosts;
    if (data.otherSubscriptions !== undefined) payload.fixedCostsOtherSubs = data.otherSubscriptions;
    if (data.otherFixedCosts !== undefined) payload.fixedCostsOther = data.otherFixedCosts;

    if (data.softwareCostItems !== undefined) {
      payload.fixedCostsSoftwareItems = softwareItems;
      payload.fixedCostsSoftware = sum(softwareItems);
    }
    if (data.otherSubscriptionItems !== undefined) {
      payload.fixedCostsOtherSubsItems = otherSubsItems;
      payload.fixedCostsOtherSubs = sum(otherSubsItems);
    }
    if (data.otherFixedCostItems !== undefined) {
      payload.fixedCostsOtherItems = otherFixedItems;
      payload.fixedCostsOther = sum(otherFixedItems);
    }
    await (this.prisma as any).organization.update({
      where: { id: orgId },
      data: payload,
    });
    return this.getOrgFixedCosts(orgId, userId);
  }
}
