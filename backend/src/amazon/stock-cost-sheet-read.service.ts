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
  findPurchaseSheetFinalColumnIndex,
  findPurchaseSheetHomePrepColumnIndex,
  findPurchaseSheetToAmazonColumnIndex,
  parseBlue30ArrivedRows,
  parsePurchaseSheetStageRows,
  planDeliveredYesUpdatesFromBlue30,
  planFinalCompleteUpdatesFromSold,
  planFinalReturnedUpdatesFromReturns,
  planFinalStatusFormatUpdatesFromValues,
  isPurchaseSheetHomePrepSent,
  planHomePrepSentUpdatesFromAmazonHeld,
  planHomePrepSentUpdatesFromFinalSoldValues,
  PURCHASE_SHEET_COMPLETE_VALUE,
  PURCHASE_SHEET_RETURNED_VALUE,
  resolvePurchaseSheetFinalStatusFormat,
  type AsinQtyCost,
  type DeliveredYesUpdate,
  type FinalCompleteUpdate,
  type FinalReturnedUpdate,
  type FinalStatusFormatUpdate,
  type HomePrepSentUpdate,
} from './stock-cost-sheet.util';

/**
 * Keep last-good pipeline maps for dashboard SWR. Soft age triggers background
 * revalidate; hard TTL is how long we may serve stale totals.
 */
const CACHE_HARD_TTL_SEC = 30 * 60;
const CACHE_SOFT_TTL_MS = 60 * 1000;
/** Pipeline aggregates — bump when Complete / Returned / sold-through model changes. */
const CACHE_KEY_PIPELINE = 'stock-cost:pipeline-maps:v8';
/** Single-flight lock so dashboard opens don't stampede Google Sheets. */
const REFRESH_LOCK_KEY = 'stock-cost:pipeline-refresh-lock:v1';
const REFRESH_LOCK_SEC = 90;
/** Throttle Blue30→Delivered + Home/Prep→sent + Final→Complete/Returned value writes. */
const SYNC_THROTTLE_KEY = 'stock-cost:delivered-sync:v6';
const SYNC_THROTTLE_SEC = 120;
/**
 * One-shot (then periodic) Final color backfill. Absent → force format even when
 * value-sync is throttled. Set to "done" after a successful format pass; TTL lets
 * greys get re-fixed if someone clears colors later.
 */
const FORMAT_FORCE_KEY = 'stock-cost:final-format-force:v1';
const FORMAT_FORCE_DONE_TTL_SEC = 6 * 60 * 60;
/**
 * One-shot (then periodic) Final Complete/Returned → Home/Prep=sent backfill.
 * Sold ⇒ must have been sent; absent key forces the pass even when value-sync
 * is throttled.
 */
const SENT_FORCE_KEY = 'stock-cost:home-prep-sent-force:v1';
const SENT_FORCE_DONE_TTL_SEC = 6 * 60 * 60;

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
  completeUpdated: number;
  completeUpdates: FinalCompleteUpdate[];
  returnedUpdated: number;
  returnedUpdates: FinalReturnedUpdate[];
  formatsUpdated: number;
  formatUpdates: FinalStatusFormatUpdate[];
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
  /** Epoch ms when this snapshot was written (SWR soft TTL). */
  cachedAt?: number;
};

type SheetReadOpts = {
  amazonHeldByAsin?: Map<string, number>;
  soldByAsin?: Map<string, number>;
  returnedByAsin?: Map<string, number>;
  /**
   * When true, wait for sync+fresh read (scripts / admin). Dashboard path
   * leaves this false so HTTP can return cached/read-only maps immediately.
   */
  awaitSync?: boolean;
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
      cachedAt: Date.now(),
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

  private async readPipelineCache(): Promise<{
    snapshot: SheetStageSnapshots;
    cachedAt: number;
  } | null> {
    try {
      const raw = await this.redis.get(CACHE_KEY_PIPELINE);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedJsonMaps;
      return {
        snapshot: this.jsonToMaps(parsed),
        cachedAt: Number(parsed.cachedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  private async writePipelineCache(snapshot: SheetStageSnapshots): Promise<void> {
    try {
      await this.redis.set(
        CACHE_KEY_PIPELINE,
        JSON.stringify(this.mapsToJson(snapshot)),
        CACHE_HARD_TTL_SEC,
      );
    } catch {
      // ignore cache write errors
    }
  }

  async invalidatePipelineCache(): Promise<void> {
    try {
      await this.redis.del(CACHE_KEY_PIPELINE);
    } catch {
      // ignore
    }
  }

  /** True when soft TTL expired or sheet force backfills still pending. */
  private async shouldRevalidatePipelineMaps(cachedAt: number): Promise<boolean> {
    if (!(cachedAt > 0) || Date.now() - cachedAt >= CACHE_SOFT_TTL_MS) {
      return true;
    }
    if (await this.isFinalFormatForceNeeded()) return true;
    if (await this.isHomePrepSentForceNeeded()) return true;
    return false;
  }

  /**
   * Single-flight background: sync sheet stages (writes) then refresh Redis maps.
   * Dashboard HTTP never awaits this — last-good cache is served instead.
   */
  private schedulePipelineMapsRefresh(opts?: SheetReadOpts): void {
    void this.runPipelineMapsRefresh(opts).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Stock-cost pipeline background refresh failed: ${msg}`);
    });
  }

  private async runPipelineMapsRefresh(opts?: SheetReadOpts): Promise<void> {
    let locked = false;
    try {
      locked = await this.redis.setIfNotExistsWithExpiry(
        REFRESH_LOCK_KEY,
        '1',
        REFRESH_LOCK_SEC,
      );
    } catch {
      locked = true; // Redis down — still attempt once
    }
    if (!locked) return;

    try {
      const sync = await this.syncBlue30ReceivedToPurchaseDelivered({
        amazonHeldByAsin: opts?.amazonHeldByAsin,
        soldByAsin: opts?.soldByAsin,
        returnedByAsin: opts?.returnedByAsin,
      });
      const snapshot = await this.readSheetMapsOnly(sync);
      await this.writePipelineCache(snapshot);
    } finally {
      try {
        await this.redis.del(REFRESH_LOCK_KEY);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Read-only CURRENT ORDERS → stage maps (no Blue30/Delivered/format writes).
   * Used for cold dashboard paint and after background sync.
   */
  private async readSheetMapsOnly(
    sync?: DeliveredSyncResult,
  ): Promise<SheetStageSnapshots> {
    const errors: string[] = [...(sync?.errors ?? [])];
    let purchaseInTransit = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['inTransit'];
    let purchaseDelivered = [] as ReturnType<
      typeof parsePurchaseSheetStageRows
    >['delivered'];
    let purchaseSheetOk = false;
    let blue30Ok = sync
      ? sync.attempted && sync.errors.length === 0
      : Boolean(this.blue30SpreadsheetId() && this.sheets.isAuthConfigured());

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
    if (sync) {
      if (sync.updated > 0) {
        syncParts.push(`synced Delivered=Yes on ${sync.updated} row(s)`);
      }
      if (sync.sentUpdated > 0) {
        syncParts.push(
          `synced Home/Prep=${HOME_PREP_SENT_VALUE} on ${sync.sentUpdated} row(s)`,
        );
      }
      if (sync.completeUpdated > 0) {
        syncParts.push(
          `synced Final=${PURCHASE_SHEET_COMPLETE_VALUE} on ${sync.completeUpdated} row(s)`,
        );
      }
      if (sync.returnedUpdated > 0) {
        syncParts.push(
          `synced Final=${PURCHASE_SHEET_RETURNED_VALUE} on ${sync.returnedUpdated} row(s)`,
        );
      }
      if (sync.formatsUpdated > 0) {
        syncParts.push(`formatted ${sync.formatsUpdated} Final status cell(s)`);
      }
      if (syncParts.length === 0 && sync.skippedThrottle) {
        syncParts.push('sheet stage sync throttled');
      }
    } else {
      syncParts.push('read-only (sync deferred)');
    }

    return {
      purchasedByAsin,
      arrivedByAsin,
      sheetSentByAsin,
      purchaseSheetOk,
      blue30Ok,
      errors,
      sourceNote: syncParts.join('; '),
    };
  }

  /** True when Final Complete/Returned colors must be force-applied (bypass value-sync throttle). */
  private async isFinalFormatForceNeeded(): Promise<boolean> {
    try {
      const done = await this.redis.get(FORMAT_FORCE_KEY);
      return done !== 'done';
    } catch {
      return true;
    }
  }

  private async markFinalFormatForceDone(): Promise<void> {
    try {
      await this.redis.set(FORMAT_FORCE_KEY, 'done', FORMAT_FORCE_DONE_TTL_SEC);
    } catch {
      // ignore
    }
  }

  /** True when Final Complete/Returned → Home/Prep=sent must run (bypass value-sync throttle). */
  private async isHomePrepSentForceNeeded(): Promise<boolean> {
    try {
      const done = await this.redis.get(SENT_FORCE_KEY);
      return done !== 'done';
    } catch {
      return true;
    }
  }

  private async markHomePrepSentForceDone(): Promise<void> {
    try {
      await this.redis.set(SENT_FORCE_KEY, 'done', SENT_FORCE_DONE_TTL_SEC);
    } catch {
      // ignore
    }
  }

  /**
   * Sold ⇒ must have been sent. Force Home/Prep (and literal To Amazon when
   * separate) to "sent" on every Final Complete/Returned row that still says
   * HOME / PREP CENTER / blank. Does not touch £/Unit or Final colors.
   */
  private async applyHomePrepSentFromFinalSold(opts: {
    tab: string;
    purchaseValues: unknown[][];
    homePrepColIndex0: number;
    toAmazonColIndex0: number;
    finalColIndex0: number;
    /** Rows we just marked Complete/Returned — also ensure sent. */
    ensureSentSheetRows?: number[];
  }): Promise<{ sentUpdates: HomePrepSentUpdate[]; errors: string[] }> {
    const errors: string[] = [];
    if (opts.homePrepColIndex0 < 0 || opts.finalColIndex0 < 0) {
      return { sentUpdates: [], errors };
    }

    const sentUpdates = planHomePrepSentUpdatesFromFinalSoldValues({
      values: opts.purchaseValues,
      homePrepColIndex0: opts.homePrepColIndex0,
      finalColIndex0: opts.finalColIndex0,
    });

    const seen = new Set(sentUpdates.map((u) => u.sheetRow));
    for (const sheetRow of opts.ensureSentSheetRows ?? []) {
      if (seen.has(sheetRow)) continue;
      const row = opts.purchaseValues[sheetRow - 1] ?? [];
      if (isPurchaseSheetHomePrepSent(row[opts.homePrepColIndex0])) continue;
      seen.add(sheetRow);
      sentUpdates.push({
        sheetRow,
        homePrepColIndex0: opts.homePrepColIndex0,
        asin: '',
        orderRef: '',
        qty: 0,
      });
    }

    if (sentUpdates.length === 0) {
      this.logger.log(
        `Final→Home/Prep sent: no Complete/Returned rows need Home/Prep=${HOME_PREP_SENT_VALUE} on "${opts.tab}"`,
      );
      await this.markHomePrepSentForceDone();
      return { sentUpdates, errors };
    }

    const homeColLetter = colIndexToA1(opts.homePrepColIndex0);
    const valueWrites: Array<{ range: string; values: string[][] }> =
      sentUpdates.map((u) => ({
        range: `'${opts.tab}'!${homeColLetter}${u.sheetRow}`,
        values: [[HOME_PREP_SENT_VALUE]],
      }));

    // Separate literal To Amazon column (if present and distinct).
    if (opts.toAmazonColIndex0 >= 0) {
      const toAmzLetter = colIndexToA1(opts.toAmazonColIndex0);
      for (const u of sentUpdates) {
        const row = opts.purchaseValues[u.sheetRow - 1] ?? [];
        if (isPurchaseSheetHomePrepSent(row[opts.toAmazonColIndex0])) continue;
        valueWrites.push({
          range: `'${opts.tab}'!${toAmzLetter}${u.sheetRow}`,
          values: [[HOME_PREP_SENT_VALUE]],
        });
      }
    }

    await this.sheets.batchUpdateValues(valueWrites);
    this.logger.log(
      `Final→Home/Prep sent: set Home/Prep=${HOME_PREP_SENT_VALUE} on ${sentUpdates.length} CURRENT ORDERS row(s) (sold ⇒ sent)`,
    );
    await this.markHomePrepSentForceDone();
    return { sentUpdates, errors };
  }

  /**
   * Force-apply green/red on every Final cell whose text is Complete/Returned
   * (case-insensitive). Scans raw column values — not just rows we just wrote.
   */
  private async applyFinalStatusFormats(opts: {
    tab: string;
    purchaseValues: unknown[][];
    finalColIndex0: number;
    completeUpdates: FinalCompleteUpdate[];
    returnedUpdates: FinalReturnedUpdate[];
  }): Promise<{ formatUpdates: FinalStatusFormatUpdate[]; errors: string[] }> {
    const errors: string[] = [];
    if (opts.finalColIndex0 < 0) {
      return { formatUpdates: [], errors };
    }

    const formatUpdates = planFinalStatusFormatUpdatesFromValues({
      values: opts.purchaseValues,
      finalColIndex0: opts.finalColIndex0,
    });

    // Ensure rows we just wrote are included even if the sheet re-read lagged.
    for (const u of opts.completeUpdates) {
      if (formatUpdates.some((f) => f.sheetRow === u.sheetRow)) continue;
      const fmt = resolvePurchaseSheetFinalStatusFormat(
        PURCHASE_SHEET_COMPLETE_VALUE,
      );
      if (!fmt) continue;
      formatUpdates.push({
        sheetRow: u.sheetRow,
        finalColIndex0: opts.finalColIndex0,
        status: fmt.status,
        backgroundColor: fmt.backgroundColor,
        foregroundColor: fmt.foregroundColor,
      });
    }
    for (const u of opts.returnedUpdates) {
      if (formatUpdates.some((f) => f.sheetRow === u.sheetRow)) continue;
      const fmt = resolvePurchaseSheetFinalStatusFormat(
        PURCHASE_SHEET_RETURNED_VALUE,
      );
      if (!fmt) continue;
      formatUpdates.push({
        sheetRow: u.sheetRow,
        finalColIndex0: opts.finalColIndex0,
        status: fmt.status,
        backgroundColor: fmt.backgroundColor,
        foregroundColor: fmt.foregroundColor,
      });
    }

    if (formatUpdates.length === 0) {
      this.logger.log(
        `Final status colors: no Complete/Returned cells to format on "${opts.tab}"`,
      );
      await this.markFinalFormatForceDone();
      return { formatUpdates, errors };
    }

    const sheetId = await this.sheets.getSheetIdByTitle(opts.tab);
    if (sheetId == null) {
      const msg = `CURRENT ORDERS: could not resolve sheetId for tab "${opts.tab}" (format skipped)`;
      errors.push(msg);
      this.logger.error(msg);
      return { formatUpdates: [], errors };
    }

    const completeN = formatUpdates.filter((f) => f.status === 'Complete').length;
    const returnedN = formatUpdates.filter((f) => f.status === 'Returned').length;
    this.logger.log(
      `Final status colors: applying sheetId=${sheetId} tab="${opts.tab}" col=${opts.finalColIndex0} complete=${completeN} returned=${returnedN} total=${formatUpdates.length}`,
    );

    const applied = await this.sheets.batchUpdateCellFormats(
      formatUpdates.map((f) => ({
        sheetId,
        sheetRow: f.sheetRow,
        colIndex0: f.finalColIndex0,
        backgroundColor: f.backgroundColor,
        foregroundColor: f.foregroundColor,
      })),
    );
    this.logger.log(
      `Final status colors: reformatted ${applied} Complete/Returned cell(s) (${completeN} green, ${returnedN} red)`,
    );
    await this.markFinalFormatForceDone();
    return { formatUpdates, errors };
  }

  /**
   * 1) Blue30 Quantity Received → CURRENT ORDERS Delivered=Yes
   * 2) Amazon reached (held + sold) → Home/Prep = "sent" on covered Delivered rows
   * 3) Amazon fulfilled sales → Final = Complete on covered sent rows (green)
   * 4) Amazon returned/refunded → Final = Returned on covered Complete rows (red)
   * 5) Final Complete/Returned → Home/Prep=sent (sold ⇒ must have been sent)
   * 6) Force Final cell color backfill for ALL Complete / Returned (raw column scan)
   * Never rewrites £/Unit or Units.
   *
   * Value writes are throttled; Final→sent and format backfills bypass that
   * throttle until their one-shot force keys are marked done (then every 6h).
   */
  async syncBlue30ReceivedToPurchaseDelivered(opts?: {
    force?: boolean;
    amazonHeldByAsin?: Map<string, number>;
    soldByAsin?: Map<string, number>;
    returnedByAsin?: Map<string, number>;
  }): Promise<DeliveredSyncResult> {
    const empty: DeliveredSyncResult = {
      attempted: false,
      skippedThrottle: false,
      updated: 0,
      updates: [],
      sentUpdated: 0,
      sentUpdates: [],
      completeUpdated: 0,
      completeUpdates: [],
      returnedUpdated: 0,
      returnedUpdates: [],
      formatsUpdated: 0,
      formatUpdates: [],
      errors: [],
    };

    if (!this.sheets.isConfigured()) {
      return { ...empty, errors: ['Purchase Google Sheet not configured'] };
    }

    const formatForceNeeded =
      opts?.force === true || (await this.isFinalFormatForceNeeded());
    const sentForceNeeded =
      opts?.force === true || (await this.isHomePrepSentForceNeeded());

    let valueSyncThrottled = false;
    if (!opts?.force) {
      try {
        const throttled = await this.redis.get(SYNC_THROTTLE_KEY);
        valueSyncThrottled = Boolean(throttled);
      } catch {
        // proceed without throttle if Redis unavailable
      }
    }

    // Value sync + format + sold→sent backfills all idle → skip entirely.
    if (valueSyncThrottled && !formatForceNeeded && !sentForceNeeded) {
      return { ...empty, skippedThrottle: true };
    }

    const errors: string[] = [];
    let deliveredUpdates: DeliveredYesUpdate[] = [];
    let sentUpdates: HomePrepSentUpdate[] = [];
    let completeUpdates: FinalCompleteUpdate[] = [];
    let returnedUpdates: FinalReturnedUpdate[] = [];
    let formatUpdates: FinalStatusFormatUpdate[] = [];
    const runValueSync = !valueSyncThrottled;

    try {
      const tab = this.currentTabTitle();
      const b30Id = this.blue30SpreadsheetId();
      const canReadBlue30 =
        runValueSync && Boolean(b30Id) && this.sheets.isAuthConfigured();
      const b30Tab = this.blue30TabTitle();

      // Parallel first paint of CURRENT ORDERS + Blue30 (independent spreadsheets).
      const [purchaseValuesInitial, blue30ValuesInitial] = await Promise.all([
        this.sheets.getValues(`'${tab}'!A1:AZ`),
        canReadBlue30
          ? this.sheets.getValues(`'${b30Tab}'!A1:AZ`, b30Id)
          : Promise.resolve(null as unknown[][] | null),
      ]);

      let purchaseValues = purchaseValuesInitial;
      let parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
      errors.push(...parsedPurchase.errors);

      const header = (purchaseValues[0] ?? []).map((h) => String(h ?? ''));
      const deliveredColIndex0 = findHeaderColumnIndex(header, ['Delivered']);
      const homePrepColIndex0 = findPurchaseSheetHomePrepColumnIndex(header);
      const toAmazonColIndex0 = findPurchaseSheetToAmazonColumnIndex(
        header,
        homePrepColIndex0,
      );
      const finalColIndex0 = findPurchaseSheetFinalColumnIndex(header);

      if (deliveredColIndex0 < 0) {
        errors.push('CURRENT ORDERS: Delivered column not found');
      }

      if (runValueSync) {
        if (canReadBlue30 && deliveredColIndex0 >= 0 && blue30ValuesInitial) {
          const parsedB30 = parseBlue30ArrivedRows(blue30ValuesInitial);
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
            purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
            parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
            errors.push(...parsedPurchase.errors);
          }
        } else if (!b30Id || !this.sheets.isAuthConfigured()) {
          errors.push('Blue30 Inbound sheet not configured');
        }

        const held = opts?.amazonHeldByAsin;
        const sold = opts?.soldByAsin;
        const returned = opts?.returnedByAsin;
        if (held && homePrepColIndex0 >= 0) {
          sentUpdates = planHomePrepSentUpdatesFromAmazonHeld({
            purchaseDelivered: parsedPurchase.delivered,
            homePrepColIndex0,
            amazonHeldByAsin: held,
            soldByAsin: sold,
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
            purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
            parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
            errors.push(...parsedPurchase.errors);
          }
        } else if (held && homePrepColIndex0 < 0) {
          errors.push('CURRENT ORDERS: Home/Prep column not found');
        }

        if (sold && finalColIndex0 >= 0) {
          completeUpdates = planFinalCompleteUpdatesFromSold({
            purchaseDelivered: parsedPurchase.delivered,
            finalColIndex0,
            soldByAsin: sold,
          });

          if (completeUpdates.length > 0) {
            const colLetter = colIndexToA1(finalColIndex0);
            await this.sheets.batchUpdateValues(
              completeUpdates.map((u) => ({
                range: `'${tab}'!${colLetter}${u.sheetRow}`,
                values: [[PURCHASE_SHEET_COMPLETE_VALUE]],
              })),
            );
            this.logger.log(
              `Amazon sales→Final sync: set Final=${PURCHASE_SHEET_COMPLETE_VALUE} on ${completeUpdates.length} CURRENT ORDERS row(s)`,
            );
            purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
            parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
            errors.push(...parsedPurchase.errors);
          }
        } else if (sold && finalColIndex0 < 0) {
          errors.push(
            'CURRENT ORDERS: Final/Complete column not found (expected Final or status column after Home/Prep)',
          );
        }

        if (returned && finalColIndex0 >= 0) {
          returnedUpdates = planFinalReturnedUpdatesFromReturns({
            purchaseDelivered: parsedPurchase.delivered,
            finalColIndex0,
            returnedByAsin: returned,
          });

          if (returnedUpdates.length > 0) {
            const colLetter = colIndexToA1(finalColIndex0);
            await this.sheets.batchUpdateValues(
              returnedUpdates.map((u) => ({
                range: `'${tab}'!${colLetter}${u.sheetRow}`,
                values: [[PURCHASE_SHEET_RETURNED_VALUE]],
              })),
            );
            this.logger.log(
              `Amazon returns→Final sync: set Final=${PURCHASE_SHEET_RETURNED_VALUE} on ${returnedUpdates.length} CURRENT ORDERS row(s)`,
            );
            purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
            parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
            errors.push(...parsedPurchase.errors);
          }
        }
      } else {
        this.logger.log(
          'Sheet value sync throttled; running Final→sent / format-only backfill',
        );
      }

      // Sold ⇒ sent: backfill Home/Prep on every Complete/Returned (force or
      // after value writes that may have just set Final).
      const runSoldToSent =
        homePrepColIndex0 >= 0 &&
        finalColIndex0 >= 0 &&
        (sentForceNeeded ||
          runValueSync ||
          completeUpdates.length > 0 ||
          returnedUpdates.length > 0);
      if (runSoldToSent) {
        const soldSent = await this.applyHomePrepSentFromFinalSold({
          tab,
          purchaseValues,
          homePrepColIndex0,
          toAmazonColIndex0,
          finalColIndex0,
          ensureSentSheetRows: [
            ...completeUpdates.map((u) => u.sheetRow),
            ...returnedUpdates.map((u) => u.sheetRow),
          ],
        });
        errors.push(...soldSent.errors);
        if (soldSent.sentUpdates.length > 0) {
          const seen = new Set(sentUpdates.map((u) => u.sheetRow));
          for (const u of soldSent.sentUpdates) {
            if (seen.has(u.sheetRow)) continue;
            seen.add(u.sheetRow);
            sentUpdates.push(u);
          }
          purchaseValues = await this.sheets.getValues(`'${tab}'!A1:AZ`);
          parsedPurchase = parsePurchaseSheetStageRows(purchaseValues);
          errors.push(...parsedPurchase.errors);
        }
      } else if (
        sentForceNeeded &&
        (homePrepColIndex0 < 0 || finalColIndex0 < 0)
      ) {
        errors.push(
          'CURRENT ORDERS: Home/Prep or Final column not found (sold→sent backfill skipped)',
        );
      }

      // Always force-apply colors when format force is needed OR after value writes.
      if (finalColIndex0 >= 0 && (formatForceNeeded || runValueSync)) {
        const formatted = await this.applyFinalStatusFormats({
          tab,
          purchaseValues,
          finalColIndex0,
          completeUpdates,
          returnedUpdates,
        });
        formatUpdates = formatted.formatUpdates;
        errors.push(...formatted.errors);
      } else if (finalColIndex0 < 0 && formatForceNeeded) {
        errors.push(
          'CURRENT ORDERS: Final/Complete column not found (format backfill skipped)',
        );
      }

      if (
        deliveredUpdates.length > 0 ||
        sentUpdates.length > 0 ||
        completeUpdates.length > 0 ||
        returnedUpdates.length > 0
      ) {
        await this.invalidatePipelineCache();
      }

      if (runValueSync) {
        try {
          await this.redis.set(SYNC_THROTTLE_KEY, '1', SYNC_THROTTLE_SEC);
        } catch {
          // ignore
        }
      }

      return {
        attempted: true,
        skippedThrottle: !runValueSync,
        updated: deliveredUpdates.length,
        updates: deliveredUpdates,
        sentUpdated: sentUpdates.length,
        sentUpdates,
        completeUpdated: completeUpdates.length,
        completeUpdates,
        returnedUpdated: returnedUpdates.length,
        returnedUpdates,
        formatsUpdated: formatUpdates.length,
        formatUpdates,
        errors,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(
        `Blue30→Delivered / Home/Prep→sent / Final→Complete/Returned sync failed: ${msg}`,
      );
      this.logger.warn(`Sheet stage sync failed: ${msg}`);
      return {
        attempted: true,
        skippedThrottle: !runValueSync,
        updated: 0,
        updates: [],
        sentUpdated: 0,
        sentUpdates: [],
        completeUpdated: 0,
        completeUpdates: [],
        returnedUpdated: 0,
        returnedUpdates: [],
        formatsUpdated: 0,
        formatUpdates: [],
        errors,
      };
    }
  }

  /**
   * CURRENT ORDERS stage maps for the dashboard.
   *
   * Fast path: serve Redis last-good immediately (even stale / while format or
   * sold→sent force is pending). Sheet writes + re-read run in the background.
   * Cold miss: one read-only sheet fetch, cache it, then sync async.
   * Pass `awaitSync: true` for scripts that must flip cells before returning.
   */
  async getPurchasedAndArrivedByAsin(
    opts?: SheetReadOpts,
  ): Promise<SheetStageSnapshots> {
    if (opts?.awaitSync) {
      const sync = await this.syncBlue30ReceivedToPurchaseDelivered({
        amazonHeldByAsin: opts?.amazonHeldByAsin,
        soldByAsin: opts?.soldByAsin,
        returnedByAsin: opts?.returnedByAsin,
      });
      const snapshot = await this.readSheetMapsOnly(sync);
      await this.writePipelineCache(snapshot);
      return snapshot;
    }

    const cached = await this.readPipelineCache();
    if (cached) {
      if (await this.shouldRevalidatePipelineMaps(cached.cachedAt)) {
        this.schedulePipelineMapsRefresh(opts);
      }
      return cached.snapshot;
    }

    // Cold miss: read-only paint, then sync/writes off the HTTP path.
    const snapshot = await this.readSheetMapsOnly();
    await this.writePipelineCache(snapshot);
    this.schedulePipelineMapsRefresh(opts);
    return snapshot;
  }
}
