"use client";

import { RedirectToSignIn, SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useDisplaySettings } from "@/contexts/display-settings-context";
import { useMarketplace } from "@/contexts/marketplace-context";
import { getDevImpersonationHeaders } from "@/lib/impersonation";
import { CogsBulkUpload } from "@/components/cogs-bulk-upload";

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

/** SKU row in the main grid (Missing / Complete / All). Complete tab may include latest ledger snapshot from API. */
type SkuCardItem = {
  id: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  revenue?: number;
  units?: number;
  latestCostEntry?: CostEntryRow | null;
  productFallbackUnitCost?: number | null;
};

/** Response item from cost-of-goods SKU list (complete/all); extends product row with optional metrics and ledger snapshot. */
type CogsSkuListApiItem = ProductRow & {
  revenue?: number;
  units?: number;
  latestCostEntry?: CostEntryRow | null;
  productFallbackUnitCost?: number | null;
};

function CostOfGoodsInner() {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId } = useMarketplace();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
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
      lineItems: number;
    }[]
  >([]);
  const [missingCount, setMissingCount] = useState<number | null>(null);

  const SKU_FETCH_SIZE = 500;
  const DISPLAY_PAGE_SIZE = 20;
  const [skuItems, setSkuItems] = useState<SkuCardItem[]>([]);
  const [skuTotal, setSkuTotal] = useState(0);
  const [skuPage, setSkuPage] = useState(1);

  type VatSettings = {
    vatRegistrationType: string;
    vatEffectiveDate: string | null;
    vatFlatRatePct: number | null;
    vatRatePct: number | null;
    vatCostsIncludeVat: boolean | null;
  };
  const [vatSettings, setVatSettings] = useState<VatSettings | null>(null);

  type FixedCosts = {
    softwareCosts: number | null;
    otherSubscriptions: number | null;
    otherFixedCosts: number | null;
  };
  const [fixedCosts, setFixedCosts] = useState<FixedCosts | null>(null);
  const [fixedCostsFormOpen, setFixedCostsFormOpen] = useState(false);
  const [fixedCostsSaving, setFixedCostsSaving] = useState(false);
  type FixedCostsPeriod = "monthly" | "annual";
  const [fixedCostsPeriod, setFixedCostsPeriod] = useState<{
    softwareCosts: FixedCostsPeriod;
    otherSubscriptions: FixedCostsPeriod;
    otherFixedCosts: FixedCostsPeriod;
  }>({ softwareCosts: "monthly", otherSubscriptions: "monthly", otherFixedCosts: "monthly" });
  const [fixedCostsForm, setFixedCostsForm] = useState({
    softwareCosts: "",
    otherSubscriptions: "",
    otherFixedCosts: "",
  });

  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CostEntryRow | null>(null);
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
    fulfilment: "FBA",
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
      fulfilment: "FBA",
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
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        ...getDevImpersonationHeaders(devImpersonate),
        ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
      };

      const missingQs = new URLSearchParams();
      if (startParam) missingQs.set("start", startParam);
      if (endParam) missingQs.set("end", endParam);
      missingQs.set("take", String(SKU_FETCH_SIZE));
      missingQs.set("skip", "0");

      const allFetches: Promise<Response>[] = [
        fetch(`${baseUrl}/api/amazon/cost-of-goods/entries?` +
          new URLSearchParams({ take: "50", skip: "0" }).toString(),
          { headers: authHeaders },
        ),
        fetch(`${baseUrl}/api/amazon/products`, { headers: authHeaders }),
        fetch(`${baseUrl}/api/amazon/inventory`, { headers: authHeaders }),
        fetch(`${baseUrl}/api/orgs/vat-settings`, { headers: authHeaders }),
      ];

      if (cogsFilter === "missing") {
        allFetches.push(
          fetch(`${baseUrl}/api/amazon/cost-of-goods/missing?${missingQs.toString()}`, {
            headers: authHeaders,
          }),
        );
      } else if (cogsFilter === "complete") {
        allFetches.push(
          fetch(
            `${baseUrl}/api/amazon/cost-of-goods/complete?` +
            new URLSearchParams({ take: String(SKU_FETCH_SIZE), skip: "0" }).toString(),
            { headers: authHeaders },
          ),
        );
      } else {
        allFetches.push(
          fetch(
            `${baseUrl}/api/amazon/cost-of-goods/products?` +
            new URLSearchParams({ take: String(SKU_FETCH_SIZE), skip: "0" }).toString(),
            { headers: authHeaders },
          ),
        );
      }

      const [entriesRes, productsRes, inventoryRes, vatRes, skuListRes] = await Promise.all(allFetches);

      if (!entriesRes.ok) throw new Error("Failed to load cost entries.");
      if (!productsRes.ok) throw new Error("Failed to load products.");
      if (!inventoryRes.ok) throw new Error("Failed to load inventory.");
      if (!skuListRes.ok) throw new Error("Failed to load SKU list.");
      if (vatRes.ok) {
        const vatData = (await vatRes.json()) as VatSettings;
        setVatSettings(vatData);
      }

      const entriesData = (await entriesRes.json()) as
        | CostEntryRow[]
        | { total?: number; items?: CostEntryRow[] };
      const productsData = (await productsRes.json()) as ProductRow[];
      const inventoryData = (await inventoryRes.json()) as Array<{
        productId: string;
        sku: string;
        asin: string | null;
        title: string | null;
        imageUrl: string | null;
      }>;

      if (Array.isArray(entriesData)) {
        setEntries(entriesData);
        setEntriesTotal(entriesData.length);
      } else {
        setEntries(Array.isArray(entriesData.items) ? entriesData.items : []);
        setEntriesTotal(Number(entriesData.total ?? 0));
      }

      const inventoryAsProducts: ProductRow[] = Array.isArray(inventoryData)
        ? inventoryData.map((r) => ({
            id: r.productId,
            sku: r.sku,
            asin: r.asin,
            title: r.title,
            imageUrl: r.imageUrl,
          }))
        : [];
      const byId = new Map<string, ProductRow>();
      for (const p of inventoryAsProducts) byId.set(p.id, p);
      for (const p of productsData) if (!byId.has(p.id)) byId.set(p.id, p);
      setProducts(Array.from(byId.values()));

      if (cogsFilter === "missing") {
        const missingData = (await skuListRes.json()) as {
          missingSkusCount?: number;
          items?: Array<{
            productId: string;
            sku: string;
            asin: string | null;
            title: string | null;
            imageUrl: string | null;
          }>;
        };
        const items = Array.isArray(missingData.items) ? missingData.items : [];
        setSkuItems(
          items.map((m) => ({
            id: m.productId,
            sku: m.sku,
            asin: m.asin,
            title: m.title,
            imageUrl: m.imageUrl,
          })),
        );
        setSkuTotal(typeof missingData.missingSkusCount === "number" ? missingData.missingSkusCount : 0);
        setMissingCount(typeof missingData.missingSkusCount === "number" ? missingData.missingSkusCount : null);
        setMissing(
          items.map((m) => ({
            productId: m.productId,
            sku: m.sku,
            asin: m.asin,
            title: m.title,
            imageUrl: m.imageUrl,
            lineItems: 0,
          })),
        );
      } else {
        const allData = (await skuListRes.json()) as {
          total: number;
          items: CogsSkuListApiItem[];
        };
        const raw = Array.isArray(allData.items) ? allData.items : [];
        setSkuItems(
          raw.map(
            (it): SkuCardItem => ({
              id: it.id,
              sku: it.sku,
              asin: it.asin,
              title: it.title,
              imageUrl: it.imageUrl,
              revenue:
                typeof it.revenue === "number" ? it.revenue : undefined,
              units: typeof it.units === "number" ? it.units : undefined,
              latestCostEntry: it.latestCostEntry ?? null,
              productFallbackUnitCost: it.productFallbackUnitCost,
            }),
          ),
        );
        setSkuTotal(typeof allData.total === "number" ? allData.total : 0);
      }
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

  // Client-side filter by SKU, ASIN, title (like inventory page) – instant search
  const filteredSkuItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skuItems;
    return skuItems.filter((p) => {
      const sku = (p.sku ?? "").toLowerCase();
      const asin = (p.asin ?? "").toLowerCase();
      const title = (p.title ?? "").toLowerCase();
      return sku.includes(q) || asin.includes(q) || title.includes(q);
    });
  }, [skuItems, query]);

  const totalSkuPages = Math.max(1, Math.ceil(filteredSkuItems.length / DISPLAY_PAGE_SIZE));
  const safeSkuPage = Math.min(skuPage, totalSkuPages);
  const paginatedSkuItems = useMemo(
    () =>
      filteredSkuItems.slice(
        (safeSkuPage - 1) * DISPLAY_PAGE_SIZE,
        safeSkuPage * DISPLAY_PAGE_SIZE,
      ),
    [filteredSkuItems, safeSkuPage],
  );

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
      fulfilment: editingEntry.fulfilment?.trim() || "FBA",
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
    if (editingEntry) return;
    if (vatSettings.vatRegistrationType === "VAT_STANDARD") {
      const pct = vatSettings.vatRatePct ?? 20;
      setForm((prev) => ({ ...prev, vatRatePct: String(pct) }));
      const incl = vatSettings.vatCostsIncludeVat !== false;
      setUnitVatMode(incl ? "inc" : "ex");
      setDeliveryVatMode(incl ? "inc" : "ex");
      setPrepVatMode(incl ? "inc" : "ex");
    }
  }, [
    showForm,
    editingEntry,
    vatSettings?.vatRegistrationType,
    vatSettings?.vatRatePct,
    vatSettings?.vatCostsIncludeVat,
  ]);

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
  }, [isSignedIn, getToken, baseUrl, startParam, endParam, cogsFilter, selectedMarketplaceId]);

  // Reset to first page when search query or tab changes (client-side filter)
  useEffect(() => {
    setSkuPage(1);
  }, [query, cogsFilter]);

  useEffect(() => {
    if (!isSignedIn) {
      setFixedCosts(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${baseUrl}/api/orgs/fixed-costs`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as FixedCosts;
        if (!cancelled) setFixedCosts(data);
      } catch {
        if (!cancelled) setFixedCosts(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isSignedIn, getToken, baseUrl]);

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

  const pagingTotal = filteredSkuItems.length;
  const pagingStart =
    filteredSkuItems.length > 0 ? (safeSkuPage - 1) * DISPLAY_PAGE_SIZE + 1 : 0;
  const pagingEnd =
    filteredSkuItems.length > 0
      ? Math.min(safeSkuPage * DISPLAY_PAGE_SIZE, filteredSkuItems.length)
      : 0;
  const canPrevSku = safeSkuPage > 1;
  const canNextSku = safeSkuPage < totalSkuPages;
  const prevSkuPage = () => setSkuPage((p) => Math.max(1, p - 1));
  const nextSkuPage = () => setSkuPage((p) => Math.min(totalSkuPages, p + 1));


  const createEntry = async () => {
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");

      const payload = {
        productId: form.productId,
        fulfilment: form.fulfilment.trim() || "FBA",
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
        fulfilment: form.fulfilment.trim() || "FBA",
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

  const bulkUploadCogsRows = async (rows: Record<string, unknown>[]) => {
    const token = await getToken({ template: "backend" });
    if (!token) throw new Error("Not authenticated.");
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      ...getDevImpersonationHeaders(devImpersonate),
      ...(selectedMarketplaceId ? { "x-marketplace-id": selectedMarketplaceId } : {}),
    };
    const res = await fetch(`${baseUrl}/api/amazon/cost-of-goods/bulk-upload`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rows }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || "Bulk upload failed.");
    }
    return (await res.json()) as {
      created: number;
      errors: Array<{ rowIndex: number; asin?: string; message: string }>;
    };
  };

  const saveFixedCosts = async () => {
    setFixedCostsSaving(true);
    setError(null);
    const toMonthly = (v: number, period: FixedCostsPeriod) => (period === "annual" ? v / 12 : v);
    const num = (s: string, period: FixedCostsPeriod) => {
      if (s.trim() === "") return undefined;
      const v = toMonthly(Number(s), period);
      return Number.isFinite(v) ? v : undefined;
    };
    try {
      const token = await getToken({ template: "backend" });
      if (!token) throw new Error("Not authenticated.");
      const res = await fetch(`${baseUrl}/api/orgs/fixed-costs`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          softwareCosts: num(fixedCostsForm.softwareCosts, fixedCostsPeriod.softwareCosts),
          otherSubscriptions: num(fixedCostsForm.otherSubscriptions, fixedCostsPeriod.otherSubscriptions),
          otherFixedCosts: num(fixedCostsForm.otherFixedCosts, fixedCostsPeriod.otherFixedCosts),
        }),
      });
      if (!res.ok) throw new Error("Failed to save fixed costs.");
      const data = (await res.json()) as FixedCosts;
      setFixedCosts(data);
      setFixedCostsFormOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save fixed costs.");
    } finally {
      setFixedCostsSaving(false);
    }
  };

  const openFixedCostsForm = () => {
    setFixedCostsForm({
      softwareCosts: fixedCosts?.softwareCosts != null ? String(fixedCosts.softwareCosts) : "",
      otherSubscriptions: fixedCosts?.otherSubscriptions != null ? String(fixedCosts.otherSubscriptions) : "",
      otherFixedCosts: fixedCosts?.otherFixedCosts != null ? String(fixedCosts.otherFixedCosts) : "",
    });
    setFixedCostsFormOpen(true);
  };

  const { backgroundClass } = useDisplaySettings();

  return (
    <div className={`min-h-screen w-full ${backgroundClass} px-4 py-6`}>
      <div className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--foreground)]">
              Cost of Goods
            </h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Log inbound cost entries per SKU (unit, delivery, prep, VAT). Profit uses the latest entry per SKU.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end sm:ml-auto">
            {!fixedCostsFormOpen ? (
              <>
                <button
                  type="button"
                  onClick={openFixedCostsForm}
                  className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black hover:opacity-90"
                >
                  Fixed monthly cost
                </button>
                <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                  Add ongoing fixed costs here
                </p>
              </>
            ) : null}
          </div>
        </div>
        {fixedCostsFormOpen && (
          <div className="mt-4 flex flex-col gap-2 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/50 p-3">
            <span className="text-sm font-medium text-[var(--foreground)]">Fixed monthly cost</span>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              Choose monthly or annual per line. Stored as monthly for reporting.
            </p>
            <div className="grid gap-3 sm:grid-cols-1">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--muted-foreground)]">Software costs</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={fixedCostsForm.softwareCosts}
                    onChange={(e) => setFixedCostsForm((f) => ({ ...f, softwareCosts: e.target.value }))}
                    className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                    placeholder="0"
                  />
                  <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--surface-border)]">
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, softwareCosts: "monthly" }))}
                      className={`cursor-pointer px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.softwareCosts === "monthly" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, softwareCosts: "annual" }))}
                      className={`cursor-pointer border-l border-[var(--surface-border)] px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.softwareCosts === "annual" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Annual
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--muted-foreground)]">Other subscriptions</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={fixedCostsForm.otherSubscriptions}
                    onChange={(e) => setFixedCostsForm((f) => ({ ...f, otherSubscriptions: e.target.value }))}
                    className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                    placeholder="0"
                  />
                  <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--surface-border)]">
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, otherSubscriptions: "monthly" }))}
                      className={`cursor-pointer px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.otherSubscriptions === "monthly" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, otherSubscriptions: "annual" }))}
                      className={`cursor-pointer border-l border-[var(--surface-border)] px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.otherSubscriptions === "annual" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Annual
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--muted-foreground)]">Other fixed costs</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={fixedCostsForm.otherFixedCosts}
                    onChange={(e) => setFixedCostsForm((f) => ({ ...f, otherFixedCosts: e.target.value }))}
                    className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                    placeholder="0"
                  />
                  <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--surface-border)]">
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, otherFixedCosts: "monthly" }))}
                      className={`cursor-pointer px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.otherFixedCosts === "monthly" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixedCostsPeriod((p) => ({ ...p, otherFixedCosts: "annual" }))}
                      className={`cursor-pointer border-l border-[var(--surface-border)] px-2 text-xs focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${fixedCostsPeriod.otherFixedCosts === "annual" ? "bg-sb-accent text-black" : "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"}`}
                    >
                      Annual
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveFixedCosts}
                disabled={fixedCostsSaving}
                className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
              >
                {fixedCostsSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setFixedCostsFormOpen(false)}
                className="cursor-pointer rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="mt-4 flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU / ASIN / title / shipment / supplier…"
            className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none sm:w-80"
          />
          <div className="flex flex-wrap items-center gap-2">
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
              className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black"
            >
              {showForm ? "Close" : "New COGS entry"}
            </button>
            <CogsBulkUpload
              onUpload={bulkUploadCogsRows}
              onFinished={async () => {
                setSkip(0);
                await load();
              }}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span className="sr-only">COGS filter</span>
            <div className="inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-[var(--surface-border)]">
              <button
                type="button"
                onClick={() => {
                  setCogsFilter("missing");
                  setSkuPage(1);
                }}
                className={[
                  "cursor-pointer h-8 px-3 text-xs",
                  cogsFilter === "missing"
                    ? "bg-sb-accent text-black"
                    : "bg-transparent text-[var(--foreground)]",
                ].join(" ")}
              >
                Missing
              </button>
              <button
                type="button"
                onClick={() => {
                  setCogsFilter("complete");
                  setSkuPage(1);
                }}
                className={[
                  "cursor-pointer h-8 px-3 text-xs border-l border-[var(--surface-border)]",
                  cogsFilter === "complete"
                    ? "bg-sb-accent text-black"
                    : "bg-transparent text-[var(--foreground)]",
                ].join(" ")}
              >
                Complete
              </button>
              <button
                type="button"
                onClick={() => {
                  setCogsFilter("all");
                  setSkuPage(1);
                }}
                className={[
                  "cursor-pointer h-8 px-3 text-xs border-l border-[var(--surface-border)]",
                  cogsFilter === "all"
                    ? "bg-sb-accent text-black"
                    : "bg-transparent text-[var(--foreground)]",
                ].join(" ")}
              >
                All
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted-foreground)]">
            <span>
              {pagingTotal > 0
                ? `${pagingStart} - ${pagingEnd} of ${pagingTotal}`
                : "0 - 0 of 0"}
            </span>
            <span className="text-[var(--muted-foreground)]">{DISPLAY_PAGE_SIZE} per page</span>
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
                      {editingEntry ? "View / edit cost entry" : "Add cost entry"}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                    Fulfilment
                  </span>
                  <span className="rounded bg-[var(--background)] px-2.5 py-1 text-xs font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--surface-border)]">
                    FBA
                  </span>
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

                  <div className="md:col-span-3 grid grid-cols-2 gap-x-8 gap-y-0 min-w-0">
                    <div className="min-w-0 flex flex-col">
                      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                        Purchase date
                      </div>
                      <div className="text-[10px] normal-case font-normal text-[var(--muted-foreground)] mt-0.5">
                        (optional input)
                      </div>
                      <input
                        type="date"
                        value={form.purchaseDate}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, purchaseDate: e.target.value }))
                        }
                        className="mt-1.5 w-full max-w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none box-border"
                      />
                    </div>
                    <div className="min-w-0 flex flex-col">
                      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                        Qty purchased
                      </div>
                      <div className="text-[10px] normal-case font-normal text-[var(--muted-foreground)] mt-0.5">
                        (optional input)
                      </div>
                      <input
                        inputMode="numeric"
                        value={form.qtyPurchased}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, qtyPurchased: e.target.value }))
                        }
                        className="mt-1.5 w-full max-w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)] outline-none box-border"
                      />
                    </div>
                  </div>

                  {/* Unit, Delivery, Prep on one line - full width of modal */}
                  <div className="md:col-span-3 grid w-full grid-cols-3 gap-3 min-w-0 mt-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          Unit cost
                        </label>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">VAT</span>
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
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center rounded-lg border border-[var(--surface-border)] bg-transparent overflow-hidden">
                        <span className="pl-2.5 text-sm text-[var(--muted-foreground)]">£</span>
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
                          className="w-full min-w-0 border-0 bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="flex items-center gap-1">
                          <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                            Delivery
                          </label>
                          <span
                            className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-[var(--muted-foreground)]/20 text-[10px] font-medium text-[var(--muted-foreground)]"
                            title="Delivery cost of shipping unit(s) to myself/FC"
                          >
                            i
                          </span>
                        </span>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">VAT</span>
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
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center rounded-lg border border-[var(--surface-border)] bg-transparent overflow-hidden">
                        <span className="pl-2.5 text-sm text-[var(--muted-foreground)]">£</span>
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
                          className="w-full min-w-0 border-0 bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <label className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          Prep
                        </label>
                        {vatSettings?.vatRegistrationType === "VAT_STANDARD" && (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">VAT</span>
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
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center rounded-lg border border-[var(--surface-border)] bg-transparent overflow-hidden">
                        <span className="pl-2.5 text-sm text-[var(--muted-foreground)]">£</span>
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
                          className="w-full min-w-0 border-0 bg-transparent px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
                        />
                      </div>
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
                    className="cursor-pointer rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creating ? "Saving…" : editingEntry ? "Save changes" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
            {loading ? (
              <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                Loading…
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--surface)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
                  <span>
                    {pagingTotal > 0
                      ? `${pagingStart} - ${pagingEnd} of ${pagingTotal}`
                      : "0 - 0 of 0"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={prevSkuPage}
                      disabled={!canPrevSku}
                      className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={nextSkuPage}
                      disabled={!canNextSku}
                      className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Next
                    </button>
                  </div>
                </div>

                {paginatedSkuItems.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-[var(--muted-foreground)]">
                    {query.trim() ? (
                      <div>No SKUs match &quot;{query.trim()}&quot;. Try a different search or clear the search.</div>
                    ) : cogsFilter === "missing" ? (
                      <>
                        <div>No SKUs missing COGS in this period.</div>
                        <p className="mt-2 text-xs">
                          Switch to &quot;All&quot; to see all inventory SKUs, or run inventory sync if you have no SKUs yet.
                        </p>
                      </>
                    ) : (
                      <div>No inventory SKUs yet. Run inventory sync on the Inventory page, then refresh.</div>
                    )}
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingEntry(null);
                          resetNewEntryForm();
                          setShowForm(true);
                        }}
                        className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black"
                      >
                        New COGS entry
                      </button>
                    </div>
                    {cogsFilter === "missing" ? (
                      <button
                        type="button"
                        onClick={seedFromExisting}
                        disabled={seeding}
                        className="ml-2 cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-60"
                        title="Create ledger entries from existing per-SKU COGS values"
                      >
                        {seeding ? "Importing…" : "Import existing COGS"}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-3 p-4 sm:grid-cols-2">
                    {paginatedSkuItems.map((p) => {
                      const entry = p.latestCostEntry;
                      const showCompleteCogs =
                        cogsFilter === "complete" && entry != null;
                      const showFallbackOnly =
                        cogsFilter === "complete" &&
                        entry == null &&
                        p.productFallbackUnitCost != null &&
                        p.productFallbackUnitCost > 0;

                      return (
                        <div
                          key={p.id}
                          className="flex items-start gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-3"
                        >
                          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                            {p.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={p.imageUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-[var(--foreground)]">
                              {p.title ?? "—"}
                            </div>
                            <div className="mt-0.5 font-mono text-xs text-[var(--muted-foreground)]">
                              {p.sku}
                              {p.asin ? ` · ${p.asin}` : ""}
                            </div>
                            {cogsFilter !== "missing" &&
                            p.revenue != null &&
                            p.units != null ? (
                              <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                                {p.units} units · £{p.revenue.toFixed(2)} revenue
                              </div>
                            ) : null}

                            {showCompleteCogs ? (
                              <div className="mt-2 space-y-1">
                                <div className="text-sm text-[var(--foreground)]">
                                  <span className="text-[var(--muted-foreground)]">
                                    Unit (inc VAT):{" "}
                                  </span>
                                  {formatCurrency(
                                    entry.unitCostIncVat,
                                    entry.currency,
                                  )}
                                </div>
                                <div className="text-xs text-[var(--muted-foreground)]">
                                  {new Date(
                                    entry.purchaseDate,
                                  ).toLocaleDateString("en-GB", {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                  })}
                                  {(entry.deliveryCostIncVat > 0 ||
                                    entry.prepCostIncVat > 0) && (
                                    <>
                                      {" · "}
                                      Line total inc VAT:{" "}
                                      {formatCurrency(
                                        entry.totalCostIncVat,
                                        entry.currency,
                                      )}
                                    </>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="mt-1 cursor-pointer rounded-lg bg-sb-accent px-3 py-1.5 text-xs font-medium text-black"
                                  onClick={() => beginEdit(entry)}
                                >
                                  View / edit COGS
                                </button>
                              </div>
                            ) : showFallbackOnly ? (
                              <div className="mt-2 space-y-1">
                                <div className="text-sm text-[var(--foreground)]">
                                  <span className="text-[var(--muted-foreground)]">
                                    Unit COGS (SKU):{" "}
                                  </span>
                                  {formatCurrency(
                                    p.productFallbackUnitCost!,
                                    "GBP",
                                  )}
                                </div>
                                <p className="text-xs text-[var(--muted-foreground)]">
                                  No ledger row yet — add one for delivery, prep,
                                  and history.
                                </p>
                                <button
                                  type="button"
                                  className="mt-1 cursor-pointer rounded-lg bg-sb-accent px-3 py-1.5 text-xs font-medium text-black"
                                  onClick={() => {
                                    setEditingEntry(null);
                                    setShowForm(true);
                                    resetNewEntryForm(p.id);
                                  }}
                                >
                                  Add ledger entry
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="mt-2 cursor-pointer rounded-lg bg-sb-accent px-3 py-1.5 text-xs font-medium text-black"
                                onClick={() => {
                                  setEditingEntry(null);
                                  setShowForm(true);
                                  resetNewEntryForm(p.id);
                                }}
                              >
                                {cogsFilter === "complete"
                                  ? "Add COGS entry"
                                  : "Add entry"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
      </SignedIn>
    </div>
  );
}

export default function CostOfGoodsPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">
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

