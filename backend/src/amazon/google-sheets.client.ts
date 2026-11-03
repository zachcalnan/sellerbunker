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
