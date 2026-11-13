import {
  isBlankProductCatalogAttr,
  parseFbaInventoryProductName,
} from './fba-inventory-summary-parse.util';

describe('parseFbaInventoryProductName', () => {
  it('reads productName from inventory summary', () => {
    expect(
      parseFbaInventoryProductName({
        sellerSku: '0D-806R-JR8R',
        asin: 'B0FLYMMYQR',
        productName:
          'Ninja Speedi 12-in-1 Multi-Cooker, Air Fryer and Slow Cooker, Grey ON500UK',
      }),
    ).toBe(
      'Ninja Speedi 12-in-1 Multi-Cooker, Air Fryer and Slow Cooker, Grey ON500UK',
    );
  });

  it('reads ProductName and trims', () => {
    expect(
      parseFbaInventoryProductName({ ProductName: '  Title  ' }),
    ).toBe('Title');
  });

  it('returns null when missing or blank', () => {
    expect(parseFbaInventoryProductName(null)).toBeNull();
    expect(parseFbaInventoryProductName({})).toBeNull();
    expect(parseFbaInventoryProductName({ productName: '  ' })).toBeNull();
  });
});

describe('isBlankProductCatalogAttr', () => {
  it('treats null/undefined/whitespace as blank', () => {
    expect(isBlankProductCatalogAttr(null)).toBe(true);
    expect(isBlankProductCatalogAttr(undefined)).toBe(true);
    expect(isBlankProductCatalogAttr('')).toBe(true);
    expect(isBlankProductCatalogAttr('  ')).toBe(true);
    expect(isBlankProductCatalogAttr('Ninja')).toBe(false);
  });
});
