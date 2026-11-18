import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, sheets_v4 } from 'googleapis';

@Injectable()
export class GoogleSheetsClient {
  private readonly logger = new Logger(GoogleSheetsClient.name);

  constructor(private readonly config: ConfigService) {}

  /** Service-account JWT credentials present (any spreadsheet). */
  isAuthConfigured(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_SHEETS_CLIENT_EMAIL')?.trim() &&
        this.config.get<string>('GOOGLE_SHEETS_PRIVATE_KEY')?.trim(),
    );
  }

  isConfigured(): boolean {
    return Boolean(
      this.isAuthConfigured() &&
        this.config.get<string>('GOOGLE_SHEETS_SPREADSHEET_ID')?.trim(),
    );
  }

  getClientEmail(): string {
    return String(this.config.get<string>('GOOGLE_SHEETS_CLIENT_EMAIL') ?? '').trim();
  }

  getSpreadsheetId(): string {
    return String(this.config.get<string>('GOOGLE_SHEETS_SPREADSHEET_ID') ?? '').trim();
  }

  private getAuth() {
    const clientEmail = this.config.get<string>('GOOGLE_SHEETS_CLIENT_EMAIL')?.trim();
    let privateKey = this.config.get<string>('GOOGLE_SHEETS_PRIVATE_KEY')?.trim();
    if (!clientEmail || !privateKey) {
      throw new Error('GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY not set');
    }
    // .env often stores literal \n sequences
    privateKey = privateKey.replace(/\\n/g, '\n');
    return new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  private sheets(): sheets_v4.Sheets {
    return google.sheets({ version: 'v4', auth: this.getAuth() });
  }

  private resolveSpreadsheetId(spreadsheetId?: string): string {
    const id = String(spreadsheetId ?? this.getSpreadsheetId()).trim();
    if (!id) {
      throw new Error('Google Sheets spreadsheet id not set');
    }
    return id;
  }

  async getValues(
    rangeA1: string,
    spreadsheetId?: string,
  ): Promise<string[][]> {
    const id = this.resolveSpreadsheetId(spreadsheetId);
    const res = await this.sheets().spreadsheets.values.get({
      spreadsheetId: id,
      range: rangeA1,
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    return (res.data.values ?? []) as string[][];
  }

  async updateValues(
    rangeA1: string,
    values: (string | number | null)[][],
    spreadsheetId?: string,
  ): Promise<void> {
    const id = this.resolveSpreadsheetId(spreadsheetId);
    await this.sheets().spreadsheets.values.update({
      spreadsheetId: id,
      range: rangeA1,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }

  /** Multi-range cell writes (e.g. flip several Delivered cells). */
  async batchUpdateValues(
    data: Array<{ range: string; values: (string | number | null)[][] }>,
    spreadsheetId?: string,
  ): Promise<void> {
    if (data.length === 0) return;
    const id = this.resolveSpreadsheetId(spreadsheetId);
    await this.sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: data.map((d) => ({
          range: d.range,
          values: d.values,
        })),
      },
    });
  }

  /**
   * Resolve numeric sheetId for a tab title (needed by spreadsheets.batchUpdate
   * repeatCell / grid ranges).
   */
  async getSheetIdByTitle(
    tabTitle: string,
    spreadsheetId?: string,
  ): Promise<number | null> {
    const id = this.resolveSpreadsheetId(spreadsheetId);
    const want = String(tabTitle ?? '').trim();
    if (!want) return null;
    const res = await this.sheets().spreadsheets.get({
      spreadsheetId: id,
      fields: 'sheets.properties(sheetId,title)',
    });
    const sheets = res.data.sheets ?? [];
    for (const s of sheets) {
      const title = String(s.properties?.title ?? '').trim();
      if (title === want && typeof s.properties?.sheetId === 'number') {
        return s.properties.sheetId;
      }
    }
    return null;
  }

  /**
   * Apply background + text color via repeatCell (userEnteredFormat).
   * `sheetRow` is 1-based (A1); `colIndex0` is 0-based.
   * Returns number of cells submitted (throws on API failure — never silent).
   */
  async batchUpdateCellFormats(
    cells: Array<{
      sheetId: number;
      sheetRow: number;
      colIndex0: number;
      backgroundColor: { red: number; green: number; blue: number };
      foregroundColor: { red: number; green: number; blue: number };
    }>,
    spreadsheetId?: string,
  ): Promise<number> {
    if (cells.length === 0) return 0;
    const id = this.resolveSpreadsheetId(spreadsheetId);
    const sheetId = cells[0]?.sheetId;
    this.logger.log(
      `batchUpdateCellFormats: spreadsheet=${id} sheetId=${sheetId} cells=${cells.length}`,
    );
    const chunkSize = 100;
    let applied = 0;
    for (let i = 0; i < cells.length; i += chunkSize) {
      const chunk = cells.slice(i, i + chunkSize);
      const requests: sheets_v4.Schema$Request[] = chunk.map((c) => {
        const row0 = Math.max(0, Math.floor(c.sheetRow) - 1);
        const col0 = Math.max(0, Math.floor(c.colIndex0));
        return {
          repeatCell: {
            range: {
              sheetId: c.sheetId,
              startRowIndex: row0,
              endRowIndex: row0 + 1,
              startColumnIndex: col0,
              endColumnIndex: col0 + 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: c.backgroundColor,
                textFormat: {
                  foregroundColor: c.foregroundColor,
                },
              },
            },
            fields:
              'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor',
          },
        };
      });
      try {
        await this.sheets().spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: { requests },
        });
        applied += chunk.length;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `batchUpdateCellFormats failed (spreadsheet=${id} sheetId=${sheetId} chunk=${i}-${i + chunk.length - 1}): ${msg}`,
        );
        throw e;
      }
    }
    this.logger.log(
      `batchUpdateCellFormats: applied ${applied}/${cells.length} cell format(s)`,
    );
    return applied;
  }

  async appendValues(
    rangeA1: string,
    values: (string | number | null)[][],
    spreadsheetId?: string,
  ): Promise<void> {
    const id = this.resolveSpreadsheetId(spreadsheetId);
    await this.sheets().spreadsheets.values.append({
      spreadsheetId: id,
      range: rangeA1,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  }

  async ensureHeaderColumns(
    tabTitle: string,
    requiredHeaders: string[],
    spreadsheetId?: string,
  ): Promise<{ header: string[]; colIndexByName: Record<string, number> }> {
    const range = `'${tabTitle}'!1:1`;
    const rows = await this.getValues(range, spreadsheetId);
    const header = [...(rows[0] ?? []).map((h) => String(h ?? ''))];
    const colIndexByName: Record<string, number> = {};
    for (let i = 0; i < header.length; i++) {
      colIndexByName[header[i].trim()] = i;
    }

    const missing = requiredHeaders.filter((h) => colIndexByName[h] == null);
    if (missing.length === 0) {
      return { header, colIndexByName };
    }

    const startCol = header.length;
    for (const h of missing) {
      header.push(h);
      colIndexByName[h] = header.length - 1;
    }
    // Write extended header row
    await this.updateValues(range, [header], spreadsheetId);
    this.logger.log(
      `Added sheet columns on ${tabTitle} starting at col ${startCol + 1}: ${missing.join(', ')}`,
    );
    return { header, colIndexByName };
  }
}
