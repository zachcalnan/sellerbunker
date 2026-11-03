import {
  isFbaShipmentAwaitingCheckIn,
  isFbaShipmentDelayed,
  resolveFbaShipmentLifecycle,
} from './shipment-status.util';

describe('shipment-status.util', () => {
  it('maps inbound lifecycle labels including derived Available', () => {
    expect(
      resolveFbaShipmentLifecycle({
        shipmentStatus: 'DELIVERED',
        unitsSent: 10,
        unitsReceived: 0,
      }).label,
    ).toBe('Delivered');

    expect(
      resolveFbaShipmentLifecycle({
        shipmentStatus: 'CHECKED_IN',
      }).label,
    ).toBe('Checked in');

    expect(
      resolveFbaShipmentLifecycle({
        shipmentStatus: 'RECEIVING',
        unitsSent: 10,
        unitsReceived: 4,
        unitsMissing: 6,
      }).label,
    ).toBe('Receiving');

    const closed = resolveFbaShipmentLifecycle({
      shipmentStatus: 'CLOSED',
      unitsSent: 10,
      unitsReceived: 10,
      unitsMissing: 0,
    });
    expect(closed.code).toBe('AVAILABLE');
    expect(closed.label).toBe('Available');
  });

  it('flags delayed in-transit past delivery date', () => {
    expect(
      isFbaShipmentDelayed({
        shipmentStatus: 'IN_TRANSIT',
        deliveryDate: '2026-09-01T00:00:00.000Z',
        now: new Date('2026-09-20T00:00:00.000Z'),
      }),
    ).toBe(true);

    expect(
      isFbaShipmentDelayed({
        shipmentStatus: 'CHECKED_IN',
        deliveryDate: '2026-09-01T00:00:00.000Z',
        now: new Date('2026-09-20T00:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('flags delivered with zero received as awaiting check-in', () => {
    expect(
      isFbaShipmentAwaitingCheckIn({
        shipmentStatus: 'DELIVERED',
        unitsReceived: 0,
      }),
    ).toBe(true);

    expect(
      isFbaShipmentAwaitingCheckIn({
        shipmentStatus: 'DELIVERED',
        unitsReceived: 2,
      }),
    ).toBe(false);

    expect(
      isFbaShipmentAwaitingCheckIn({
        shipmentStatus: 'RECEIVING',
        unitsReceived: 0,
      }),
    ).toBe(false);
  });
});
