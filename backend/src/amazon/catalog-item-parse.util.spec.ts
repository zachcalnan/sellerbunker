import {
  normalizePurchaseAsin,
  parseCatalogItemImageUrl,
  parseCatalogItemTitle,
} from './catalog-item-parse.util';

describe('catalog-item-parse.util', () => {
  it('normalizePurchaseAsin trims and uppercases valid ASINs', () => {
    expect(normalizePurchaseAsin(' b0bx4px242 ')).toBe('B0BX4PX242');
    expect(normalizePurchaseAsin('nope')).toBeNull();
    expect(normalizePurchaseAsin('B0TOO_SHORT')).toBeNull();
  });

  it('parseCatalogItemTitle prefers marketplace summary itemName', () => {
    const payload = {
      summaries: [
        { marketplaceId: 'A1F83G8C2ARO7P', itemName: 'UK Title' },
        { marketplaceId: 'ATVPDKIKX0DER', itemName: 'US Title' },
      ],
    };
    expect(parseCatalogItemTitle(payload, 'A1F83G8C2ARO7P')).toBe('UK Title');
    expect(parseCatalogItemTitle({ payload }, 'ATVPDKIKX0DER')).toBe('US Title');
  });

  it('parseCatalogItemImageUrl picks MAIN image link', () => {
    const payload = {
      images: [
        {
          marketplaceId: 'A1F83G8C2ARO7P',
          images: [
            { variant: 'PT01', link: 'https://example.com/pt.jpg' },
            { variant: 'MAIN', link: 'https://example.com/main.jpg' },
          ],
        },
      ],
    };
    expect(parseCatalogItemImageUrl(payload, 'A1F83G8C2ARO7P')).toBe(
      'https://example.com/main.jpg',
    );
  });
});
