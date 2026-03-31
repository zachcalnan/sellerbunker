"use client";

import Link from "next/link";
import {
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import {
  aggregateOrderRows,
  filterOrderRowsForDashboardPreset,
  type DashboardRangePreset,
} from "@/lib/orders-period-metrics";
import { StripeCheckoutButton } from "@/components/stripe-checkout-button";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

type AccountSummary = {
  marketplace: string;
  sellerId: string;
  currency: string;
  period: string;
  revenue: number;
  profitMargin: number;
  unitsSold: number;
  totalOrders: number;
  orderItemsOrdersCount?: number;
  orderItemsCoveragePct?: number;
  activeSkus: number;
  unitsInFba: number;
  openShipments: number;
  hasCostData?: boolean;
  totalProfit?: number;
  totalCostOfGoods?: number;
  roiPct?: number | null;
  generatedAt: string;
};

type SalesPoint = {
  date: string;
  revenue: number;
  orders: number;
  profit: number;
};

type SalesSeries = {
  currency: string;
  points: SalesPoint[];
};

type RecentOrderRow = {
  id: string;
  orderId: string;
  orderDate: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  quantity: number;
  salePrice: number;
  profit: number | null;
  roiPct?: number | null;
  availableStock: number | null;
  totalStock: number | null;
  orderStatusLabel?: string | null;
  excludedFromSales?: boolean;
};

const POST_CONNECT_REFRESH_PENDING_KEY =
  "sellerbunker_post_connect_refresh_pending";
const CHECKOUT_SYNC_MODAL_PENDING_KEY =
  "sellerbunker_show_sync_modal_after_checkout";
const SYNC_RETRIGGERED_KEY = "sellerbunker_sync_retriggered_after_checkout";

/** Timeframe & custom-range controls: high-contrast for readability */
const FILTER_SELECT_CLASS =
  "h-8 cursor-pointer rounded-lg border border-zinc-600 bg-black px-2.5 text-xs text-white outline-none focus:ring-2 focus:ring-sb-accent/40";
const FILTER_DATE_CLASS =
  "h-8 rounded-lg border border-zinc-600 bg-black px-2 text-xs text-white outline-none [color-scheme:dark]";

function HomeInner() {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId } = useMarketplace();
  const { backgroundClass, ringColor } = useDisplaySettings();
  const router = useRouter();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");

  const [rangePreset, setRangePreset] = useState<
    "today" | "7d" | "14d" | "30d" | "yesterday" | "all" | "custom"
  >("30d");
  const [trendPreset, setTrendPreset] = useState<
    "today" | "7d" | "14d" | "30d" | "yesterday" | "all" | "custom"
  >("30d");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [trendCustomStart, setTrendCustomStart] = useState<string>("");
  const [trendCustomEnd, setTrendCustomEnd] = useState<string>("");
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [orderRowsForRings, setOrderRowsForRings] = useState<RecentOrderRow[]>(
    [],
  );
  const [ordersLoadedForRings, setOrdersLoadedForRings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSubscriptionAccess, setHasSubscriptionAccess] = useState<boolean | null>(null);
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const isLocked = hasSubscriptionAccess === false;

  const amazonConnectedParam = searchParams.get("amazon_connected") === "1";
  const [showAmazonConnectThankYou, setShowAmazonConnectThankYou] = useState(false);

  // Run as soon as possible (before paint): read URL directly so modal always shows regardless of useSearchParams/Suspense
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const search = window.location.search;
    const hasParam = search.includes("amazon_connected=1");
    const fromCheckout =
      sessionStorage.getItem(CHECKOUT_SYNC_MODAL_PENDING_KEY) === "1";

    if (fromCheckout && hasSubscriptionAccess === true) {
      try {
        // Payment redirect path does not include amazon_connected=1,
        // so mark sync as pending here as well to start bar polling.
        sessionStorage.setItem(POST_CONNECT_REFRESH_PENDING_KEY, "1");
        sessionStorage.setItem("sellerbunker_initial_sync_pending", "1");
        localStorage.setItem("sellerbunker_sync_started_at", String(Date.now()));
        localStorage.removeItem("sellerbunker_initial_sync_dismissed");
        window.dispatchEvent(new CustomEvent("sellerbunker-initial-sync-pending"));
      } catch {
        /* ignore */
      }
      setShowAmazonConnectThankYou(true);
      return;
    }

    if (hasParam) {
      try {
        sessionStorage.setItem(POST_CONNECT_REFRESH_PENDING_KEY, "1");
        sessionStorage.setItem("sellerbunker_initial_sync_pending", "1");
        try {
          localStorage.setItem("sellerbunker_sync_started_at", String(Date.now()));
        } catch {}
        const params = new URLSearchParams(search);
        const syncProgressApi = params.get("sync_progress_api");
        if (syncProgressApi) {
          sessionStorage.setItem("sellerbunker_sync_progress_api", syncProgressApi);
        }
        window.dispatchEvent(new CustomEvent("sellerbunker-initial-sync-pending"));
        localStorage.removeItem("sellerbunker_initial_sync_dismissed");
      } catch {
        /* ignore */
      }
      // Show full-sync waiting modal only for paid users.
      if (hasSubscriptionAccess === true) {
        setShowAmazonConnectThankYou(true);
      }
      return;
    }

    // Fallback: param was stripped (e.g. after auth redirect) but we have sync-pending and user hasn't dismissed
    const fromSession =
      sessionStorage.getItem(POST_CONNECT_REFRESH_PENDING_KEY) === "1" ||
      sessionStorage.getItem("sellerbunker_initial_sync_pending") === "1";
    const thanksSeen = localStorage.getItem("sellerbunker_amazon_connect_thanks_seen") === "1";
    if (fromSession && !thanksSeen && hasSubscriptionAccess === true) {
      setShowAmazonConnectThankYou(true);
    }
  }, [hasSubscriptionAccess]);

  // Keep sessionStorage in sync when searchParams resolve (e.g. after Suspense)
  useEffect(() => {
    if (!amazonConnectedParam) return;
    try {
      sessionStorage.setItem(POST_CONNECT_REFRESH_PENDING_KEY, "1");
      sessionStorage.setItem("sellerbunker_initial_sync_pending", "1");
      const syncProgressApi = searchParams.get("sync_progress_api");
      if (syncProgressApi) {
        sessionStorage.setItem("sellerbunker_sync_progress_api", syncProgressApi);
      }
      window.dispatchEvent(new CustomEvent("sellerbunker-initial-sync-pending"));
    } catch {
      /* ignore */
    }
  }, [amazonConnectedParam, searchParams]);

  // Safety net: after payment redirect, if sync is pending and still at 0, trigger
  // a background sync once so users don't need to reconnect Amazon manually.
  useEffect(() => {
    if (!isSignedIn || hasSubscriptionAccess !== true) return;
    if (typeof window === "undefined") return;
    const checkoutPending =
      sessionStorage.getItem(CHECKOUT_SYNC_MODAL_PENDING_KEY) === "1";
    const syncPending =
      sessionStorage.getItem(POST_CONNECT_REFRESH_PENDING_KEY) === "1" ||
      sessionStorage.getItem("sellerbunker_initial_sync_pending") === "1";
    if (!checkoutPending && !syncPending) return;
    if (sessionStorage.getItem(SYNC_RETRIGGERED_KEY) === "1") return;

    const run = async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token) return;
        const url = new URL(`${baseUrl}/api/amazon/sync`);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        await fetch(url.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
          },
        });
        sessionStorage.setItem(SYNC_RETRIGGERED_KEY, "1");
      } catch {
        // ignore; normal poller will continue
      }
    };
    void run();
  }, [isSignedIn, hasSubscriptionAccess, getToken, baseUrl]);
  const dismissAmazonConnectThankYou = () => {
    try {
      localStorage.setItem("sellerbunker_amazon_connect_thanks_seen", "1");
      sessionStorage.removeItem(CHECKOUT_SYNC_MODAL_PENDING_KEY);
    } catch {
      /* ignore */
    }
    setShowAmazonConnectThankYou(false);
    const next = new URLSearchParams(searchParams.toString());
    next.delete("amazon_connected");
    next.delete("sync_progress_api");
    const q = next.toString();
    router.replace(q ? `/dashboard?${q}` : "/dashboard");
  };

  const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const defaultEnd = toDateOnly(today);
  const defaultStart30 = toDateOnly(
    new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000),
  );
  const defaultStart14 = toDateOnly(
    new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000),
  );
  const yesterday = toDateOnly(
    new Date(today.getTime() - 24 * 60 * 60 * 1000),
  );
  const allTimeStart = "2020-01-01"; // fixed "all time" start

  const effectiveStart =
    rangePreset === "today"
      ? defaultEnd
      : rangePreset === "7d"
        ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
        : rangePreset === "14d"
          ? defaultStart14
          : rangePreset === "30d"
            ? defaultStart30
            : rangePreset === "yesterday"
              ? yesterday
              : rangePreset === "all"
                ? allTimeStart
                : (startParam ?? defaultStart30);
  const effectiveEnd =
    rangePreset === "today" ||
    rangePreset === "7d" ||
    rangePreset === "14d" ||
    rangePreset === "30d"
      ? defaultEnd
      : rangePreset === "yesterday"
        ? yesterday
        : rangePreset === "all"
          ? defaultEnd
          : (endParam ?? defaultEnd);

  /** Orders tab "30 days" / "7 days" = rolling N×24h from now, not calendar UTC dates. Rings must use the same window. */
  const hasCustomRangeInUrl = Boolean(startParam ?? endParam);
  const summaryRangeForApi = useMemo(() => {
    if (hasCustomRangeInUrl) {
      return { start: effectiveStart, end: effectiveEnd };
    }
    if (rangePreset === "30d") {
      const ms = 30 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    if (rangePreset === "7d") {
      const ms = 7 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    if (rangePreset === "14d") {
      const ms = 14 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    return { start: effectiveStart, end: effectiveEnd };
  }, [
    hasCustomRangeInUrl,
    rangePreset,
    effectiveStart,
    effectiveEnd,
  ]);

  /** Same period rules as `filterOrderRowsForDashboardPreset` + Orders tab rolling windows. */
  const dashboardRingFilterPreset = useMemo((): DashboardRangePreset => {
    if (hasCustomRangeInUrl || rangePreset === "custom") return "custom";
    return rangePreset;
  }, [hasCustomRangeInUrl, rangePreset]);

  const dashboardRingFilterCustom = useMemo(() => {
    if (dashboardRingFilterPreset !== "custom") return undefined;
    return { start: effectiveStart, end: effectiveEnd };
  }, [dashboardRingFilterPreset, effectiveStart, effectiveEnd]);

  // Trend has its own range (separate from summary/cards)
  const trendStart =
    trendPreset === "today"
      ? defaultEnd
      : trendPreset === "7d"
        ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
        : trendPreset === "14d"
          ? defaultStart14
          : trendPreset === "30d"
            ? defaultStart30
            : trendPreset === "yesterday"
              ? yesterday
              : trendPreset === "all"
                ? allTimeStart
                : (trendCustomStart || defaultStart30);
  const trendEnd =
    trendPreset === "today"
      ? defaultEnd
      : trendPreset === "7d"
        ? defaultEnd
        : trendPreset === "14d"
          ? defaultEnd
          : trendPreset === "30d"
            ? defaultEnd
            : trendPreset === "yesterday"
              ? yesterday
              : trendPreset === "all"
                ? defaultEnd
                : (trendCustomEnd || defaultEnd);

  const trendRangeForApi = useMemo(() => {
    if (trendPreset === "custom") {
      return {
        start: trendCustomStart || defaultStart30,
        end: trendCustomEnd || defaultEnd,
      };
    }
    if (trendPreset === "30d") {
      const ms = 30 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    if (trendPreset === "7d") {
      const ms = 7 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    if (trendPreset === "14d") {
      const ms = 14 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(Date.now() - ms).toISOString(),
        end: new Date().toISOString(),
      };
    }
    return { start: trendStart, end: trendEnd };
  }, [
    trendPreset,
    trendCustomStart,
    trendCustomEnd,
    trendStart,
    trendEnd,
    defaultStart30,
    defaultEnd,
  ]);

  const rangeLabel =
    rangePreset === "today"
      ? "Today"
      : rangePreset === "yesterday"
        ? "Yesterday"
        : rangePreset === "7d"
          ? "7 days"
          : rangePreset === "14d"
            ? "Two weeks"
            : rangePreset === "30d"
              ? "30 days"
              : rangePreset === "all"
                ? "All time"
                : "Custom";
  const trendLabel =
    trendPreset === "today"
      ? "Today"
      : trendPreset === "yesterday"
        ? "Yesterday"
        : trendPreset === "7d"
          ? "7 days"
          : trendPreset === "14d"
            ? "Two weeks"
            : trendPreset === "30d"
              ? "30 days"
              : trendPreset === "all"
                ? "All time"
                : "Custom";

  useEffect(() => {
    // Initialize preset based on URL (or defaults)
    const start = effectiveStart;
    const end = effectiveEnd;

    const isSame = (a: string, b: string) => a === b;
    const endIsToday = isSame(end, defaultEnd);
    const startIsToday = isSame(start, defaultEnd);
    const startIs7 = isSame(
      start,
      toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)),
    );
    const startIs14 = isSame(start, defaultStart14);
    const startIs30 = isSame(start, defaultStart30);

    if (startParam || endParam) {
      const startIsYesterday = isSame(start, yesterday);
      const endIsYesterday = isSame(end, yesterday);
      const startIsAll = isSame(start, allTimeStart);
      const endIsTodayForAll = isSame(end, defaultEnd);
      if (startIsToday && endIsToday) setRangePreset("today");
      else if (startIs7 && endIsToday) setRangePreset("7d");
      else if (startIs14 && endIsToday) setRangePreset("14d");
      else if (startIs30 && endIsToday) setRangePreset("30d");
      else if (startIsYesterday && endIsYesterday)
        setRangePreset("yesterday");
      else if (startIsAll && endIsTodayForAll) setRangePreset("all");
      else setRangePreset("custom");
    } else {
      setRangePreset("30d");
    }

    setCustomStart(start);
    setCustomEnd(end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startParam, endParam]);

  const setRangeInUrl = (start: string, end: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("start", start);
    next.set("end", end);
    router.replace(`/dashboard?${next.toString()}`);
  };

  const fetchSummary = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!isSignedIn) return;
      if (!opts?.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(
          `${baseUrl}/api/amazon/account/summary?` +
            new URLSearchParams({
              start: summaryRangeForApi.start,
              end: summaryRangeForApi.end,
            }).toString(),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
            },
          },
        );
        if (!res.ok) {
          const message =
            res.status === 404
              ? "Start by connecting your Amazon account to SellerBunker."
              : "Start by connecting your Amazon account to SellerBunker.";
          setError(message);
          setSummary(null);
          return;
        }
        const data = (await res.json()) as AccountSummary;
        setSummary(data);
      } catch {
        if (!opts?.silent) {
          setError("Unable to reach backend. Is it running?");
          setSummary(null);
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [
      isSignedIn,
      getToken,
      baseUrl,
      summaryRangeForApi.start,
      summaryRangeForApi.end,
      selectedMarketplaceId,
    ],
  );

  const fetchOrdersForRings = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      const url = new URL(`${baseUrl}/api/amazon/orders`);
      if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
          ...(selectedMarketplaceId
            ? { "x-marketplace-id": selectedMarketplaceId }
            : {}),
        },
      });
      if (!res.ok) {
        setOrderRowsForRings([]);
        setOrdersLoadedForRings(false);
        return;
      }
      const data = (await res.json()) as RecentOrderRow[];
      setOrderRowsForRings(Array.isArray(data) ? data : []);
      setOrdersLoadedForRings(true);
    } catch {
      setOrderRowsForRings([]);
      setOrdersLoadedForRings(false);
    }
  }, [isSignedIn, getToken, baseUrl, selectedMarketplaceId]);

  useEffect(() => {
    if (!isSignedIn) {
      setSummary(null);
      return;
    }
    fetchSummary();
  }, [isSignedIn, fetchSummary]);

  useEffect(() => {
    if (!isSignedIn) {
      setOrderRowsForRings([]);
      setOrdersLoadedForRings(false);
      return;
    }
    void fetchOrdersForRings();
  }, [isSignedIn, fetchOrdersForRings]);

  useEffect(() => {
    if (!isSignedIn) return;
    const checkAccess = async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token) return;
        const url = new URL(`${baseUrl}/api/subscription/status`);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
          },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { hasAccess?: boolean };
        setHasSubscriptionAccess(Boolean(data.hasAccess));
      } catch {
        // Keep default true so dashboard stays usable if check fails.
      }
    };
    void checkAccess();
  }, [isSignedIn, getToken, baseUrl]);

  useEffect(() => {
    if (!isSignedIn) return;
    const handleAmazonDisconnected = () => {
      setShowAmazonConnectThankYou(false);
      void fetchSummary({ silent: true });
      void fetchOrdersForRings();
    };
    window.addEventListener(
      "sellerbunker-amazon-disconnected",
      handleAmazonDisconnected,
    );
    return () =>
      window.removeEventListener(
        "sellerbunker-amazon-disconnected",
        handleAmazonDisconnected,
      );
  }, [isSignedIn, fetchSummary, fetchOrdersForRings]);

  // After connecting Amazon, sync runs in the background. Poll summary until we have data
  // so the dashboard updates without a manual refresh.
  const isPostConnect =
    amazonConnectedParam ||
    (typeof window !== "undefined" &&
      sessionStorage.getItem(POST_CONNECT_REFRESH_PENDING_KEY) === "1");
  useEffect(() => {
    if (!isPostConnect) return;
    const hasOrderLines =
      (summary?.totalOrders ?? 0) > 0 || orderRowsForRings.length > 0;
    if (hasOrderLines) {
      try {
        sessionStorage.removeItem(POST_CONNECT_REFRESH_PENDING_KEY);
      } catch {}
      return;
    }
    const maxPolls = 20;
    let polls = 0;
    const interval = setInterval(async () => {
      polls += 1;
      if (polls > maxPolls) {
        try {
          sessionStorage.removeItem(POST_CONNECT_REFRESH_PENDING_KEY);
        } catch {}
        clearInterval(interval);
        return;
      }
      await fetchSummary({ silent: true });
      await fetchOrdersForRings();
    }, 12000);
    return () => clearInterval(interval);
  }, [
    isPostConnect,
    fetchSummary,
    fetchOrdersForRings,
    summary?.totalOrders,
    orderRowsForRings.length,
  ]);

  const ringMetricsFromOrders = useMemo(() => {
    if (!ordersLoadedForRings) return null;
    const filtered = filterOrderRowsForDashboardPreset(
      orderRowsForRings,
      dashboardRingFilterPreset,
      dashboardRingFilterCustom,
    );
    return aggregateOrderRows(filtered);
  }, [
    ordersLoadedForRings,
    orderRowsForRings,
    dashboardRingFilterPreset,
    dashboardRingFilterCustom,
  ]);

  const displaySummary = useMemo(() => {
    if (!summary) return null;
    if (!ringMetricsFromOrders) return summary;
    const rev = ringMetricsFromOrders.totalSales;
    const margin =
      rev > 0
        ? ringMetricsFromOrders.totalProfit / rev
        : summary.profitMargin;
    return {
      ...summary,
      revenue: rev,
      unitsSold: ringMetricsFromOrders.totalUnits,
      totalOrders: ringMetricsFromOrders.orderCount,
      totalProfit: ringMetricsFromOrders.totalProfit,
      profitMargin: margin,
    };
  }, [summary, ringMetricsFromOrders]);

  const effectiveCurrency = summary?.currency ?? "USD";

  const hasCostData = summary?.hasCostData ?? false;
  const showProfitNumbers =
    (ordersLoadedForRings && summary != null) || hasCostData;
  // Profit / sales / units: same aggregation as Orders tab when order list has loaded
  const profit =
    displaySummary != null
      ? (displaySummary.totalProfit != null
          ? displaySummary.totalProfit
          : displaySummary.revenue * displaySummary.profitMargin)
      : 0;
  // ROI = profit / cost of goods (backend; can differ from order-line profit)
  const roiPct =
    summary != null && hasCostData && summary.roiPct != null && Number.isFinite(summary.roiPct)
      ? summary.roiPct
      : 0;
  const cards = displaySummary
    ? [
        {
          label: "Profit",
          value: showProfitNumbers ? formatCurrency(profit, effectiveCurrency, 2) : "—",
          percentage: showProfitNumbers ? Math.round(displaySummary.profitMargin * 100) : 0,
          color: "#22C55E",
          fullRing: true,
          centerLine1: showProfitNumbers ? formatCurrency(profit, effectiveCurrency, 2) : "—",
          centerLine2: "",
          centerLine3: showProfitNumbers ? `${(displaySummary.profitMargin * 100).toFixed(1)}%` : "—",
        },
        {
          label: "Sales",
          value: formatCurrency(displaySummary.revenue, effectiveCurrency, 2),
          percentage: 0,
          color: "#60A5FA",
          fullRing: true,
          hidePercentage: true,
        },
        {
          label: "Units",
          value: displaySummary.unitsSold.toLocaleString(),
          percentage: 0,
          color: "#F59E0B",
          fullRing: true,
          hidePercentage: true,
        },
        {
          label: "ROI",
          value: hasCostData ? `${Math.round(roiPct)}%` : "—",
          percentage: hasCostData ? Math.min(100, Math.round(roiPct)) : 0,
          color: "#A78BFA",
          fullRing: true,
          hidePercentage: !hasCostData,
          centerLine1: hasCostData ? `${Math.round(roiPct)}%` : "—",
          centerLine2: "",
          centerLine3: "ROI",
        },
      ]
    : [];

  return (
    <div className={`min-h-screen ${backgroundClass} text-[var(--foreground)]`}>
      {showAmazonConnectThankYou && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-6">
          <div className="relative flex h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 shadow-2xl">
            <button
              type="button"
              onClick={dismissAmazonConnectThankYou}
              className="absolute right-4 top-4 rounded p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
              <h2 className="text-xl font-semibold text-[var(--foreground)] sm:text-2xl">
                Please be patient — your data is syncing
              </h2>
              <div className="flex flex-col gap-4 text-sm text-[var(--muted-foreground)] sm:text-base">
                <p>
                  This only has to happen once. When you return, your data will be available for immediate loading.
                </p>
                <p>
                  Right now we&apos;re syncing your full Amazon estate, including the last 30 days of orders and shipments (plus inventory and fees as they load).
                </p>
                <p>
                  Initial sync can take up to 30 minutes if things are slow. You can close this and use the app — some data will continue syncing in the background while you navigate. That’s normal.
                </p>
                <p className="mt-2 font-medium text-[var(--foreground)]">
                  Thank you for joining SellerBunker.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissAmazonConnectThankYou}
                className="rounded-lg bg-sb-accent px-6 py-3 text-sm font-medium text-black hover:opacity-90"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      {unlockModalOpen && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-2xl">
            <div className="mb-3 flex items-center gap-2 text-[var(--foreground)]">
              <span aria-hidden>🔒</span>
              <h3 className="text-lg font-semibold">Unlock full order history</h3>
            </div>
            <p className="text-sm text-[var(--muted-foreground)]">
              We are currently in testing. Access is free if you have a code.
            </p>
            <div className="mt-4">
              <StripeCheckoutButton className="w-full rounded-lg bg-sb-accent px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90">
                Continue
              </StripeCheckoutButton>
            </div>
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">
              You can request the free sign up code:
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <a href="https://discord.gg/sbDwPbV9" target="_blank" rel="noopener noreferrer" className="underline">Discord</a>
              <a href="https://www.instagram.com/sellerbunker" target="_blank" rel="noopener noreferrer" className="underline">Instagram</a>
              <a href="https://www.tiktok.com/@sellerbunker" target="_blank" rel="noopener noreferrer" className="underline">TikTok</a>
              <a href="mailto:support@sellerbunker.com" className="underline">Email</a>
            </div>
            <button
              type="button"
              onClick={() => setUnlockModalOpen(false)}
              className="mt-5 w-full rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
            >
              Close
            </button>
          </div>
        </div>
      )}
      <main className="flex min-h-screen w-full flex-col gap-6 px-4 pt-2 pb-6">

        {loading && (
          <div className="rounded-xl border border-[var(--surface-border)] bg-transparent px-4 py-3 text-xs text-[var(--muted-foreground)]">
            Loading account summary...
          </div>
        )}
        {error ? (
          <div className="flex flex-col gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-700">
            <span>{error}</span>
            {isSignedIn && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const token = await getToken({ template: "backend" });
                    if (!token) {
                      alert("Please sign in again and try connecting.");
                      return;
                    }
                    const returnOrigin = typeof window !== 'undefined' ? window.location.origin : '';
                    const params = new URLSearchParams({ region: 'EU' });
                    if (returnOrigin) params.set('returnOrigin', returnOrigin);
                    if (devImpersonate) params.set("impersonate", devImpersonate);
                    const res = await fetch(`${baseUrl}/api/amazon/connect?${params}`, {
                      headers: {
                        Authorization: `Bearer ${token}`,
                        ...getDevImpersonationHeaders(devImpersonate),
                        ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
                      },
                    });
                    const data = (await res.json()) as { url?: string; message?: string };
                    if (!res.ok) {
                      alert(`Could not start Amazon connection: ${data?.message ?? res.statusText ?? "Please try again."}`);
                      return;
                    }
                    if (data?.url) {
                      window.location.href = data.url;
                    } else {
                      alert("Could not get Amazon sign-in link. Please try again or contact support.");
                    }
                  } catch (e) {
                    alert(`Could not start Amazon connection: ${e instanceof Error ? e.message : "Please try again."}`);
                  }
                }}
                className="inline-flex w-fit items-center justify-center rounded-md bg-sb-accent px-3 py-1.5 text-xs font-medium text-black shadow-sm transition hover:opacity-90"
              >
                Connect Amazon
              </button>
            )}
          </div>
        ) : null}

        {summary && (
          <section className="-mt-0.5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
              {/* Left column: Performance Snapshot + Recent orders + Top Sellers + Cost Breakdown */}
              <div className="flex min-w-0 flex-col gap-3">
                {/* Performance Snapshot */}
                <div className="flex w-full flex-col rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 shadow-sm">
                  <div className="mb-4 flex w-full flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--foreground)]">
                      Performance Snapshot
                    </h2>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--muted-foreground)]">
                    <select
                      value={rangePreset}
                      onChange={(e) => {
                        const v = e.target.value as
                          | "today"
                          | "7d"
                          | "14d"
                          | "30d"
                          | "yesterday"
                          | "all"
                          | "custom";
                        setRangePreset(v);
                        if (v === "custom") return;
                        const end =
                          v === "yesterday"
                            ? yesterday
                            : v === "all"
                              ? defaultEnd
                              : defaultEnd;
                        const start =
                          v === "today"
                            ? defaultEnd
                            : v === "7d"
                              ? toDateOnly(
                                  new Date(
                                    today.getTime() - 6 * 24 * 60 * 60 * 1000,
                                  ),
                                )
                              : v === "14d"
                                ? defaultStart14
                                : v === "30d"
                                  ? defaultStart30
                                  : v === "yesterday"
                                    ? yesterday
                                    : allTimeStart;
                        setRangeInUrl(start, end);
                      }}
                      className={FILTER_SELECT_CLASS}
                    >
                      <option className="bg-black text-white" value="today">Today</option>
                      <option className="bg-black text-white" value="yesterday">Yesterday</option>
                      <option className="bg-black text-white" value="7d">7 days</option>
                      <option className="bg-black text-white" value="14d">Two weeks</option>
                      <option className="bg-black text-white" value="30d">30 days</option>
                      <option className="bg-black text-white" value="all">All time</option>
                      <option className="bg-black text-white" value="custom">Custom</option>
                    </select>
                    {rangePreset === "custom" ? (
                      <>
                        <input
                          type="date"
                          value={customStart}
                          onChange={(e) =>
                            setCustomStart(e.target.value)}
                          className={FILTER_DATE_CLASS}
                        />
                        <span className="text-[var(--muted-foreground)]">→</span>
                        <input
                          type="date"
                          value={customEnd}
                          onChange={(e) =>
                            setCustomEnd(e.target.value)}
                          className={FILTER_DATE_CLASS}
                        />
                        <button
                          type="button"
                          className="h-8 cursor-pointer rounded-lg bg-sb-accent px-3 text-xs font-medium text-black transition hover:opacity-90"
                          onClick={() => {
                            if (!customStart || !customEnd) return;
                            setRangeInUrl(customStart, customEnd);
                          }}
                        >
                          Apply
                        </button>
                      </>
                    ) : null}
                    {isLocked && (
                      <div className="rounded-md border border-[var(--surface-border)] bg-[var(--background)]/50 px-2 py-1 text-[10px] text-[var(--foreground)]">
                        🔒 Unlock full performance snapshot{" "}
                        <button
                          type="button"
                          onClick={() => setUnlockModalOpen(true)}
                          className="ml-1 rounded bg-sb-accent px-1.5 py-0.5 text-[10px] font-semibold text-black"
                        >
                          Unlock access
                        </button>
                      </div>
                    )}
                    </div>
                  </div>
                  <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-4">
                    {cards.map((card) => (
                      <DonutCard key={card.label} {...card} />
                    ))}
                  </div>
                </div>

                {/* Recent orders */}
                <RecentOrders
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                  maxRows={hasSubscriptionAccess ? 10 : 5}
                />
                {isLocked && (
                  <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--foreground)]">
                    <span className="mr-2">🔒</span>
                    Unlock full order history
                    <button
                      type="button"
                      onClick={() => setUnlockModalOpen(true)}
                      className="ml-2 rounded bg-sb-accent px-2 py-0.5 font-semibold text-black"
                    >
                      Unlock access
                    </button>
                  </div>
                )}

                {/* Top categories by metric (4 pie charts by displayGroup) */}
                <div className={isLocked ? "blur-sm pointer-events-none select-none" : ""}>
                <CategoryPieCharts
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                  start={summaryRangeForApi.start}
                  end={summaryRangeForApi.end}
                />
                </div>

                {/* Top Sellers (this month) */}
                <div className={isLocked ? "blur-sm pointer-events-none select-none" : ""}>
                <TopSellers
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                />
                </div>

                {/* Cost Breakdown (actual sales costs) */}
                <div className={isLocked ? "blur-sm pointer-events-none select-none" : ""}>
                <CostBreakdown
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                />
                </div>
              </div>

              {/* Right column: Sales v Profit + Inventory Summary + Category Pie Charts + Profit & Loss */}
              <div className={`flex min-w-0 flex-col gap-3 ${isLocked ? "blur-sm pointer-events-none select-none" : ""}`}>
              <div className="flex min-w-0 w-full flex-col overflow-hidden rounded-xl bg-[var(--surface)] p-4 ring-1 ring-[var(--surface-border)]">
                <div className="mb-3 flex w-full items-center justify-between gap-2">
                  <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
                    Sales v Profit
                  </h2>
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--muted-foreground)]">
                    <select
                      value={trendPreset}
                      onChange={(e) => {
                        const v = e.target.value as
                          | "today"
                          | "7d"
                          | "14d"
                          | "30d"
                          | "yesterday"
                          | "all"
                          | "custom";
                        setTrendPreset(v);
                        if (v === "custom") return;
                        const end =
                          v === "yesterday"
                            ? yesterday
                            : v === "all"
                              ? defaultEnd
                              : defaultEnd;
                        const start =
                          v === "today"
                            ? defaultEnd
                            : v === "7d"
                              ? toDateOnly(
                                  new Date(
                                    today.getTime() - 6 * 24 * 60 * 60 * 1000,
                                  ),
                                )
                              : v === "14d"
                                ? defaultStart14
                                : v === "30d"
                                  ? defaultStart30
                                  : v === "yesterday"
                                    ? yesterday
                                    : allTimeStart;
                        setTrendCustomStart(start);
                        setTrendCustomEnd(end);
                      }}
                      className={FILTER_SELECT_CLASS}
                    >
                      <option className="bg-black text-white" value="today">Today</option>
                      <option className="bg-black text-white" value="yesterday">Yesterday</option>
                      <option className="bg-black text-white" value="7d">7 days</option>
                      <option className="bg-black text-white" value="14d">Two weeks</option>
                      <option className="bg-black text-white" value="30d">30 days</option>
                      <option className="bg-black text-white" value="all">All time</option>
                      <option className="bg-black text-white" value="custom">Custom</option>
                    </select>
                    {trendPreset === "custom" ? (
                      <>
                        <input
                          type="date"
                          value={trendCustomStart}
                          onChange={(e) =>
                            setTrendCustomStart(e.target.value)}
                          className={FILTER_DATE_CLASS}
                        />
                        <span className="text-[var(--muted-foreground)]">→</span>
                        <input
                          type="date"
                          value={trendCustomEnd}
                          onChange={(e) =>
                            setTrendCustomEnd(e.target.value)}
                          className={FILTER_DATE_CLASS}
                        />
                      </>
                    ) : null}
                  </div>
                </div>
                <SalesTrend
                  baseUrl={baseUrl}
                  isSignedIn={isSignedIn}
                  getToken={getToken}
                  currency={effectiveCurrency}
                  start={trendRangeForApi.start}
                  end={trendRangeForApi.end}
                  label={trendLabel}
                  noWrapper
                />
              </div>

              {/* Inventory breakdown */}
              <InventorySummary
                baseUrl={baseUrl}
                isSignedIn={isSignedIn}
                getToken={getToken}
                currency={effectiveCurrency}
              />

              {/* Profit & Loss: just below Inventory Summary */}
              <ProfitAndLoss
                baseUrl={baseUrl}
                isSignedIn={isSignedIn}
                getToken={getToken}
                currency={effectiveCurrency}
              />
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-4 py-6 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

type RecentOrdersProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
  maxRows?: number;
};

function RecentOrders({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
  maxRows = 10,
}: RecentOrdersProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [orders, setOrders] = useState<RecentOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setOrders([]);
      return;
    }
    const fetchOrders = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken({ template: "backend" });
        const url = new URL(`${baseUrl}/api/amazon/orders`);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
            ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
          },
        });
        if (!res.ok) throw new Error("Failed to load orders");
        const data = (await res.json()) as RecentOrderRow[];
        setOrders(Array.isArray(data) ? data.slice(0, maxRows) : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error");
        setOrders([]);
      } finally {
        setLoading(false);
      }
    };
    void fetchOrders();
  }, [isSignedIn, getToken, baseUrl, selectedMarketplaceId, maxRows, devImpersonate]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-4 ring-1 ring-[var(--surface-border)]">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
        Recent orders
      </h2>
      {loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
      {!loading && !error && orders.length === 0 && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No orders yet.
        </p>
      )}
      {!loading && !error && orders.length > 0 && (
        <div className="max-h-44 w-full overflow-y-auto overflow-x-hidden">
          <div className="min-w-0 w-full pr-2">
            {/* Header: title area left, Price/Profit/ROI grouped right (centered under headers) */}
            <div className="flex w-full items-center gap-2 border-b border-[var(--surface-border)] pb-1 pt-0 text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              <span className="min-w-0 flex-1">Product</span>
              <div className="flex shrink-0 items-center justify-end gap-1 pl-2">
                <span className="w-16 text-center text-white">Price</span>
                <span className="w-16 text-center text-white">Profit</span>
                <span className="w-9 text-center text-white">ROI</span>
              </div>
            </div>
            {orders.map((row) => {
              const revenue = row.salePrice * row.quantity;
              const title = row.title?.trim() || "—";
              const excluded = Boolean(row.excludedFromSales);
              return (
                <div
                  key={row.id}
                  className="flex w-full min-w-0 flex-col gap-0.5 border-b border-[var(--surface-border)] py-1.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <div className="truncate text-[10px] font-medium leading-tight text-[var(--foreground)]" title={row.title ?? undefined}>
                        {title}
                      </div>
                      {row.orderStatusLabel ? (
                        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-red-600">
                          {row.orderStatusLabel}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-[var(--muted-foreground)]">
                      <div className="h-5 w-5 shrink-0 overflow-hidden rounded bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                        {row.imageUrl ? (
                          <img src={row.imageUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[8px]">—</div>
                        )}
                      </div>
                      <span className="truncate">
                        {formatDate(row.orderDate)}
                        <span className="mx-1">·</span>
                        {row.sku}
                        <span className="mx-1">·</span>
                        {row.asin ?? "—"}
                        <span className="mx-1">·</span>
                        Qty {row.quantity}
                        <span className="mx-1">·</span>
                        Stock {row.availableStock != null ? row.availableStock : "—"}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center justify-end gap-1 pl-2 text-[10px] tabular-nums font-medium text-white">
                    <span
                      className={`w-16 text-center ${excluded ? "font-semibold text-red-600" : ""}`}
                    >
                      {revenue != null && Number.isFinite(revenue) ? formatCurrency(revenue, currency, 2) : "—"}
                    </span>
                    <span className="w-16 text-center">
                      {row.profit != null && Number.isFinite(row.profit) ? formatCurrency(row.profit, currency, 2) : "—"}
                    </span>
                    <span className="w-9 text-center">
                      {row.roiPct != null && Number.isFinite(row.roiPct) ? `${row.roiPct.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type TopSellerRow = {
  productId: string;
  sku: string | null;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  units: number;
  revenue: number;
  profit: number;
};

type TopSellersProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

function TopSellers({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: TopSellersProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [rows, setRows] = useState<TopSellerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFallbackPeriod, setIsFallbackPeriod] = useState(false);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      return;
    }
    const fetchTop = async () => {
      setLoading(true);
      setError(null);
      setIsFallbackPeriod(false);
      try {
        const token = await getToken({ template: "backend" });
        const url1 = new URL(
          `${baseUrl}/api/amazon/products/top-profitable?limit=5&period=month`,
        );
        if (devImpersonate) url1.searchParams.set("impersonate", devImpersonate);
        let res = await fetch(
          url1.toString(),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...getDevImpersonationHeaders(devImpersonate),
              ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
            },
          },
        );
        if (!res.ok) throw new Error("Failed to load top sellers");
        let data = (await res.json()) as TopSellerRow[];
        if (Array.isArray(data) && data.length === 0) {
          const url2 = new URL(
            `${baseUrl}/api/amazon/products/top-profitable?limit=5&period=30d`,
          );
          if (devImpersonate) url2.searchParams.set("impersonate", devImpersonate);
          res = await fetch(
            url2.toString(),
            {
              headers: {
                Authorization: `Bearer ${token}`,
                ...getDevImpersonationHeaders(devImpersonate),
                ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
              },
            },
          );
          if (res.ok) {
            data = (await res.json()) as TopSellerRow[];
            if (Array.isArray(data) && data.length > 0) setIsFallbackPeriod(true);
          }
        }
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error");
        setRows([]);
      } finally {
        setLoading(false);
      }
    };
    void fetchTop();
  }, [isSignedIn, getToken, baseUrl, selectedMarketplaceId, devImpersonate]);

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-3 ring-1 ring-[var(--surface-border)]">
      <h2 className="mb-1.5 text-xs font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
        Top Sellers (this month)
      </h2>
      {isFallbackPeriod && rows.length > 0 && (
        <p className="mb-1 text-[9px] text-[var(--muted-foreground)]">
          No sales this month — showing last 30 days
        </p>
      )}
      {loading && (
        <p className="text-[10px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {error && (
        <p className="text-[10px] text-red-600">{error}</p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p className="text-[10px] text-[var(--muted-foreground)]">
          No sales this month yet.
        </p>
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <th className="py-1 pr-1.5 text-left">Title</th>
                <th className="py-1 px-1.5 text-left">SKU</th>
                <th className="py-1 px-1 text-left">IMG</th>
                <th className="py-1 px-1.5 text-left">ASIN</th>
                <th className="w-14 py-1 text-center">Qty</th>
                <th className="w-14 py-1 text-center">Rev</th>
                <th className="w-14 py-1 text-center">Profit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.productId}
                  className="border-b border-[var(--surface-border)] last:border-b-0"
                >
                  <td className="max-w-[8rem] truncate py-1 pr-1.5 font-medium text-[var(--foreground)]" title={row.title ?? undefined}>
                    {row.title?.trim() || "—"}
                  </td>
                  <td className="max-w-[5rem] truncate py-1 px-1.5 font-medium tabular-nums text-[var(--foreground)]" title={row.sku ?? undefined}>
                    {row.sku ?? "—"}
                  </td>
                  <td className="py-1 px-1">
                    <div className="h-6 w-6 overflow-hidden rounded bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                      {row.imageUrl ? (
                        <img
                          src={row.imageUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div
                          className="flex h-full w-full items-center justify-center bg-[var(--surface)] text-[7px] font-medium uppercase text-[var(--muted-foreground)]"
                          title="No image"
                        >
                          —
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="max-w-[4.5rem] truncate py-1 px-1.5 tabular-nums text-[var(--foreground)]" title={row.asin ?? undefined}>
                    {row.asin ?? "—"}
                  </td>
                  <td className="w-14 py-1 text-center tabular-nums text-[var(--foreground)]">
                    {row.units.toLocaleString()}
                  </td>
                  <td className="w-14 py-1 text-center tabular-nums text-[var(--foreground)]">
                    {formatCurrency(row.revenue, currency)}
                  </td>
                  <td className="w-14 py-1 text-center tabular-nums text-[var(--foreground)]">
                    {formatCurrency(row.profit, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type CostBreakdownData = {
  totalCogs: number;
  prepFees: number;
  referralFees: number;
  fbaFees: number;
  digitalServiceFees: number;
  totalAmazonFees: number;
  currency: string;
  start: string;
  end: string;
};

type CostBreakdownProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

type CostBreakdownPreset = "yesterday" | "today" | "7d" | "14d" | "30d" | "all" | "custom";

function CostBreakdown({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: CostBreakdownProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [data, setData] = useState<CostBreakdownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [periodPreset, setPeriodPreset] = useState<CostBreakdownPreset>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const defaultEnd = toDateOnly(today);
  const defaultStart30 = toDateOnly(new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000));
  const yesterday = toDateOnly(new Date(today.getTime() - 24 * 60 * 60 * 1000));
  const allTimeStart = "2020-01-01";

  const effectiveStart =
    periodPreset === "today"
      ? defaultEnd
      : periodPreset === "yesterday"
        ? yesterday
        : periodPreset === "7d"
          ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
          : periodPreset === "14d"
            ? toDateOnly(new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000))
            : periodPreset === "30d"
              ? defaultStart30
              : periodPreset === "all"
                ? allTimeStart
                : customStart || defaultStart30;
  const effectiveEnd =
    periodPreset === "today" || periodPreset === "7d" || periodPreset === "14d" || periodPreset === "30d"
      ? defaultEnd
      : periodPreset === "yesterday"
        ? yesterday
        : periodPreset === "all"
          ? defaultEnd
          : customEnd || defaultEnd;

  useEffect(() => {
    if (!isSignedIn) {
      setData(null);
      return;
    }
    const fetchData = async () => {
      setLoading(true);
      try {
        const token = await getToken({ template: "backend" });
        const url = new URL(`${baseUrl}/api/amazon/dashboard/cost-breakdown`);
        url.searchParams.set("start", effectiveStart);
        url.searchParams.set("end", effectiveEnd);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
            ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
          },
        });
        if (!res.ok) throw new Error("Failed to load cost breakdown");
        const json = (await res.json()) as CostBreakdownData;
        setData(json);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, [isSignedIn, getToken, baseUrl, effectiveStart, effectiveEnd, selectedMarketplaceId, devImpersonate]);

  const cur = data?.currency ?? currency;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

  const rows: { label: string; value: number }[] = data
    ? [
        { label: "Total COGS", value: data.totalCogs },
        { label: "Prep fees", value: data.prepFees },
        { label: "Referral (sales fee)", value: data.referralFees },
        { label: "FBA (sales fee)", value: data.fbaFees },
        { label: "Digital service fee", value: data.digitalServiceFees },
        { label: "Total Amazon fees", value: data.totalAmazonFees },
      ]
    : [];

  const total = data
    ? data.totalCogs + data.prepFees + data.referralFees + data.fbaFees + data.digitalServiceFees
    : 0;

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-4 ring-1 ring-[var(--surface-border)]">
      <div className="mb-2 flex w-full flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
          Cost Breakdown
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <select
            value={periodPreset}
            onChange={(e) => setPeriodPreset(e.target.value as CostBreakdownPreset)}
            className={FILTER_SELECT_CLASS}
          >
            <option className="bg-black text-white" value="yesterday">Yesterday</option>
            <option className="bg-black text-white" value="today">Today</option>
            <option className="bg-black text-white" value="7d">7 days</option>
            <option className="bg-black text-white" value="14d">Two weeks</option>
            <option className="bg-black text-white" value="30d">30 days</option>
            <option className="bg-black text-white" value="all">All time</option>
            <option className="bg-black text-white" value="custom">Custom</option>
          </select>
          {periodPreset === "custom" && (
            <>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className={FILTER_DATE_CLASS}
              />
              <span className="text-[var(--muted-foreground)]">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className={FILTER_DATE_CLASS}
              />
            </>
          )}
        </div>
      </div>
      {data && (
        <p className="mb-2 text-[10px] text-[var(--muted-foreground)]">
          {data.start} – {data.end} · actual sales costs (not estimated)
        </p>
      )}
      {loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {!loading && data && (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <th className="py-1.5 pr-2 text-left">Cost</th>
                <th className="py-1.5 pl-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ label, value }) => (
                <tr key={label} className="border-b border-[var(--surface-border)] last:border-b-0">
                  <td className="py-1.5 pr-2 text-[var(--foreground)]">{label}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums font-medium text-[var(--foreground)]">
                    {fmt(value)}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--surface-border)] bg-[var(--surface)]/50 font-semibold">
                <td className="py-1.5 pr-2 text-[var(--foreground)]">Total costs</td>
                <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--foreground)]">
                  {fmt(total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {!loading && !data && (
        <p className="text-[11px] text-[var(--muted-foreground)]">No cost data for this period.</p>
      )}
      {!loading && data && (
        <p className="mt-1.5 text-[10px] text-[var(--muted-foreground)]">
          Order-related costs only. Removal &amp; storage are not stored in DB.
        </p>
      )}
    </div>
  );
}

type ProfitAndLossData = {
  revenue: number;
  totalSellingCosts: number;
  totalCogs: number;
  prepFees: number;
  referralFees: number;
  fbaFees: number;
  digitalServiceFees: number;
  totalAmazonFees: number;
  softwareSubsTotal: number;
  otherSubsTotal: number;
  totalFixedCosts: number;
  totalProfit: number;
  outputVat: number;
  inputVat: number;
  vatBalance: number;
  vatRegistered?: boolean;
  currency: string;
  start: string;
  end: string;
};

type ProfitAndLossProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

function ProfitAndLoss({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: ProfitAndLossProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [data, setData] = useState<ProfitAndLossData | null>(null);
  const [loading, setLoading] = useState(false);
  const [periodPreset, setPeriodPreset] = useState<CostBreakdownPreset>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const defaultEnd = toDateOnly(today);
  const defaultStart30 = toDateOnly(new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000));
  const yesterday = toDateOnly(new Date(today.getTime() - 24 * 60 * 60 * 1000));
  const allTimeStart = "2020-01-01";

  const effectiveStart =
    periodPreset === "today"
      ? defaultEnd
      : periodPreset === "yesterday"
        ? yesterday
        : periodPreset === "7d"
          ? toDateOnly(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000))
          : periodPreset === "14d"
            ? toDateOnly(new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000))
            : periodPreset === "30d"
              ? defaultStart30
              : periodPreset === "all"
                ? allTimeStart
                : customStart || defaultStart30;
  const effectiveEnd =
    periodPreset === "today" || periodPreset === "7d" || periodPreset === "14d" || periodPreset === "30d"
      ? defaultEnd
      : periodPreset === "yesterday"
        ? yesterday
        : periodPreset === "all"
          ? defaultEnd
          : customEnd || defaultEnd;

  useEffect(() => {
    if (!isSignedIn) {
      setData(null);
      return;
    }
    const fetchData = async () => {
      setLoading(true);
      try {
        const token = await getToken({ template: "backend" });
        const url = new URL(`${baseUrl}/api/amazon/dashboard/profit-and-loss`);
        url.searchParams.set("start", effectiveStart);
        url.searchParams.set("end", effectiveEnd);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
            ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
          },
        });
        if (!res.ok) throw new Error("Failed to load profit & loss");
        const json = (await res.json()) as ProfitAndLossData;
        setData(json);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, [isSignedIn, getToken, baseUrl, effectiveStart, effectiveEnd, selectedMarketplaceId, devImpersonate]);

  const cur = data?.currency ?? currency;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-4 ring-1 ring-[var(--surface-border)]">
      <div className="mb-2 flex w-full flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
          Profit &amp; Loss
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <select
            value={periodPreset}
            onChange={(e) => setPeriodPreset(e.target.value as CostBreakdownPreset)}
            className={FILTER_SELECT_CLASS}
          >
            <option className="bg-black text-white" value="yesterday">Yesterday</option>
            <option className="bg-black text-white" value="today">Today</option>
            <option className="bg-black text-white" value="7d">7 days</option>
            <option className="bg-black text-white" value="14d">Two weeks</option>
            <option className="bg-black text-white" value="30d">30 days</option>
            <option className="bg-black text-white" value="all">All time</option>
            <option className="bg-black text-white" value="custom">Custom</option>
          </select>
          {periodPreset === "custom" && (
            <>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className={FILTER_DATE_CLASS}
              />
              <span className="text-[var(--muted-foreground)]">→</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className={FILTER_DATE_CLASS}
              />
            </>
          )}
        </div>
      </div>
      {data && (
        <p className="mb-2 text-[10px] text-[var(--muted-foreground)]">
          {data.start} – {data.end}
        </p>
      )}
      {loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {!loading && data && (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-[11px]">
            <tbody>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-1.5 pr-2 text-[var(--foreground)]">Revenue</td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-medium text-[var(--foreground)]">
                  {fmt(data.revenue)}
                </td>
              </tr>
              <tr className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <td colSpan={2} className="pt-2 pb-0.5">Selling unit costs</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">COGS</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.totalCogs)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">Prep fees</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.prepFees)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">Referral</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.referralFees)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">FBA</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.fbaFees)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">Digital service fee</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.digitalServiceFees)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)] font-medium">
                <td className="py-1 pr-2 pl-2 text-[var(--foreground)]">Total selling costs</td>
                <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.totalSellingCosts)}</td>
              </tr>
              <tr className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <td colSpan={2} className="pt-2 pb-0.5">Fixed costs</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">Software subscriptions</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.softwareSubsTotal)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)]">
                <td className="py-0.5 pr-2 pl-2 text-[var(--foreground)]">Other subscriptions</td>
                <td className="py-0.5 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.otherSubsTotal)}</td>
              </tr>
              <tr className="border-b border-[var(--surface-border)] font-medium">
                <td className="py-1 pr-2 pl-2 text-[var(--foreground)]">Total fixed costs</td>
                <td className="py-1 pl-2 text-right tabular-nums text-[var(--foreground)]">{fmt(data.totalFixedCosts)}</td>
              </tr>
              <tr className="border-t-2 border-[var(--surface-border)] bg-[var(--surface)]/50 font-semibold">
                <td className="py-1.5 pr-2 text-[var(--foreground)]">Total profit</td>
                <td className={`py-1.5 pl-2 text-right tabular-nums ${data.totalProfit >= 0 ? "text-[var(--foreground)]" : "text-red-500"}`}>
                  {fmt(data.totalProfit)}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
            <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
              VAT adjustment
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-[var(--muted-foreground)]">
              <span>Output VAT</span>
              <span className="text-right tabular-nums text-[var(--foreground)]">{fmt(data.outputVat)}</span>
              <span>Input VAT</span>
              <span className="text-right tabular-nums text-[var(--foreground)]">{fmt(data.inputVat)}</span>
              <span className="font-medium text-[var(--foreground)]">VAT balance</span>
              <span className="flex items-center justify-end gap-1">
                <span className={`tabular-nums font-medium ${(data.vatRegistered ? data.vatBalance : 0) >= 0 ? "text-[var(--foreground)]" : "text-red-500"}`}>
                  {fmt(data.vatRegistered ? data.vatBalance : 0)}
                </span>
                {!data.vatRegistered && (
                  <span
                    className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full bg-[var(--muted-foreground)]/20 text-[8px] font-semibold text-[var(--muted-foreground)]"
                    title="VAT balance shows as zero for non VAT registered users"
                  >
                    i
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>
      )}
      {!loading && !data && (
        <p className="text-[11px] text-[var(--muted-foreground)]">No P&amp;L data for this period.</p>
      )}
    </div>
  );
}

type InventorySummaryRow = {
  availableQty: number | null;
  reservedQty: number | null;
  inboundQty: number | null;
  issueQty: number | null;
  totalQty: number | null;
  currentListedPrice?: number | null;
  costOfGoods?: number | null;
  byMarketplace?: Array<{
    fulfillableQty: number;
    inboundQty: number;
    reservedQty: number;
    researchingQty: number;
    unfulfillableQty: number;
    currentQty: number;
    fcProcessingQty?: number;
    customerOrdersQty?: number;
    transshipmentQty?: number;
    inboundWorkingQty?: number;
    inboundShippedQty?: number;
    inboundReceivingQty?: number;
    warehouseDamagedQty?: number;
    expiredQty?: number;
  }>;
};

type InventorySummaryProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
};

function InventorySummary({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
}: InventorySummaryProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [rows, setRows] = useState<InventorySummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setRows([]);
      return;
    }
    const fetchInventory = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken({ template: "backend" });
        const url = new URL(`${baseUrl}/api/amazon/inventory`);
        if (devImpersonate) url.searchParams.set("impersonate", devImpersonate);
        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
            ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
          },
        });
        if (!res.ok) throw new Error("Failed to load inventory");
        const data = (await res.json()) as InventorySummaryRow[];
        setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error");
        setRows([]);
      } finally {
        setLoading(false);
      }
    };
    void fetchInventory();
  }, [isSignedIn, getToken, baseUrl, selectedMarketplaceId, devImpersonate]);

  const n = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : 0);
  const total = rows.reduce((sum, r) => sum + n(r.totalQty), 0);
  const price = (r: InventorySummaryRow) => n(r.currentListedPrice);
  const cogs = (r: InventorySummaryRow) => n(r.costOfGoods);

  let fulfillable = 0;
  let fulfillableValue = 0;
  let fulfillableCost = 0;
  let reserved = 0;
  let reservedValue = 0;
  let reservedCost = 0;
  let inbound = 0;
  let inboundValue = 0;
  let inboundCost = 0;
  let researching = 0;
  let researchingValue = 0;
  let researchingCost = 0;
  let unfulfillable = 0;
  let unfulfillableValue = 0;
  let unfulfillableCost = 0;
  let current = 0;
  let currentValue = 0;
  let currentCost = 0;
  let fcProcessing = 0;
  let fcProcessingValue = 0;
  let fcProcessingCost = 0;
  let customerOrders = 0;
  let customerOrdersValue = 0;
  let customerOrdersCost = 0;
  let transshipment = 0;
  let transshipmentValue = 0;
  let transshipmentCost = 0;
  let inboundWorking = 0;
  let inboundWorkingValue = 0;
  let inboundWorkingCost = 0;
  let inboundShipped = 0;
  let inboundShippedValue = 0;
  let inboundShippedCost = 0;
  let inboundReceiving = 0;
  let inboundReceivingValue = 0;
  let inboundReceivingCost = 0;
  let warehouseDamaged = 0;
  let warehouseDamagedValue = 0;
  let warehouseDamagedCost = 0;
  let expired = 0;
  let expiredValue = 0;
  let expiredCost = 0;

  rows.forEach((r) => {
    const p = price(r);
    const c = cogs(r);
    const av = n(r.availableQty);
    const rv = n(r.reservedQty);
    const inv = n(r.inboundQty);
    fulfillable += av;
    fulfillableValue += p * av;
    fulfillableCost += c * av;
    reserved += rv;
    reservedValue += p * rv;
    reservedCost += c * rv;
    inbound += inv;
    inboundValue += p * inv;
    inboundCost += c * inv;

    r.byMarketplace?.forEach((m) => {
      const rq = n(m.researchingQty);
      const uq = n(m.unfulfillableQty);
      const cq = n(m.currentQty);
      const fcp = n(m.fcProcessingQty);
      const co = n(m.customerOrdersQty);
      const ts = n(m.transshipmentQty);
      const iw = n(m.inboundWorkingQty);
      const ish = n(m.inboundShippedQty);
      const ir = n(m.inboundReceivingQty);
      const wd = n(m.warehouseDamagedQty);
      const ex = n(m.expiredQty);

      researching += rq;
      researchingValue += p * rq;
      researchingCost += c * rq;
      unfulfillable += uq;
      unfulfillableValue += p * uq;
      unfulfillableCost += c * uq;
      current += cq;
      currentValue += p * cq;
      currentCost += c * cq;
      fcProcessing += fcp;
      fcProcessingValue += p * fcp;
      fcProcessingCost += c * fcp;
      customerOrders += co;
      customerOrdersValue += p * co;
      customerOrdersCost += c * co;
      transshipment += ts;
      transshipmentValue += p * ts;
      transshipmentCost += c * ts;
      inboundWorking += iw;
      inboundWorkingValue += p * iw;
      inboundWorkingCost += c * iw;
      inboundShipped += ish;
      inboundShippedValue += p * ish;
      inboundShippedCost += c * ish;
      inboundReceiving += ir;
      inboundReceivingValue += p * ir;
      inboundReceivingCost += c * ir;
      warehouseDamaged += wd;
      warehouseDamagedValue += p * wd;
      warehouseDamagedCost += c * wd;
      expired += ex;
      expiredValue += p * ex;
      expiredCost += c * ex;
    });
  });

  // Total value/cost from product-level totalQty to avoid double-counting
  const totalValue = rows.reduce((sum, r) => sum + price(r) * n(r.totalQty), 0);
  const totalCost = rows.reduce((sum, r) => sum + cogs(r) * n(r.totalQty), 0);
  const totalProfit = totalValue - totalCost;
  const totalRoiPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : null;

  // Granular statuses from FBA API (details=true): show all breakdowns we store; profit = value - cost, ROI = profit/cost
  type StatusRow = { label: string; value: number; stockValue: number; unitCost: number; profit: number; roiPct: number | null };
  const toStatusRow = (label: string, value: number, stockValue: number, unitCost: number): StatusRow => ({
    label,
    value,
    stockValue,
    unitCost,
    profit: stockValue - unitCost,
    roiPct: unitCost > 0 ? ((stockValue - unitCost) / unitCost) * 100 : null,
  });
  const statuses: StatusRow[] = [
    toStatusRow("FBA Available", fulfillable, fulfillableValue, fulfillableCost),
    toStatusRow("FC Processing", fcProcessing, fcProcessingValue, fcProcessingCost),
    toStatusRow("Customer Orders", customerOrders, customerOrdersValue, customerOrdersCost),
    toStatusRow("Transshipment", transshipment, transshipmentValue, transshipmentCost),
    toStatusRow("Reserved", reserved, reservedValue, reservedCost),
    toStatusRow("Inbound Working", inboundWorking, inboundWorkingValue, inboundWorkingCost),
    toStatusRow("Inbound Shipped", inboundShipped, inboundShippedValue, inboundShippedCost),
    toStatusRow("Inbound Receiving", inboundReceiving, inboundReceivingValue, inboundReceivingCost),
    toStatusRow("Inbound", inbound, inboundValue, inboundCost),
    toStatusRow("Researching", researching, researchingValue, researchingCost),
    toStatusRow("Unfulfillable", unfulfillable, unfulfillableValue, unfulfillableCost),
    toStatusRow("Warehouse Damaged", warehouseDamaged, warehouseDamagedValue, warehouseDamagedCost),
    toStatusRow("Expired", expired, expiredValue, expiredCost),
    toStatusRow("Current", current > 0 ? current : total, current > 0 ? currentValue : totalValue, current > 0 ? currentCost : totalCost),
  ];

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-3 ring-1 ring-[var(--surface-border)]">
      <div className="mb-1 flex items-center gap-1">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--foreground)]">
          Inventory summary
        </h2>
        <span
          className="inline-flex h-3 w-3 shrink-0 cursor-help items-center justify-center rounded-full bg-[var(--muted-foreground)]/20 text-[8px] font-semibold text-[var(--muted-foreground)]"
          title="Complete COGS for accurate inventory summary"
        >
          i
        </span>
      </div>
      {loading && (
        <p className="text-[9px] text-[var(--muted-foreground)]">Loading…</p>
      )}
      {error && (
        <p className="text-[9px] text-red-600">{error}</p>
      )}
      {!loading && !error && (
        <div className="min-w-0 w-full overflow-x-auto">
          <table className="w-full text-[9px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-[8px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                <th className="py-0.5 pr-1 text-left">Status</th>
                <th className="py-0.5 px-0.5 text-center">Qty</th>
                <th className="py-0.5 px-1 text-center">Stock value</th>
                <th className="py-0.5 px-1 text-center">Stock cost</th>
                <th className="py-0.5 px-1 text-center">Potential profit</th>
                <th className="py-0.5 pl-1 text-center">Potential ROI</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)]/50 font-semibold">
                <td className="py-0.5 pr-1 text-[var(--foreground)]">Total</td>
                <td className="py-0.5 px-0.5 text-center tabular-nums text-[var(--foreground)]">{total.toLocaleString()}</td>
                <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(totalValue, currency, 2)}</td>
                <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(totalCost, currency, 2)}</td>
                <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(totalProfit, currency, 2)}</td>
                <td className="py-0.5 pl-1 text-center tabular-nums text-[var(--foreground)]">{totalRoiPct != null ? `${totalRoiPct.toFixed(1)}%` : "—"}</td>
              </tr>
              {statuses.map(({ label, value, stockValue, unitCost, profit, roiPct }) => (
                <tr key={label} className="border-b border-[var(--surface-border)] last:border-b-0">
                  <td className="py-0.5 pr-1 text-[var(--muted-foreground)]">{label}</td>
                  <td className="py-0.5 px-0.5 text-center font-medium tabular-nums text-[var(--foreground)]">{value.toLocaleString()}</td>
                  <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(stockValue, currency, 2)}</td>
                  <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(unitCost, currency, 2)}</td>
                  <td className="py-0.5 px-1 text-center tabular-nums text-[var(--foreground)]">{formatCurrency(profit, currency, 2)}</td>
                  <td className="py-0.5 pl-1 text-center tabular-nums text-[var(--foreground)]">{roiPct != null ? `${roiPct.toFixed(1)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type DonutCardProps = {
  label: string;
  value: string;
  percentage: number;
  color: string;
  /** Small title shown above the value in the center (e.g. "Profit", "ROI") */
  centerTitle?: string;
  /** Override center: line 1 (amount, biggest), line 2 ("Profit on Sales"), line 3 (percent) */
  centerLine1?: string;
  centerLine2?: string;
  centerLine3?: string;
  /** Optional helper note shown under the label (e.g. when a metric requires setup). */
  note?: ReactNode;
  /** When true, show only value (no %); ring stays empty. Use for metrics without a meaningful %. */
  hidePercentage?: boolean;
  /** When true, draw the colored ring full (100%) all the way round. */
  fullRing?: boolean;
};

type SalesTrendProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
  start: string;
  end: string;
  label: string;
  /** When true, do not render outer box/title (parent provides them) */
  noWrapper?: boolean;
};

function SalesTrend({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
  start,
  end,
  label,
  noWrapper = false,
}: SalesTrendProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const { ringColor } = useDisplaySettings();
  const [sales, setSales] = useState<SalesSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setSales(null);
      return;
    }

    const fetchSales = async () => {
      setLoading(true);
      setError(null);

      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(
          `${baseUrl}/api/amazon/sales/timeseries?` +
            new URLSearchParams({ start, end }).toString(),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
            },
          },
        );

        if (!res.ok) {
          setError("Failed to load sales trend.");
          setSales(null);
          return;
        }

        const data = (await res.json()) as SalesSeries;
        setSales(data);
      } catch {
        setError("Unable to load sales trend.");
        setSales(null);
      } finally {
        setLoading(false);
      }
    };

    fetchSales();
  }, [isSignedIn, getToken, baseUrl, start, end, selectedMarketplaceId]);

  if (!sales && !loading && !error) {
    return null;
  }

  const points = sales?.points ?? [];
  const maxValue =
    points.length > 0
      ? points.reduce(
          (m, p) => Math.max(m, p.revenue, p.profit),
          0
        )
      : 0;
  const allZero = points.length > 0 && maxValue === 0;

  const height = 250;
  const paddingX = 12; // room for y-axis labels (right-aligned so they donÔÇÖt overlap bars)
  const paddingBottom = 48; // room for x-axis line + rotated date labels underneath
  const paddingTop = 12; // room for hover labels

  const width = 400;
  const barAreaHeight = height - paddingTop - paddingBottom;
  const barAreaWidth = width - paddingX * 2;
  const numPoints = Math.max(1, points.length);
  const bucketWidth = barAreaWidth / numPoints;
  /** Pair of bars per bucket: revenue (left) + profit (right); keep total width ≤ bucket */
  const pairGap = Math.max(0.5, bucketWidth * 0.12);
  const barWidth = Math.max(
    0.75,
    (bucketWidth * 0.96 - pairGap) / 2,
  );
  const revenueColor = ringColor; // matches display settings theme
  const profitColor = "rgb(16, 185, 129)"; // emerald — distinct from revenue
  const minBarH =
    barAreaHeight > 0 ? Math.min(4, barAreaHeight * 0.02) : 0;

  const content = (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div>
          {!noWrapper && (
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
              Sales v Profit
            </p>
          )}
          <p className={`text-[11px] text-[var(--muted-foreground)] ${noWrapper ? "" : "mt-0.5"}`}>
            {label} · Revenue vs profit ({currency})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: revenueColor }} />
            Revenue
          </span>
          <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)]">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: profitColor }} />
            Profit
          </span>
          {loading && (
            <span className="text-[11px] text-[var(--muted-foreground)]">
              Loading…
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
      {!error && (points.length === 0 || allZero) && !loading && (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          No orders found for the selected period yet.
        </p>
      )}
      {points.length > 0 && !allZero && (
        <div className="w-full">
        <svg
          viewBox={`-50 0 ${width + 50} ${height}`}
          className="mt-2 h-[18rem] min-h-[12rem] w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* X-axis line */}
          <line
            x1={paddingX}
            y1={paddingTop + barAreaHeight}
            x2={width - paddingX}
            y2={paddingTop + barAreaHeight}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.4}
          />
          {/* Y-axis line */}
          <line
            x1={paddingX}
            y1={paddingTop}
            x2={paddingX}
            y2={paddingTop + barAreaHeight}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.4}
          />
          {/* Y-axis grid / labels – compact format, right-aligned to avoid overlap */}
          {maxValue > 0 &&
            [0, 0.5, 1].map((ratio, idx) => {
              const value = maxValue * ratio;
              const y =
                paddingTop +
                (1 - ratio) * barAreaHeight;
              const compactLabel =
                value >= 1000
                  ? `${(value / 1000).toFixed(1)}k`
                  : value >= 1
                    ? Math.round(value).toString()
                    : value > 0
                      ? value.toFixed(1)
                      : "0";
              return (
                <g key={`y-${idx}`}>
                  <line
                    x1={paddingX}
                    x2={width - paddingX}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth={0.5}
                    opacity={0.15}
                  />
                  <text
                    x={paddingX - 2}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="7"
                    fill="currentColor"
                  >
                    {compactLabel}
                  </text>
                </g>
              );
            })}

          {points.map((p, idx) => {
            const bucketLeft = paddingX + idx * bucketWidth;
            const pairTotal = barWidth * 2 + pairGap;
            const pairLeft = bucketLeft + (bucketWidth - pairTotal) / 2;
            const revenueX = pairLeft;
            const profitX = pairLeft + barWidth + pairGap;
            const revenueRatio = maxValue > 0 ? p.revenue / maxValue : 0;
            const profitRatio = maxValue > 0 ? Math.max(0, p.profit) / maxValue : 0;
            const rawRevH = revenueRatio * barAreaHeight;
            const rawProfH = profitRatio * barAreaHeight;
            const revenueHeight =
              p.revenue > 0 ? Math.max(rawRevH, minBarH) : 0;
            const profitHeight =
              p.profit > 0 ? Math.max(rawProfH, minBarH) : 0;
            const barBottomY = paddingTop + barAreaHeight;
            const isHovered = hoveredIndex === idx;

            return (
              <g
                key={p.date}
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <rect
                  x={revenueX}
                  y={barBottomY - revenueHeight}
                  width={barWidth}
                  height={revenueHeight}
                  fill={revenueColor}
                  fillOpacity={isHovered ? 1 : 0.9}
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={0.4}
                  rx={1.5}
                  className="cursor-pointer"
                />
                <rect
                  x={profitX}
                  y={barBottomY - profitHeight}
                  width={barWidth}
                  height={profitHeight}
                  fill={profitColor}
                  fillOpacity={isHovered ? 1 : 0.92}
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={0.4}
                  rx={1.5}
                  className="cursor-pointer"
                />
              </g>
            );
          })}
          {hoveredIndex !== null && points[hoveredIndex] && (
            (() => {
              const p = points[hoveredIndex];
              const x =
                paddingX +
                hoveredIndex * bucketWidth +
                bucketWidth / 2;
              const revenueRatio = maxValue > 0 ? p.revenue / maxValue : 0;
              const profitRatio = maxValue > 0 ? p.profit / maxValue : 0;
              const revenueHeight = revenueRatio * barAreaHeight;
              const profitHeight = profitRatio * barAreaHeight;
              const y = paddingTop + barAreaHeight - Math.max(revenueHeight, profitHeight);
              const isZero = p.revenue === 0 && p.profit === 0;
              const label = isZero
                ? "Zero sales"
                : `Revenue: ${formatCurrency(p.revenue, currency)} · Profit: ${formatCurrency(p.profit, currency)}`;
              const approxWidth = Math.min(label.length * 5.5, 140);
              const padding = 6;
              const rectWidth = approxWidth + padding * 2;
              const rectY = Math.max(4, y - 22);
              const textY = rectY + 11;

              return (
                <g>
                  <rect
                    x={x - rectWidth / 2}
                    y={rectY}
                    width={rectWidth}
                    height={20}
                    rx={3}
                    fill="var(--surface)"
                    stroke="var(--surface-border)"
                    strokeWidth={0.5}
                  />
                  <text
                    x={x}
                    y={textY}
                    textAnchor="middle"
                    fontSize="8"
                    fill="var(--foreground)"
                  >
                    {label}
                  </text>
                </g>
              );
            })()
          )}
          {/* Date labels: drawn in SVG so they sit under the x-axis and fit in the padding area */}
          {points.map((p, idx) => {
            if (idx % 2 !== 0) return null;
            const x =
              paddingX +
              idx * bucketWidth +
              bucketWidth / 2;
            const labelY = paddingTop + barAreaHeight + 14; // just under the x-axis line
            const [, month, day] = p.date.split("-");
            const label = `${day}/${month}`;
            return (
              <text
                key={`${p.date}-label`}
                x={x}
                y={labelY}
                textAnchor="end"
                fontSize="9"
                fontFamily="system-ui, sans-serif"
                fontWeight="600"
                fontStyle="normal"
                fill="var(--foreground)"
                transform={`rotate(-55 ${x} ${labelY})`}
              >
                {label}
              </text>
            );
          })}
        </svg>
      </div>
      )}
    </>
  );
  return noWrapper ? (
    content
  ) : (
    <div className="rounded-xl bg-[var(--surface)] p-4 ring-1 ring-[var(--surface-border)]">
      {content}
    </div>
  );
}

type CategoryBreakdown = {
  sales: Array<{ category: string; value: number }>;
  profit: Array<{ category: string; value: number }>;
  roi: Array<{ category: string; value: number }>;
  units: Array<{ category: string; value: number }>;
  currency: string;
};

type CategoryPieChartsProps = {
  baseUrl: string;
  isSignedIn: boolean | undefined;
  getToken: (args: { template?: string }) => Promise<string | null>;
  currency: string;
  start: string;
  end: string;
};

const PIE_COLORS = ["#4F46E5", "#10B981", "#F59E0B", "#EC4899"];

function CategoryPieChart({
  title,
  data,
  currency,
  formatValue,
}: {
  title: string;
  data: Array<{ category: string; value: number }>;
  currency: string;
  formatValue: (v: number) => string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const hasData = total > 0 && data.length > 0;
  const size = 80;
  const cx = size / 2;
  const cy = size / 2;
  const r = 32;

  let cumulative = 0;
  const segments = hasData
    ? data.map((d, i) => {
        const pct = total > 0 ? d.value / total : 0;
        const startAngle = cumulative * 2 * Math.PI;
        cumulative += pct;
        const endAngle = cumulative * 2 * Math.PI;
        const x1 = cx + r * Math.sin(startAngle);
        const y1 = cy - r * Math.cos(startAngle);
        const x2 = cx + r * Math.sin(endAngle);
        const y2 = cy - r * Math.cos(endAngle);
        const large = pct > 0.5 ? 1 : 0;
        const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        return { path, color: PIE_COLORS[i % PIE_COLORS.length], ...d };
      })
    : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-[var(--surface-border)] bg-[var(--surface)]/30 p-2">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--foreground)]">
        {title}
      </h3>
      {hasData ? (
        <div className="flex min-w-0 items-start gap-2">
          <svg viewBox={`0 0 ${size} ${size}`} className="h-14 w-14 shrink-0 sm:h-16 sm:w-16">
            {segments.map((seg, i) => (
              <path
                key={i}
                d={seg.path}
                fill={seg.color}
                stroke="var(--background)"
                strokeWidth={1}
              />
            ))}
          </svg>
          <ul className="min-w-0 flex-1 space-y-0.5 text-[10px]">
            {segments.map((seg, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-1.5 text-[var(--foreground)]"
              >
                <span className="flex min-w-0 items-center gap-1 truncate">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: seg.color }}
                  />
                  <span className="truncate">{seg.category}</span>
                </span>
                <span className="shrink-0 tabular-nums font-medium">
                  {formatValue(seg.value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="py-2 text-[10px] text-[var(--muted-foreground)]">No data</p>
      )}
    </div>
  );
}

function CategoryPieCharts({
  baseUrl,
  isSignedIn,
  getToken,
  currency,
  start,
  end,
}: CategoryPieChartsProps) {
  const { selectedMarketplaceId } = useMarketplace();
  const [data, setData] = useState<CategoryBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isSignedIn) {
      setData(null);
      return;
    }
    const fetchData = async () => {
      setLoading(true);
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(
          `${baseUrl}/api/amazon/dashboard/category-breakdown?${new URLSearchParams({
            start,
            end,
          }).toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
            },
          },
        );
        if (!res.ok) throw new Error("Failed to load category breakdown");
        const json = (await res.json()) as CategoryBreakdown;
        setData(json);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, [isSignedIn, getToken, baseUrl, start, end, selectedMarketplaceId]);

  if (loading) {
    return (
      <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-3 ring-1 ring-[var(--surface-border)]">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
          Top categories by metric
        </h2>
        <p className="text-[10px] text-[var(--muted-foreground)]">Loading…</p>
      </div>
    );
  }

  const cur = data?.currency ?? currency;
  const formatCur = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);
  const formatPct = (n: number) => `${Math.round(n)}%`;
  const formatNum = (n: number) => n.toLocaleString();

  return (
    <div className="flex w-full flex-col rounded-xl bg-[var(--surface)] p-3 ring-1 ring-[var(--surface-border)]">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-[var(--foreground)]">
        Top categories by metric
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <CategoryPieChart
          title="Sales"
          data={data?.sales ?? []}
          currency={cur}
          formatValue={formatCur}
        />
        <CategoryPieChart
          title="Profit"
          data={data?.profit ?? []}
          currency={cur}
          formatValue={formatCur}
        />
        <CategoryPieChart
          title="ROI"
          data={data?.roi ?? []}
          currency={cur}
          formatValue={formatPct}
        />
        <CategoryPieChart
          title="Units sold"
          data={data?.units ?? []}
          currency={cur}
          formatValue={formatNum}
        />
      </div>
    </div>
  );
}

function formatCurrency(amount: number, currency: string, decimals = 0) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `$${amount.toLocaleString()}`;
  }
}

function DonutCard({
  label,
  value,
  percentage,
  color,
  centerTitle,
  centerLine1,
  centerLine2,
  centerLine3,
  note,
  hidePercentage,
  fullRing,
}: DonutCardProps) {
  const radius = 54;
  const strokeWidth = 8;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const ringFill = fullRing ? 100 : clamped;
  const offset = circumference * (1 - ringFill / 100);
  const useCustomCenter =
    centerLine1 != null && centerLine2 != null && centerLine3 != null;
  const valueOnly = hidePercentage === true;

  const trackColor = "var(--surface-border)";
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <svg
          viewBox="0 0 120 120"
          className="h-full w-full -rotate-90"
          aria-hidden
        >
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke={trackColor}
            strokeWidth={strokeWidth}
            fill="none"
            opacity={0.4}
          />
          <circle
            cx="60"
            cy="60"
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
            style={{
              strokeDasharray: `${circumference} ${circumference}`,
              strokeDashoffset: offset,
              transition: "stroke-dashoffset 0.5s ease-out",
            }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-start pt-10 text-center">
          {centerTitle && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
              {centerTitle}
            </span>
          )}
          {useCustomCenter ? (
            <>
              <span className="text-lg font-bold tabular-nums leading-none text-[var(--foreground)]">
                {centerLine1}
              </span>
              {centerLine2 ? (
                <span className="text-[10px] text-[var(--muted-foreground)]">
                  {centerLine2}
                </span>
              ) : null}
              <span className="mt-1.5 inline-flex items-center rounded-full bg-[var(--surface)] px-2 py-0.5 text-[9px] font-medium uppercase tracking-normal text-[var(--muted-foreground)]">
                {centerLine3}
              </span>
            </>
          ) : (
            <>
              <span className="text-lg font-bold tabular-nums leading-none text-[var(--foreground)]">
                {value}
              </span>
              {!valueOnly && (
                <span className="mt-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                  {clamped.toFixed(0)}%
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {label}
        </p>
        {note ? (
          <p className="text-[11px] text-[var(--muted-foreground)]">{note}</p>
        ) : null}
      </div>
    </div>
  );
}

