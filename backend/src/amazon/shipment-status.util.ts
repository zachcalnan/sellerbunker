/**
 * FBA Inbound shipmentStatus → seller-facing lifecycle labels.
 * Amazon does not send an "AVAILABLE" inbound status; we derive it when a
 * CLOSED shipment has been fully (or partially) received into inventory.
 */

export const FBA_SHIPMENT_STATUS_ORDER = [
  'WORKING',
  'READY_TO_SHIP',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CHECKED_IN',
  'RECEIVING',
  'CLOSED',
  'CANCELLED',
  'DELETED',
  'ERROR',
] as const;

export type FbaShipmentStatusCode = (typeof FBA_SHIPMENT_STATUS_ORDER)[number] | 'AVAILABLE';

const LABEL_BY_CODE: Record<string, string> = {
  WORKING: 'Working',
  READY_TO_SHIP: 'Ready to ship',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  CHECKED_IN: 'Checked in',
  RECEIVING: 'Receiving',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  DELETED: 'Deleted',
  ERROR: 'Error',
  AVAILABLE: 'Available',
};

/** Statuses where the shipment is still moving / not yet at FC inventory. */
export const FBA_SHIPMENT_IN_FLIGHT_STATUSES = new Set([
  'SHIPPED',
  'IN_TRANSIT',
]);

export function normalizeFbaShipmentStatus(
  raw: string | null | undefined,
): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

/**
 * Prefer inbound `shipmentStatus` for lifecycle. Transport carrier text is
 * secondary (shown separately) — it used to overwrite the Status column and
 * made everything look like Sent/Received only.
 */
export function resolveFbaShipmentLifecycle(args: {
  shipmentStatus: string | null | undefined;
  unitsSent?: number | null;
  unitsReceived?: number | null;
  unitsMissing?: number | null;
}): {
  code: string;
  label: string;
  /** True when CLOSED and units have landed (seller-facing "available"). */
  derivedAvailable: boolean;
} {
  const code = normalizeFbaShipmentStatus(args.shipmentStatus);
  const sent = Math.max(0, Number(args.unitsSent) || 0);
  const received = Math.max(0, Number(args.unitsReceived) || 0);
  const missing = Math.max(0, Number(args.unitsMissing) || 0);

  const derivedAvailable =
    code === 'CLOSED' && received > 0 && (missing === 0 || received >= sent);

  if (derivedAvailable) {
    return { code: 'AVAILABLE', label: LABEL_BY_CODE.AVAILABLE, derivedAvailable: true };
  }

  return {
    code: code || 'UNKNOWN',
    label: LABEL_BY_CODE[code] ?? (code ? titleCaseStatus(code) : '—'),
    derivedAvailable: false,
  };
}

function titleCaseStatus(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Delayed when still in transit/shipped and Amazon's delivery date (or a
 * soft expected window from pickup) is in the past.
 */
export function isFbaShipmentDelayed(args: {
  shipmentStatus: string | null | undefined;
  deliveryDate?: Date | string | null;
  pickupDate?: Date | string | null;
  now?: Date;
}): boolean {
  const code = normalizeFbaShipmentStatus(args.shipmentStatus);
  if (!FBA_SHIPMENT_IN_FLIGHT_STATUSES.has(code)) return false;

  const now = args.now ?? new Date();
  const delivery = toDate(args.deliveryDate);
  if (delivery && delivery.getTime() < now.getTime() - 12 * 60 * 60 * 1000) {
    return true;
  }
  // Soft fallback: 10+ days after pickup with no delivery date and still in flight.
  const pickup = toDate(args.pickupDate);
  if (!delivery && pickup) {
    const days =
      (now.getTime() - pickup.getTime()) / (24 * 60 * 60 * 1000);
    if (days >= 10) return true;
  }
  return false;
}

/**
 * True when Amazon marks the shipment Delivered at the FC but check-in /
 * receiving has not started (no units received yet).
 */
export function isFbaShipmentAwaitingCheckIn(args: {
  shipmentStatus: string | null | undefined;
  unitsReceived?: number | null;
}): boolean {
  const code = normalizeFbaShipmentStatus(args.shipmentStatus);
  if (code !== 'DELIVERED') return false;
  return Math.max(0, Number(args.unitsReceived) || 0) === 0;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
