"use client";

import { useEffect, useMemo, useState } from "react";
import { useMarketplace } from "@/contexts/marketplace-context";

/** Dispatched when the user should pick a base marketplace via this control (see marketplace-onboarding-modal). */
export const SB_OPEN_MARKETPLACE_SELECTOR_EVENT = "sellerbunker-open-marketplace-selector";
const VIEW_LABELS: Record<string, string> = {
  gb: "UK marketplace view",
  de: "German marketplace view",
  fr: "French marketplace view",
  es: "Spanish marketplace view",
};
const REGION_LABELS: Record<string, string> = {
  EU: "Europe",
  NA: "North America",
  AUSTRALASIA: "Australasia",
};

export function MarketplaceSelector() {
  const { marketplaces, selectedMarketplaceId, selectMarketplace } = useMarketplace();
  const [open, setOpen] = useState(false);
  const [needBaseCue, setNeedBaseCue] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setNeedBaseCue(true);
    };
    window.addEventListener(SB_OPEN_MARKETPLACE_SELECTOR_EVENT, onOpen);
    return () => window.removeEventListener(SB_OPEN_MARKETPLACE_SELECTOR_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (marketplaces.some((m) => m.isBase)) {
      queueMicrotask(() => setNeedBaseCue(false));
    }
  }, [marketplaces]);

  const selected = useMemo(
    () => marketplaces.find((m) => m.marketplaceId === selectedMarketplaceId) ?? marketplaces[0],
    [marketplaces, selectedMarketplaceId],
  );
  const grouped = useMemo(() => {
    const order = ["EU", "NA", "AUSTRALASIA"] as const;
    return order
      .map((region) => ({
        region,
        label: REGION_LABELS[region],
        items: marketplaces.filter((m) => m.region === region),
      }))
      .filter((g) => g.items.length > 0);
  }, [marketplaces]);

  if (!selected) return null;

  const renderFlag = (countryCode?: string, fallback?: string) => {
    const code = String(countryCode ?? "").trim().toLowerCase();
    if (code.length === 2) {
      return (
        <img
          src={`https://flagcdn.com/24x18/${code}.png`}
          alt=""
          className="h-4 w-6 rounded-[2px] object-cover"
          loading="lazy"
        />
      );
    }
    return <span className="text-lg leading-none">{fallback ?? "🏳️"}</span>;
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-lg px-2 hover:bg-[var(--foreground)]/5"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={VIEW_LABELS[String(selected.countryCode).toLowerCase()] ?? `${selected.displayName} marketplace view`}
      >
        {renderFlag(selected.countryCode, selected.flag)}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-1 shadow-lg">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            {needBaseCue ? "Set your default marketplace" : "Marketplace selected"}
          </div>
          <div className="mb-1 rounded-md border border-[var(--surface-border)] px-2 py-1.5 text-sm">
            <span className="inline-flex items-center gap-2">
              {renderFlag(selected.countryCode, selected.flag)}
              <span>{selected.displayName}</span>
            </span>
          </div>
          {grouped.map((group) => (
            <div key={group.region} className="mb-1 last:mb-0">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                {group.label}
              </div>
              {group.items.map((marketplace) => (
                <button
                  key={marketplace.marketplaceId}
                  type="button"
                  onClick={() => {
                    void selectMarketplace(marketplace.marketplaceId);
                    setNeedBaseCue(false);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--foreground)]/5"
                >
                  <span className="truncate inline-flex items-center gap-2">
                    {renderFlag(marketplace.countryCode, marketplace.flag)}
                    <span>{marketplace.displayName}</span>
                  </span>
                  <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                    {marketplace.currencyCode}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
