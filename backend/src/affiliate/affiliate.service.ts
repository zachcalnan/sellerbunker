import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { Affiliate, AffiliateCommissionStatus } from '@prisma/client';

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Normalize ?ref= value for lookup (lowercase, safe chars). */
  normalizeReferralCode(raw: string): string {
    return String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
  }

  async getAffiliateByCode(refCode: string): Promise<Affiliate | null> {
    const code = this.normalizeReferralCode(refCode);
    if (!code) return null;
    return this.prisma.affiliate.findFirst({
      where: { referralCode: code, active: true },
    });
  }

  /** Resolve any affiliate row by code (admin / inactive check). */
  async findAffiliateByCodeAny(refCode: string): Promise<Affiliate | null> {
    const code = this.normalizeReferralCode(refCode);
    if (!code) return null;
    return this.prisma.affiliate.findUnique({
      where: { referralCode: code },
    });
  }

  private minPaidInvoiceSequence(): number {
    const raw = this.config.get<string>('AFFILIATE_MIN_PAID_INVOICE_NUMBER') ?? '1';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  /**
   * Share of each qualifying payment for this referred user (1st / 2nd / 3+ invoice).
   * Env overrides; defaults: 100% / 50% / 25%.
   */
  commissionRateForPaymentNumber(paymentNumber: number): number {
    const parseRate = (key: string, fallback: number): number => {
      const raw = this.config.get<string>(key);
      if (raw === undefined || raw === '') return fallback;
      const n = parseFloat(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    if (paymentNumber <= 1) {
      return parseRate('AFFILIATE_COMMISSION_RATE_PAYMENT_1', 1);
    }
    if (paymentNumber === 2) {
      return parseRate('AFFILIATE_COMMISSION_RATE_PAYMENT_2', 0.5);
    }
    return parseRate('AFFILIATE_COMMISSION_RATE_PAYMENT_3_PLUS', 0.25);
  }

  async getAffiliateStats(affiliateId: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id: affiliateId },
      select: { id: true, referralCode: true, name: true, email: true, active: true },
    });
    if (!affiliate) return null;

    const [referredSignups, paidUserIds, commissionAgg, pendingAgg, paidAgg] =
      await Promise.all([
        this.prisma.user.count({ where: { referredAffiliateId: affiliateId } }),
        this.prisma.affiliateCommission.groupBy({
          by: ['userId'],
          where: { affiliateId },
        }),
        this.prisma.affiliateCommission.aggregate({
          where: { affiliateId },
          _count: true,
          _sum: { amount: true },
        }),
        this.prisma.affiliateCommission.aggregate({
          where: { affiliateId, status: 'pending' },
          _sum: { amount: true },
        }),
        this.prisma.affiliateCommission.aggregate({
          where: { affiliateId, status: 'paid' },
          _sum: { amount: true },
        }),
      ]);

    const referredUsersWhoPaid = paidUserIds.length; // distinct referred users with ≥1 commission row

    return {
      affiliate,
      referredSignups,
      referredUsersWhoPaid,
      commissionRows: commissionAgg._count,
      totalCommissionAmount: commissionAgg._sum.amount?.toString() ?? '0',
      pendingCommissionAmount: pendingAgg._sum.amount?.toString() ?? '0',
      paidOutCommissionAmount: paidAgg._sum.amount?.toString() ?? '0',
      tierRates: {
        payment1: this.commissionRateForPaymentNumber(1),
        payment2: this.commissionRateForPaymentNumber(2),
        payment3Plus: this.commissionRateForPaymentNumber(3),
      },
    };
  }

  /**
   * Create a pending commission when a referred user pays (invoice or checkout with amount).
   * Idempotent on stripeEventId.
   */
  async recordCommissionFromPayment(params: {
    stripeEventId: string;
    userId: string;
    affiliateId: string;
    amountPaidMinorUnits: number;
    currency: string;
    stripeInvoiceId?: string | null;
  }): Promise<void> {
    const {
      stripeEventId,
      userId,
      affiliateId,
      amountPaidMinorUnits,
      currency,
      stripeInvoiceId,
    } = params;

    if (!stripeEventId || amountPaidMinorUnits <= 0) return;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredAffiliateId: true },
    });
    if (!user?.referredAffiliateId || user.referredAffiliateId !== affiliateId) {
      return;
    }

    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id: affiliateId },
    });
    if (!affiliate?.active) return;

    const minSeq = this.minPaidInvoiceSequence();
    const prior = await this.prisma.affiliateCommission.count({
      where: { userId, affiliateId },
    });
    const paymentNumber = prior + 1;
    if (paymentNumber < minSeq) {
      this.logger.debug(
        `Skip commission: paymentNumber=${paymentNumber} < AFFILIATE_MIN_PAID_INVOICE_NUMBER=${minSeq} userId=${userId}`,
      );
      return;
    }

    const grossMajor = amountPaidMinorUnits / 100;
    const rate = this.commissionRateForPaymentNumber(paymentNumber);
    const amount = Math.round(grossMajor * rate * 100) / 100;
    if (amount <= 0) return;

    try {
      await this.prisma.affiliateCommission.create({
        data: {
          userId,
          affiliateId,
          amount,
          currency: (currency || 'gbp').toLowerCase(),
          status: 'pending',
          stripeEventId,
          stripeInvoiceId: stripeInvoiceId ?? null,
          paymentNumber,
        },
      });
      this.logger.log(
        `Commission pending: ${amount} (${currency}) user=${userId} affiliate=${affiliateId} payment#${paymentNumber} rate=${rate} event=${stripeEventId}`,
      );
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === 'P2002') {
        return;
      }
      this.logger.warn(
        `recordCommissionFromPayment failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async handleInvoicePaid(
    stripeEventId: string,
    invoice: {
      id?: string;
      customer?: string | { id?: string } | null;
      customer_email?: string | null;
      amount_paid?: number | null;
      currency?: string | null;
    },
  ): Promise<void> {
    const amountPaid = invoice.amount_paid ?? 0;
    if (amountPaid <= 0) return;

    const customerRaw = invoice.customer;
    const customerId =
      typeof customerRaw === 'string'
        ? customerRaw
        : customerRaw && typeof customerRaw === 'object' && 'id' in customerRaw
          ? String((customerRaw as { id?: string }).id ?? '')
          : '';

    let userId: string | null = null;

    if (customerId) {
      const sub = await this.prisma.subscription.findFirst({
        where: { stripeCustomerId: customerId },
        select: { userId: true },
      });
      if (sub) userId = sub.userId;
    }

    if (!userId && invoice.customer_email?.trim()) {
      const u = await this.prisma.user.findFirst({
        where: {
          email: {
            equals: invoice.customer_email.trim(),
            mode: 'insensitive',
          },
        },
        select: { id: true },
      });
      if (u) userId = u.id;
    }

    if (!userId) return;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referredAffiliateId: true },
    });
    if (!user?.referredAffiliateId) return;

    await this.recordCommissionFromPayment({
      stripeEventId,
      userId,
      affiliateId: user.referredAffiliateId,
      amountPaidMinorUnits: amountPaid,
      currency: invoice.currency || 'gbp',
      stripeInvoiceId: invoice.id ?? null,
    });
  }

  /**
   * Subscription checkouts: commission is recorded on invoice.paid only (avoids double-counting).
   * One-time payment mode: commission on this session if amount_total > 0.
   */
  async handleCheckoutSessionCompleted(
    stripeEventId: string,
    session: {
      mode?: string | null;
      client_reference_id?: string | null;
      amount_total?: number | null;
      currency?: string | null;
    },
  ): Promise<void> {
    if (session.mode === 'subscription') return;
    const amountTotal = session.amount_total ?? 0;
    if (amountTotal <= 0) return;

    const clerkId = session.client_reference_id?.trim();
    if (!clerkId) return;

    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      select: { id: true, referredAffiliateId: true },
    });
    if (!user?.referredAffiliateId) return;

    await this.recordCommissionFromPayment({
      stripeEventId,
      userId: user.id,
      affiliateId: user.referredAffiliateId,
      amountPaidMinorUnits: amountTotal,
      currency: session.currency || 'gbp',
      stripeInvoiceId: null,
    });
  }

  async createAffiliate(data: {
    referralCode: string;
    name?: string;
    email?: string;
    commissionRate?: number;
    active?: boolean;
  }): Promise<Affiliate> {
    const referralCode = this.normalizeReferralCode(data.referralCode);
    if (!referralCode) {
      throw new Error('referralCode is required');
    }
    // Stored for reference; payout % uses env tiered rates (1st / 2nd / 3+ payment).
    const rate = data.commissionRate ?? 1;
    return this.prisma.affiliate.create({
      data: {
        referralCode,
        name: data.name ?? null,
        email: data.email ?? null,
        commissionRate: rate,
        active: data.active !== false,
      },
    });
  }

  async listAffiliates(): Promise<Affiliate[]> {
    return this.prisma.affiliate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async listCommissions(filters?: {
    affiliateId?: string;
    status?: AffiliateCommissionStatus;
  }) {
    return this.prisma.affiliateCommission.findMany({
      where: {
        affiliateId: filters?.affiliateId,
        status: filters?.status,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        affiliate: { select: { referralCode: true, name: true } },
        user: { select: { email: true, id: true } },
      },
    });
  }

  async markCommissionPaid(id: string): Promise<void> {
    await this.prisma.affiliateCommission.update({
      where: { id },
      data: { status: 'paid', paidAt: new Date() },
    });
  }
}
