import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsClient } from './google-sheets.client';
import { RedisService } from '../redis/redis.service';
import {
  colIndexToA1,
  findHeaderColumnIndex,
} from './purchase-sheet-cogs.util';
import {
  buildSheetPurchasedAndArrivedByAsin,
  parseBlue30ArrivedRows,
  parsePurchaseSheetStageRows,
  planDeliveredYesUpdatesFromBlue30,
  planHomePrepSentUpdatesFromAmazonHeld,
  type AsinQtyCost,
  type DeliveredYesUpdate,
  type HomePrepSentUpdate,
} from './stock-cost-sheet.util';

const CACHE_TTL_SEC = 90;
/** Pipeline aggregates — bump when costing / Home/Prep=sent model changes. */
const CACHE_KEY_PIPELINE = 'stock-cost:pipeline-maps:v3';
/** Throttle Blue30→Delivered + Home/Prep→sent sheet writes. */
const SYNC_THROTTLE_KEY = 'stock-cost:delivered-sync:v2';
const SYNC_THROTTLE_SEC = 120;

/** Exact Home/Prep cell value when units have been sent into Amazon. */
export const HOME_PREP_SENT_VALUE = 'sent';

export type SheetStageSnapshots = {
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
  sheetSentByAsin: Map<string, number>;
  purchaseSheetOk: boolean;
  blue30Ok: boolean;
  errors: string[];
  sourceNote: string;
};

export type DeliveredSyncResult = {
  attempted: boolean;
  skippedThrottle: boolean;
  updated: number;
  updates: DeliveredYesUpdate[];
  sentUpdated: number;
  sentUpdates: HomePrepSentUpdate[];
  errors: string[];
};

type CachedJsonMaps = {
  purchased: Record<string, AsinQtyCost>;
  arrived: Record<string, AsinQtyCost>;
  sheetSent: Record<string, number>;
  purchaseSheetOk: boolean;
  blue30Ok: boolean;
  errors: string[];
  sourceNote: string;
};

@Injectable()
export class StockCostSheetReadService {
  private readonly logger = new Logger(StockCostSheetReadService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sheets: GoogleSheetsClient,
    private readonly redis: RedisService,
  ) {}

  private currentTabTitle(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_TAB_CURRENT')?.trim() ||
      'CURRENT ORDERS'
    );
  }

  private blue30SpreadsheetId(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_PREP_INBOUND_SPREADSHEET_ID')?.trim() ||
      ''
    );
  }

  private blue30TabTitle(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_PREP_INBOUND_TAB')?.trim() ||
      'Inbound'
    );
  }

  private mapsToJson(s: SheetStageSnapshots): CachedJsonMaps {
    return {
      purchased: Object.fromEntries(s.purchasedByAsin),
      arrived: Object.fromEntries(s.arrivedByAsin),
      sheetSent: Object.fromEntries(s.sheetSentByAsin),
      purchaseSheetOk: s.purchaseSheetOk,
      blue30Ok: s.blue30Ok,
      errors: s.errors,
      sourceNote: s.sourceNote,
    };
  }

  private jsonToMaps(j: CachedJsonMaps): SheetStageSnapshots {
    return {
      purchasedByAsin: new Map(Object.entries(j.purchased ?? {})),
      arrivedByAsin: new Map(Object.entries(j.arrived ?? {})),
      sheetSentByAsin: new Map(
        Object.entries(j.sheetSent ?? {}).map(([k, v]) => [k, Number(v) || 0]),
      ),
      purchaseSheetOk: j.purchaseSheetOk,
      blue30Ok: j.blue30Ok,
      errors: j.errors ?? [],
      sourceNote: j.sourceNote ?? '',
    };
  }

  async invalidatePipelineCache(): Promise<void> {
    try {
      await this.redis.del(CACHE_KEY_PIPELINE);
    } catch {
      // ignore
    }
  }

  /**
   * 1) Blue30 Quantity Received → CURRENT ORDERS Delivered=Yes
   * 2) Amazon held (available+inbound) → Home/Prep = "sent" on covered Delivered rows
   * Idempotent; never rewrites £/Unit or Units.
   */
  async syncBlue30ReceivedToPurchaseDelivered(opts?: {
    force?: boolean;
    amazonHeldByAsin?: Map<string, number>;
  }): Promise<DeliveredSyncResult> {
    const empty: DeliveredSyncResult = {
      attempted: false,
      skippedThrottle: false,
      updated: 0,
      updates: [],
      sentUpdated: 0,
      sentUpdates: [],
      errors: [],
    };

    if (!this.sheets.isConfigured()) {
      return { ...empty, errors: ['Purchase Google Sheet not configured'] };
    }

    if (!opts?.force) {
      try {
        const throttled = await this.redis.get(SYNC_THROTTLE_KEY);
        if (throttled) {
          return { ...empty, skippedThrottle: true };
        }
      } catch {
        // proceed without throttle if Redis unavailable
      }
    }

    const errors: string[] = [];
    let deliveredUpdates: DeliveredYesUpdate[] = [];
    let sentUpdates: HomePrepSentUpdate[] = [];

    try {
      const tab = this.currentTabTitle();
      let purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
      let parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
      errors.push(...parsedPurchase.errors);

      const header = (purchaseValues[0] ?? []).map((h) => String(h ?? ''));
      const deliveredColIndex0 = findHeaderColumnIndex(header, ['Delivered']);
      const homePrepColIndex0 = findHeaderColumnIndex(header, [
        'Home/Prep',
        'Prep',
      ]);

      if (deliveredColIndex0 < 0) {
        errors.push('CURRENT ORDERS: Delivered column not found');
      }

      const b30Id = this.blue30SpreadsheetId();
      if (this.sheets.isAuthConfigured() && b30Id && deliveredColIndex0 >= 0) {
        const b30Tab = this.blue30TabTitle();
        const blue30Values = await this.sheets.getValues(
          `'${b30Tab}'!A1:AZ`,
          b30Id,
        );
        const parsedB30 = parseBlue30ArrivedRows(blue30Values);
        errors.push(...parsedB30.errors);

        deliveredUpdates = planDeliveredYesUpdatesFromBlue30({
          purchaseInTransit: parsedPurchase.inTransit,
          deliveredColIndex0,
          blue30Arrived: parsedB30.arrived,
        });

        if (deliveredUpdates.length > 0) {
          const colLetter = colIndexToA1(deliveredColIndex0);
          await this.sheets.batchUpdateValues(
            deliveredUpdates.map((u) => ({
              range: `'${tab}'!${colLetter}${u.sheetRow}`,
              values: [['Yes']],
            })),
          );
          this.logger.log(
            `Blue30→Delivered sync: set Delivered=Yes on ${deliveredUpdates.length} CURRENT ORDERS row(s)`,
          );
          // Re-read so Home/Prep=sent planning sees flipped Delivered rows.
          purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
          parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
          errors.push(...parsedPurchase.errors);
        }
      } else if (!b30Id || !this.sheets.isAuthConfigured()) {
        errors.push('Blue30 Inbound sheet not configured');
      }

      const held = opts?.amazonHeldByAsin;
      if (held && homePrepColIndex0 >= 0) {
        sentUpdates = planHomePrepSentUpdatesFromAmazonHeld({
          purchaseDelivered: parsedPurchase.delivered,
          homePrepColIndex0,
          amazonHeldByAsin: held,
        });

        if (sentUpdates.length > 0) {
          const colLetter = colIndexToA1(homePrepColIndex0);
          await this.sheets.batchUpdateValues(
            sentUpdates.map((u) => ({
              range: `'${tab}'!${colLetter}${u.sheetRow}`,
              values: [[HOME_PREP_SENT_VALUE]],
            })),
          );
          this.logger.log(
            `Amazon→Home/Prep sync: set Home/Prep=${HOME_PREP_SENT_VALUE} on ${sentUpdates.length} CURRENT ORDERS row(s)`,
          );
        }
      } else if (held && homePrepColIndex0 < 0) {
        errors.push('CURRENT ORDERS: Home/Prep column not found');
      }

      if (deliveredUpdates.length > 0 || sentUpdates.length > 0) {
        await this.invalidatePipelineCache();
      }

      try {
        await this.redis.set(SYNC_THROTTLE_KEY, '1', SYNC_THROTTLE_SEC);
      } catch {
        // ignore
      }

      return {
        attempted: true,
        skippedThrottle: false,
        updated: deliveredUpdates.length,
        updates: deliveredUpdates,
        sentUpdated: sentUpdates.length,
        sentUpdates,
        errors,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Blue30→Delivered / Home/Prep→sent sync failed: ${msg}`);
      this.logger.warn(`Sheet stage sync failed: ${msg}`);
      return {
        attempted: true,
        skippedThrottle: false,
        updated: 0,
        updates: [],
        sentUpdated: 0,
        sentUpdates: [],
        errors,
      };
    }
  }

  /**
   * Read CURRENT ORDERS after optional Blue30→Delivered + Home/Prep→sent sync.
   * Prep candidates = Delivered=Yes and Home/Prep ≠ sent.
   * Cached ~90s in Redis.
   */
  async getPurchasedAndArrivedByAsin(opts?: {
    amazonHeldByAsin?: Map<string, number>;
  }): Promise<SheetStageSnapshots> {
    try {
      const raw = await this.redis.get(CACHE_KEY_PIPELINE);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedJsonMaps;
        return this.jsonToMaps(parsed);
      }
    } catch {
      // ignore cache read errors
    }

    const sync = await this.syncBlue30ReceivedToPurchaseDelivered({
      amazonHeldByAsin: opts?.amazonHeldByAsin,
    });
    const errors: string[] = [...sync.errors];
    let purchaseInTransit = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['inTransit'];
    let purchaseDelivered = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['delivered'];
    let purchaseSheetOk = false;
    let blue30Ok = sync.attempted && sync.errors.length === 0;

    if (this.sheets.isConfigured()) {
      try {
        const tab = this.currentTabTitle();
        const values = await this.sheets.getValues(`'${tab}'!A1:AZ`);
        const parsed = parsePurchaseSheetStageRows(values);
        purchaseInTransit = parsed.inTransit;
        purchaseDelivered = parsed.delivered;
        errors.push(...parsed.errors);
        purchaseSheetOk =
          parsed.errors.length === 0 ||
          parsed.inTransit.length + parsed.delivered.length > 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Purchase sheet read failed: ${msg}`);
        this.logger.warn(`Purchase sheet read failed: ${msg}`);
      }
    } else {
      errors.push('Purchase Google Sheet not configured');
    }

    if (!this.blue30SpreadsheetId() || !this.sheets.isAuthConfigured()) {
      blue30Ok = false;
    }

    const { purchasedByAsin, arrivedByAsin, sheetSentByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit,
        purchaseDelivered,
      });

    const syncParts: string[] = [];
    if (sync.updated > 0) {
      syncParts.push(`synced Delivered=Yes on ${sync.updated} row(s)`);
    }
    if (sync.sentUpdated > 0) {
      syncParts.push(
        `synced Home/Prep=${HOME_PREP_SENT_VALUE} on ${sync.sentUpdated} row(s)`,
      );
    }
    if (syncParts.length === 0 && sync.skippedThrottle) {
      syncParts.push('sheet stage sync throttled');
    }

    const snapshot: SheetStageSnapshots = {
      purchasedByAsin,
      arrivedByAsin,
      sheetSentByAsin,
      purchaseSheetOk,
      blue30Ok,
      errors,
      sourceNote: syncParts.join('; '),
    };

    try {
      await this.redis.set(
        CACHE_KEY_PIPELINE,
        JSON.stringify(this.mapsToJson(snapshot)),
        CACHE_TTL_SEC,
      );
    } catch {
      // ignore cache write errors
    }

    return snapshot;
  }
}
