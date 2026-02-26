/**
 * VAT calculation helpers.
 * Net = amount ex VAT; VAT amount = amount incl VAT - Net.
 * Net cost = cost incl VAT / (1 + VAT rate)
 * Net revenue = revenue incl VAT / (1 + VAT rate)
 */

export function amountExVatFromIncl(amountInclVat: number, vatRatePct: number): number {
  if (vatRatePct < 0 || vatRatePct >= 100) return amountInclVat;
  const divisor = 1 + vatRatePct / 100;
  return Math.round((amountInclVat / divisor) * 100) / 100;
}

export function amountInclVatFromEx(amountExVat: number, vatRatePct: number): number {
  if (vatRatePct < 0) return amountExVat;
  const multiplier = 1 + vatRatePct / 100;
  return Math.round(amountExVat * multiplier * 100) / 100;
}

export function vatAmountFromIncl(amountInclVat: number, vatRatePct: number): number {
  const ex = amountExVatFromIncl(amountInclVat, vatRatePct);
  return Math.round((amountInclVat - ex) * 100) / 100;
}

export function vatAmountFromEx(amountExVat: number, vatRatePct: number): number {
  const incl = amountInclVatFromEx(amountExVat, vatRatePct);
  return Math.round((incl - amountExVat) * 100) / 100;
}

/** VAT Balance (net liability) = Output VAT - Input VAT */
export function vatBalance(outputVat: number, inputVat: number): number {
  return Math.round((outputVat - inputVat) * 100) / 100;
}
