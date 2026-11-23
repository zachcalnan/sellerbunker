import {
  buildSalePushLabel,
  buildSalePushTexts,
} from './sale-push-profit.util';

describe('buildSalePushLabel', () => {
  it('does not show a sale as minus the sale price when fees swallowed the order', () => {
    const label = buildSalePushLabel({
      amount: 64.99,
      quantity: 1,
      costPerUnit: 20,
      feePerUnit: 10,
      signedFeesTotal: -64.99,
      computedProfit: -64.99,
    });
    expect(label).toBe('£34.99 profit');
    expect(label.startsWith('-')).toBe(false);
    expect(label.includes('-')).toBe(false);
  });

  it('keeps a real positive profit', () => {
    expect(
      buildSalePushLabel({
        amount: 64.99,
        costPerUnit: 30,
        signedFeesTotal: -12.4,
        computedProfit: 22.59,
      }),
    ).toBe('£22.59 profit');
  });

  it('shows the sale amount when there is no cost, never a minus', () => {
    expect(
      buildSalePushLabel({
        amount: 64.99,
        computedProfit: -64.99,
        signedFeesTotal: -64.99,
      }),
    ).toBe('£64.99 sale');
  });

  it('does not alert a missing order total as minus cost', () => {
    expect(
      buildSalePushLabel({
        amount: 0,
        costPerUnit: 64.99,
        computedProfit: -64.99,
      }),
    ).toBe('New sale');
  });
});

describe('buildSalePushTexts', () => {
  it('puts qty × product and ✅ £ once in the title; body empty', () => {
    const texts = buildSalePushTexts({
      profitLabel: '£6.40 profit',
      shortTitle: 'Test product',
      quantity: 1,
    });
    expect(texts.title).toBe('Sold: 1 × Test product — ✅ £6.40 profit');
    expect(texts.body).toBe('');
    expect(texts.title.includes('\u2705')).toBe(true);
    expect(texts.body.includes('\u2705')).toBe(false);
    expect(texts.profitLabel).toBe('£6.40 profit');
  });

  it('uses real qty when provided', () => {
    expect(
      buildSalePushTexts({
        profitLabel: '£12.80 profit',
        shortTitle: 'Widget',
        quantity: 2,
      }).title,
    ).toBe('Sold: 2 × Widget — ✅ £12.80 profit');
  });

  it('falls back to item when there is no product name', () => {
    expect(
      buildSalePushTexts({ profitLabel: '£6.40 profit' }).title,
    ).toBe('Sold: 1 × item — ✅ £6.40 profit');
  });

  it('shows sale label when there is no profit', () => {
    expect(
      buildSalePushTexts({
        profitLabel: '£64.99 sale',
        shortTitle: 'Test product',
      }).title,
    ).toBe('Sold: 1 × Test product — ✅ £64.99 sale');
  });
});
