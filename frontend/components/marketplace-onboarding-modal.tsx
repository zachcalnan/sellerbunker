"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMarketplace } from "@/contexts/marketplace-context";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const REGION_LABELS: Record<string, string> = {
  EU: "Europe",
  NA: "North America",
  AUSTRALASIA: "Australasia",
};

function Flag({ countryCode, fallback }: { countryCode?: string; fallback?: string }) {
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
  return <span>{fallback ?? "🏳️"}</span>;
}

export function MarketplaceOnboardingModal() {
  const { isSignedIn, getToken } = useAuth();
  const { marketplaces, selectMarketplace, refreshMarketplaces } = useMarketplace();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const order = ["EU", "NA", "AUSTRALASIA"] as const;
    type MarketplaceRow = (typeof marketplaces)[number];
    return order
      .map((region) => ({
        region,
        label: REGION_LABELS[region],
        items: marketplaces.filter((m: MarketplaceRow) => m.region === region),
      }))
      .filter((g) => g.items.length > 0);
  }, [marketplaces]);

  const checkNeedsMarketplaceOnboarding = useCallback(async () => {
    if (!isSignedIn) return;
    setChecking(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const [vatRes, marketplacesRes] = await Promise.all([
        fetch(`${BASE_URL}/api/orgs/vat-settings`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${BASE_URL}/api/marketplaces`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!vatRes.ok || !marketplacesRes.ok) return;
      const vatData = (await vatRes.json()) as { vatRegistrationType?: string | null };
      const mpData = (await marketplacesRes.json()) as { marketplaces?: Array<{ marketplaceId: string; isBase: boolean }> };
      const vatDone = Boolean(vatData.vatRegistrationType);
      const rows = Array.isArray(mpData.marketplaces) ? mpData.marketplaces : [];
      const hasBase = rows.some((r) => r.isBase);
      if (vatDone && !hasBase) {
        setOpen(true);
      } else {
        setOpen(false);
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  }, [getToken, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    void checkNeedsMarketplaceOnboarding();
  }, [isSignedIn, checkNeedsMarketplaceOnboarding]);

  useEffect(() => {
    const onVatComplete = () => {
      void refreshMarketplaces().then(() => void checkNeedsMarketplaceOnboarding());
    };
    window.addEventListener("sellerbunker-vat-onboarding-complete", onVatComplete);
    return () => window.removeEventListener("sellerbunker-vat-onboarding-complete", onVatComplete);
  }, [refreshMarketplaces, checkNeedsMarketplaceOnboarding]);

  const saveMarketplace = async () => {
    if (!selectedMarketplaceId) return;
    setSaving(true);
    setError(null);
    try {
      await selectMarketplace(selectedMarketplaceId);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save marketplace.");
    } finally {
      setSaving(false);
    }
  };

  if (checking || !open) return null;

  return (
    <div
      className="fixed inset-0 z-[205] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="marketplace-onboarding-title"
      aria-describedby="marketplace-onboarding-desc"
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-xl">
        <h2 id="marketplace-onboarding-title" className="text-lg font-semibold text-[var(--foreground)]">
          Select your most used marketplace
        </h2>
        <p id="marketplace-onboarding-desc" className="mt-1 text-sm text-[var(--muted-foreground)]">
          We&apos;ll save this as your default marketplace. You can change it any time from the flag selector.
        </p>

        <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-[var(--surface-border)] p-2">
          {grouped.map((group) => (
            <div key={group.region} className="mb-2 last:mb-0">
              <p className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((m) => (
                  <button
                    key={m.marketplaceId}
                    type="button"
                    onClick={() => setSelectedMarketplaceId(m.marketplaceId)}
                    className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-sm ${
                      selectedMarketplaceId === m.marketplaceId
                        ? "border-sb-accent bg-sb-accent/10"
                        : "border-transparent hover:bg-[var(--foreground)]/5"
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Flag countryCode={m.countryCode} fallback={m.flag} />
                      <span>{m.displayName}</span>
                    </span>
                    <span className="text-xs text-[var(--muted-foreground)]">{m.currencyCode}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={saveMarketplace}
            disabled={!selectedMarketplaceId || saving}
            className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {saving ? "Saving…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

