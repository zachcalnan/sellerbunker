import { parseCheckoutAddressFromSheet } from './purchase-sheet-checkout-address.util';

describe('purchase-sheet-checkout-address.util', () => {
  it('parses label/value rows from COPY SHEET tabs', () => {
    const values = [
      ['Email', 'rugby.4.lif3@hotmail.com'],
      ['First name', 'ZEFA'],
      ['Last name', 'B30-1234'],
      ['Address', 'Great Stambridge Hall'],
      ['Address line 2', 'Stambridge'],
      ['City', 'Rochford'],
      ['Postcode', 'SS4 2BF'],
      ['Phone', '07123456789'],
      ['Prep ID', 'B30-1234'],
    ];
    const { address, errors } = parseCheckoutAddressFromSheet(values);
    expect(errors).toEqual([]);
    expect(address).toMatchObject({
      email: 'rugby.4.lif3@hotmail.com',
      firstName: 'ZEFA',
      lastName: 'B30-1234',
      address1: 'Great Stambridge Hall',
      address2: 'Stambridge',
      city: 'Rochford',
      postcode: 'SS4 2BF',
      phone: '07123456789',
      prepId: 'B30-1234',
      country: 'United Kingdom',
    });
  });

  it('parses header + data row layout', () => {
    const values = [
      ['Email', 'First name', 'Last name', 'Address', 'City', 'Postcode'],
      [
        'buyer@example.com',
        'Jane',
        'Doe',
        '1 High Street',
        'London',
        'SW1A 1AA',
      ],
    ];
    const { address, errors } = parseCheckoutAddressFromSheet(values);
    expect(errors).toEqual([]);
    expect(address.email).toBe('buyer@example.com');
    expect(address.firstName).toBe('Jane');
    expect(address.postcode).toBe('SW1A 1AA');
  });

  it('reports missing required fields', () => {
    const { errors } = parseCheckoutAddressFromSheet([['Email', 'a@b.com']]);
    expect(errors).toContain('missing firstName');
    expect(errors).toContain('missing postcode');
  });
});
