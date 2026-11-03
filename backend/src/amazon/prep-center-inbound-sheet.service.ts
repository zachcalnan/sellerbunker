import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsClient } from './google-sheets.client';
import { findAsinColumnIndex } from './purchase-sheet-cogs.util';
import { normalizeShipDestinationLabel } from './purchase-sheet-order-write.service';
import {
  PREP_INBOUND_WRITABLE_COLUMN_LIMIT,
  buildPrepInboundRowForHeader,
  collectPrepInboundExistingKeys,
  findPrepInboundHeaderRowIndex,
  findPrepInboundNextEmptyRow1Based,
  formatPrepInboundDate,
  prepInboundDuplicateKey,
  type PrepInboundAppendInput,
} from './prep-center-inbound-sheet.util';
import { colIndexToA1 } from './purchase-sheet-cogs.util';

export type AppendPrepInboundResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  spreadsheetId: string;
  tabTitle: string;
  appended: number;
  skippedDuplicate: number;
  sheetRowNumbers: number[];
  errors: string[];
  /** Present on access-check / share guidance. */
  shareWithEmail?: string;
};

@Injectable()
export class PrepCenterInboundSheetService {
  private readonly logger = new Logger(PrepCenterInboundSheetService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sheets: GoogleSheetsClient,
  ) {}

  getSpreadsheetId(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_PREP_INBOUND_SPREADSHEET_ID')?.trim() ||
      ''
    );
  }

  private tabTitle(): string {
    return (
      this.config.get<string>('GOOGLE_SHEETS_PREP_INBOUND_TAB')?.trim() ||
      'Inbound'
    );
  }

  isConfigured(): boolean {
    return Boolean(this.sheets.isAuthConfigured() && this.getSpreadsheetId());
  }

  /**
   * Probe read access to the Blue30 Inbound sheet.
   * Use this to confirm the sheet was shared with the service account.
   */
  async checkAccess(): Promise<{
    configured: boolean;
    spreadsheetId: string;
    tabTitle: string;
    shareWithEmail: string;
    ok: boolean;
    headerRowIndex: number | null;
    headerPreview: string[];
    errors: string[];
    howToShare: string[];
  }> {
    const spreadsheetId = this.getSpreadsheetId();
    const tabTitle = this.tabTitle();
    const shareWithEmail = this.sheets.getClientEmail();
    const howToShare = [
      'Open the Blue30 spreadsheet in Google Sheets.',
      'Click Share.',
      `Add ${shareWithEmail || '(GOOGLE_SHEETS_CLIENT_EMAIL)'} as Editor.`,
      'Uncheck “Notify people” if you prefer, then Share.',
      'If Share is greyed out, only the owner (prep centre) can grant Editor — ask them, or ask for a copy you own.',
    ];

    if (!this.sheets.isAuthConfigured()) {
      return {
        configured: false,
        spreadsheetId,
        tabTitle,
        shareWithEmail,
        ok: false,
        headerRowIndex: null,
        headerPreview: [],
        errors: ['Google Sheets service account credentials not configured'],
        howToShare,
      };
    }
    if (!spreadsheetId) {
      return {
        configured: false,
        spreadsheetId,
        tabTitle,
        shareWithEmail,
        ok: false,
        headerRowIndex: null,
        headerPreview: [],
        errors: ['GOOGLE_SHEETS_PREP_INBOUND_SPREADSHEET_ID not set'],
        howToShare,
      };
    }

    try {
      const values = await this.sheets.getValues(
        `'${tabTitle}'!A1:AZ40`,
        spreadsheetId,
      );
      const headerRowIndex = findPrepInboundHeaderRowIndex(values);
      if (headerRowIndex < 0) {
        return {
          configured: true,
          spreadsheetId,
          tabTitle,
          shareWithEmail,
          ok: false,
          headerRowIndex: null,
          headerPreview: [],
          errors: [
            `Could not find Inbound header row on tab "${tabTitle}" (need Date/Order Reference/ASIN columns)`,
          ],
          howToShare,
        };
      }
      const header = (values[headerRowIndex] ?? []).map((h) => String(h ?? ''));
      return {
        configured: true,
        spreadsheetId,
        tabTitle,
        shareWithEmail,
        ok: true,
        headerRowIndex,
        headerPreview: header.filter(Boolean).slice(0, 16),
        errors: [],
        howToShare,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const permissionDenied =
        /permission|forbidden|403|does not have permission/i.test(msg);
      return {
        configured: true,
        spreadsheetId,
        tabTitle,
        shareWithEmail,
        ok: false,
        headerRowIndex: null,
        headerPreview: [],
        errors: [
          permissionDenied
            ? `No access yet — share the sheet as Editor with ${shareWithEmail}. (${msg})`
            : msg,
        ],
        howToShare,
      };
    }
  }

  /**
   * Append inbound lines when ship-to is PREP CENTER.
   * No-op (ok + skipped) for HOME / unset / unconfigured.
   */
  async appendIfPrepCenter(
    input: PrepInboundAppendInput & {
      shipDestination?: string | null;
    },
  ): Promise<AppendPrepInboundResult> {
    const tabTitle = this.tabTitle();
    const spreadsheetId = this.getSpreadsheetId();
    const shareWithEmail = this.sheets.getClientEmail();
    const dest = normalizeShipDestinationLabel(input.shipDestination);

    if (dest !== 'PREP CENTER') {
      return {
        ok: true,
        skipped: true,
        reason: 'shipDestination is not PREP CENTER',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: [],
        shareWithEmail,
      };
    }

    if (!this.isConfigured()) {
      return {
        ok: false,
        skipped: true,
        reason: 'Prep inbound Google Sheet not configured',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: [
          'Set GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY, and GOOGLE_SHEETS_PREP_INBOUND_SPREADSHEET_ID',
        ],
        shareWithEmail,
      };
    }

    const errors: string[] = [];
    let values: string[][];
    try {
      values = await this.sheets.getValues(
        `'${tabTitle}'!A1:AZ`,
        spreadsheetId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const permissionDenied =
        /permission|forbidden|403|does not have permission/i.test(msg);
      return {
        ok: false,
        skipped: false,
        reason: permissionDenied ? 'sheet_not_shared' : 'read_failed',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: [
          permissionDenied
            ? `Share this spreadsheet as Editor with ${shareWithEmail}`
            : msg,
        ],
        shareWithEmail,
      };
    }

    const headerRowIndex = findPrepInboundHeaderRowIndex(values);
    if (headerRowIndex < 0) {
      return {
        ok: false,
        skipped: false,
        reason: 'header_not_found',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['Inbound header row not found'],
        shareWithEmail,
      };
    }

    const header = (values[headerRowIndex] ?? []).map((h) => String(h ?? ''));
    if (findAsinColumnIndex(header) < 0) {
      return {
        ok: false,
        skipped: false,
        reason: 'asin_column_missing',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate: 0,
        sheetRowNumbers: [],
        errors: ['ASIN column not found on Inbound sheet'],
        shareWithEmail,
      };
    }

    const existingKeys = collectPrepInboundExistingKeys(
      values,
      headerRowIndex,
      header,
    );
    const dateStr = formatPrepInboundDate(input.purchaseDate);
    const orderRef = input.orderNumber.trim();
    const rowsToAppend: (string | number)[][] = [];
    const sheetRowNumbers: number[] = [];
    let skippedDuplicate = 0;
    // INSERT_ROWS fails on Blue30 (protected check-in columns). Write into
    // the next empty intake row and only touch writable columns A–L.
    let nextRow = findPrepInboundNextEmptyRow1Based(
      values,
      headerRowIndex,
      header,
    );

    for (const line of input.lines) {
      const asin = line.asin.trim().toUpperCase();
      if (!asin) continue;
      const key = prepInboundDuplicateKey(orderRef, asin);
      if (existingKeys.has(key)) {
        skippedDuplicate += 1;
        continue;
      }
      existingKeys.add(key);

      const qty = Math.max(1, Math.floor(line.qty) || 1);
      rowsToAppend.push(
        buildPrepInboundRowForHeader(header, {
          date: dateStr,
          orderReference: orderRef,
          courierTracking: input.courierTracking?.trim() || undefined,
          supplier: input.supplier.trim(),
          productName: line.productTitle?.trim() || asin,
          asin,
          sku: line.sku?.trim() || undefined,
          quantity: qty,
          bundleOf: line.bundleOf,
          notes: input.notes?.trim() || 'SB bot',
        }),
      );
      sheetRowNumbers.push(nextRow);
      nextRow += 1;
    }

    if (rowsToAppend.length === 0) {
      return {
        ok: true,
        skipped: false,
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
        shareWithEmail,
      };
    }

    try {
      const endCol = colIndexToA1(
        Math.max(rowsToAppend[0].length - 1, PREP_INBOUND_WRITABLE_COLUMN_LIMIT - 1),
      );
      const startRow = sheetRowNumbers[0];
      const endRow = sheetRowNumbers[sheetRowNumbers.length - 1];
      await this.sheets.updateValues(
        `'${tabTitle}'!A${startRow}:${endCol}${endRow}`,
        rowsToAppend,
        spreadsheetId,
      );
      this.logger.log(
        `Wrote ${rowsToAppend.length} row(s) to prep Inbound rows ${startRow}-${endRow} for order ${orderRef}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const protectedCell = /protected cell|protected range/i.test(msg);
      errors.push(
        protectedCell
          ? `${msg} — ask Blue30 to allow edits on Date→Notes columns, or add ${shareWithEmail} as an editor on protected ranges.`
          : msg,
      );
      return {
        ok: false,
        skipped: false,
        reason: protectedCell ? 'protected_range' : 'append_failed',
        spreadsheetId,
        tabTitle,
        appended: 0,
        skippedDuplicate,
        sheetRowNumbers: [],
        errors,
        shareWithEmail,
      };
    }

    return {
      ok: true,
      skipped: false,
      spreadsheetId,
      tabTitle,
      appended: rowsToAppend.length,
      skippedDuplicate,
      sheetRowNumbers,
      errors,
      shareWithEmail,
    };
  }
}
