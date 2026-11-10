import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsClient } from './google-sheets.client';
import { findAsinColumnIndex } from './purchase-sheet-cogs.util';
import { buildPurchaseSheetRowForHeader } from './purchase-sheet-row.util';
import {
  buildBlue30CopyRowForHeader,
  formatBlue30CopyDate,
  resolveBlue30CopyHomePrep,
} from './purchase-sheet-blue30-copy.util';

export type PurchaseSheetLineInput = {
  asin: string;
  productTitle?: string | null;
  sku?: string | null;
  qty: number;
  unitCostIncVat: number;
  deliveryCostIncVat?: number;
  prepCostIncVat?: number;
  /** CURRENT ORDERS Home/Prep column: HOME | PREP CENTER */
  shipDestination?: 'HOME' | 'PREP CENTER' | string | null;
  supplierLink?: string | null;
};

export type AppendPurchaseOrderInput = {
  supplier: string;
  orderNumber: string;
  purchaseDate: string;
  courierTracking?: string | null;
  lines: PurchaseSheetLineInput[];
};

export type AppendPurchaseOrderResult = {
  ok: boolean;
  tabTitle: string;
  appended: number;
  skippedDuplicate: number;
  sheetRowNumbers: number[];
  errors: string[];
};

export type AppendBlue30CopyResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  tabTitle: string;
  appended: number;
  skippedDuplicate: number;
  sheetRowNumbers: number[];
  errors: string[];
};

/** Map free-text / enum into the live sheet Home/Prep labels. */
export function normalizeShipDestinationLabel(
  raw: unknown,
): 'HOME' | 'PREP CENTER' | '' {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!s) return '';
  if (
    s === 'home' ||
    s === 'house' ||
    s.includes('home address') ||
    s === 'residential'
  ) {
    return 'HOME';
  }
  if (
    s === 'prep center' ||
    s === 'prep centre' ||
    s === 'prep' ||
    s.includes('prep center') ||
    s.includes('prep centre') ||
    s.includes('fulfilment') ||
    s.includes('fulfillment') ||
    s.includes('blue30') ||
    s.includes('ep center') ||
    s.includes('rep center') ||
    s === 'fc' ||
    s === 'amz' ||
    s === 'amazon'
  ) {
    return 'PREP CENTER';
  }
  if (s === 'home' || /^home\b/.test(s)) return 'HOME';
  return '';
}

@Injectable()
export class PurchaseSheetOrderWriteService {
  private readonly logger = new Logger(PurchaseSheetOrderWriteService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sheets: GoogleSheetsClient,
  ) {}

  isConfigured(): boolean {
    return this.sheets.isConfigured();
  }

  private currentTabTitle(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_TAB_CURRENT')?.trim() ||
      'CURRENT ORDERS'
    );
  }

  private blue30CopyTabTitle(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_TAB_BLUE30')?.trim() ||
      'BLUE30 COPY SHEET'
    );
  }

  private formatSheetDate(iso: string): string {
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '').trim());
    if (day) {
      // Avoid UTC/local Date parsing shifting the calendar day.
      return `${Number(day[2])}/${Number(day[3])}/${day[1]}`;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    // Match existing sheet style (M/D/YYYY).
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  }

  /**
   * Append paste-ready rows to BLUE30 COPY SHEET (Date→Qty + Home/Prep).
   * Used to reformat CURRENT ORDERS into Blue30 Inbound column order.
   * Writes HOME and PREP CENTER lines (same as the live tab).
   */
  async appendBlue30CopySheet(
    input: AppendPurchaseOrderInput,
  ): Promise<AppendBlue30CopyResult> {
    const tabTitle = this.blue30CopyTabTitle();
    const errors: string[] = [];
    if (!this.sheets.isConfigured()) {
      return {
        ok: false,
        skipped: true,
        reason: 'Google Sheets not configured',
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['Google Sheets not configured'],
      };
    }

    let values: string[][];
    try {
      values = await this.sheets.getValues(`'${tabTitle}'!A1:AZ`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        skipped: false,
        reason: 'read_failed',
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: [msg],
      };
    }

    if (!values.length) {
      return {
        ok: false,
        skipped: false,
        reason: 'empty_tab',
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['BLUE30 COPY SHEET tab is empty'],
      };
    }

    const header = (values[0] ?? []).map((h) => String(h ?? ''));
    const asinIdx = findAsinColumnIndex(header);
    if (asinIdx < 0) {
      return {
        ok: false,
        skipped: false,
        reason: 'asin_column_missing',
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['ASIN column not found on BLUE30 COPY SHEET'],
      };
    }

    const dateStr = formatBlue30CopyDate(input.purchaseDate);
    const orderRef = input.orderNumber.trim();
    const rowsToAppend: (string | number)[][] = [];
    const sheetRowNumbers: number[] = [];
    const skippedDuplicate = 0;
    let nextRow = values.length + 1;

    for (const line of input.lines) {
      const asin = line.asin.trim().toUpperCase();
      if (!asin) continue;

      const qty = Math.max(1, Math.floor(line.qty) || 1);
      rowsToAppend.push(
        buildBlue30CopyRowForHeader(header, {
          date: dateStr,
          orderReference: orderRef,
          courierTracking: input.courierTracking?.trim() || undefined,
          supplier: input.supplier.trim(),
          productName: line.productTitle?.trim() || asin,
          asin,
          sku: line.sku?.trim() || undefined,
          quantity: qty,
          homePrep: resolveBlue30CopyHomePrep(line.shipDestination),
        }),
      );
      sheetRowNumbers.push(nextRow);
      nextRow += 1;
    }

    if (rowsToAppend.length === 0) {
      return {
        ok: true,
        skipped: false,
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
      };
    }

    try {
      await this.sheets.appendValues(`'${tabTitle}'!A1`, rowsToAppend);
      this.logger.log(
        `Appended ${rowsToAppend.length} row(s) to ${tabTitle} for order ${orderRef}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      return {
        ok: false,
        skipped: false,
        reason: 'append_failed',
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
      };
    }

    return {
      ok: true,
      skipped: false,
      tabTitle,
      appended: rowsToAppend.length,
      skippedDuplicate,
      sheetRowNumbers,
      errors,
    };
  }

  /**
   * Append purchase lines to CURRENT ORDERS on the shared Google Sheet.
   * Always appends (no Order Num + ASIN duplicate skip) so retries can catch misses.
   */
  async appendPurchaseOrder(
    input: AppendPurchaseOrderInput,
  ): Promise<AppendPurchaseOrderResult> {
    const tabTitle = this.currentTabTitle();
    const errors: string[] = [];
    if (!this.sheets.isConfigured()) {
      return {
        ok: false,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['Google Sheets not configured'],
      };
    }

    const values = await this.sheets.getValues(`'${tabTitle}'!A1:AZ`);
    if (!values.length) {
      return {
        ok: false,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['Sheet tab is empty'],
      };
    }

    const header = (values[0] ?? []).map((h) => String(h ?? ''));
    const asinIdx = findAsinColumnIndex(header);
    if (asinIdx < 0) {
      return {
        ok: false,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['ASIN column not found on purchase sheet'],
      };
    }

    const dateStr = this.formatSheetDate(input.purchaseDate);
    const rowsToAppend: (string | number)[][] = [];
    const sheetRowNumbers: number[] = [];
    const skippedDuplicate = 0;
    let nextRow = values.length + 1;

    for (const line of input.lines) {
      const asin = line.asin.trim().toUpperCase();
      if (!asin) continue;

      const qty = Math.max(1, Math.floor(line.qty) || 1);
      const unit = Math.round((line.unitCostIncVat || 0) * 100) / 100;
      const prep = Math.round((line.prepCostIncVat ?? 0) * 100) / 100;
      const delivery = Math.round((line.deliveryCostIncVat ?? 0) * 100) / 100;
      const orderCost = Math.round((unit * qty + delivery + prep) * 100) / 100;
      const shipDestination = normalizeShipDestinationLabel(
        line.shipDestination,
      );

      const notes = [
        line.supplierLink?.trim() ? `Link: ${line.supplierLink.trim()}` : null,
        prep > 0 ? `Prep £${prep.toFixed(2)}` : null,
        'SB bot',
      ]
        .filter(Boolean)
        .join(' | ');

      rowsToAppend.push(
        buildPurchaseSheetRowForHeader(header, {
          date: dateStr,
          asin,
          product: line.productTitle?.trim() || asin,
          orderNum: input.orderNumber.trim(),
          orderCost,
          units: qty,
          unitCost: unit,
          supplier: input.supplier.trim(),
          notes,
          // Live sheet uses Home/Prep for destination (HOME / PREP CENTER), not £ prep.
          homePrep: shipDestination,
        }),
      );
      sheetRowNumbers.push(nextRow);
      nextRow += 1;
    }

    if (rowsToAppend.length === 0) {
      return {
        ok: true,
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
      };
    }

    try {
      // Use the table range (not A:A only) so multi-column rows append to the
      // CURRENT ORDERS block rather than a narrow single-column table.
      await this.sheets.appendValues(`'${tabTitle}'!A1`, rowsToAppend);
      this.logger.log(
        `Appended ${rowsToAppend.length} row(s) to ${tabTitle} for order ${input.orderNumber}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      return {
        ok: false,
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
      };
    }

    return {
      ok: true,
      tabTitle,
      appended: rowsToAppend.length,
      skippedDuplicate,
      sheetRowNumbers,
      errors,
    };
  }
}
