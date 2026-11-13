"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

export type DealCheckResult = {
  asin: string;
  title: string | null;
  currency: string;
  buyPrice: number;
  lookbackDays: number;
  priceSource: "keepa_new_fba" | "keepa_new";
  sampleDays: number;
  currentPrice: number | null;
  medianPrice: number | null;
  goodResalePrice: number | null;
  bestCaseResalePrice: number | null;
  probabilityPct: number | null;
  decemberGoodResalePrice: number | null;
  decemberSampleDays: number;
  decemberWeight: number;
  feesAtGood: number | null;
  referralFeeAtGood?: number | null;
  fbaFeeAtGood?: number | null;
  digitalServiceFeeAtGood?: number | null;
  feesIncludeVat?: boolean;
  feeSource?:
    | "product_fees_api"
    | "stored_scaled"
    | "heuristic"
    | null;
  profitAtGood: number | null;
  roiAtGood: number | null;
  meetsRoiGate: boolean;
  usedFeeFallback: boolean;
  monthlySoldEstimate: number | null;
  tokensLeft: number | null;
  note: string;
};

const MONEY = (n: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);

type Props = {
  open: boolean;
  onClose: () => void;
  asin: string;
  buyPrice: number | null;
  marketplaceId?: string | null;
  title?: string | null;
  /** When true, ASIN field is editable (standalone check). */
  allowEditAsin?: boolean;
  currency?: string;
};

export function DealCheckPanel({
  open,
  onClose,
  asin: initialAsin,
  buyPrice: initialBuy,
  marketplaceId,
  title,
  allowEditAsin = false,
  currency = "GBP",
}: Props) {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { getToken } = useAuth();
  const [asin, setAsin] = useState(initialAsin);
  const [buyPrice, setBuyPrice] = useState(
    initialBuy != null && Number.isFinite(initialBuy) ? String(initialBuy) : "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DealCheckResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setAsin(initialAsin);
    setBuyPrice(
      initialBuy != null && Number.isFinite(initialBuy) ? String(initialBuy) : "",
    );
    setError(null);
    setResult(null);
  }, [open, initialAsin, initialBuy]);

  const run = useCallback(async () => {
    const buy = Number(buyPrice);
    const a = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(a)) {
      setError("Enter a valid 10-character ASIN");
      return;
    }
    if (!Number.isFinite(buy) || buy <= 0) {
      setError("Enter a buy price greater than 0");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${baseUrl}/api/amazon/deal-check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...getDevImpersonationHeaders(),
          ...(marketplaceId ? { "x-marketplace-id": marketplaceId } : {}),
        },
        body: JSON.stringify({
          asin: a,
          buyPrice: buy,
          marketplaceId: marketplaceId || undefined,
          lookbackDays: 365,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (data as { message?: string | string[] })?.message ??
          `Deal check failed (${res.status})`;
        throw new Error(Array.isArray(msg) ? msg.join(", ") : String(msg));
      }
      setResult(data as DealCheckResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deal check failed");
    } finally {
      setLoading(false);
    }
  }, [asin, buyPrice, baseUrl, getToken, marketplaceId]);

  if (!open) return null;

  const profitGood =
    result?.profitAtGood != null && result.meetsRoiGate
      ? "text-emerald-600 dark:text-emerald-400"
      : result?.profitAtGood != null && result.profitAtGood > 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Deal check"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--foreground)]">
              Deal check
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">
              {title || "Expected resale from Keepa 3P New / FBA history"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
            aria-label="Close deal check"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="mt-3 grid gap-2">
          <label className="text-[11px] text-[var(--muted-foreground)]">
            ASIN
            <input
              value={asin}
              onChange={(e) => setAsin(e.target.value.toUpperCase())}
              readOnly={!allowEditAsin}
              className="mt-1 h-9 w-full rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2 font-mono text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent read-only:opacity-80"
            />
          </label>
          <label className="text-[11px] text-[var(--muted-foreground)]">
            Buy price ({currency})
            <input
              inputMode="decimal"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2 text-sm tabular-nums text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
              placeholder="49.00"
            />
          </label>
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="mt-1 rounded-md bg-sb-accent px-3 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Check resale"}
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        {result && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Good resale (next ~{result.lookbackDays}d band)
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-2xl font-semibold tabular-nums text-[var(--foreground)]">
                  {result.goodResalePrice != null
                    ? MONEY(result.goodResalePrice, result.currency)
                    : "—"}
                </span>
                {result.probabilityPct != null && (
                  <span className="text-sm text-[var(--muted-foreground)]">
                    {result.probabilityPct}% of days historically
                  </span>
                )}
              </div>
              {result.bestCaseResalePrice != null &&
                result.bestCaseResalePrice !== result.goodResalePrice && (
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Best case band{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {MONEY(result.bestCaseResalePrice, result.currency)}
                    </span>
                  </div>
                )}
              {result.decemberWeight > 0 &&
                result.decemberGoodResalePrice != null && (
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    December band{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {MONEY(result.decemberGoodResalePrice, result.currency)}
                    </span>
                    {" · "}
                    {Math.round(result.decemberWeight * 100)}% weight
                    {result.decemberSampleDays > 0
                      ? ` (${result.decemberSampleDays} Dec days)`
                      : ""}
                  </div>
                )}
            </div>

            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                Expected profit / unit
              </div>
              <div className={`mt-1 text-2xl font-semibold tabular-nums ${profitGood}`}>
                {result.profitAtGood != null
                  ? MONEY(result.profitAtGood, result.currency)
                  : "—"}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                <span>
                  Fees{" "}
                  {result.feesAtGood != null
                    ? MONEY(result.feesAtGood, result.currency)
                    : "—"}
                  {result.feesIncludeVat ? " inc VAT" : ""}
                  {result.usedFeeFallback ? " (est.)" : ""}
                </span>
                <span>
                  ROI{" "}
                  {result.roiAtGood != null
                    ? `${Math.round(result.roiAtGood * 1000) / 10}%`
                    : "—"}
                  {result.meetsRoiGate ? " · ≥15% ✓" : " · below 15%"}
                </span>
              </div>
              {(result.referralFeeAtGood != null ||
                result.fbaFeeAtGood != null ||
                result.digitalServiceFeeAtGood != null) && (
                <div className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                  {[
                    result.referralFeeAtGood != null
                      ? `Ref ${MONEY(result.referralFeeAtGood, result.currency)}`
                      : null,
                    result.fbaFeeAtGood != null
                      ? `FBA ${MONEY(result.fbaFeeAtGood, result.currency)}`
                      : null,
                    result.digitalServiceFeeAtGood != null
                      ? `DSF ${MONEY(result.digitalServiceFeeAtGood, result.currency)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted-foreground)]">
              <div>
                Now{" "}
                <span className="tabular-nums text-[var(--foreground)]">
                  {result.currentPrice != null
                    ? MONEY(result.currentPrice, result.currency)
                    : "—"}
                </span>
              </div>
              <div>
                Median{" "}
                <span className="tabular-nums text-[var(--foreground)]">
                  {result.medianPrice != null
                    ? MONEY(result.medianPrice, result.currency)
                    : "—"}
                </span>
              </div>
              <div>
                Sold/mo{" "}
                <span className="tabular-nums text-[var(--foreground)]">
                  {result.monthlySoldEstimate != null
                    ? `~${result.monthlySoldEstimate}`
                    : "—"}
                </span>
              </div>
              <div>
                Source{" "}
                <span className="text-[var(--foreground)]">
                  {result.priceSource === "keepa_new_fba" ? "New FBA" : "3P New"}
                </span>
              </div>
            </div>

            <p className="text-[10px] leading-relaxed text-[var(--muted-foreground)]">
              {result.note}
              {result.tokensLeft != null
                ? ` Keepa tokens left: ${result.tokensLeft}.`
                : ""}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
