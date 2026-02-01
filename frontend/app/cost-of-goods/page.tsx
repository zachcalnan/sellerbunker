"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";

type ProductRow = {
  id: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  costOfGoods: number | null;
  updatedAt: string;
};

const SYSTEM_SKUS = new Set(["AMAZON_GENERIC", "AMAZON_MULTI"]);

export default function CostOfGoodsPage() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isSignedIn) {
      setProducts([]);
      setDraft({});
      setError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(`${baseUrl}/api/amazon/products`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error("Failed to load products.");
        }
        const data = (await res.json()) as ProductRow[];
        if (cancelled) return;
        setProducts(data);
        const initial: Record<string, string> = {};
        for (const p of data) {
          initial[p.id] =
            p.costOfGoods == null ? "" : String(p.costOfGoods);
        }
        setDraft(initial);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken, baseUrl]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (!showSystem && SYSTEM_SKUS.has(p.sku)) return false;
      if (!q) return true;
      return (
        p.sku.toLowerCase().includes(q) ||
        (p.asin ?? "").toLowerCase().includes(q) ||
        (p.title ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, query, showSystem]);

  const normalizeDraftToNumber = (raw: string): number | null => {
    const trimmed = (raw ?? "").trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const dirtyIds = useMemo(() => {
    const dirty: string[] = [];
    for (const p of products) {
      const current = p.costOfGoods == null ? null : Number(p.costOfGoods);
      const next = normalizeDraftToNumber(draft[p.id] ?? "");
      if (current !== next) dirty.push(p.id);
    }
    return dirty;
  }, [products, draft]);

  const saveAll = async () => {
    if (dirtyIds.length === 0) return;

    setSaving(true);
    setError(null);
    setSaveNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");

      const updates = await Promise.all(
        dirtyIds.map(async (productId) => {
          const costOfGoods = normalizeDraftToNumber(draft[productId] ?? "");
          const res = await fetch(
            `${baseUrl}/api/amazon/products/${productId}/cost-of-goods`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ costOfGoods }),
            },
          );

          if (!res.ok) {
            const msg = await res.text();
            throw new Error(
              msg || `Failed to save COGS for product ${productId}`,
            );
          }

          return (await res.json()) as ProductRow;
        }),
      );

      setProducts((prev) => {
        const byId = new Map(updates.map((u) => [u.id, u]));
        return prev.map((p) => byId.get(p.id) ?? p);
      });

      setDraft((prev) => {
        const next = { ...prev };
        for (const u of updates) {
          next[u.id] = u.costOfGoods == null ? "" : String(u.costOfGoods);
        }
        return next;
      });

      setSaveNotice(`Saved ${updates.length} SKU${updates.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-[var(--foreground)]">
            Cost of Goods
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Set per-unit COGS per SKU. Profit is only calculated when COGS is present.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <input
              type="checkbox"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            Show system SKUs
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU / ASIN / title…"
            className="w-72 max-w-[70vw] rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
          />
        </div>
      </div>

      <SignedOut>
        <div className="rounded-xl border border-[var(--surface-border)] bg-transparent p-4 text-sm text-[var(--muted-foreground)]">
          <div className="mb-3">Sign in to manage Cost of Goods.</div>
          <SignInButton>
            <button className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        {error ? (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        {saveNotice ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {saveNotice}
          </div>
        ) : null}

        <div className="mb-4 flex items-center justify-end">
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || dirtyIds.length === 0}
            className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving
              ? "Saving…"
              : dirtyIds.length === 0
                ? "Saved"
                : `Save changes (${dirtyIds.length})`}
          </button>
        </div>

        <div className="overflow-hidden rounded-xl ring-1 ring-[var(--surface-border)]">
          <div className="hidden md:grid grid-cols-[44px_1.2fr_1fr_2fr_1fr_auto] gap-3 bg-[var(--surface)] px-4 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
            <div />
            <div>SKU</div>
            <div>ASIN</div>
            <div>Title</div>
            <div>COGS (per unit)</div>
            <div />
          </div>

          {loading ? (
            <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
              No products found.
            </div>
          ) : (
            <div className="divide-y divide-[var(--surface-border)] bg-transparent">
              {filtered.map((p) => {
                const isSystem = SYSTEM_SKUS.has(p.sku);
                return (
                  <>
                    {/* Mobile card */}
                    <div key={`${p.id}-mobile`} className="md:hidden px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center">
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt={p.title ?? p.sku}
                              className="h-11 w-11 rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="h-11 w-11 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--foreground)]">
                            {p.title ?? p.sku}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                            SKU {p.sku} · ASIN {p.asin ?? "—"}
                          </div>
                          {isSystem ? (
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                              System SKU
                            </div>
                          ) : null}

                          <div className="mt-3">
                            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                              COGS (per unit)
                            </div>
                            <input
                              value={draft[p.id] ?? ""}
                              onChange={(e) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  [p.id]: e.target.value,
                                }))
                              }
                              inputMode="decimal"
                              placeholder="e.g. 3.25"
                              className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Desktop table row */}
                    <div
                      key={`${p.id}-desktop`}
                      className="hidden md:grid grid-cols-[44px_1.2fr_1fr_2fr_1fr_auto] items-center gap-3 px-4 py-3"
                    >
                      <div className="flex items-center justify-center">
                        {p.imageUrl ? (
                          <img
                            src={p.imageUrl}
                            alt={p.title ?? p.sku}
                            className="h-9 w-9 rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="h-9 w-9 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--foreground)]">
                          {p.sku}
                        </div>
                        {isSystem ? (
                          <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                            System SKU
                          </div>
                        ) : null}
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {p.asin ?? "—"}
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {p.title ?? "—"}
                      </div>
                      <div>
                        <input
                          value={draft[p.id] ?? ""}
                          onChange={(e) =>
                            setDraft((prev) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }))
                          }
                          inputMode="decimal"
                          placeholder="e.g. 3.25"
                          className="w-40 rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                        />
                      </div>
                      <div className="flex justify-end" />
                    </div>
                  </>
                );
              })}
            </div>
          )}
        </div>
      </SignedIn>
    </div>
  );
}

