import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AmazonService } from '../amazon/amazon.service';
import {
  MARKETPLACE_MAP,
  MARKETPLACES,
  type MarketplaceActivityClass,
} from './marketplace.constants';

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly amazonService: AmazonService,
  ) {}

  async getCatalog() {
    return {
      regions: ['NA', 'EU', 'AUSTRALASIA'],
      marketplaces: MARKETPLACES,
    };
  }

  async setBaseMarketplace(userId: string, marketplaceId: string) {
    const target = MARKETPLACE_MAP.get(marketplaceId);
    if (!target) throw new NotFoundException('Marketplace not supported');

    await (this.prisma as any).$transaction(async (tx: any) => {
      await tx.userMarketplaceSetting.updateMany({
        where: { userId, isBase: true },
        data: { isBase: false },
      });
      await tx.userMarketplaceSetting.upsert({
        where: { userId_marketplaceId: { userId, marketplaceId } },
        create: {
          userId,
          marketplaceId,
          countryCode: target.countryCode,
          region: target.region,
          currencyCode: target.currencyCode,
          isBase: true,
          isEnabledByUser: true,
        },
        update: {
          isBase: true,
          isEnabledByUser: true,
          countryCode: target.countryCode,
          region: target.region,
          currencyCode: target.currencyCode,
        },
      });
    });

    return this.listUserMarketplaces(userId);
  }

  async listUserMarketplaces(userId: string) {
    const rows = await (this.prisma as any).userMarketplaceSetting.findMany({
      where: { userId },
      orderBy: [{ isBase: 'desc' }, { countryCode: 'asc' }],
    });
    return {
      marketplaces: rows.map((row: any) => {
        const meta = MARKETPLACE_MAP.get(row.marketplaceId);
        return {
          ...row,
          displayName: meta?.displayName ?? row.countryCode,
          flag: meta?.flag ?? '',
        };
      }),
    };
  }

  async toggleMarketplace(userId: string, marketplaceId: string, enabled: boolean) {
    const existing = await (this.prisma as any).userMarketplaceSetting.findUnique({
      where: { userId_marketplaceId: { userId, marketplaceId } },
    });
    if (!existing) throw new NotFoundException('Marketplace not found for user');

    await (this.prisma as any).userMarketplaceSetting.update({
      where: { userId_marketplaceId: { userId, marketplaceId } },
      data: { isEnabledByUser: enabled },
    });
    return this.listUserMarketplaces(userId);
  }

  private classify(count: number): MarketplaceActivityClass {
    if (count >= 50) return 'HIGH';
    if (count >= 4) return 'MEDIUM';
    return 'INACTIVE';
  }

  private nextSyncAt(cls: MarketplaceActivityClass) {
    const now = Date.now();
    const ms =
      cls === 'HIGH'
        ? 6 * 60 * 1000
        : cls === 'MEDIUM'
          ? 40 * 60 * 1000
          : 24 * 60 * 60 * 1000;
    return new Date(now + ms);
  }

  async detectMarketplaceActivity(userId: string) {
    const participation = await this.amazonService.getMarketplaceParticipationsForUser(userId);
    const region = participation.region === 'na' ? 'NA' : participation.region === 'fe' ? 'AUSTRALASIA' : 'EU';
    const payload = participation.participations as any;
    const entries = Array.isArray(payload?.payload)
      ? payload.payload
      : Array.isArray(payload?.payload?.marketplaceParticipations)
        ? payload.payload.marketplaceParticipations
        : Array.isArray(payload?.marketplaceParticipations)
          ? payload.marketplaceParticipations
          : [];

    const participantIds = entries
      .map((entry: any) => entry?.marketplace?.id ?? entry?.marketplaceId)
      .filter((id: unknown): id is string => typeof id === 'string');

    const inRegion = MARKETPLACES.filter((m) => m.region === region && participantIds.includes(m.marketplaceId));
    const checked: Array<{ marketplaceId: string; count24h: number; activityClass: MarketplaceActivityClass }> = [];

    for (const marketplace of inRegion) {
      const count24h = await this.amazonService.getOrderCountLast24HoursForMarketplace(
        userId,
        marketplace.marketplaceId,
      );
      const activityClass = this.classify(count24h);
      checked.push({ marketplaceId: marketplace.marketplaceId, count24h, activityClass });

      await (this.prisma as any).userMarketplaceSetting.upsert({
        where: {
          userId_marketplaceId: { userId, marketplaceId: marketplace.marketplaceId },
        },
        create: {
          userId,
          marketplaceId: marketplace.marketplaceId,
          countryCode: marketplace.countryCode,
          region: marketplace.region,
          currencyCode: marketplace.currencyCode,
          detectedBySystem: count24h > 0,
          activityClass,
          orderCount24h: count24h,
          lastActivityCheckAt: new Date(),
          nextSyncAt: this.nextSyncAt(activityClass),
          isEnabledByUser: count24h > 0,
        },
        update: {
          countryCode: marketplace.countryCode,
          region: marketplace.region,
          currencyCode: marketplace.currencyCode,
          detectedBySystem: count24h > 0,
          activityClass,
          orderCount24h: count24h,
          lastActivityCheckAt: new Date(),
          nextSyncAt: this.nextSyncAt(activityClass),
        },
      });
    }

    // Keep base marketplace aligned with detected activity so users don't get
    // auto-switched to alphabetic defaults (e.g. DE) when only UK is active.
    const ranked = [...checked]
      .sort((a, b) => b.count24h - a.count24h)
      .sort((a, b) => {
        // Tie-breaker: prefer UK in EU region when counts are equal.
        const aIsUk = a.marketplaceId === 'A1F83G8C2ARO7P';
        const bIsUk = b.marketplaceId === 'A1F83G8C2ARO7P';
        if (aIsUk && !bIsUk) return -1;
        if (!aIsUk && bIsUk) return 1;
        return 0;
      });
    const bestActive = ranked.find((r) => r.count24h > 0);
    if (bestActive) {
      await (this.prisma as any).$transaction(async (tx: any) => {
        await tx.userMarketplaceSetting.updateMany({
          where: { userId, isBase: true },
          data: { isBase: false },
        });
        await tx.userMarketplaceSetting.update({
          where: {
            userId_marketplaceId: {
              userId,
              marketplaceId: bestActive.marketplaceId,
            },
          },
          data: { isBase: true, isEnabledByUser: true },
        });
      });
    }

    const current = await this.listUserMarketplaces(userId);
    const detectedActive = current.marketplaces.filter((m: any) => m.detectedBySystem);
    return {
      detectedMessage:
        detectedActive.length > 0
          ? `We detected your active marketplaces: ${detectedActive.map((m: any) => `${m.flag} ${m.displayName}`).join(', ')}`
          : 'No active marketplaces detected in the last 24 hours.',
      checked,
      ...current,
    };
  }
}
