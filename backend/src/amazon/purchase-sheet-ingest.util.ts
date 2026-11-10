import {
  effectiveUnitCostIncVatForPromo,
  SupplierPromoType,
} from './supplier-order-promo.util';

export type IngestLedgerLineForSheet = {
  lineIndex: number;
  status: 'created' | 'skipped';
  asin?: string;
  productTitle?: string | null;
  unitCostIncVat?: number;
};

export type IngestDtoLineForSheet = {
  asin?: string;
  sku?: string;
  productTitle?: string;
  qty: number;
  unitCostIncVat?: number;
  unitRrpIncVat?: number;
  deliveryCostIncVat?: number;
  prepCostIncVat?: number;
};

export type PurchaseSheetIngestLine = {
  asin: string;
  productTitle?: string | null;
  sku?: string | null;
  qty: number;
  unitCostIncVat: number;
  deliveryCostIncVat?: number;
  prepCostIncVat?: number;
  shipDestination?: 'HOME' | 'PREP CENTER' | string | null;
  supplierLink?: string | null;
};

/**
 * Map supplier-order ingest ledger + DTO lines into purchase-sheet rows.
 *
 * Includes both `created` and `skipped` ledger lines so sheet builders stay
 * compatible with older ingest responses. Sheets always append (no duplicate skip).
 */
export function buildPurchaseSheetLinesFromIngest(opts: {
  ledgerLines: IngestLedgerLineForSheet[];
  dtoLines: IngestDtoLineForSheet[];
  promoType?: SupplierPromoType;
  supplierLink?: string | null;
  shipDestination?: 'HOME' | 'PREP CENTER' | string | null;
}): PurchaseSheetIngestLine[] {
  const promo: SupplierPromoType = opts.promoType ?? 'none';
  const out: PurchaseSheetIngestLine[] = [];

  for (const ledgerLine of opts.ledgerLines) {
    if (ledgerLine.status !== 'created' && ledgerLine.status !== 'skipped') {
      continue;
    }
    const dtoLine = opts.dtoLines[ledgerLine.lineIndex - 1];
    const asin = (
      ledgerLine.asin ||
      dtoLine?.asin ||
      ''
    )
      .trim()
      .replace(/\s/g, '')
      .toUpperCase();
    if (!asin) continue;

    const qty = Math.max(1, Math.floor(Number(dtoLine?.qty ?? 1) || 1));
    let unitCostIncVat = Number(
      ledgerLine.unitCostIncVat ?? dtoLine?.unitCostIncVat ?? 0,
    );
    if (!(unitCostIncVat > 0) && dtoLine?.unitRrpIncVat != null) {
      const rrp = Number(dtoLine.unitRrpIncVat);
      if (rrp > 0) {
        unitCostIncVat = effectiveUnitCostIncVatForPromo(qty, rrp, promo);
      }
    }
    if (!(unitCostIncVat > 0)) continue;

    const title =
      dtoLine?.productTitle?.trim() ||
      ledgerLine.productTitle?.trim() ||
      null;

    out.push({
      asin,
      productTitle: title,
      sku: dtoLine?.sku?.trim() || null,
      qty,
      unitCostIncVat,
      deliveryCostIncVat: dtoLine?.deliveryCostIncVat,
      prepCostIncVat: dtoLine?.prepCostIncVat,
      shipDestination: opts.shipDestination,
      supplierLink: opts.supplierLink,
    });
  }

  return out;
}
