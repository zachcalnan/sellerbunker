"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const STORAGE_KEY = "selected-marketplace-id";

type UserMarketplace = {
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  region?: "NA" | "EU" | "AUSTRALASIA";
  isBase: boolean;
  isEnabledByUser: boolean;
  detectedBySystem: boolean;
  displayName: string;
  flag: string;
};

type CatalogMarketplace = {
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  region: "NA" | "EU" | "AUSTRALASIA";
  displayName: string;
  flag: string;
};

type MarketplaceContextValue = {
  marketplaces: UserMarketplace[];
  selectedMarketplaceId: string | null;
  selectedCurrency: string;
  selectMarketplace: (marketplaceId: string) => Promise<void>;
  refreshMarketplaces: () => Promise<void>;
};

const MarketplaceContext = createContext<MarketplaceContextValue | null>(null);

export function MarketplaceProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const [marketplaces, setMarketplaces] = useState<UserMarketplace[]>([]);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState<string | null>(null);

  const refreshMarketplaces = useCallback(async () => {
    if (!isSignedIn) {
      setMarketplaces([]);
      setSelectedMarketplaceId(null);
      return;
    }
    const token = await getToken({ template: "backend" });
    const [userRes, catalogRes] = await Promise.all([
      fetch(`${BASE_URL}/api/marketplaces`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`${BASE_URL}/api/marketplaces/catalog`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    if (!userRes.ok) return;
    const data = (await userRes.json()) as { marketplaces: UserMarketplace[] };
    const userRows = data.marketplaces ?? [];
    const catalogData = catalogRes.ok
      ? ((await catalogRes.json()) as { marketplaces?: CatalogMarketplace[] })
      : { marketplaces: [] };
    const catalogRows = Array.isArray(catalogData.marketplaces) ? catalogData.marketplaces : [];

    const byId = new Map<string, UserMarketplace>();
    for (const c of catalogRows) {
      byId.set(c.marketplaceId, {
        marketplaceId: c.marketplaceId,
        countryCode: c.countryCode,
        currencyCode: c.currencyCode,
        region: c.region,
        isBase: false,
        isEnabledByUser: false,
        detectedBySystem: false,
        displayName: c.displayName,
        flag: c.flag,
      });
    }
    for (const row of userRows) {
      byId.set(row.marketplaceId, {
        ...(byId.get(row.marketplaceId) ?? row),
        ...row,
      });
    }
    const rows = Array.from(byId.values()).sort((a, b) => {
      if (a.isBase !== b.isBase) return a.isBase ? -1 : 1;
      if (a.isEnabledByUser !== b.isEnabledByUser) return a.isEnabledByUser ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    setMarketplaces(rows);

    const stored = typeof window !== "undefined" ? window.sessionStorage.getItem(STORAGE_KEY) : null;
    const initial =
      (stored && rows.some((m) => m.marketplaceId === stored) ? stored : null) ??
      userRows.find((m) => m.isBase)?.marketplaceId ??
      userRows.find((m) => m.isEnabledByUser)?.marketplaceId ??
      rows.find((m) => m.countryCode === "GB")?.marketplaceId ??
      rows[0]?.marketplaceId ??
      null;
    setSelectedMarketplaceId(initial);
  }, [getToken, isSignedIn]);

  useEffect(() => {
    void refreshMarketplaces();
  }, [refreshMarketplaces]);

  const selectMarketplace = useCallback(
    async (marketplaceId: string) => {
      setSelectedMarketplaceId(marketplaceId);
      try {
        window.sessionStorage.setItem(STORAGE_KEY, marketplaceId);
      } catch {}
      const token = await getToken({ template: "backend" });
      await fetch(`${BASE_URL}/api/marketplaces/base`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ marketplaceId }),
      });
      await refreshMarketplaces();
    },
    [getToken, refreshMarketplaces],
  );

  const selectedCurrency = useMemo(() => {
    const selected = marketplaces.find((m) => m.marketplaceId === selectedMarketplaceId);
    if (selected?.currencyCode) return selected.currencyCode;
    const gb = marketplaces.find((m) => m.countryCode === "GB");
    return gb?.currencyCode ?? marketplaces[0]?.currencyCode ?? "GBP";
  }, [marketplaces, selectedMarketplaceId]);

  const value = useMemo(
    () => ({
      marketplaces,
      selectedMarketplaceId,
      selectedCurrency,
      selectMarketplace,
      refreshMarketplaces,
    }),
    [marketplaces, selectedMarketplaceId, selectedCurrency, selectMarketplace, refreshMarketplaces],
  );

  return <MarketplaceContext.Provider value={value}>{children}</MarketplaceContext.Provider>;
}

export function useMarketplace() {
  const ctx = useContext(MarketplaceContext);
  if (!ctx) {
    return {
      marketplaces: [],
      selectedMarketplaceId: null,
      selectedCurrency: "GBP",
      selectMarketplace: async () => {},
      refreshMarketplaces: async () => {},
    };
  }
  return ctx;
}
