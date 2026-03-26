"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type CatalogMarketplace = {
  marketplaceId: string;
  countryCode: string;
  displayName: string;
  flag: string;
  currencyCode: string;
  region: "NA" | "EU" | "AUSTRALASIA";
};

type CatalogResponse = {
  marketplaces: CatalogMarketplace[];
};

function ConnectAmazonContent() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [catalog, setCatalog] = useState<CatalogMarketplace[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState<string>("");
  const justPaid = searchParams.get("checkout") === "success";

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/");
      return;
    }
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    const loadCatalog = async () => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const token = await getToken({ template: "backend" });
        if (!token) throw new Error("Please sign in again.");
        const res = await fetch(`${BASE_URL}/api/marketplaces/catalog`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Could not load marketplace options.");
        const data = (await res.json()) as CatalogResponse;
        if (cancelled) return;
        const rows = Array.isArray(data.marketplaces) ? data.marketplaces : [];
        setCatalog(rows);
        setSelectedMarketplaceId((prev) => {
          if (prev && rows.some((m) => m.marketplaceId === prev)) return prev;
          return rows.find((m) => m.countryCode === "GB")?.marketplaceId ?? rows[0]?.marketplaceId ?? "";
        });
      } catch (e) {
        if (!cancelled) {
          setCatalogError(e instanceof Error ? e.message : "Could not load marketplace options.");
          setCatalog([]);
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    };
    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken]);

  const connectAmazon = async () => {
    if (!isSignedIn) return;
    setConnecting(true);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setConnecting(false);
        alert("Please sign in again and try connecting.");
        return;
      }
      const selectedMarketplace = catalog.find((m) => m.marketplaceId === selectedMarketplaceId) ?? null;
      const selectedRegion = selectedMarketplace?.region === "NA"
        ? "NA"
        : selectedMarketplace?.region === "AUSTRALASIA"
          ? "FE"
          : "EU";

      if (selectedMarketplace) {
        const baseRes = await fetch(`${BASE_URL}/api/marketplaces/base`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ marketplaceId: selectedMarketplace.marketplaceId }),
        });
        if (!baseRes.ok) {
          setConnecting(false);
          alert("Could not save your base marketplace. Please try again.");
          return;
        }
      }

      const returnOrigin = typeof window !== 'undefined' ? window.location.origin : '';
      const params = new URLSearchParams({ region: selectedRegion });
      if (returnOrigin) params.set('returnOrigin', returnOrigin);
      const res = await fetch(`${BASE_URL}/api/amazon/connect?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok) {
        setConnecting(false);
        alert(`Could not start Amazon connection: ${data?.message ?? res.statusText ?? "Please try again."}`);
        return;
      }
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setConnecting(false);
        alert("Could not get Amazon sign-in link. Please try again or contact support.");
      }
    } catch (e) {
      setConnecting(false);
      alert(`Could not start Amazon connection: ${e instanceof Error ? e.message : "Please try again."}`);
    } finally {
      setConnecting(false);
    }
  };

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <p className="text-[var(--muted-foreground)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--background)] px-4 text-[var(--foreground)]">
      <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 text-center">
        {justPaid && (
          <p className="mb-4 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
            Thank you for your payment. Your trial has started.
          </p>
        )}
        <h1 className="text-2xl font-bold">Connect your Amazon account</h1>
        <p className="mt-4 text-[var(--muted-foreground)]">
          We will import 30 days worth of selling data. More can be requested.
        </p>
        <div className="mt-6 text-left">
          <p className="mb-2 text-sm font-medium text-[var(--foreground)]">Choose your base marketplace</p>
          {catalogLoading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading marketplaces…</p>
          ) : catalogError ? (
            <p className="text-sm text-red-500">{catalogError}</p>
          ) : (
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-[var(--surface-border)] p-2">
              {catalog.map((m) => (
                <label
                  key={m.marketplaceId}
                  className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 hover:bg-[var(--foreground)]/5"
                >
                  <span className="text-sm text-[var(--foreground)]">
                    {m.flag} {m.displayName}
                    <span className="ml-2 text-xs text-[var(--muted-foreground)]">({m.currencyCode})</span>
                  </span>
                  <input
                    type="radio"
                    name="base-marketplace"
                    value={m.marketplaceId}
                    checked={selectedMarketplaceId === m.marketplaceId}
                    onChange={() => setSelectedMarketplaceId(m.marketplaceId)}
                    className="h-4 w-4 accent-[var(--sb-accent)]"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="mt-8">
          <button
            type="button"
            onClick={connectAmazon}
            disabled={connecting || catalogLoading || !selectedMarketplaceId}
            className="w-full rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-black transition hover:bg-gray-100 disabled:opacity-60"
          >
            {connecting ? "Opening…" : "Connect Amazon account"}
          </button>
        </div>
        <p className="mt-6 text-sm text-[var(--muted-foreground)]">
          <Link href="/dashboard" className="underline hover:no-underline">
            Skip for now — go to dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ConnectAmazonPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
          <p className="text-[var(--muted-foreground)]">Loading…</p>
        </div>
      }
    >
      <ConnectAmazonContent />
    </Suspense>
  );
}
