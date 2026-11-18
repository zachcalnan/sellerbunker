import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsClient } from './google-sheets.client';
import { RedisService } from '../redis/redis.service';
import {
  buildSheetPurchasedAndArrivedByAsin,
  parseBlue30ArrivedRows,
  parsePurchaseSheetStageRows,
  type AsinQtyCost,
} from './stock-cost-sheet.util';

const CACHE_TTL_SEC = 90;
const CACHE_KEY_PURCHASE = 'stock-cost:purchase-sheet:v1';
const CACHE_KEY_BLUE30 = 'stock-cost:blue30-inbound:v1';

export type SheetStageSnapshots = {
  purchasedByAsin: Map<string, AsinQtyCost>;
  arrivedByAsin: Map<string, AsinQtyCost>;
  purchaseSheetOk: boolean;
  blue30Ok: boolean;
  errors: string[];
  sourceNote: string;
};

type CachedJsonMaps = {
  purchased: Record<string, AsinQtyCost>;
  arrived: Record<string, AsinQtyCost>;
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
      purchaseSheetOk: j.purchaseSheetOk,
      blue30Ok: j.blue30Ok,
      errors: j.errors ?? [],
      sourceNote: j.sourceNote ?? '',
    };
  }

  /**
   * Read purchase CURRENT ORDERS + Blue30 Inbound (Quantity Received),
   * build purchased / arrived ASIN aggregates. Cached ~90s in Redis.
   */
  async getPurchasedAndArrivedByAsin(): Promise<SheetStageSnapshots> {
    const cacheKey = `${CACHE_KEY_PURCHASE}+${CACHE_KEY_BLUE30}`;
    try {
      const raw = await this.redis.get(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedJsonMaps;
        return this.jsonToMaps(parsed);
      }
    } catch {
      // ignore cache read errors
    }

    const errors: string[] = [];
    let purchaseInTransit = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['inTransit'];
    let purchaseDelivered = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['delivered'];
    let blue30Arrived = [] as ReturnType<
      typeof parseBlue30ArrivedRows
    >['arrived'];
    let purchaseSheetOk = false;
    let blue30Ok = false;

    if (this.sheets.isConfigured()) {
      try {
        const tab = this.currentTabTitle();
        const values = await this.sheets.getValues(`'${tab}'!A1:AZ`);
        const parsed = parsePurchaseSheetStageRows(values);
        purchaseInTransit = parsed.inTransit;
        purchaseDelivered = parsed.delivered;
        errors.push(...parsed.errors);
        purchaseSheetOk = parsed.errors.length === 0 || parsed.inTransit.length + parsed.delivered.length > 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Purchase sheet read failed: ${msg}`);
        this.logger.warn(`Purchase sheet read failed: ${msg}`);
      }
    } else {
      errors.push('Purchase Google Sheet not configured');
    }

    const b30Id = this.blue30SpreadsheetId();
    if (this.sheets.isAuthConfigured() && b30Id) {
      try {
        const tab = this.blue30TabTitle();
        const values = await this.sheets.getValues(`'${tab}'!A1:AZ`, b30Id);
        const parsed = parseBlue30ArrivedRows(values);
        blue30Arrived = parsed.arrived;
        errors.push(...parsed.errors);
        blue30Ok =
          parsed.errors.length === 0 || parsed.arrived.length > 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Blue30 Inbound read failed: ${msg}`);
        this.logger.warn(`Blue30 Inbound read failed: ${msg}`);
      }
    } else {
      errors.push('Blue30 Inbound sheet not configured');
    }

    const { purchasedByAsin, arrivedByAsin } =
      buildSheetPurchasedAndArrivedByAsin({
        purchaseInTransit,
        purchaseDelivered,
        blue30Arrived,
      });

    const snapshot: SheetStageSnapshots = {
      purchasedByAsin,
      arrivedByAsin,
      purchaseSheetOk,
      blue30Ok,
      errors,
      sourceNote: '',
    };

    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(this.mapsToJson(snapshot)),
        CACHE_TTL_SEC,
      );
    } catch {
      // ignore cache write errors
    }

    return snapshot;
  }
}
