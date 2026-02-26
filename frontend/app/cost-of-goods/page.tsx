"use client";

import { RedirectToSignIn, SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

type ProductRow = {
  id: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
};

type CostEntryRow = {
  id: string;
  fulfilment: string;
  supplier: string | null;
  supplierLink?: string | null;
  bundleSize?: number | null;
  purchaseDate: string;
  shipmentId: string | null;
  qtyPurchased: number;
  qtyDelivered: number;
  currency: string;
  vatRatePct: number;
  unitCostIncVat: number;
  deliveryCostIncVat: number;
  prepCostIncVat: number;
  totalCostIncVat: number;
  product: ProductRow;
};

function CostOfGoodsInner() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const searchParams = useSearchParams();
  const missingParamOn = searchParams.get("missing") === "1";
  const [cogsFilter, setCogsFilter] = useState<"missing" | "complete" | "all">(
    "missing",
  );
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");

  const [entries, setEntries] = useState<CostEntryRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [entriesTotal, setEntriesTotal] = useState<number>(0);
  const [take, setTake] = useState(10);
  const [skip, setSkip] = useState(0);
  const [missing, setMissing] = useState<
    {
      productId: string;
      sku: string;
      asin: string | null;
      title: string | null;
      imageUrl: string | null;
      revenue: number;
      units: number;
      lineItems: number;
    }[]
  >([]);
  const [missingCount, setMissingCount] = useState<number | null>(null);

  type VatSettings = {
    vatRegistrationType: string;
    vatEffectiveDate: string | null;
    vatFlatRatePct: number | null;
    vatRatePct: number | null;
    vatCostsIncludeVat: boolean | null;
  };
  const [vatSettings, setVatSettings] = useState<VatSettings | null>(null);

  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CostEntryRow | null>(null);
  const currencyOptions = ["GBP", "EUR", "USD", "CAD", "MXN", "BRL", "AUD", "AED"] as const;
  const isCurrencyOption = (
    v: string,
  ): v is (typeof currencyOptions)[number] =>
    (currencyOptions as readonly string[]).includes(v);
  const [productPickerQuery, setProductPickerQuery] = useState("");

  type VatMode = "inc" | "ex";
  const [unitVatMode, setUnitVatMode] = useState<VatMode>("inc");
  const [deliveryVatMode, setDeliveryVatMode] = useState<VatMode>("inc");
  const [prepVatMode, setPrepVatMode] = useState<VatMode>("inc");
  const [unitCostExVat, setUnitCostExVat] = useState("");
  const [deliveryCostExVat, setDeliveryCostExVat] = useState("");
  const [prepCostExVat, setPrepCostExVat] = useState("");

  const [form, setForm] = useState({
    productId: "",
    fulfilment: "Amazon",
    supplier: "",
    supplierLink: "",
    bundleSize: "1",
    purchaseDate: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    shipmentId: "",
    qtyPurchased: "0",
    qtyDelivered: "0",
    currency: "GBP",
    vatRatePct: "0",
    unitCostIncVat: "",
    deliveryCostIncVat: "0",
    prepCostIncVat: "0",
  });

  const resetNewEntryForm = (productId?: string) => {
    setForm({
      productId: productId ?? "",
      fulfilment: "Amazon",
      supplier: "",
      supplierLink: "",
      bundleSize: "1",
      purchaseDate: new Date().toISOString().slice(0, 10),
      shipmentId: "",
      qtyPurchased: "0",
      qtyDelivered: "0",
      currency: "GBP",
      vatRatePct: "0",
      unitCostIncVat: "",
      deliveryCostIncVat: "0",
      prepCostIncVat: "0",
    });
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");

      const missingQs = new URLSearchParams();
      if (startParam) missingQs.set("start", startParam);
      if (endParam) missingQs.set("end", endParam);
      missingQs.set("limit", "50");

      const [entriesRes, productsRes, missingRes, vatRes] = await Promise.all([
        fetch(
          `${baseUrl}/api/amazon/cost-of-goods/entries?` +
          new URLSearchParams({
            query,
            take: String(take),
            skip: String(skip),
          }).toString(),
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        ),
        fetch(`${baseUrl}/api/amazon/products`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/amazon/cost-of-goods/missing?${missingQs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/orgs/vat-settings`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!entriesRes.ok) throw new Error("Failed to load cost entries.");
      if (!productsRes.ok) throw new Error("Failed to load products.");
      if (!missingRes.ok) throw new Error("Failed to load missing COGS.");
      if (vatRes.ok) {
        const vatData = (await vatRes.json()) as VatSettings;
        setVatSettings(vatData);
      }

      const entriesData = (await entriesRes.json()) as
        | CostEntryRow[]
        | { total?: number; items?: CostEntryRow[] };
      const productsData = (await productsRes.json()) as ProductRow[];
      const missingData = (await missingRes.json()) as {
        missingSkusCount?: number;
        items?: {
          productId: string;
          sku: string;
          asin: string | null;
          title: string | null;
          imageUrl: string | null;
          revenue: number;
          units: number;
          lineItems: number;
        }[];
      };
      if (Array.isArray(entriesData)) {
        setEntries(entriesData);
        setEntriesTotal(entriesData.length);
      } else {
        setEntries(Array.isArray(entriesData.items) ? entriesData.items : []);
        setEntriesTotal(Number(entriesData.total ?? 0));
      }
      setProducts(productsData);
      setMissing(Array.isArray(missingData.items) ? missingData.items : []);
      setMissingCount(
        typeof missingData.missingSkusCount === "number"
          ? missingData.missingSkusCount
          : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  };

  const canPrev = skip > 0;
  const canNext = skip + entries.length < entriesTotal;
  const prevPage = () => setSkip((s) => Math.max(0, s - take));
  const nextPage = () => setSkip((s) => s + take);

  const vatPct = Number(form.vatRatePct ?? 0) || 0;
  const vatMult = 1 + vatPct / 100;
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const incFromEx = (ex: number) => round2(ex * vatMult);
  const exFromInc = (inc: number) => (vatMult === 0 ? round2(inc) : round2(inc / vatMult));

  const selectedProduct = useMemo(() => {
    const id = form.productId;
    if (!id) return null;
    return products.find((p) => p.id === id) ?? null;
  }, [products, form.productId]);

  const filteredProductsForPicker = useMemo(() => {
    const q = productPickerQuery.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    return products
      .filter((p) => {
        const sku = p.sku ?? "";
        const asin = p.asin ?? "";
        const title = p.title ?? "";
        return (
          sku.toLowerCase().includes(q) ||
          asin.toLowerCase().includes(q) ||
          title.toLowerCase().includes(q)
        );
      })
      .slice(0, 30);
  }, [products, productPickerQuery]);

  useEffect(() => {
    if (!showForm) return;

    // Reset VAT input helpers each time modal opens.
    setUnitVatMode("inc");
    setDeliveryVatMode("inc");
    setPrepVatMode("inc");
    setUnitCostExVat("");
    setDeliveryCostExVat("");
    setPrepCostExVat("");
    setProductPickerQuery("");

    if (!editingEntry) return;

    setForm({
      productId: editingEntry.product.id,
      fulfilment: editingEntry.fulfilment ?? "Amazon",
      supplier: editingEntry.supplier ?? "",
      supplierLink: editingEntry.supplierLink ?? "",
      bundleSize: String(editingEntry.bundleSize ?? 1),
      purchaseDate: new Date(editingEntry.purchaseDate).toISOString().slice(0, 10),
      shipmentId: editingEntry.shipmentId ?? "",
      qtyPurchased: String(editingEntry.qtyPurchased ?? 0),
      qtyDelivered: String(editingEntry.qtyDelivered ?? 0),
      currency: editingEntry.currency ?? "GBP",
      vatRatePct: String(editingEntry.vatRatePct ?? 0),
      unitCostIncVat: String(editingEntry.unitCostIncVat ?? 0),
      deliveryCostIncVat: String(editingEntry.deliveryCostIncVat ?? 0),
      prepCostIncVat: String(editingEntry.prepCostIncVat ?? 0),
    });
  }, [showForm, editingEntry]);

  useEffect(() => {
    if (!showForm || !vatSettings) return;
    if (vatSettings.vatRegistrationType === "VAT_STANDARD") {
      const pct = vatSettings.vatRatePct ?? 20;
      setForm((prev) => ({ ...prev, vatRatePct: String(pct) }));
      const incl = vatSettings.vatCostsIncludeVat !== false;
      setUnitVatMode(incl ? "inc" : "ex");
      setDeliveryVatMode(incl ? "inc" : "ex");
      setPrepVatMode(incl ? "inc" : "ex");
    }
  }, [showForm, vatSettings?.vatRegistrationType, vatSettings?.vatRatePct, vatSettings?.vatCostsIncludeVat]);

  useEffect(() => {
    if (!showForm) return;

    if (unitVatMode === "ex") {
      const ex = Number(unitCostExVat ?? 0) || 0;
      if (ex > 0) {
        setForm((prev) => ({ ...prev, unitCostIncVat: String(incFromEx(ex)) }));
      }
    }
    if (deliveryVatMode === "ex") {
      const ex = Number(deliveryCostExVat ?? 0) || 0;
      if (ex > 0) {
        setForm((prev) => ({
          ...prev,
          deliveryCostIncVat: String(incFromEx(ex)),
        }));
      }
    }
    if (prepVatMode === "ex") {
      const ex = Number(prepCostExVat ?? 0) || 0;
      if (ex > 0) {
        setForm((prev) => ({ ...prev, prepCostIncVat: String(incFromEx(ex)) }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showForm,
    vatPct,
    unitVatMode,
    deliveryVatMode,
    prepVatMode,
    unitCostExVat,
    deliveryCostExVat,
    prepCostExVat,
  ]);

  useEffect(() => {
    if (!isSignedIn) {
      setEntries([]);
      setProducts([]);
      setError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await load();
      } finally {
        if (cancelled) return;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, getToken, baseUrl, startParam, endParam, query, take, skip]);

  useEffect(() => {
    if (missingParamOn) {
      setCogsFilter("missing");
    }
  }, [missingParamOn]);

  useEffect(() => {
    if (!showForm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowForm(false);
        setEditingEntry(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showForm]);

  const filtered = useMemo(() => entries, [entries]);

  const filteredWithMissingToggle = useMemo(() => {
    const missingIds = new Set(missing.map((m) => m.productId));

    return filtered.filter((e) => {
      if (cogsFilter === "missing") {
        return missingIds.has(e.product.id);
      }

      if (cogsFilter === "complete") {
        return !missingIds.has(e.product.id);
      }

      return true; // "all"
    });
  }, [filtered, cogsFilter, missing]);

  const pagingTotal =
    cogsFilter === "missing"
      ? typeof missingCount === "number"
        ? missingCount
        : missing.length
      : cogsFilter === "all"
        ? entriesTotal
        : filteredWithMissingToggle.length;
  const pagingStart =
    pagingTotal > 0 ? (cogsFilter === "all" ? skip + 1 : 1) : 0;
  const pagingEnd =
    pagingTotal > 0
      ? cogsFilter === "all"
        ? Math.min(skip + entries.length, entriesTotal)
        : cogsFilter === "missing"
          ? Math.min(missing.length, pagingTotal)
          : filteredWithMissingToggle.length
      : 0;


  const createEntry = async () => {
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");

      const payload = {
        productId: form.productId,
        fulfilment: form.fulfilment.trim() || "Amazon",
        supplier: form.supplier.trim() || undefined,
        supplierLink: form.supplierLink.trim() || undefined,
        bundleSize: Math.max(1, Number(form.bundleSize ?? 1) || 1),
        purchaseDate: new Date(form.purchaseDate).toISOString(),
        shipmentId: form.shipmentId.trim() || undefined,
        qtyPurchased: Number(form.qtyPurchased ?? 0) || 0,
        qtyDelivered: Number(form.qtyDelivered ?? 0) || 0,
        currency: form.currency.trim() || "GBP",
        vatRatePct: round2(Number(form.vatRatePct ?? 0) || 0),
        unitCostIncVat: round2(Number(form.unitCostIncVat ?? 0) || 0),
        deliveryCostIncVat: round2(Number(form.deliveryCostIncVat ?? 0) || 0),
        prepCostIncVat: round2(Number(form.prepCostIncVat ?? 0) || 0),
      };

      if (!payload.productId) throw new Error('Pick a SKU.');
      if (!Number.isFinite(payload.unitCostIncVat) || payload.unitCostIncVat <= 0) {
        throw new Error("Enter a unit cost (inc VAT).");
      }

      const res = await fetch(`${baseUrl}/api/amazon/cost-of-goods/entries`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Failed to create entry.");
      }

      await res.json();
      if (vatSettings?.vatRegistrationType === "VAT_STANDARD") {
        try {
          await fetch(`${baseUrl}/api/orgs/vat-settings`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              vatRatePct: Number(form.vatRatePct ?? 0) || 20,
              vatCostsIncludeVat: unitVatMode === "inc",
            }),
          });
        } catch {
          // Non-fatal: entry saved; org VAT defaults may not be updated
        }
      }
      setNotice("Saved.");
      setShowForm(false);
      setEditingEntry(null);
      setForm((prev) => ({
        ...prev,
        supplier: "",
        supplierLink: "",
        bundleSize: "1",
        shipmentId: "",
        qtyPurchased: "0",
        qtyDelivered: "0",
        unitCostIncVat: "",
        deliveryCostIncVat: "0",
        prepCostIncVat: "0",
      }));
      setSkip(0);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create entry.");
    } finally {
      setCreating(false);
    }
  };

  const updateEntry = async () => {
    if (!editingEntry) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");

      const payload = {
        fulfilment: form.fulfilment.trim() || "Amazon",
        supplier: form.supplier.trim() || undefined,
        supplierLink: form.supplierLink.trim() || undefined,
        bundleSize: Math.max(1, Number(form.bundleSize ?? 1) || 1),
        purchaseDate: new Date(form.purchaseDate).toISOString(),
        shipmentId: form.shipmentId.trim() || undefined,
        qtyPurchased: Number(form.qtyPurchased ?? 0) || 0,
        qtyDelivered: Number(form.qtyDelivered ?? 0) || 0,
        currency: form.currency.trim() || "GBP",
        vatRatePct: round2(Number(form.vatRatePct ?? 0) || 0),
        unitCostIncVat: round2(Number(form.unitCostIncVat ?? 0) || 0),
        deliveryCostIncVat: round2(Number(form.deliveryCostIncVat ?? 0) || 0),
        prepCostIncVat: round2(Number(form.prepCostIncVat ?? 0) || 0),
      };

      if (!Number.isFinite(payload.unitCostIncVat) || payload.unitCostIncVat <= 0) {
        throw new Error("Enter a unit cost (inc VAT).");
      }

      const res = await fetch(
        `${baseUrl}/api/amazon/cost-of-goods/entries/${editingEntry.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Failed to update entry.");
      }

      if (vatSettings?.vatRegistrationType === "VAT_STANDARD") {
        try {
          await fetch(`${baseUrl}/api/orgs/vat-settings`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              vatRatePct: Number(form.vatRatePct ?? 0) || 20,
              vatCostsIncludeVat: unitVatMode === "inc",
            }),
          });
        } catch {
          // Non-fatal: entry saved; org VAT defaults may not be updated
        }
      }
      setNotice("Saved.");
      setShowForm(false);
      setEditingEntry(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update entry.");
    } finally {
      setCreating(false);
    }
  };

  const beginEdit = (entry: CostEntryRow) => {
    setError(null);
    setNotice(null);
    setEditingEntry(entry);
    setShowForm(true);
  };

  const seedFromExisting = async () => {
    setSeeding(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");
      const res = await fetch(
        `${baseUrl}/api/amazon/cost-of-goods/seed-from-products`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Failed to import existing COGS.");
      }
      const result = (await res.json()) as {
        seeded?: number;
        skippedExisting?: number;
        considered?: number;
      };
      setNotice(
        `Imported ${Number(result.seeded ?? 0)} entries` +
        (result.skippedExisting
          ? ` (skipped ${Number(result.skippedExisting)} existing)`
          : "") +
        ".",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import existing COGS.");
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Cost of Goods
          </h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Log inbound cost entries per SKU (unit, delivery, prep, VAT). Profit uses the latest entry per SKU.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SKU / ASIN / title / shipment / supplier…"
              className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none sm:w-80"
            />
            <button
              type="button"
              onClick={() => {
                if (showForm) {
                  setShowForm(false);
                  setEditingEntry(null);
                  return;
                }
                setEditingEntry(null);
                resetNewEntryForm();
                setShowForm(true);
              }}
              className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black"
            >
              {showForm ? "Close" : "Add entry"}
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <span className="sr-only">COGS filter</span>

              <div className="inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-[var(--surface-border)]">
                <button
                  type="button"
                  onClick={() => {
                    setCogsFilter("missing");
                    setSkip(0);
                  }}
                  className={[
                    "cursor-pointer h-8 px-3 text-xs",
                    cogsFilter === "missing"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "bg-transparent text-[var(--foreground)]",
                  ].join(" ")}
                >
                  Missing
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setCogsFilter("complete");
                    setSkip(0);
                  }}
                  className={[
                    "cursor-pointer h-8 px-3 text-xs border-l border-[var(--surface-border)]",
                    cogsFilter === "complete"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "bg-transparent text-[var(--foreground)]",
                  ].join(" ")}
                >
                  Complete
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setCogsFilter("all");
                    setSkip(0);
                  }}
                  className={[
                    "cursor-pointer h-8 px-3 text-xs border-l border-[var(--surface-border)]",
                    cogsFilter === "all"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "bg-transparent text-[var(--foreground)]",
                  ].join(" ")}
                >
                  All
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted-foreground)]">
              {cogsFilter === "all" ? (
                <label className="flex h-8 items-center gap-2">
                  <span>Items per page:</span>
                  <select
                    value={take}
                    onChange={(e) => {
                      setTake(Number(e.target.value));
                      setSkip(0);
                    }}
                    className="h-8 cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-2 text-xs text-[var(--foreground)] outline-none"
                  >
                    {[10, 25, 50, 100].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <span>
                {pagingTotal > 0
                  ? `${pagingStart} - ${pagingEnd} of ${pagingTotal}`
                  : "0 - 0 of 0"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>

      <SignedIn>
        {notice ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {cogsFilter === "missing" ? (
          <div className="mb-4 rounded-xl bg-transparent p-4 ring-1 ring-[var(--surface-border)]">
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium text-[var(--foreground)]">
                SKUs needing COGS
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                {missingCount == null
                  ? "Loading…"
                  : missingCount === 0
                    ? "All good — none missing in this period."
                    : `Missing for ${missingCount} SKU${missingCount === 1 ? "" : "s"} in this period.`}
              </div>
            </div>

            {missing.length > 0 ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {missing.map((m) => (
                  <div
                    key={m.productId}
                    className="flex items-start gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-3"
                  >
                    <div className="h-10 w-10 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                      {m.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={m.imageUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-[var(--foreground)]">
                        {m.title ?? "—"}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                        <span className="font-mono">{m.sku}</span>
                        {m.asin ? ` · ${m.asin}` : ""}
                        {" · "}
                        {m.units.toLocaleString()} units
                        {" · "}
                        £{m.revenue.toFixed(2)}
                      </div>
                      <div className="mt-2">
                        <button
                          type="button"
                          className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-xs font-medium text-black"
                          onClick={() => {
                            setEditingEntry(null);
                            setShowForm(true);
                            resetNewEntryForm(m.productId);
                          }}
                        >
                          Add entry
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={seedFromExisting}
                disabled={seeding}
                className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                title="Create ledger entries from existing per-SKU COGS values"
              >
                {seeding ? "Importing…" : "Import existing COGS"}
              </button>
            </div>
          </div>
        ) : null}

        {showForm ? (
          <div
            className="fixed inset-0 z-50 flex cursor-pointer items-start justify-center bg-black/40 backdrop-blur-sm p-4 md:items-center"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setShowForm(false);
                setEditingEntry(null);
              }
            }}
          >
            <div className="w-full max-w-3xl cursor-default overflow-hidden rounded-xl bg-[var(--background)] text-[var(--foreground)] ring-1 ring-[var(--surface-border)]">
              <div className="flex items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
                <div className="min-w-0">
                  {selectedProduct ? (
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="aspect-square h-9 w-9 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                        {selectedProduct.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={selectedProduct.imageUrl}
                            alt=""
                            className="h-full w-full object-cover object-center"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--foreground)]">
                          {selectedProduct.title ?? selectedProduct.sku}
                        </div>
                        <div className="truncate text-xs text-[var(--muted-foreground)]">
                          <span className="font-mono">
                            SKU: {selectedProduct.sku}
                          </span>
                          {selectedProduct.asin ? ` · ASIN: ${selectedProduct.asin}` : ""}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm font-medium">
                      {editingEntry ? "Edit cost entry" : "Add cost entry"}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  className="cursor-pointer rounded-md p-2 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
                  onClick={() => {
                    setShowForm(false);
                    setEditingEntry(null);
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="M6 6 18 18" />
                  </svg>
                </button>
              </div>

              <div className="max-h-[80vh] overflow-auto p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  {!selectedProduct ? (
                    <div className="md:col-span-3">
                      <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                        Product
                      </label>
                      <div className="mt-1 rounded-lg border border-[var(--surface-border)] bg-transparent p-3">
                        <input
                          value={productPickerQuery}
                          onChange={(e) => setProductPickerQuery(e.target.value)}
                          placeholder="Search SKU / ASIN / title…"
                          className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                        />
                        <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-[var(--surface-border)]">
                          {filteredProductsForPicker.length === 0 ? (
                            <div className="px-3 py-3 text-sm text-[var(--muted-foreground)]">
                              No products found.
                            </div>
                          ) : (
                            filteredProductsForPicker.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-[var(--foreground)]/5"
                                onClick={() => setForm((prev) => ({ ...prev, productId: p.id }))}
                              >
                                <div className="aspect-square h-8 w-8 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                                  {p.imageUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={p.imageUrl}
                                      alt=""
                                      className="h-full w-full object-cover object-center"
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                    />
                                  ) : null}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-[var(--foreground)]">
                                    {p.title ?? p.sku}
                                  </div>
                                  <div className="truncate text-xs text-[var(--muted-foreground)]">
                                    <span className="font-mono">SKU: {p.sku}</span>
                                    {p.asin ? ` · ASIN: ${p.asin}` : ""}
                                  </div>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Purchase date
                    </label>
                    <input
                      type="date"
                      value={form.purchaseDate}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, purchaseDate: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Fulfilment
                    </label>
                    <input
                      value={form.fulfilment}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, fulfilment: e.target.value }))
                      }
                      placeholder="Amazon / FBM / etc"
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Shipment ID
                    </label>
                    <input
                      value={form.shipmentId}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, shipmentId: e.target.value }))
                      }
                      placeholder="e.g. FBA15..."
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Bundle size
                    </label>
                    <input
                      inputMode="numeric"
                      value={form.bundleSize}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, bundleSize: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Qty purchased
                    </label>
                    <input
                      inputMode="numeric"
                      value={form.qtyPurchased}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, qtyPurchased: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Qty delivered
                    </label>
                    <input
                      inputMode="numeric"
                      value={form.qtyDelivered}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, qtyDelivered: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  {/* Unit, Delivery, Prep on one line - full width of modal */}
                  <div className="md:col-span-3 grid w-full grid-cols-3 gap-3 min-w-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          Unit
                        </label>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <div className="inline-flex overflow-hidden rounded-md ring-1 ring-[var(--surface-border)]">
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                unitVatMode === "inc"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setUnitVatMode("inc");
                                setUnitCostExVat("");
                              }}
                            >
                              Inc
                            </button>
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                unitVatMode === "ex"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setUnitVatMode("ex");
                                const inc = Number(form.unitCostIncVat ?? 0) || 0;
                                setUnitCostExVat(inc > 0 ? String(exFromInc(inc)) : "");
                              }}
                            >
                              Ex
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        inputMode="decimal"
                        value={vatSettings?.vatRegistrationType === "VAT_STANDARD" ? (unitVatMode === "inc" ? form.unitCostIncVat : unitCostExVat) : form.unitCostIncVat}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (vatSettings?.vatRegistrationType !== "VAT_STANDARD" || unitVatMode === "inc") {
                            setForm((prev) => ({ ...prev, unitCostIncVat: v }));
                            return;
                          }
                          setUnitCostExVat(v);
                          const ex = Number(v ?? 0) || 0;
                          setForm((prev) => ({ ...prev, unitCostIncVat: ex > 0 ? String(incFromEx(ex)) : "" }));
                        }}
                        placeholder={vatSettings?.vatRegistrationType === "VAT_STANDARD" && unitVatMode === "ex" ? "e.g. 10.28" : "e.g. 12.34"}
                        className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          Delivery
                        </label>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <div className="inline-flex overflow-hidden rounded-md ring-1 ring-[var(--surface-border)]">
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                deliveryVatMode === "inc"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setDeliveryVatMode("inc");
                                setDeliveryCostExVat("");
                              }}
                            >
                              Inc
                            </button>
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                deliveryVatMode === "ex"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setDeliveryVatMode("ex");
                                const inc = Number(form.deliveryCostIncVat ?? 0) || 0;
                                setDeliveryCostExVat(inc > 0 ? String(exFromInc(inc)) : "");
                              }}
                            >
                              Ex
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        inputMode="decimal"
                        value={
                          vatSettings?.vatRegistrationType === "VAT_STANDARD"
                            ? deliveryVatMode === "inc"
                              ? form.deliveryCostIncVat
                              : deliveryCostExVat
                            : form.deliveryCostIncVat
                        }
                        placeholder="0"
                        onChange={(e) => {
                          const v = e.target.value;
                          if (vatSettings?.vatRegistrationType !== "VAT_STANDARD" || deliveryVatMode === "inc") {
                            setForm((prev) => ({ ...prev, deliveryCostIncVat: v }));
                            return;
                          }
                          setDeliveryCostExVat(v);
                          const ex = Number(v ?? 0) || 0;
                          setForm((prev) => ({
                            ...prev,
                            deliveryCostIncVat: ex > 0 ? String(incFromEx(ex)) : "0",
                          }));
                        }}
                        className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          Prep
                        </label>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <div className="inline-flex overflow-hidden rounded-md ring-1 ring-[var(--surface-border)]">
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                prepVatMode === "inc"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setPrepVatMode("inc");
                                setPrepCostExVat("");
                              }}
                            >
                              Inc
                            </button>
                            <button
                              type="button"
                              className={[
                                "cursor-pointer px-1.5 py-0.5 text-[10px]",
                                prepVatMode === "ex"
                                  ? "bg-[var(--surface)] text-[var(--foreground)]"
                                  : "text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5",
                              ].join(" ")}
                              onClick={() => {
                                setPrepVatMode("ex");
                                const inc = Number(form.prepCostIncVat ?? 0) || 0;
                                setPrepCostExVat(inc > 0 ? String(exFromInc(inc)) : "");
                              }}
                            >
                              Ex
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        inputMode="decimal"
                        value={
                          vatSettings?.vatRegistrationType === "VAT_STANDARD"
                            ? prepVatMode === "inc"
                              ? form.prepCostIncVat
                              : prepCostExVat
                            : form.prepCostIncVat
                        }
                        placeholder="0"
                        onChange={(e) => {
                          const v = e.target.value;
                          if (vatSettings?.vatRegistrationType !== "VAT_STANDARD" || prepVatMode === "inc") {
                            setForm((prev) => ({ ...prev, prepCostIncVat: v }));
                            return;
                          }
                          setPrepCostExVat(v);
                          const ex = Number(v ?? 0) || 0;
                          setForm((prev) => ({ ...prev, prepCostIncVat: ex > 0 ? String(incFromEx(ex)) : "0" }));
                        }}
                        className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                      />
                    </div>
                  </div>

                  {/* VAT % below costs, aligned right */}
                  {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                    <div className="md:col-span-3 flex w-full justify-end">
                      <div className="flex items-baseline gap-2">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          VAT rate (%)
                        </label>
                        <input
                          inputMode="decimal"
                          value={form.vatRatePct}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, vatRatePct: e.target.value }))
                          }
                          className="w-16 rounded-lg border border-[var(--surface-border)] bg-transparent px-2 py-1 text-sm text-[var(--foreground)] outline-none text-right"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Currency
                    </label>
                    <select
                      value={form.currency}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, currency: e.target.value }))
                      }
                      className="mt-1 w-full cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    >
                      {currencyOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                      {form.currency && !isCurrencyOption(form.currency) ? (
                        <option value={form.currency}>{form.currency}</option>
                      ) : null}
                    </select>
                  </div>

                  <div className="md:col-span-3">
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Supplier
                    </label>
                    <input
                      value={form.supplier}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, supplier: e.target.value }))
                      }
                      placeholder="Optional"
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                      Supplier link
                    </label>
                    <input
                      value={form.supplierLink}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, supplierLink: e.target.value }))
                      }
                      placeholder="https://… (optional)"
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={editingEntry ? updateEntry : createEntry}
                    disabled={creating}
                    className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creating ? "Saving…" : editingEntry ? "Save changes" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {cogsFilter !== "missing" ? (
          <div className="overflow-hidden rounded-xl ring-1 ring-[var(--surface-border)]">
            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : filteredWithMissingToggle.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                <div>No entries found.</div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingEntry(null);
                      resetNewEntryForm();
                      setShowForm(true);
                    }}
                    className="cursor-pointer rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black"
                  >
                    Add entry
                  </button>
                  <button
                    type="button"
                    onClick={seedFromExisting}
                    disabled={seeding}
                    className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Create ledger entries from existing per-SKU COGS values"
                  >
                    {seeding ? "Importing…" : "Import existing COGS"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-[var(--surface-border)] bg-transparent">
                <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--surface)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
                  <span>
                    {pagingTotal > 0
                      ? `${pagingStart} - ${pagingEnd} of ${pagingTotal}`
                      : "0 - 0 of 0"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={prevPage}
                      disabled={cogsFilter !== "all" || !canPrev}
                      className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={nextPage}
                      disabled={cogsFilter !== "all" || !canNext}
                      className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Next
                    </button>
                  </div>
                </div>

              {/* Desktop header */}
              <div className="hidden md:grid grid-cols-[2.2fr_0.8fr_1fr_1.2fr_0.6fr_0.6fr_0.8fr_0.8fr_0.8fr_1fr] gap-3 bg-[var(--surface)] px-4 py-3 text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
                <div>Product</div>
                <div>Fulfilment</div>
                <div>Supplier</div>
                <div>Costs (per unit)</div>
                <div>Curr</div>
                <div>VAT</div>
                <div>Date</div>
                <div className="text-right">Purchased</div>
                <div className="text-right">Delivered</div>
                <div className="text-right">Shipment</div>
              </div>

              {filteredWithMissingToggle.map((p) => {
                const title = p.product?.title ?? p.product?.sku ?? "—";
                const sku = p.product?.sku ?? "—";
                const asin = p.product?.asin ?? "—";
                const date = p.purchaseDate
                  ? new Date(p.purchaseDate).toLocaleDateString()
                  : "—";

                const money = (n: number) => formatCurrency(n, p.currency);

                return (
                  <>
                    {/* Mobile card */}
                    <div
                      key={`${p.id}-m`}
                      className="cursor-pointer md:hidden px-4 py-3 hover:bg-[var(--foreground)]/5"
                      onClick={() => beginEdit(p)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex aspect-square h-11 w-11 shrink-0 items-center justify-center">
                          {p.product?.imageUrl ? (
                            <img
                              src={p.product.imageUrl}
                              alt={title}
                              className="h-full w-full rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="h-11 w-11 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-[var(--foreground)]">
                            {title}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                            SKU {sku} · ASIN {asin}
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                            <div className="text-[var(--muted-foreground)]">
                              Total{" "}
                              <span className="font-medium text-[var(--foreground)]">
                                {money(p.totalCostIncVat)}
                              </span>
                            </div>
                            <div className="text-[var(--muted-foreground)]">
                              Unit{" "}
                              <span className="font-medium text-[var(--foreground)]">
                                {money(p.unitCostIncVat)}
                              </span>
                            </div>
                            <div className="text-[var(--muted-foreground)]">
                              Delivery{" "}
                              <span className="font-medium text-[var(--foreground)]">
                                {money(p.deliveryCostIncVat)}
                              </span>
                            </div>
                            <div className="text-[var(--muted-foreground)]">
                              Prep{" "}
                              <span className="font-medium text-[var(--foreground)]">
                                {money(p.prepCostIncVat)}
                              </span>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
                            <span>
                              {p.fulfilment || "Amazon"} · VAT {p.vatRatePct}%
                            </span>
                            <span>{date}</span>
                            <span>
                              {p.qtyPurchased}/{p.qtyDelivered} units
                            </span>
                            {p.bundleSize && p.bundleSize > 1 ? (
                              <span>Bundle ×{p.bundleSize}</span>
                            ) : null}
                            {p.shipmentId ? <span>{p.shipmentId}</span> : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Desktop row */}
                    <div
                      key={`${p.id}-d`}
                      className="hidden cursor-pointer md:grid grid-cols-[2.2fr_0.8fr_1fr_1.2fr_0.6fr_0.6fr_0.8fr_0.8fr_0.8fr_1fr] items-center gap-3 px-4 py-3 hover:bg-[var(--foreground)]/5"
                      onClick={() => beginEdit(p)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-3">
                          <div className="flex aspect-square h-9 w-9 shrink-0 items-center justify-center">
                            {p.product?.imageUrl ? (
                              <img
                                src={p.product.imageUrl}
                                alt={title}
                                className="h-full w-full rounded-md object-cover ring-1 ring-[var(--surface-border)]"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="h-9 w-9 rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-[var(--foreground)]">
                              {title}
                            </div>
                            <div className="truncate text-xs text-[var(--muted-foreground)]">
                              SKU {sku} · ASIN {asin}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="truncate text-sm text-[var(--muted-foreground)]">
                        {p.fulfilment || "Amazon"}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--muted-foreground)]">
                          {p.supplier ?? "—"}
                        </div>
                        {p.supplierLink ? (
                          <a
                            href={p.supplierLink}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="mt-0.5 inline-block truncate text-xs text-[var(--muted-foreground)] underline underline-offset-2 hover:text-[var(--foreground)]"
                          >
                            {p.supplierLink}
                          </a>
                        ) : null}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        <div>
                          Total{" "}
                          <span className="font-medium text-[var(--foreground)]">
                            {money(p.totalCostIncVat)}
                          </span>
                        </div>
                        <div>
                          Unit {money(p.unitCostIncVat)} · Delivery{" "}
                          {money(p.deliveryCostIncVat)} · Prep{" "}
                          {money(p.prepCostIncVat)}
                        </div>
                      </div>
                      <div className="text-sm text-[var(--muted-foreground)]">
                        {p.currency}
                      </div>
                      <div className="text-sm text-[var(--muted-foreground)]">
                        {p.vatRatePct}%
                      </div>
                      <div className="text-sm text-[var(--muted-foreground)]">
                        {date}
                      </div>
                      <div className="text-right text-sm font-medium text-[var(--foreground)]">
                        {p.qtyPurchased}
                      </div>
                      <div className="text-right text-sm font-medium text-[var(--foreground)]">
                        {p.qtyDelivered}
                      </div>
                      <div className="text-right truncate text-sm text-[var(--muted-foreground)]">
                        {p.shipmentId ?? "—"}
                      </div>
                    </div>
                  </>
                );
              })}
              </div>
            )}
          </div>
        ) : null}
      </SignedIn>
    </div>
  );
}

export default function CostOfGoodsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <CostOfGoodsInner />
    </Suspense>
  );
}

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `£${amount.toFixed(2)}`;
  }
}

