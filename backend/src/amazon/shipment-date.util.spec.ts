import {
  extractInboundV2024ShipmentDates,
  extractTransportDatesFromPayload,
  FBA_CHECKED_IN_STATUSES,
  parseDateFromShipmentName,
  resolveShipmentCheckedIn,
  sameCalendarDay,
} from './shipment-date.util';

describe('parseDateFromShipmentName', () => {
  it('parses UK date from FBA STA shipment name', () => {
    const d = parseDateFromShipmentName('FBA STA (11/03/2025 19:20)-BHX4');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
    expect(d!.getMonth()).toBe(2);
    expect(d!.getDate()).toBe(11);
    expect(d!.getHours()).toBe(19);
    expect(d!.getMinutes()).toBe(20);
  });

  it('returns null for names without embedded date', () => {
    expect(parseDateFromShipmentName('FBA123ABC')).toBeNull();
  });
});

describe('sameCalendarDay', () => {
  it('matches same calendar day regardless of time', () => {
    const a = new Date('2025-06-01T08:00:00Z');
    const b = new Date('2025-06-01T22:00:00Z');
    expect(sameCalendarDay(a, b)).toBe(true);
  });
});

describe('resolveShipmentCheckedIn', () => {
  it('falls back to delivery date for closed shipments', () => {
    const deliveryDate = new Date('2025-04-15T12:00:00Z');
    const result = resolveShipmentCheckedIn({
      shipmentStatus: 'CLOSED',
      checkedInDate: null,
      checkedInDateIsClosedDate: null,
      deliveryDate,
      lastUpdatedDate: new Date('2025-04-16T12:00:00Z'),
      updatedAt: new Date('2025-06-01T12:00:00Z'),
      createdAt: new Date('2025-02-01T12:00:00Z'),
      unitsReceived: 10,
    });
    expect(result.checkedInDate).toEqual(deliveryDate);
    expect(result.checkedInDateIsClosedDate).toBe(true);
    expect(result.checkedInDateSource).toBe('delivery');
  });

  it('does not invent check-in for in-transit shipments', () => {
    const result = resolveShipmentCheckedIn({
      shipmentStatus: 'IN_TRANSIT',
      checkedInDate: null,
      checkedInDateIsClosedDate: null,
      deliveryDate: new Date('2025-04-15T12:00:00Z'),
      lastUpdatedDate: new Date('2025-04-10T12:00:00Z'),
      updatedAt: new Date('2025-06-01T12:00:00Z'),
      createdAt: new Date('2025-02-01T12:00:00Z'),
    });
    expect(result.checkedInDate).toBeNull();
  });

  it('exports checked-in status list', () => {
    expect(FBA_CHECKED_IN_STATUSES).toContain('RECEIVING');
  });

  it('labels v2024 plan check-in when it matches lastUpdated and delivery is set', () => {
    const d = new Date('2025-03-15T14:30:00Z');
    const result = resolveShipmentCheckedIn({
      shipmentStatus: 'RECEIVING',
      checkedInDate: d,
      checkedInDateIsClosedDate: true,
      deliveryDate: new Date('2025-03-14T20:00:00Z'),
      lastUpdatedDate: d,
      updatedAt: new Date('2025-06-01T12:00:00Z'),
      createdAt: new Date('2025-02-01T12:00:00Z'),
      unitsReceived: 5,
    });
    expect(result.checkedInDateSource).toBe('inbound_plan');
  });
});

describe('extractInboundV2024ShipmentDates', () => {
  it('parses plan and shipment delivery window', () => {
    const result = extractInboundV2024ShipmentDates(
      {
        createdAt: '2025-03-01T10:00:00Z',
        lastUpdatedAt: '2025-03-15T14:30:00Z',
      },
      {
        shipmentConfirmationId: 'FBA15LSVS5VR',
        status: 'RECEIVING',
        selectedDeliveryWindow: {
          startDate: '2025-03-14T08:00:00Z',
          endDate: '2025-03-14T20:00:00Z',
        },
        dates: {
          readyToShipWindow: {
            start: '2025-03-10T08:00:00Z',
            end: '2025-03-10T18:00:00Z',
          },
        },
      },
    );
    expect(result.shipmentConfirmationId).toBe('FBA15LSVS5VR');
    expect(result.status).toBe('RECEIVING');
    expect(result.planLastUpdatedAt?.toISOString()).toBe('2025-03-15T14:30:00.000Z');
    expect(result.deliveryWindowEnd?.toISOString()).toBe('2025-03-14T20:00:00.000Z');
    expect(result.readyToShipEnd?.toISOString()).toBe('2025-03-10T18:00:00.000Z');
  });
});

describe('extractTransportDatesFromPayload', () => {
  it('finds nested pickup and delivery dates', () => {
    const result = extractTransportDatesFromPayload({
      TransportHeader: { ShipmentPickupDate: '2025-04-01T12:00:00Z' },
      TransportDetails: {
        PartneredSmallParcelData: {
          PackageList: [{ EstimatedDeliveryDate: '2025-04-05T09:00:00Z' }],
        },
      },
    });
    expect(result.pickup?.toISOString()).toBe('2025-04-01T12:00:00.000Z');
    expect(result.delivery?.toISOString()).toBe('2025-04-05T09:00:00.000Z');
  });
});
