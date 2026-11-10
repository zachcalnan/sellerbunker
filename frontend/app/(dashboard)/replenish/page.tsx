"use client";

import { useAuth, SignedIn, SignedOut } from "@clerk/nextjs";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { PurchaseOrderIngestPanel } from "@/components/purchase-order-ingest-panel";
import { DealCheckPanel } from "@/components/deal-check-panel";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type SmartReplenishRow = {
  productId: string;
  imageUrl: string | null;
  title: string | null;
  sku: string;
  asin: string | null;
  lastSold: number | null;
  fulfillableQty: number;
  inboundQty: number;
  effectiveStock: number;
  targetStockUnits: number;
  avgDailyUnits: number;
  daysOfCover: number | null;
  avgGrossProfitPerUnit: number | null;
  roi: number | null;
  suggestedBuyQty: number;
  maxBuyPriceBreakEvenPerUnit: number | null;
  maxBuyPriceForTargetsPerUnit: number | null;
  supplier: string | null;
  supplierLink: string | null;
  latestPurchaseId: string | null;
  latestCogsEntry:
    | {
        purchaseDate: string;
        currency: string;
        vatRatePct: number;
        bundleSize: number;
        qtyPurchased: number;
        qtyDelivered: number;
        unitCostIncVat: number;
        deliveryCostIncVat: number;
        prepCostIncVat: number;
        totalCostIncVat: number;
      }
    | null;
  lastBuyUnitCostIncVat: number | null;
  expectedProfitPerUnitAtLastBuy: number | null;
  expectedProfitTotalAtLastBuy: number | null;
  rationale: string;
};

type SnoozeStatus = "replenished" | "unavailable";

const SMART_PAGE_SIZE = 25;
const URGENT_COVER_DAYS = 7;
const MONEY = (n: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);

function isUrgent(row: SmartReplenishRow): boolean {
  if ((row.effectiveStock ?? 0) <= 0) return true;
  if (row.daysOfCover == null) return false;
  return row.daysOfCover <= URGENT_COVER_DAYS;
}

function isGoodBuyNow(row: SmartReplenishRow): boolean {
  // Sale / clearance buys that no longer clear targets at last cost.
  if (
    row.expectedProfitPerUnitAtLastBuy != null &&
    Number.isFinite(row.expectedProfitPerUnitAtLastBuy)
  ) {
    return row.expectedProfitPerUnitAtLastBuy > 0;
  }
  // No last-buy cost: still allow if max target buy exists (unknown ≠ bad).
  return true;
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
        active
          ? "border-sb-accent bg-sb-accent/15 text-[var(--foreground)]"
          : "border-[var(--surface-border)] bg-[var(--background)] text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
      }`}
    >
      {children}
    </button>
  );
}

function ReplenishInner() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId, selectedCurrency } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const SMART_PERIOD_DAYS = 30;
  const SMART_SNOOZE_DAYS = 7;

  const [smart, setSmart] = useState<SmartReplenishRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [smartPage, setSmartPage] = useState(1);
  const [buyQtyByProductId, setBuyQtyByProductId] = useState<Record<string, number>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [filterUrgent, setFilterUrgent] = useState(false);
  const [filterHasSupplier, setFilterHasSupplier] = useState(false);
  const [filterGoodBuy, setFilterGoodBuy] = useState(true);

  const [smartTargetCoverDays, setSmartTargetCoverDays] = useState(45);
  const [smartTargetProfitPerUnit, setSmartTargetProfitPerUnit] = useState(1);
  const [smartTargetRoiPct, setSmartTargetRoiPct] = useState(15);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsItem, setDetailsItem] = useState<SmartReplenishRow | null>(null);
  const [dealCheckOpen, setDealCheckOpen] = useState(false);
  const [dealCheckAsin, setDealCheckAsin] = useState("");
  const [dealCheckBuy, setDealCheckBuy] = useState<number | null>(null);
  const [dealCheckTitle, setDealCheckTitle] = useState<string | null>(null);
  const [dealCheckAllowEditAsin, setDealCheckAllowEditAsin] = useState(false);
  const [newSupplierLink, setNewSupplierLink] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [savingSupplierLink, setSavingSupplierLink] = useState(false);
  const [supplierLinkError, setSupplierLinkError] = useState<string | null>(null);

  const openDealCheck = useCallback(
    (opts: {
      asin: string;
      buyPrice: number | null;
      title?: string | null;
      allowEditAsin?: boolean;
    }) => {
      setDealCheckAsin(opts.asin);
      setDealCheckBuy(opts.buyPrice);
      setDealCheckTitle(opts.title ?? null);
      setDealCheckAllowEditAsin(Boolean(opts.allowEditAsin));
      setDealCheckOpen(true);
    },
    [],
  );
  const [smartStatusByProductId, setSmartStatusByProductId] = useState<
    Record<string, { status: SnoozeStatus; untilMs: number } | undefined>
  >({});
  const [smartStatusLoaded, setSmartStatusLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const smartUrl = new URL(`${baseUrl}/api/amazon/replenish/smart`);
      smartUrl.searchParams.set("take", "200");
      smartUrl.searchParams.set("periodDays", String(SMART_PERIOD_DAYS));
      smartUrl.searchParams.set("targetCoverDays", String(smartTargetCoverDays));
      smartUrl.searchParams.set("minProfitPerUnit", String(smartTargetProfitPerUnit));
      smartUrl.searchParams.set("minRoi", String((smartTargetRoiPct || 0) / 100));
      if (devImpersonate) smartUrl.searchParams.set("impersonate", devImpersonate);

      const headers = {
        Authorization: `Bearer ${token}`,
        ...getDevImpersonationHeaders(devImpersonate),
        ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
      };

      const smartRes = await fetch(smartUrl.toString(), {
        headers,
        credentials: "include",
      });
      if (!smartRes.ok) {
        const text = await smartRes.text();
        throw new Error(text || `Request failed (${smartRes.status})`);
      }
      const smartData = (await smartRes.json()) as SmartReplenishRow[];
      setSmart(Array.isArray(smartData) ? smartData : []);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Error";
      setError(
        message === "Failed to fetch"
          ? "Could not reach the API. Ensure the backend is running."
          : message,
      );
      setSmart([]);
    } finally {
      setLoading(false);
    }
  }, [
    getToken,
    baseUrl,
    selectedMarketplaceId,
    devImpersonate,
    smartTargetCoverDays,
    smartTargetProfitPerUnit,
    smartTargetRoiPct,
  ]);

  useEffect(() => {
    if (!isSignedIn) {
      setSmart([]);
      setError(null);
      return;
    }
    void load();
  }, [isSignedIn, load]);

  const smartNow = Date.now();
  const smartStatusActiveByProductId = useMemo(() => {
    const out: Record<string, { status: SnoozeStatus; untilMs: number }> = {};
    for (const [productId, v] of Object.entries(smartStatusByProductId)) {
      if (!v) continue;
      if (v.untilMs > smartNow) out[productId] = v;
    }
    return out;
  }, [smartStatusByProductId, smartNow]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("sb.smartReplenishStatus.v1");
    if (!raw) {
      setSmartStatusLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<
        string,
        { status: SnoozeStatus; untilMs: number }
      >;
      if (!parsed || typeof parsed !== "object") return;
      setSmartStatusByProductId(parsed);
    } catch {
      // ignore
    }
    setSmartStatusLoaded(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!smartStatusLoaded) return;
    window.localStorage.setItem(
      "sb.smartReplenishStatus.v1",
      JSON.stringify(smartStatusActiveByProductId),
    );
  }, [smartStatusActiveByProductId, smartStatusLoaded]);

  const snoozedCount = useMemo(
    () => Object.keys(smartStatusActiveByProductId).length,
    [smartStatusActiveByProductId],
  );

  const smartFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return smart.filter((r) => {
      // Ordered / Skip hide the row for 7 days.
      if (smartStatusActiveByProductId[r.productId]) return false;
      if (q) {
        const hay = `${r.sku} ${r.asin ?? ""} ${r.title ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filterUrgent && !isUrgent(r)) return false;
      if (filterHasSupplier && !(r.supplierLink || r.supplier)) return false;
      if (filterGoodBuy && !isGoodBuyNow(r)) return false;
      return true;
    });
  }, [
    smart,
    query,
    smartStatusActiveByProductId,
    filterUrgent,
    filterHasSupplier,
    filterGoodBuy,
  ]);

  const smartTotalPages = Math.max(1, Math.ceil(smartFiltered.length / SMART_PAGE_SIZE));
  const smartSafePage = Math.min(smartPage, smartTotalPages);
  const smartPaginated = useMemo(
    () =>
      smartFiltered.slice(
        (smartSafePage - 1) * SMART_PAGE_SIZE,
        smartSafePage * SMART_PAGE_SIZE,
      ),
    [smartFiltered, smartSafePage],
  );

  useEffect(() => {
    setSmartPage(1);
  }, [query, filterUrgent, filterHasSupplier, filterGoodBuy]);

  useEffect(() => {
    setBuyQtyByProductId((prev) => {
      const next = { ...prev };
      for (const row of smart) {
        if (next[row.productId] == null) {
          next[row.productId] = Math.max(1, Math.round(row.suggestedBuyQty || 1));
        }
      }
      return next;
    });
  }, [smart]);

  const { backgroundClass } = useDisplaySettings();

  const clampNum = (raw: string, { min, max }: { min: number; max: number }) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
  };

  const snooze = (productId: string, status: SnoozeStatus) => {
    const untilMs = Date.now() + SMART_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    setSmartStatusByProductId((prev) => ({
      ...prev,
      [productId]: { status, untilMs },
    }));
  };

  const openDetails = (row: SmartReplenishRow) => {
    setDetailsItem(row);
    setNewSupplierLink("");
    setNewSupplierName(row.supplier ?? "");
    setSupplierLinkError(null);
    setDetailsOpen(true);
  };

  const saveSupplierLink = async () => {
    if (!detailsItem) return;
    const link = newSupplierLink.trim();
    if (!link) {
      setSupplierLinkError("Paste a supplier URL");
      return;
    }
    setSavingSupplierLink(true);
    setSupplierLinkError(null);
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(
        `${baseUrl}/api/amazon/products/${encodeURIComponent(detailsItem.productId)}/supplier-link`,
      );
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          supplierLink: link,
          supplier: newSupplierName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Save failed (${res.status})`);
      }
      const saved = (await res.json()) as {
        purchaseId: string;
        supplier: string | null;
        supplierLink: string;
      };
      const patch = {
        supplier: saved.supplier ?? (newSupplierName.trim() || null),
        supplierLink: saved.supplierLink,
        latestPurchaseId: saved.purchaseId,
      };
      setSmart((prev) =>
        prev.map((r) =>
          r.productId === detailsItem.productId ? { ...r, ...patch } : r,
        ),
      );
      setDetailsItem((prev) => (prev ? { ...prev, ...patch } : prev));
      setNewSupplierLink("");
    } catch (e) {
      setSupplierLinkError(e instanceof Error ? e.message : "Could not save link");
    } finally {
      setSavingSupplierLink(false);
    }
  };

  const copyQtyAndOpenSupplier = async (row: SmartReplenishRow) => {
    const qty = buyQtyByProductId[row.productId] ?? row.suggestedBuyQty;
    const clip = [String(qty), row.asin ?? row.sku, row.title ?? ""]
      .filter(Boolean)
      .join(" · ");
    try {
      await navigator.clipboard.writeText(clip);
      setCopiedId(row.productId);
      window.setTimeout(() => setCopiedId((id) => (id === row.productId ? null : id)), 1500);
    } catch {
      // ignore clipboard failures
    }
    if (row.supplierLink) {
      window.open(row.supplierLink, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className={`flex min-h-screen flex-col gap-3 ${backgroundClass} p-3 md:p-4`}>
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          <p className="text-[var(--muted-foreground)]">
            Sign in to view replenishment suggestions.
          </p>
          <SignInButtonWithReturn>
            <button className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-[var(--foreground)]">Replenish</h1>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Compact reorder queue — open supplier, buy, mark Ordered. Skip hides sale junk for{" "}
                {SMART_SNOOZE_DAYS} days.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTargetsOpen(true)}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
            >
              Targets ({smartTargetCoverDays}d cover)
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
            <input
              type="search"
              placeholder="Search SKU, ASIN or title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-md rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
              aria-label="Search replenish list"
            />
            <div className="flex flex-wrap gap-2">
              <FilterChip active={filterUrgent} onClick={() => setFilterUrgent((v) => !v)}>
                Urgent (≤{URGENT_COVER_DAYS}d / OOS)
              </FilterChip>
              <FilterChip
                active={filterHasSupplier}
                onClick={() => setFilterHasSupplier((v) => !v)}
              >
                Has supplier
              </FilterChip>
              <FilterChip active={filterGoodBuy} onClick={() => setFilterGoodBuy((v) => !v)}>
                Hide bad buys
              </FilterChip>
            </div>
          </div>
          {snoozedCount > 0 && (
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              {snoozedCount} item{snoozedCount === 1 ? "" : "s"} hidden for {SMART_SNOOZE_DAYS}{" "}
              days (Ordered / Skip).
            </p>
          )}
        </div>

        <PurchaseOrderIngestPanel onFinished={load} />

        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--foreground)]">
                Quick deal check
              </div>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                Paste an ASIN + buy price for deals not on this list. Row button uses the
                listing ASIN automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                openDealCheck({
                  asin: "",
                  buyPrice: null,
                  title: "New deal",
                  allowEditAsin: true,
                })
              }
              className="rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500"
            >
              Check ASIN
            </button>
          </div>
        </div>

        {targetsOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Smart replenishment targets"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setTargetsOpen(false);
            }}
          >
            <div className="w-full max-w-lg rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--foreground)]">
                    Smart replenishment targets
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Adjust targets and suggestions update.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setTargetsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                  aria-label="Close targets"
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

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Target cover (days)
                  </span>
                  <input
                    inputMode="numeric"
                    value={String(smartTargetCoverDays)}
                    onChange={(e) => {
                      const v = clampNum(e.target.value, { min: 7, max: 180 });
                      if (v == null) return;
                      setSmartTargetCoverDays(Math.round(v));
                    }}
                    className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Target ROI (%)
                  </span>
                  <input
                    inputMode="decimal"
                    value={String(smartTargetRoiPct)}
                    onChange={(e) => {
                      const v = clampNum(e.target.value, { min: 0, max: 1000 });
                      if (v == null) return;
                      setSmartTargetRoiPct(Math.round(v * 100) / 100);
                    }}
                    className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Target profit / unit
                  </span>
                  <input
                    inputMode="decimal"
                    value={String(smartTargetProfitPerUnit)}
                    onChange={(e) => {
                      const v = clampNum(e.target.value, { min: 0, max: 9999 });
                      if (v == null) return;
                      setSmartTargetProfitPerUnit(Math.round(v * 100) / 100);
                    }}
                    className="h-9 rounded-lg border border-[var(--surface-border)] bg-white px-3 text-sm text-black focus:outline-none focus:ring-2 focus:ring-sb-accent dark:bg-white"
                  />
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setTargetsOpen(false)}
                  className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--muted-foreground)]">Loading…</div>
        ) : smart.length === 0 ? (
          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            No smart replenishment suggestions for your current targets.
          </div>
        ) : smartFiltered.length === 0 ? (
          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            Nothing left in this queue
            {filterGoodBuy ? " (bad buys hidden)" : ""}
            {snoozedCount > 0 ? ` — ${snoozedCount} snoozed` : ""}. Try clearing filters.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]">
            <div className="border-b border-[var(--surface-border)] px-4 py-2 text-xs text-[var(--muted-foreground)]">
              {smartFiltered.length} to reorder
              {filterGoodBuy ? " · hiding loss-making last buys" : ""}
            </div>

            <ul className="divide-y divide-[var(--surface-border)]">
              {smartPaginated.map((s) => {
                const qty = buyQtyByProductId[s.productId] ?? s.suggestedBuyQty;
                const urgent = isUrgent(s);
                const badBuy = !isGoodBuyNow(s);
                return (
                  <li
                    key={s.productId}
                    className="flex flex-col gap-2 px-3 py-2.5 hover:bg-[var(--foreground)]/[0.03] sm:flex-row sm:items-center sm:gap-3"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => openDetails(s)}
                    >
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--surface-border)] bg-[var(--background)]">
                        {s.imageUrl ? (
                          <img src={s.imageUrl} alt="" className="h-full w-full object-contain" />
                        ) : (
                          <span className="text-[9px] text-[var(--muted-foreground)]">—</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="line-clamp-1 text-sm font-medium text-[var(--foreground)]">
                            {s.title ?? s.sku}
                          </span>
                          {urgent && (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              Urgent
                            </span>
                          )}
                          {badBuy && (
                            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                              Bad at last buy
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--muted-foreground)]">
                          {s.asin && (
                            <span className="font-mono text-[var(--foreground)]">{s.asin}</span>
                          )}
                          <span className="tabular-nums">
                            Cover{" "}
                            <span className="text-[var(--foreground)]">
                              {s.daysOfCover != null ? `${s.daysOfCover}d` : "—"}
                            </span>
                          </span>
                          <span className="tabular-nums">
                            Stock{" "}
                            <span className="text-[var(--foreground)]">{s.effectiveStock}</span>
                          </span>
                          {s.maxBuyPriceForTargetsPerUnit != null && (
                            <span className="tabular-nums">
                              Max buy{" "}
                              <span className="text-[var(--foreground)]">
                                {MONEY(s.maxBuyPriceForTargetsPerUnit, selectedCurrency)}
                              </span>
                            </span>
                          )}
                          {s.supplier && (
                            <span className="line-clamp-1">
                              {s.supplier}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>

                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                        Qty
                        <input
                          inputMode="numeric"
                          value={String(qty)}
                          onChange={(e) => {
                            const v = clampNum(e.target.value, { min: 1, max: 5000 });
                            if (v == null) return;
                            setBuyQtyByProductId((prev) => ({
                              ...prev,
                              [s.productId]: Math.round(v),
                            }));
                          }}
                          className="h-8 w-16 rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2 text-sm tabular-nums text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                          aria-label={`Buy quantity for ${s.sku}`}
                        />
                      </label>

                      <button
                        type="button"
                        onClick={() => {
                          if (!s.asin) return;
                          openDealCheck({
                            asin: s.asin,
                            buyPrice: s.lastBuyUnitCostIncVat,
                            title: s.title ?? s.sku,
                          });
                        }}
                        disabled={!s.asin}
                        title={
                          s.asin
                            ? "Expected resale / profit from Keepa 3P New history"
                            : "No ASIN on this listing"
                        }
                        className="rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Deal check
                      </button>

                      <button
                        type="button"
                        onClick={() => void copyQtyAndOpenSupplier(s)}
                        disabled={!s.supplierLink}
                        title={
                          s.supplierLink
                            ? "Copy qty + ASIN and open supplier link"
                            : "No supplier link saved — add one in details"
                        }
                        className="rounded-md bg-sky-500 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-sm ring-1 ring-sky-300/50 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {copiedId === s.productId ? "Copied" : "Open supplier"}
                      </button>

                      <button
                        type="button"
                        onClick={() => snooze(s.productId, "replenished")}
                        className="rounded-md bg-emerald-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-600"
                      >
                        Ordered
                      </button>

                      <button
                        type="button"
                        onClick={() => snooze(s.productId, "unavailable")}
                        className="rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                        title={`Hide for ${SMART_SNOOZE_DAYS} days`}
                      >
                        Skip
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {smartTotalPages > 1 && (
              <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border)] px-4 py-3">
                <div className="text-sm text-[var(--muted-foreground)]">
                  Page {smartSafePage} of {smartTotalPages}
                  <span className="ml-2">
                    ({(smartSafePage - 1) * SMART_PAGE_SIZE + 1}–
                    {Math.min(smartSafePage * SMART_PAGE_SIZE, smartFiltered.length)} of{" "}
                    {smartFiltered.length})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSmartPage((p) => Math.max(1, p - 1))}
                    disabled={smartSafePage <= 1}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSmartPage((p) => Math.min(smartTotalPages, p + 1))}
                    disabled={smartSafePage >= smartTotalPages}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-transparent text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {detailsOpen && detailsItem && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Smart replenishment details"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDetailsOpen(false);
            }}
          >
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--foreground)]">
                    {detailsItem.title ?? detailsItem.sku}
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {detailsItem.asin ? (
                      <>
                        ASIN{" "}
                        <span className="font-mono text-[var(--foreground)]">
                          {detailsItem.asin}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono">{detailsItem.sku}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                  aria-label="Close details"
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

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    Suggested restock
                  </div>
                  <div className="mt-1 text-sm text-[var(--foreground)]">
                    Buy{" "}
                    <span className="font-semibold tabular-nums text-emerald-400">
                      {detailsItem.suggestedBuyQty}
                    </span>{" "}
                    units
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Stock{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {detailsItem.effectiveStock}
                    </span>{" "}
                    → target{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {detailsItem.targetStockUnits ?? "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Cover{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {detailsItem.daysOfCover ?? "—"}d
                    </span>{" "}
                    · target {smartTargetCoverDays}d
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {detailsItem.rationale}
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    Is this a good buy now?
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Last buy{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {detailsItem.lastBuyUnitCostIncVat != null
                        ? MONEY(detailsItem.lastBuyUnitCostIncVat, selectedCurrency)
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Exp. profit / unit at last buy{" "}
                    <span
                      className={`tabular-nums ${
                        (detailsItem.expectedProfitPerUnitAtLastBuy ?? 0) < 0
                          ? "text-red-500"
                          : "text-[var(--foreground)]"
                      }`}
                    >
                      {detailsItem.expectedProfitPerUnitAtLastBuy != null
                        ? MONEY(detailsItem.expectedProfitPerUnitAtLastBuy, selectedCurrency)
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Max buy for targets{" "}
                    <span className="tabular-nums text-[var(--foreground)]">
                      {detailsItem.maxBuyPriceForTargetsPerUnit != null
                        ? MONEY(detailsItem.maxBuyPriceForTargetsPerUnit, selectedCurrency)
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  Supplier
                </div>
                <div className="mt-2 space-y-2">
                  {detailsItem.supplier ? (
                    <div className="text-sm text-[var(--foreground)]">{detailsItem.supplier}</div>
                  ) : null}
                  {detailsItem.supplierLink ? (
                    <a
                      href={detailsItem.supplierLink}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2.5 text-sm font-bold text-white shadow-sm ring-1 ring-sky-300/50 hover:bg-sky-400"
                    >
                      Open supplier link
                      <span aria-hidden className="text-xs">↗</span>
                    </a>
                  ) : (
                    <p className="text-xs text-[var(--muted-foreground)]">
                      No supplier link saved yet.
                    </p>
                  )}
                </div>

                <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
                  <div className="text-[11px] font-semibold text-[var(--foreground)]">
                    Add new supplier link
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                    Paste a product URL to replace the saved link for Buy.
                  </p>
                  <div className="mt-2 flex flex-col gap-2">
                    <input
                      type="url"
                      placeholder="https://…"
                      value={newSupplierLink}
                      onChange={(e) => setNewSupplierLink(e.target.value)}
                      className="h-9 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                      aria-label="New supplier link"
                    />
                    <input
                      type="text"
                      placeholder="Supplier name (optional)"
                      value={newSupplierName}
                      onChange={(e) => setNewSupplierName(e.target.value)}
                      className="h-9 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                      aria-label="Supplier name"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void saveSupplierLink()}
                        disabled={savingSupplierLink || !newSupplierLink.trim()}
                        className="rounded-lg bg-sb-accent px-3 py-2 text-xs font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {savingSupplierLink ? "Saving…" : "Save link"}
                      </button>
                      {detailsItem.supplierLink && newSupplierLink.trim() && (
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          Replaces current link
                        </span>
                      )}
                    </div>
                    {supplierLinkError && (
                      <p className="text-xs text-red-500">{supplierLinkError}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {detailsItem.asin && (
                  <button
                    type="button"
                    onClick={() =>
                      openDealCheck({
                        asin: detailsItem.asin!,
                        buyPrice: detailsItem.lastBuyUnitCostIncVat,
                        title: detailsItem.title ?? detailsItem.sku,
                      })
                    }
                    className="rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500"
                  >
                    Deal check
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    snooze(detailsItem.productId, "unavailable");
                    setDetailsOpen(false);
                  }}
                  className="rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                >
                  Skip {SMART_SNOOZE_DAYS}d
                </button>
                <button
                  type="button"
                  onClick={() => {
                    snooze(detailsItem.productId, "replenished");
                    setDetailsOpen(false);
                  }}
                  className="rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
                >
                  Ordered
                </button>
              </div>
            </div>
          </div>
        )}

        <DealCheckPanel
          open={dealCheckOpen}
          onClose={() => setDealCheckOpen(false)}
          asin={dealCheckAsin}
          buyPrice={dealCheckBuy}
          marketplaceId={selectedMarketplaceId}
          title={dealCheckTitle}
          allowEditAsin={dealCheckAllowEditAsin}
          currency={selectedCurrency}
        />
      </SignedIn>
    </div>
  );
}

export default function ReplenishPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">Loading…</div>
      }
    >
      <ReplenishInner />
    </Suspense>
  );
}
