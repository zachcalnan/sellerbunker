import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsClient } from './google-sheets.client';
import {
  CheckoutAddressProfile,
  parseCheckoutAddressFromSheet,
  type CheckoutAddressFields,
} from './purchase-sheet-checkout-address.util';

export type CheckoutAddressResult = {
  ok: boolean;
  profile: CheckoutAddressProfile;
  tabTitle: string;
  address: Partial<CheckoutAddressFields>;
  errors: string[];
};

@Injectable()
export class PurchaseSheetCheckoutAddressService {
  private readonly logger = new Logger(PurchaseSheetCheckoutAddressService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sheets: GoogleSheetsClient,
  ) {}

  isConfigured(): boolean {
    return this.sheets.isConfigured();
  }

  private tabForProfile(profile: CheckoutAddressProfile): string {
    const envKey = `GOOGLE_SHEETS_TAB_${profile.toUpperCase()}`;
    const fromEnv = this.config.get<string>(envKey)?.trim();
    if (fromEnv) return fromEnv;

    const defaults: Record<CheckoutAddressProfile, string> = {
      blue30: 'BLUE30 COPY SHEET',
      home: 'HOME COPY SHEET',
      ep_center: 'EP CENTER COPY SHEET',
      rep_center: 'REP CENTER COPY SHEET',
    };
    return defaults[profile];
  }

  async getCheckoutAddress(
    profile: CheckoutAddressProfile,
  ): Promise<CheckoutAddressResult> {
    const tabTitle = this.tabForProfile(profile);
    if (!this.sheets.isConfigured()) {
      return {
        ok: false,
        profile,
        tabTitle,
        address: {},
        errors: ['Google Sheets not configured'],
      };
    }

    try {
      const values = await this.sheets.getValues(`'${tabTitle}'!A1:Z50`);
      const { address, errors } = parseCheckoutAddressFromSheet(values);
      const ok = errors.length === 0;
      if (!ok) {
        this.logger.warn(
          `${profile} address incomplete on ${tabTitle}: ${errors.join(', ')}`,
        );
      }
      return { ok, profile, tabTitle, address, errors };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed reading ${tabTitle} (${profile}): ${msg}`);
      return { ok: false, profile, tabTitle, address: {}, errors: [msg] };
    }
  }

  async getAllCheckoutAddresses(): Promise<{
    profiles: CheckoutAddressResult[];
  }> {
    const profiles: CheckoutAddressProfile[] = [
      'blue30',
      'home',
      'ep_center',
      'rep_center',
    ];
    const results: CheckoutAddressResult[] = [];
    for (const profile of profiles) {
      results.push(await this.getCheckoutAddress(profile));
    }
    return { profiles: results };
  }
}
