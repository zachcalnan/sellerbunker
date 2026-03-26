export type MarketplaceRegion = 'NA' | 'EU' | 'AUSTRALASIA';
export type MarketplaceActivityClass = 'HIGH' | 'MEDIUM' | 'INACTIVE';

export type MarketplaceDefinition = {
  marketplaceId: string;
  countryCode: string;
  displayName: string;
  flag: string;
  currencyCode: string;
  region: MarketplaceRegion;
};

export const MARKETPLACES: MarketplaceDefinition[] = [
  { marketplaceId: 'A1F83G8C2ARO7P', countryCode: 'GB', displayName: 'UK', flag: '🇬🇧', currencyCode: 'GBP', region: 'EU' },
  { marketplaceId: 'A1PA6795UKMFR9', countryCode: 'DE', displayName: 'Germany', flag: '🇩🇪', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'A13V1IB3VIYZZH', countryCode: 'FR', displayName: 'France', flag: '🇫🇷', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'APJ6JRA9NG5V4', countryCode: 'IT', displayName: 'Italy', flag: '🇮🇹', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'A1RKKUPIHCS9HS', countryCode: 'ES', displayName: 'Spain', flag: '🇪🇸', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'A1805IZSGTT6HS', countryCode: 'NL', displayName: 'Netherlands', flag: '🇳🇱', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'A28R8C7NBKEWEA', countryCode: 'IE', displayName: 'Ireland', flag: '🇮🇪', currencyCode: 'EUR', region: 'EU' },
  { marketplaceId: 'ATVPDKIKX0DER', countryCode: 'US', displayName: 'United States', flag: '🇺🇸', currencyCode: 'USD', region: 'NA' },
  { marketplaceId: 'A2EUQ1WTGCTBG2', countryCode: 'CA', displayName: 'Canada', flag: '🇨🇦', currencyCode: 'CAD', region: 'NA' },
  { marketplaceId: 'A1AM78C64UM0Y8', countryCode: 'MX', displayName: 'Mexico', flag: '🇲🇽', currencyCode: 'MXN', region: 'NA' },
  { marketplaceId: 'A1VC38T7YXB528', countryCode: 'JP', displayName: 'Japan', flag: '🇯🇵', currencyCode: 'JPY', region: 'AUSTRALASIA' },
  { marketplaceId: 'A39IBJ37TRP1C6', countryCode: 'AU', displayName: 'Australia', flag: '🇦🇺', currencyCode: 'AUD', region: 'AUSTRALASIA' },
];

export const MARKETPLACE_MAP = new Map(
  MARKETPLACES.map((m) => [m.marketplaceId, m]),
);
