import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AmazonService } from './amazon.service';
import { AmazonSpApiClient } from './sp-api.client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

describe('AmazonService.refreshAsinSellingEligibilityForUser', () => {
  it('persists canRestock true when Listings Restrictions are empty, false when reason codes exist', async () => {
    const userId = 'test-user-eligibility';
    const marketplaceId = 'A1F83G8C2ARO7P';
    const asinUngated = 'B000UNGATED';
    const asinGated = 'B000GATED';

    const sellerAccountRow = {
      sellerId: 'A1TESTSELLER',
      credentials: {
        region: 'eu' as const,
        lwaClientId: 'lwa',
        lwaClientSecret: 'lwa-sec',
        refreshToken: 'rt',
        awsAccessKeyId: 'aki',
        awsSecretAccessKey: 'sak',
      },
    };

    const upsertMock = jest.fn().mockResolvedValue({});

    const deleteManyMock = jest.fn().mockResolvedValue({ count: 0 });
    const prismaMock = {
      sellerAccount: {
        findUnique: jest.fn().mockResolvedValue(sellerAccountRow),
      },
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ asin: asinUngated }, { asin: asinGated }]),
      },
      inventoryByMarketplace: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      asinSellingEligibility: {
        deleteMany: deleteManyMock,
        upsert: upsertMock,
      },
    };

    const getListingsRestrictions = jest.fn().mockImplementation(
      (_creds: unknown, params: { asin: string; marketplaceIds: string[] }) => {
        expect(params.marketplaceIds).toEqual([marketplaceId]);
        if (params.asin === asinGated) {
          return Promise.resolve({
            restrictions: [
              {
                marketplaceId,
                conditionType: 'new_new',
                reasons: [{ reasonCode: 'APPROVAL_REQUIRED', message: 'Gated' }],
              },
            ],
          });
        }
        return Promise.resolve({ restrictions: [] });
      },
    );

    const spApiMock = { getListingsRestrictions };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AmazonService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AmazonSpApiClient, useValue: spApiMock },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: UsersService, useValue: {} },
      ],
    }).compile();

    const amazon = moduleRef.get(AmazonService);
    const out = await amazon.refreshAsinSellingEligibilityForUser(userId, {
      limit: 10,
      delayMs: 0,
    });

    expect(out.pairsConsidered).toBe(2);
    expect(out.successCount).toBe(2);
    expect(out.errorCount).toBe(0);
    expect(out.canRestockCount).toBe(1);
    expect(out.blockedCount).toBe(1);
    expect(getListingsRestrictions).toHaveBeenCalledTimes(2);

    expect(upsertMock).toHaveBeenCalledTimes(2);

    const gatedCall = upsertMock.mock.calls.find(
      (c) => (c[0] as { create: { asin: string } }).create.asin === asinGated,
    );
    const ungatedCall = upsertMock.mock.calls.find(
      (c) => (c[0] as { create: { asin: string } }).create.asin === asinUngated,
    );
    expect(ungatedCall).toBeDefined();
    expect(gatedCall).toBeDefined();
    expect((ungatedCall![0] as { create: { canRestock: boolean } }).create.canRestock).toBe(true);
    expect((gatedCall![0] as { create: { canRestock: boolean; notes: string | null } }).create.canRestock).toBe(
      false,
    );
    expect((gatedCall![0] as { create: { notes: string | null } }).create.notes).toContain('APPROVAL_REQUIRED');
    expect((ungatedCall![0] as { create: { source: string } }).create.source).toBe(
      'spapi_listings_restrictions_v2021_08_01',
    );
    expect((ungatedCall![0] as { create: { marketplaceId: string } }).create.marketplaceId).toBe(marketplaceId);
    expect(deleteManyMock).toHaveBeenCalled();

    const samplesByAsin = Object.fromEntries(out.samples.map((s) => [s.asin, s]));
    expect(samplesByAsin[asinUngated].canRestock).toBe(true);
    expect(samplesByAsin[asinGated].canRestock).toBe(false);
  });
});
