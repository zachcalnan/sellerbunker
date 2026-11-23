import {
  renderSalePushAmountIcon,
  renderSalePushCard,
  renderSalePushCheckIcon,
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

describe('renderSalePushCheckIcon', () => {
  it('renders a square opaque green check PNG', () => {
    const { PNG } = require('pngjs') as typeof import('pngjs');
    const png = renderSalePushCheckIcon();
    expect(png).toBeTruthy();
    expect(png!.subarray(0, 8).equals(PNG_SIG)).toBe(true);
    const decoded = PNG.sync.read(png!);
    let transparent = 0;
    let emerald = 0;
    let white = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      const r = decoded.data[i]!;
      const g = decoded.data[i + 1]!;
      const b = decoded.data[i + 2]!;
      const a = decoded.data[i + 3]!;
      if (a < 250) transparent += 1;
      if (a >= 250 && g > 140 && g > r + 40 && g > b + 40) emerald += 1;
      if (a >= 250 && r > 240 && g > 240 && b > 240) white += 1;
    }
    expect(transparent).toBe(0);
    expect(emerald).toBeGreaterThan(1000);
    expect(white).toBeGreaterThan(200);
  });
});

describe('renderSalePushAmountIcon', () => {
  it('renders a square green-amount icon PNG', () => {
    const png = renderSalePushAmountIcon({ profitLabel: '£6.40 profit' });
    expect(png).toBeTruthy();
    expect(png!.length).toBeGreaterThan(100);
    expect(png!.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  });

  it('is fully opaque with lime (not white) amount pixels', () => {
    const { PNG } = require('pngjs') as typeof import('pngjs');
    const png = renderSalePushAmountIcon({ profitLabel: '£6.40 profit' });
    expect(png).toBeTruthy();
    const decoded = PNG.sync.read(png!);
    let transparent = 0;
    let lime = 0;
    let white = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      const r = decoded.data[i]!;
      const g = decoded.data[i + 1]!;
      const b = decoded.data[i + 2]!;
      const a = decoded.data[i + 3]!;
      if (a < 250) transparent += 1;
      if (a >= 250 && g > 180 && g > r + 40 && g > b + 40) lime += 1;
      if (a >= 250 && r > 200 && g > 200 && b > 200) white += 1;
    }
    expect(transparent).toBe(0);
    expect(lime).toBeGreaterThan(500);
    expect(white).toBe(0);
  });
});
