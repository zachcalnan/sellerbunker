import { buildSalePushLabel } from './sale-push-profit.util';

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
