"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CogsScreenshotIngest } from "@/components/cogs-screenshot-ingest";
import { RedirectToSignInWithReturn } from "@/components/redirect-to-sign-in-with-return";
import { SignInButtonWithReturn } from "@/components/sign-in-button-with-return";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { formatApiErrorMessage } from "@/lib/format-api-error";
import { getDevImpersonationHeaders, withImpersonateParam } from "@/lib/impersonation";

const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type SheetLink = {
  label: string;
  spreadsheetId: string;
  url: string;
};

type SheetLinksResponse = {
  purchaseSheet: SheetLink | null;
  prepInbound: SheetLink | null;
};

function PurchasesInner() {
  const { getToken, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const { backgroundClass } = useDisplaySettings();
  const [sheetLinks, setSheetLinks] = useState<SheetLinksResponse | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setSheetLinks(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${baseUrl}/api/amazon/sheets/links`, {
          headers: {
            Authorization: `Bearer ${token}`,
            ...getDevImpersonationHeaders(devImpersonate),
          },
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as SheetLinksResponse;
        if (!cancelled) setSheetLinks(json);
      } catch {
        // Optional links — ignore failures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken, devImpersonate]);

  const extractPurchaseScreenshot = useCallback(
    async (body: {
      imageBase64: string;
      mimeType: string;
      hint?: string;
    }) => {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");
      const res = await fetch(
        `${baseUrl}/api/amazon/cost-of-goods/screenshot-extract`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...getDevImpersonationHeaders(devImpersonate),
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(
          formatApiErrorMessage(msg, "Screenshot extract failed."),
        );
      }
      return (await res.json()) as {
        draft: {
          supplier: string;
          orderNumber: string;
          purchaseDate: string;
          currency: string;
          vatRatePct: number;
          fulfilment: string;
          supplierLink?: string;
          promo?: { type: "none" | "buy_3_get_1_free" };
          lines: Array<{
            productTitle?: string;
            asin?: string;
            sku?: string;
            qty: number;
            unitRrpIncVat?: number;
            unitCostIncVat?: number;
            lineTotalIncVat?: number;
            deliveryCostIncVat?: number;
            prepCostIncVat?: number;
          }>;
          warnings: string[];
        };
        model: string;
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          approxCostUsd?: number;
        };
        quota?: { used: number; limit: number; remaining: number };
      };
    },
    [getToken, devImpersonate],
  );

  const loadScreenshotQuota = useCallback(async () => {
    const token = await getToken({ template: "backend" });
    if (!token) throw new Error("Not authenticated.");
    const res = await fetch(
      `${baseUrl}/api/amazon/cost-of-goods/screenshot-extract/quota`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
        },
      },
    );
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(formatApiErrorMessage(msg, "Could not load AI quota."));
    }
    return (await res.json()) as {
      used: number;
      limit: number;
      remaining: number;
    };
  }, [getToken, devImpersonate]);

  const searchListings = useCallback(
    async (query: string) => {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");
      const url = new URL(`${baseUrl}/api/amazon/products/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("take", "20");
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          ...getDevImpersonationHeaders(devImpersonate),
        },
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(formatApiErrorMessage(msg, "Listing search failed."));
      }
      const rows = (await res.json()) as Array<{
        asin: string | null;
        sku: string;
        title: string | null;
        imageUrl?: string | null;
        costOfGoods?: number | null;
      }>;
      return rows
        .filter((r) => (r.asin ?? "").trim().length >= 8)
        .map((r) => ({
          asin: (r.asin ?? "").toUpperCase(),
          sku: r.sku,
          title: (r.title ?? "").trim() || r.sku,
          imageUrl: r.imageUrl ?? null,
          costOfGoods: r.costOfGoods ?? null,
        }));
    },
    [getToken, devImpersonate],
  );

  const confirmScreenshotIngest = useCallback(
    async (payload: Record<string, unknown>) => {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");
      const res = await fetch(`${baseUrl}/api/amazon/supplier-orders/ingest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...getDevImpersonationHeaders(devImpersonate),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(
          formatApiErrorMessage(msg, "Purchase ingest failed."),
        );
      }
      return (await res.json()) as {
        ledger: {
          created: number;
          skipped: number;
          sellerBunkerCogsUpdated?: number;
          errors: Array<{ lineIndex: number; asin?: string; message: string }>;
        };
        sheet?: {
          ok?: boolean;
          appended?: number;
          skippedDuplicate?: number;
          errors?: string[];
          tabTitle?: string;
        };
      };
    },
    [getToken, devImpersonate],
  );

  return (
    <div className={`min-h-screen w-full ${backgroundClass} p-2 pb-6 sm:p-3 md:px-4 md:py-6`}>
      <div className="mb-3 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-3 sm:mb-4 sm:px-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-[var(--foreground)] sm:text-2xl">
              Purchases
            </h1>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground)] sm:mt-1 sm:text-sm">
              Search your listings for the ASIN, fill qty and cost, then confirm
              — updates SellerBunker COGS and your purchase sheets. Tick{" "}
              <span className="font-medium text-[var(--foreground)]">
                Search with AI
              </span>{" "}
              only if you want a screenshot read (uses OpenAI).
            </p>
            {sheetLinks?.purchaseSheet?.url || sheetLinks?.prepInbound?.url ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
                <span className="text-[var(--muted-foreground)]">Sheets:</span>
                {sheetLinks.purchaseSheet?.url ? (
                  <a
                    href={sheetLinks.purchaseSheet.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sb-accent hover:underline"
                  >
                    Purchase sheet ↗
                  </a>
                ) : null}
                {sheetLinks.prepInbound?.url ? (
                  <a
                    href={sheetLinks.prepInbound.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sb-accent hover:underline"
                  >
                    Prep inbound ↗
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
          <Link
            href={withImpersonateParam("/cost-of-goods", devImpersonate)}
            className="text-xs font-medium text-sb-accent no-underline hover:underline sm:shrink-0 sm:pt-1"
          >
            View / edit COGS →
          </Link>
        </div>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to log purchases.</div>
          <SignInButtonWithReturn>
            <button className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButtonWithReturn>
          <RedirectToSignInWithReturn fallback="/purchases" />
        </div>
      </SignedOut>

      <SignedIn>
        <CogsScreenshotIngest
          variant="page"
          onExtract={extractPurchaseScreenshot}
          onLoadQuota={loadScreenshotQuota}
          onSearchListings={searchListings}
          onConfirm={confirmScreenshotIngest}
          onFinished={() => undefined}
        />
      </SignedIn>
    </div>
  );
}

export default function PurchasesPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <PurchasesInner />
    </Suspense>
  );
}
