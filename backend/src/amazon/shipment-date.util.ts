/** Parse created/shipped date embedded in FBA shipment name, e.g. "FBA STA (11/03/2025 19:20)-BHX4". */
export function parseDateFromShipmentName(name: unknown): Date | null {
  const s = typeof name === 'string' ? name : null;
  if (!s) return null;
  const match = s.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?\)/);
  if (!match) return null;
  const [, day, month, year, hour = '0', min = '0'] = match;
  const d = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(min, 10),
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function parseSpApiDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Mine every date-like field from a raw getShipments row (Amazon field names vary). */
export function extractInboundShipmentDatesFromRow(row: Record<string, unknown>): {
  created: Date | null;
  lastUpdated: Date | null;
  closed: Date | null;
  checkIn: Date | null;
  received: Date | null;
} {
  const byKey = new Map<string, Date>();
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v != null && typeof v === 'object') continue;
    if (!/date|time|at$/i.test(k)) continue;
    const d = parseSpApiDate(v);
    if (d) byKey.set(k.toLowerCase(), d);
  }
  const pick = (...keys: string[]): Date | null => {
    for (const k of keys) {
      const d = byKey.get(k.toLowerCase());
      if (d) return d;
    }
    return null;
  };
  return {
    created: pick('createddate', 'createdat', 'created'),
    lastUpdated: pick(
      'lastupdateddate',
      'lastupdatedat',
      'lastupdated',
      'lastupdatedate',
      'updatedate',
    ),
    closed: pick('closeddate', 'closedat'),
    checkIn: pick('checkedindate', 'checkindate', 'checkedinat'),
    received: pick(
      'receiveddate',
      'actualarrivaldate',
      'deliverydate',
      'receivedat',
    ),
  };
}

/** Shipment statuses that imply units have arrived / are being received at the FC. */
export const FBA_CHECKED_IN_STATUSES = [
  'CLOSED',
  'RECEIVING',
  'CHECKED_IN',
  'DELIVERED',
] as const;

export type CheckedInDateSource =
  | 'check_in'
  | 'closed'
  | 'delivery'
  | 'last_updated'
  | 'inbound_plan'
  | null;

/** Dates from Fulfillment Inbound API v2024-03-20 getShipment + parent plan. */
export function extractInboundV2024ShipmentDates(
  plan: Record<string, unknown>,
  shipment: Record<string, unknown>,
): {
  planCreatedAt: Date | null;
  planLastUpdatedAt: Date | null;
  deliveryWindowStart: Date | null;
  deliveryWindowEnd: Date | null;
  readyToShipStart: Date | null;
  readyToShipEnd: Date | null;
  appointmentEnd: Date | null;
  status: string | null;
  shipmentConfirmationId: string | null;
} {
  const windowDates = (w: unknown): { start: Date | null; end: Date | null } => {
    if (w == null || typeof w !== 'object') return { start: null, end: null };
    const o = w as Record<string, unknown>;
    return {
      start: parseSpApiDate(o.start ?? o.startDate ?? o.Start ?? o.StartDate),
      end: parseSpApiDate(o.end ?? o.endDate ?? o.End ?? o.EndDate),
    };
  };

  const deliveryWindow = windowDates(
    shipment.selectedDeliveryWindow ?? shipment.SelectedDeliveryWindow,
  );
  const readyWindow = windowDates(
    (shipment.dates as Record<string, unknown> | undefined)?.readyToShipWindow ??
      (shipment.Dates as Record<string, unknown> | undefined)?.readyToShipWindow,
  );

  let appointmentEnd: Date | null = null;
  const appointments =
    shipment.selfShipAppointmentDetails ??
    shipment.SelfShipAppointmentDetails ??
    [];
  if (Array.isArray(appointments)) {
    for (const appt of appointments) {
      if (appt == null || typeof appt !== 'object') continue;
      const slot =
        (appt as Record<string, unknown>).appointmentSlotTime ??
        (appt as Record<string, unknown>).AppointmentSlotTime;
      if (slot != null && typeof slot === 'object') {
        const end = parseSpApiDate(
          (slot as Record<string, unknown>).endTime ??
            (slot as Record<string, unknown>).end ??
            (slot as Record<string, unknown>).EndTime,
        );
        if (end && (!appointmentEnd || end > appointmentEnd)) {
          appointmentEnd = end;
        }
      }
    }
  }

  const confirmationRaw =
    shipment.shipmentConfirmationId ?? shipment.ShipmentConfirmationId;
  const statusRaw = shipment.status ?? shipment.Status;

  return {
    planCreatedAt: parseSpApiDate(plan.createdAt ?? plan.CreatedAt),
    planLastUpdatedAt: parseSpApiDate(plan.lastUpdatedAt ?? plan.LastUpdatedAt),
    deliveryWindowStart: deliveryWindow.start,
    deliveryWindowEnd: deliveryWindow.end,
    readyToShipStart: readyWindow.start,
    readyToShipEnd: readyWindow.end,
    appointmentEnd,
    status:
      typeof statusRaw === 'string' && statusRaw.trim()
        ? statusRaw.trim().toUpperCase()
        : null,
    shipmentConfirmationId:
      typeof confirmationRaw === 'string' && confirmationRaw.trim()
        ? confirmationRaw.trim()
        : null,
  };
}

/** Walk transport payload for pickup / delivery timestamps (v0 field names vary). */
export function extractTransportDatesFromPayload(
  root: Record<string, unknown>,
  maxDepth = 5,
): {
  pickup: Date | null;
  delivery: Date | null;
  received: Date | null;
} {
  const byKey = new Map<string, Date>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v != null && typeof v === 'object') {
        walk(v, depth + 1);
        continue;
      }
      if (!/date|time|at$/i.test(k)) continue;
      const d = parseSpApiDate(v);
      if (d) byKey.set(k.toLowerCase(), d);
    }
  };
  walk(root, 0);

  const pick = (...patterns: RegExp[]): Date | null => {
    for (const [k, d] of byKey) {
      if (patterns.some((p) => p.test(k))) return d;
    }
    return null;
  };

  return {
    pickup: pick(/pickup/, /readytoship/, /shipdate/, /shipped/),
    delivery: pick(/delivery/, /estimateddelivery/, /arrival/, /delivered/),
    received: pick(/received/, /checkin/, /checkedin/),
  };
}

function isSyncPlaceholder(
  d: Date,
  updatedAt: Date,
  createdAt: Date,
): boolean {
  return sameCalendarDay(d, updatedAt) && sameCalendarDay(d, createdAt);
}

/**
 * Best-effort check-in date for display.
 * Amazon Inbound v0 does not publish a true FC check-in timestamp for most sellers —
 * we use stored sync values, delivery date, closed/last-updated fallbacks, or manual entry.
 */
export function resolveShipmentCheckedIn(input: {
  shipmentStatus: string | null;
  checkedInDate: Date | null;
  checkedInDateIsClosedDate: boolean | null;
  deliveryDate: Date | null;
  lastUpdatedDate: Date | null;
  updatedAt: Date;
  createdAt: Date;
  unitsReceived?: number;
}): {
  checkedInDate: Date | null;
  checkedInDateIsClosedDate: boolean | null;
  checkedInDateSource: CheckedInDateSource;
  receivedDate: Date | null;
} {
  const statusUpper = (input.shipmentStatus ?? '').toUpperCase();
  const atFc = FBA_CHECKED_IN_STATUSES.some((s) => s === statusUpper);
  const receivedDate = input.deliveryDate;

  if (
    input.checkedInDate != null &&
    !isSyncPlaceholder(input.checkedInDate, input.updatedAt, input.createdAt)
  ) {
    const fromInboundPlan =
      input.lastUpdatedDate != null &&
      input.deliveryDate != null &&
      input.checkedInDate.getTime() === input.lastUpdatedDate.getTime();
    return {
      checkedInDate: input.checkedInDate,
      checkedInDateIsClosedDate: input.checkedInDateIsClosedDate,
      checkedInDateSource: fromInboundPlan
        ? 'inbound_plan'
        : input.checkedInDateIsClosedDate
          ? 'closed'
          : 'check_in',
      receivedDate,
    };
  }

  if (!atFc) {
    return {
      checkedInDate: null,
      checkedInDateIsClosedDate: null,
      checkedInDateSource: null,
      receivedDate,
    };
  }

  const preferClosed = statusUpper === 'CLOSED' || statusUpper === 'RECEIVING';
  const candidates: Array<{ date: Date; source: CheckedInDateSource }> = [];
  if (input.deliveryDate) {
    candidates.push({ date: input.deliveryDate, source: 'delivery' });
  }
  if (input.lastUpdatedDate) {
    candidates.push({ date: input.lastUpdatedDate, source: 'last_updated' });
  }
  if (input.checkedInDate) {
    candidates.push({
      date: input.checkedInDate,
      source: input.checkedInDateIsClosedDate ? 'closed' : 'check_in',
    });
  }

  for (const { date, source } of candidates) {
    if (isSyncPlaceholder(date, input.updatedAt, input.createdAt)) continue;
    return {
      checkedInDate: date,
      checkedInDateIsClosedDate: preferClosed ? true : null,
      checkedInDateSource: source,
      receivedDate,
    };
  }

  const lastResort = input.deliveryDate ?? input.lastUpdatedDate;
  if (lastResort != null && (input.unitsReceived ?? 0) > 0) {
    return {
      checkedInDate: lastResort,
      checkedInDateIsClosedDate: preferClosed ? true : null,
      checkedInDateSource: input.deliveryDate ? 'delivery' : 'last_updated',
      receivedDate,
    };
  }

  return {
    checkedInDate: null,
    checkedInDateIsClosedDate: null,
    checkedInDateSource: null,
    receivedDate,
  };
}
