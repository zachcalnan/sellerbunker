import {
  renderSalePushAmountIcon,
  renderSalePushCard,
} from './sale-push-card.util';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderSalePushCard', () => {
  it('renders emerald profit PNG without sharp', async () => {
    const png = await renderSalePushCard({
      imageUrl: null,
      profitLabel: '£6.40 profit',
      title: 'Test product',
    });
    expect(png).toBeTruthy();
    expect(png!.length).toBeGreaterThan(100);
    expect(png!.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  });
});

describe('renderSalePushAmountIcon', () => {
  it('renders a square green-amount icon PNG', () => {
    const png = renderSalePushAmountIcon({ profitLabel: '£6.40 profit' });
    expect(png).toBeTruthy();
    expect(png!.length).toBeGreaterThan(100);
    expect(png!.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  });
});
