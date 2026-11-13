"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { sellerAmpSasLookupUrl } from "@/lib/selleramp";
import { coerceQty, sanitizeQtyDraft } from "@/lib/qty-input";
import { getDevImpersonationHeaders } from "@/lib/impersonation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function defaultAlertLocalDatetime(daysAhead = 3): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ListingCandidate = {
  asin: string;
  sku: string;
  title: string;
  score: number;
  imageUrl?: string | null;
};

type ExtractLine = {
  productTitle?: string;
  asin?: string;
  sku?: string;
  /** Catalog / listing image — used when creating a missing product stub. */
  imageUrl?: string | null;
  /** Number or digit draft/"" while editing — do not coerce on every keystroke. */
  qty: number | string;
  unitRrpIncVat?: number;
  unitCostIncVat?: number;
  lineTotalIncVat?: number;
  deliveryCostIncVat?: number;
  prepCostIncVat?: number;
  listingCandidates?: ListingCandidate[];
};

type ExtractDraft = {
  supplier: string;
  orderNumber: string;
  purchaseDate: string;
  currency: string;
  vatRatePct: number;
  fulfilment: string;
  shipDestination?: "HOME" | "PREP CENTER";
  supplierLink?: string;
  /** Free-text note → purchase sheet Notes. */
  notes?: string;
  /** When true, also write notes onto Blue30 Inbound (prep only). */
  copyNotesToPrepInbound?: boolean;
  promo?: { type: "none" | "buy_3_get_1_free" };
  lines: ExtractLine[];
  warnings: string[];
};

type VisionQuota = {
  used: number;
  limit: number;
  remaining: number;
};

type ExtractResponse = {
  draft: ExtractDraft;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    approxCostUsd?: number;
  };
  quota?: VisionQuota;
};

type IngestResult = {
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
    skipped?: number;
    errors?: string[];
    error?: string;
    tabTitle?: string;
  };
  prepInbound?: {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    appended?: number;
    skippedDuplicate?: number;
    errors?: string[];
    tabTitle?: string;
    shareWithEmail?: string;
  };
  blue30Copy?: {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    appended?: number;
    skippedDuplicate?: number;
    errors?: string[];
    tabTitle?: string;
  };
};

type ListingHit = {
  asin: string;
  sku: string;
  title: string;
  imageUrl?: string | null;
  costOfGoods?: number | null;
};

type CatalogAsinHit = {
  source: "portfolio" | "catalog";
  asin: string;
  sku: string | null;
  title: string | null;
  imageUrl?: string | null;
  costOfGoods?: number | null;
};

type Props = {
  onExtract: (body: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }) => Promise<ExtractResponse>;
  onConfirm: (payload: Record<string, unknown>) => Promise<IngestResult>;
  onFinished: () => void;
  /** Optional: load UTC-day AI quota for the banner. */
  onLoadQuota?: () => Promise<VisionQuota>;
  /** Optional: search org listings by ASIN/SKU/title (no OpenAI). */
  onSearchListings?: (query: string) => Promise<ListingHit[]>;
  /** Optional: ASIN → portfolio or Amazon Catalog (for products not yet listed). */
  onLookupAsin?: (asin: string) => Promise<CatalogAsinHit>;
  /** "page" = always-visible panel. Default "button" opens a modal. */
  variant?: "button" | "page";
  /** Label for the collapsed trigger (button variant only). */
  triggerLabel?: string;
};

function isValidAsinShape(raw: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(raw.trim());
}

const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.7;

async function compressImageFile(
  file: File,
): Promise<{ base64: string; mimeType: string; previewUrl: string }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read image"));
      el.src = objectUrl;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    return { base64, mimeType: "image/jpeg", previewUrl: dataUrl };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function emptyLine(seed?: Partial<ExtractLine>): ExtractLine {
  return {
    qty: 1,
    productTitle: "",
    asin: "",
    unitCostIncVat: undefined,
    ...seed,
  };
}

function blankDraft(): ExtractDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    supplier: "",
    orderNumber: "",
    purchaseDate: today,
    currency: "GBP",
    vatRatePct: 0,
    fulfilment: "FBA",
    shipDestination: undefined,
    notes: "",
    copyNotesToPrepInbound: false,
    promo: { type: "none" },
    // Blank qty so manual entry can type 4 without fighting sticky 1.
    lines: [emptyLine({ qty: "" })],
    warnings: [
      "Search your listings, or paste an ASIN and Search Amazon if it is not listed yet — then fill qty, unit cost, supplier, and order number.",
    ],
  };
}

function ListingSearchField({
  onSearch,
  onLookupAsin,
  onPick,
}: {
  onSearch: (query: string) => Promise<ListingHit[]>;
  onLookupAsin?: (asin: string) => Promise<CatalogAsinHit>;
  onPick: (hit: ListingHit & { imageUrl?: string | null }) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ListingHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [catalogHit, setCatalogHit] = useState<CatalogAsinHit | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asinReady = isValidAsinShape(q);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = q.trim();
    setCatalogHit(null);
    if (trimmed.length < 2) {
      setHits([]);
      setBusy(false);
      setErr(null);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const rows = await onSearch(trimmed);
          setHits(rows);
          setErr(null);
        } catch (e) {
          setHits([]);
          setErr(e instanceof Error ? e.message : "Search failed");
        } finally {
          setBusy(false);
        }
      })();
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, onSearch]);

  const runCatalogLookup = async () => {
    if (!onLookupAsin || !asinReady) return;
    const asin = q.trim().toUpperCase();
    setCatalogBusy(true);
    setErr(null);
    setCatalogHit(null);
    try {
      const hit = await onLookupAsin(asin);
      if (hit.source === "portfolio") {
        onPick({
          asin: hit.asin,
          sku: hit.sku ?? "",
          title: (hit.title ?? "").trim() || hit.asin,
          imageUrl: hit.imageUrl ?? null,
          costOfGoods: hit.costOfGoods ?? null,
        });
        setQ("");
        setHits([]);
        setCatalogHit(null);
        return;
      }
      setCatalogHit(hit);
    } catch (e) {
      setCatalogHit(null);
      setErr(e instanceof Error ? e.message : "ASIN lookup failed");
    } finally {
      setCatalogBusy(false);
    }
  };

  return (
    <div className="sm:col-span-2">
      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
        Search your listings (ASIN / SKU / title)
        <div className="flex flex-wrap items-stretch gap-1.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                onLookupAsin &&
                asinReady &&
                hits.length === 0
              ) {
                e.preventDefault();
                void runCatalogLookup();
              }
            }}
            placeholder="e.g. B0… or Otamatone"
            className="min-w-0 flex-1 rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
          />
          {onLookupAsin ? (
            <button
              type="button"
              disabled={!asinReady || catalogBusy}
              onClick={() => void runCatalogLookup()}
              className="shrink-0 rounded border border-[var(--surface-border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                asinReady
                  ? "Look up this ASIN on Amazon if it is not in your listings"
                  : "Enter a 10-character ASIN to search Amazon catalog"
              }
            >
              {catalogBusy ? "Searching…" : "Search ASIN"}
            </button>
          ) : null}
        </div>
      </label>
      {onLookupAsin ? (
        <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
          Not in your listings yet? Paste the ASIN and click Search ASIN.
        </p>
      ) : null}
      {busy ? (
        <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
          Searching listings…
        </p>
      ) : null}
      {err ? <p className="mt-1 text-[11px] text-red-500">{err}</p> : null}
      {hits.length > 0 ? (
        <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-1.5">
          {hits.map((h) => (
            <li key={`${h.asin}-${h.sku}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  setQ("");
                  setHits([]);
                  setCatalogHit(null);
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
              >
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                  {h.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={h.imageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[9px] text-[var(--muted-foreground)]">
                      No img
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sb-accent">{h.asin}</div>
                  <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                    {h.sku} · {h.title}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {catalogHit && catalogHit.source === "catalog" ? (
        <div className="mt-1.5 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-1.5">
          <p className="mb-1 px-1 text-[11px] font-medium text-[var(--muted-foreground)]">
            Amazon catalog — not in your listings yet
          </p>
          <button
            type="button"
            onClick={() => {
              onPick({
                asin: catalogHit.asin,
                sku: "",
                title: (catalogHit.title ?? "").trim() || catalogHit.asin,
                imageUrl: catalogHit.imageUrl ?? null,
                costOfGoods: null,
              });
              setQ("");
              setHits([]);
              setCatalogHit(null);
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
          >
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
              {catalogHit.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={catalogHit.imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[9px] text-[var(--muted-foreground)]">
                  No img
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sb-accent">{catalogHit.asin}</div>
              <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                {(catalogHit.title ?? "").trim() || "Untitled catalog item"}
              </div>
            </div>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CogsScreenshotIngest({
  onExtract,
  onConfirm,
  onFinished,
  onLoadQuota,
  onSearchListings,
  onLookupAsin,
  variant = "button",
  triggerLabel = "From screenshot",
}: Props) {
  const { getToken } = useAuth();
  const isPage = variant === "page";
  const [open, setOpen] = useState(isPage);
  const [busy, setBusy] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  // Manual entry first; tick “Search with AI” only when needed.
  const [useAiSearch, setUseAiSearch] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExtractDraft | null>(
    isPage ? blankDraft() : null,
  );
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [lastCostUsd, setLastCostUsd] = useState<number | null>(null);
  const [quota, setQuota] = useState<VisionQuota | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [hint, setHint] = useState("");
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertAtLocal, setAlertAtLocal] = useState(defaultAlertLocalDatetime);
  const [alertNote, setAlertNote] = useState("Cancel membership / free trial");
  const [alertUrl, setAlertUrl] = useState("");
  const [alertStatus, setAlertStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!onLoadQuota || !useAiSearch) return;
    let cancelled = false;
    void (async () => {
      try {
        const q = await onLoadQuota();
        if (!cancelled) setQuota(q);
      } catch {
        // Non-fatal — extract still works; banner just stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onLoadQuota, useAiSearch]);

  const reset = useCallback(() => {
    setPreviewUrl(null);
    setDraft(isPage ? blankDraft() : null);
    setModelUsed(null);
    setLastCostUsd(null);
    setLocalError(null);
    setResult(null);
    setHint("");
    setAlertEnabled(false);
    setAlertAtLocal(defaultAlertLocalDatetime());
    setAlertNote("Cancel membership / free trial");
    setAlertUrl("");
    setAlertStatus(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [isPage]);

  const startManualEntry = useCallback(() => {
    setUseAiSearch(false);
    setModelUsed(null);
    setLastCostUsd(null);
    setResult(null);
    setDraft(blankDraft());
  }, []);

  const handleFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!useAiSearch) {
        setLocalError(
          "Turn on “Search with AI” to analyse a screenshot, or fill the form and search your listings.",
        );
        return;
      }
      if (!file.type.startsWith("image/")) {
        setLocalError("Please drop a screenshot image (PNG/JPEG/WebP).");
        return;
      }
      if (quota && quota.remaining <= 0) {
        setLocalError(
          `Daily screenshot AI limit reached (${quota.limit}/day). Search your listings instead, or try again tomorrow.`,
        );
        setDraft(blankDraft());
        return;
      }
      setExtractBusy(true);
      setLocalError(null);
      setResult(null);
      setDraft(null);
      setLastCostUsd(null);
      try {
        const compressed = await compressImageFile(file);
        setPreviewUrl(compressed.previewUrl);
        const res = await onExtract({
          imageBase64: compressed.base64,
          mimeType: compressed.mimeType,
          hint: hint.trim() || undefined,
        });
        setDraft({
          ...res.draft,
          notes: res.draft.notes ?? "",
          copyNotesToPrepInbound: res.draft.copyNotesToPrepInbound ?? false,
          lines:
            res.draft.lines.length > 0
              ? res.draft.lines
              : [emptyLine()],
        });
        setModelUsed(res.model);
        if (res.usage?.approxCostUsd != null) {
          setLastCostUsd(res.usage.approxCostUsd);
        }
        if (res.quota) setQuota(res.quota);
      } catch (e) {
        setLocalError(
          e instanceof Error ? e.message : "Could not analyse screenshot.",
        );
        // Keep the preview; let the user fall back to manual fields.
        setDraft(blankDraft());
        setModelUsed(null);
        if (onLoadQuota) {
          try {
            setQuota(await onLoadQuota());
          } catch {
            /* ignore */
          }
        }
      } finally {
        setExtractBusy(false);
      }
    },
    [hint, onExtract, onLoadQuota, quota, useAiSearch],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files?.[0];
      if (f) void handleFile(f);
    },
    [handleFile],
  );

  const updateLine = (idx: number, patch: Partial<ExtractLine>) => {
    setDraft((d) => {
      if (!d) return d;
      const lines = d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      return { ...d, lines };
    });
  };

  const submit = async () => {
    if (!draft) return;
    setLocalError(null);
    setResult(null);
    if (!draft.supplier.trim() || !draft.orderNumber.trim()) {
      setLocalError("Supplier and order number are required.");
      return;
    }
    if (!draft.shipDestination) {
      setLocalError("Pick Home/Prep (HOME or PREP CENTER) before submit.");
      return;
    }
    for (const line of draft.lines) {
      if (!(line.asin?.trim() || line.sku?.trim())) {
        setLocalError("Each line needs an ASIN or SKU before submit.");
        return;
      }
      const cost = Number(line.unitCostIncVat ?? 0);
      const rrp = Number(line.unitRrpIncVat ?? 0);
      if (!(cost > 0 || rrp > 0)) {
        setLocalError("Each line needs a unit cost (or RRP with promo).");
        return;
      }
    }
    setBusy(true);
    try {
      const payload = {
        supplier: draft.supplier.trim(),
        orderNumber: draft.orderNumber.trim(),
        purchaseDate: draft.purchaseDate,
        currency: draft.currency || "GBP",
        vatRatePct: draft.vatRatePct || 0,
        fulfilment: draft.fulfilment || "FBA",
        shipDestination: draft.shipDestination,
        supplierLink: draft.supplierLink?.trim() || undefined,
        notes: draft.notes?.trim() || undefined,
        copyNotesToPrepInbound:
          draft.shipDestination === "PREP CENTER" &&
          draft.copyNotesToPrepInbound === true,
        promo: draft.promo?.type
          ? { type: draft.promo.type }
          : { type: "none" as const },
        createProductIfMissing: true,
        lines: draft.lines.map((l) => ({
          asin: l.asin?.trim() || undefined,
          sku: l.sku?.trim() || undefined,
          productTitle: l.productTitle?.trim() || undefined,
          imageUrl: l.imageUrl?.trim() || undefined,
          qty: coerceQty(l.qty, 1),
          unitCostIncVat:
            l.unitCostIncVat != null && Number(l.unitCostIncVat) > 0
              ? Number(l.unitCostIncVat)
              : undefined,
          unitRrpIncVat:
            l.unitRrpIncVat != null && Number(l.unitRrpIncVat) > 0
              ? Number(l.unitRrpIncVat)
              : undefined,
          deliveryCostIncVat: Number(l.deliveryCostIncVat ?? 0) || undefined,
          prepCostIncVat: Number(l.prepCostIncVat ?? 0) || undefined,
        })),
      };
      const r = await onConfirm(payload);
      setResult(r);
      const sheetFailed =
        r.sheet != null &&
        (r.sheet.ok === false ||
          (Array.isArray(r.sheet.errors) && r.sheet.errors.length > 0) ||
          Boolean(r.sheet.error));
      const sheetAppended = Number(r.sheet?.appended ?? 0);
      const prep = r.prepInbound;
      const prepFailed =
        draft.shipDestination === "PREP CENTER" &&
        prep != null &&
        prep.skipped !== true &&
        (prep.ok === false ||
          (Array.isArray(prep.errors) && prep.errors.length > 0));
      const prepAppended = Number(prep?.appended ?? 0);

      if (sheetFailed || prepFailed) {
        const parts: string[] = [];
        if (sheetFailed) {
          parts.push(
            `Purchase sheet: ${
              r.sheet?.error ||
              r.sheet?.errors?.filter(Boolean).join("; ") ||
              "write failed"
            }`,
          );
        }
        if (prepFailed) {
          parts.push(
            `Blue30 Inbound: ${
              prep?.errors?.filter(Boolean).join("; ") || "write failed"
            }`,
          );
        }
        setLocalError(
          `COGS ledger updated, but sheet write had issues — ${parts.join(" · ")}`,
        );
      } else if (
        r.ledger.created > 0 &&
        r.sheet &&
        sheetAppended === 0 &&
        Number(r.sheet.skippedDuplicate ?? r.sheet.skipped ?? 0) === 0
      ) {
        setLocalError(
          "COGS ledger updated, but no new row was added to the purchase sheet (missing ASIN or unit cost?).",
        );
      } else if (
        draft.shipDestination === "PREP CENTER" &&
        prep &&
        prep.skipped !== true &&
        prep.ok === true &&
        prepAppended === 0 &&
        Number(prep.skippedDuplicate ?? 0) === 0 &&
        r.ledger.created > 0
      ) {
        setLocalError(
          "COGS + purchase sheet updated, but no new Blue30 Inbound row was added (missing ASIN?).",
        );
      }
      if (alertEnabled) {
        try {
          const token = await getToken({ template: "backend" });
          if (!token) throw new Error("Not signed in for push alert");
          const fireAt = new Date(alertAtLocal);
          if (Number.isNaN(fireAt.getTime())) {
            throw new Error("Invalid alert date/time");
          }
          const note = alertNote.trim() || "Reminder";
          const link = alertUrl.trim() || draft.supplierLink?.trim() || "";
          const alertRes = await fetch(`${API_BASE}/api/push/alerts`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              ...getDevImpersonationHeaders(),
            },
            body: JSON.stringify({
              fireAt: fireAt.toISOString(),
              title: draft.supplier.trim()
                ? `${draft.supplier.trim()} reminder`
                : "Purchase reminder",
              body: note,
              ...(link ? { url: link } : {}),
            }),
          });
          const alertJson = await alertRes.json().catch(() => ({}));
          if (!alertRes.ok) {
            const msg =
              (alertJson as { message?: string | string[] })?.message ??
              `Alert failed (${alertRes.status})`;
            throw new Error(Array.isArray(msg) ? msg.join(", ") : String(msg));
          }
          setAlertStatus(
            `Push alert set for ${fireAt.toLocaleString()} — tap opens the link (enable alerts in Settings if you haven’t).`,
          );
        } catch (alertErr) {
          setAlertStatus(
            alertErr instanceof Error
              ? `Purchase saved, but alert failed: ${alertErr.message}`
              : "Purchase saved, but alert failed.",
          );
        }
      }

      if (r.ledger.created > 0 || r.ledger.skipped > 0) {
        await onFinished();
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy || extractBusy) return;
    reset();
    if (!isPage) setOpen(false);
  };

  const panel = (
          <div
            className={
              isPage
                ? "w-full rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-3 sm:p-4"
                : "max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-xl"
            }
          >
            {!isPage ? (
            <div className="mb-4 flex items-start justify-between gap-2">
              <div>
                <h2
                  id="cogs-screenshot-title"
                  className="text-lg font-semibold text-[var(--foreground)]"
                >
                  Log a purchase
                </h2>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Fill supplier, order, qty and cost — or tick Search with AI
                  to read a screenshot. Updates COGS and your purchase sheets.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
              >
                ✕
              </button>
            </div>
            ) : (
              <h2 id="cogs-screenshot-title" className="sr-only">
                Log purchase
              </h2>
            )}

            <label className="mb-3 flex cursor-pointer items-start gap-2 text-sm text-[var(--foreground)]">
              <input
                type="checkbox"
                checked={useAiSearch}
                onChange={(e) => {
                  const on = e.target.checked;
                  setUseAiSearch(on);
                  if (!on) {
                    setPreviewUrl(null);
                    setModelUsed(null);
                    setLastCostUsd(null);
                    if (!draft) setDraft(blankDraft());
                  }
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Search with AI</span>
                <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                  Uses OpenAI to read a screenshot. Leave unticked to search your
                  listings for free.
                </span>
              </span>
            </label>

            {useAiSearch && quota ? (
              <p className="mb-3 text-xs text-[var(--muted-foreground)]">
                AI extracts today:{" "}
                <span className="font-medium text-[var(--foreground)]">
                  {quota.used}/{quota.limit}
                </span>
                {quota.remaining === 0
                  ? " — limit reached; search listings instead."
                  : ` · ${quota.remaining} left`}
                {lastCostUsd != null
                  ? ` · last call ~$${lastCostUsd.toFixed(3)}`
                  : null}
              </p>
            ) : null}

            {useAiSearch && !isPage ? (
            <label className="mb-3 block text-xs text-[var(--muted-foreground)]">
              Optional hint
              <input
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="e.g. Thomann 10x Otamatone / Healf confirmation"
                className="mt-1 w-full rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
              />
            </label>
            ) : null}

            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />

            {useAiSearch ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={onDrop}
              className={
                isPage
                  ? "mb-3 rounded-xl border-2 border-dashed border-[var(--surface-border)] bg-[var(--surface)] px-4 py-10 text-center text-sm text-[var(--muted-foreground)] sm:py-12"
                  : "mb-4 rounded-lg border-2 border-dashed border-[var(--surface-border)] bg-[var(--background)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]"
              }
            >
              {extractBusy ? (
                "Analysing screenshot…"
              ) : previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt="Screenshot preview"
                  className="mx-auto max-h-48 rounded object-contain"
                />
              ) : (
                <>
                  <p className="font-medium text-[var(--foreground)]">
                    Drop order confirmation screenshot
                  </p>
                  <p className="mt-1 text-xs">
                    or{" "}
                    <button
                      type="button"
                      className="font-medium text-sb-accent underline"
                      onClick={() => inputRef.current?.click()}
                    >
                      browse
                    </button>
                    {" "}· PNG / JPEG / WebP
                  </p>
                </>
              )}
            </div>
            ) : (
              <p className="mb-3 text-xs text-[var(--muted-foreground)]">
                Search a listing below, fill supplier / order / qty / cost, then
                confirm. No OpenAI call.
              </p>
            )}

            {useAiSearch && isPage ? (
              <label className="mb-3 block text-xs text-[var(--muted-foreground)]">
                Optional hint
                <input
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="e.g. iHerb PURA D'OR / Thomann 10x Otamatone"
                  className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                />
              </label>
            ) : null}

            <div className="mb-4 flex flex-wrap items-center gap-3">
              {useAiSearch && previewUrl ? (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-xs text-sb-accent underline"
                  disabled={extractBusy || busy}
                >
                  Choose a different image
                </button>
              ) : null}
              {!draft ? (
                <button
                  type="button"
                  onClick={startManualEntry}
                  className="text-xs text-sb-accent underline"
                  disabled={extractBusy || busy}
                >
                  Enter manually (no AI)
                </button>
              ) : null}
            </div>

            {modelUsed ? (
              <p className="mb-2 text-[11px] text-[var(--muted-foreground)]">
                Extracted with {modelUsed} (OpenAI API — not Cursor)
              </p>
            ) : draft && !modelUsed ? (
              <p className="mb-2 text-[11px] text-[var(--muted-foreground)]">
                Manual entry — AI extract skipped or unavailable
              </p>
            ) : null}

            {localError ? (
              <p className="mb-3 text-sm text-red-500">{localError}</p>
            ) : null}

            {draft ? (
              <div className="space-y-3">
                {draft.warnings.length > 0 ? (
                  <ul className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--foreground)]">
                    {draft.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["supplier", "Supplier"],
                      ["orderNumber", "Order number"],
                      ["purchaseDate", "Purchase date"],
                      ["currency", "Currency"],
                    ] as const
                  ).map(([key, label]) => {
                    const dateMissing =
                      key === "purchaseDate" &&
                      draft.warnings.some((w) =>
                        /purchase date not found/i.test(w),
                      );
                    return (
                      <label
                        key={key}
                        className={`flex flex-col gap-0.5 text-xs ${
                          dateMissing
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-[var(--muted-foreground)]"
                        }`}
                      >
                        {label}
                        {dateMissing ? " (check this)" : ""}
                        <input
                          type={key === "purchaseDate" ? "date" : "text"}
                          value={draft[key] ?? ""}
                          onChange={(e) =>
                            setDraft((d) =>
                              d ? { ...d, [key]: e.target.value } : d,
                            )
                          }
                          className={`rounded border bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] ${
                            dateMissing
                              ? "border-amber-500 ring-1 ring-amber-500/40"
                              : "border-[var(--surface-border)]"
                          }`}
                        />
                      </label>
                    );
                  })}
                </div>

                <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                  Promo
                  <select
                    value={draft.promo?.type ?? "none"}
                    onChange={(e) =>
                      setDraft((d) =>
                        d
                          ? {
                              ...d,
                              promo: {
                                type: e.target.value as
                                  | "none"
                                  | "buy_3_get_1_free",
                              },
                            }
                          : d,
                      )
                    }
                    className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                  >
                    <option value="none">None</option>
                    <option value="buy_3_get_1_free">4-for-3 / B3G1</option>
                  </select>
                </label>

                <label
                  className={`flex flex-col gap-0.5 text-xs ${
                    draft.warnings.some((w) => /ship-to not clear|home\/prep/i.test(w))
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-[var(--muted-foreground)]"
                  }`}
                >
                  Home / Prep
                  <select
                    value={draft.shipDestination ?? ""}
                    onChange={(e) =>
                      setDraft((d) =>
                        d
                          ? {
                              ...d,
                              shipDestination: (e.target.value ||
                                undefined) as
                                | "HOME"
                                | "PREP CENTER"
                                | undefined,
                            }
                          : d,
                      )
                    }
                    className={`rounded border bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] ${
                      draft.warnings.some((w) =>
                        /ship-to not clear|home\/prep/i.test(w),
                      )
                        ? "border-amber-500 ring-1 ring-amber-500/40"
                        : "border-[var(--surface-border)]"
                    }`}
                  >
                    <option value="">Select…</option>
                    <option value="HOME">HOME</option>
                    <option value="PREP CENTER">PREP CENTER</option>
                  </select>
                </label>

                <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                  Notes
                  <textarea
                    value={draft.notes ?? ""}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, notes: e.target.value } : d,
                      )
                    }
                    rows={2}
                    placeholder="Optional — goes on the purchase sheet Notes column"
                    className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                  />
                </label>

                {draft.shipDestination === "PREP CENTER" ? (
                  <label className="flex items-start gap-2 text-xs text-[var(--muted-foreground)]">
                    <input
                      type="checkbox"
                      checked={draft.copyNotesToPrepInbound === true}
                      onChange={(e) =>
                        setDraft((d) =>
                          d
                            ? { ...d, copyNotesToPrepInbound: e.target.checked }
                            : d,
                        )
                      }
                      className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--surface-border)]"
                    />
                    <span>
                      Also copy notes to Blue30 prep (Inbound Notes column)
                    </span>
                  </label>
                ) : null}

                <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3">
                  <label className="flex items-start gap-2 text-xs font-medium text-[var(--foreground)]">
                    <input
                      type="checkbox"
                      checked={alertEnabled}
                      onChange={(e) => setAlertEnabled(e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--surface-border)]"
                    />
                    <span>Add alert (phone push)</span>
                  </label>
                  {alertEnabled ? (
                    <div className="mt-2 grid gap-2">
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        When
                        <input
                          type="datetime-local"
                          value={alertAtLocal}
                          onChange={(e) => setAlertAtLocal(e.target.value)}
                          className="rounded border border-[var(--surface-border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        Note (shown on the push)
                        <input
                          type="text"
                          value={alertNote}
                          onChange={(e) => setAlertNote(e.target.value)}
                          placeholder="Cancel membership / free trial"
                          className="rounded border border-[var(--surface-border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        Open this link when tapped
                        <input
                          type="url"
                          value={alertUrl}
                          onChange={(e) => setAlertUrl(e.target.value)}
                          placeholder="https://… account / cancel page"
                          className="rounded border border-[var(--surface-border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                        />
                      </label>
                      <p className="text-[10px] text-[var(--muted-foreground)]">
                        Needs push enabled (Settings → Notifications). Defaults to
                        ~3 days at 9:00.
                      </p>
                    </div>
                  ) : null}
                  {alertStatus ? (
                    <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
                      {alertStatus}
                    </p>
                  ) : null}
                </div>

                {draft.lines.map((line, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-[var(--surface-border)] p-3"
                  >
                    <p className="mb-2 text-xs font-medium text-[var(--foreground)]">
                      Line {idx + 1}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {onSearchListings ? (
                        <ListingSearchField
                          onSearch={onSearchListings}
                          onLookupAsin={onLookupAsin}
                          onPick={(hit) =>
                            updateLine(idx, {
                              asin: hit.asin,
                              sku: hit.sku,
                              productTitle: hit.title,
                              imageUrl: hit.imageUrl ?? null,
                              unitCostIncVat:
                                hit.costOfGoods != null &&
                                Number(hit.costOfGoods) > 0
                                  ? Number(hit.costOfGoods)
                                  : undefined,
                            })
                          }
                        />
                      ) : null}
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)] sm:col-span-2">
                        Product title
                        <input
                          value={line.productTitle ?? ""}
                          onChange={(e) =>
                            updateLine(idx, { productTitle: e.target.value })
                          }
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                        <a
                          href={sellerAmpSasLookupUrl(
                            (line.asin || line.productTitle || "").trim() ||
                              " ",
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`rounded-lg border border-[var(--surface-border)] px-2.5 py-1.5 text-xs font-semibold no-underline ${
                            (line.asin || line.productTitle || "").trim()
                              ? "text-sb-accent hover:bg-[var(--foreground)]/5"
                              : "pointer-events-none opacity-40 text-[var(--muted-foreground)]"
                          }`}
                          title="Open title/ASIN in SellerAmp SAS"
                        >
                          Open in SAS
                        </a>
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          Searches SellerAmp with ASIN if set, otherwise title
                        </span>
                      </div>
                      {(line.listingCandidates?.length ?? 0) > 0 ? (
                        <div className="sm:col-span-2 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-2 py-2">
                          <p className="mb-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">
                            Listing matches — tap to select
                          </p>
                          <ul className="space-y-1.5">
                            {line.listingCandidates!.map((c) => {
                              const selected =
                                (line.asin ?? "").toUpperCase() ===
                                c.asin.toUpperCase();
                              return (
                                <li key={c.asin}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateLine(idx, {
                                        asin: c.asin,
                                        sku: c.sku,
                                        productTitle: c.title,
                                      })
                                    }
                                    className={[
                                      "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--foreground)]/5",
                                      selected
                                        ? "bg-sb-accent/15 ring-1 ring-sb-accent/50"
                                        : "",
                                    ].join(" ")}
                                  >
                                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                                      {c.imageUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={c.imageUrl}
                                          alt=""
                                          className="h-full w-full object-cover"
                                          loading="lazy"
                                          referrerPolicy="no-referrer"
                                        />
                                      ) : (
                                        <div className="flex h-full w-full items-center justify-center text-[9px] text-[var(--muted-foreground)]">
                                          No img
                                        </div>
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-x-1">
                                        <span className="font-medium text-sb-accent">
                                          {c.asin}
                                        </span>
                                        <span className="text-[var(--muted-foreground)]">
                                          ·
                                        </span>
                                        <span className="truncate text-[var(--muted-foreground)]">
                                          {c.sku}
                                        </span>
                                      </div>
                                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-[var(--muted-foreground)]">
                                        {c.title}
                                      </span>
                                    </div>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        ASIN *
                        <input
                          value={line.asin ?? ""}
                          onChange={(e) =>
                            updateLine(idx, {
                              asin: e.target.value.toUpperCase(),
                            })
                          }
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        SKU (optional)
                        <input
                          value={line.sku ?? ""}
                          onChange={(e) =>
                            updateLine(idx, { sku: e.target.value })
                          }
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        Qty
                        <input
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="e.g. 4"
                          value={
                            line.qty === "" || line.qty == null
                              ? ""
                              : String(line.qty)
                          }
                          onChange={(e) => {
                            updateLine(idx, {
                              qty: sanitizeQtyDraft(e.target.value),
                            });
                          }}
                          onBlur={() => {
                            const settled = coerceQty(line.qty, 1);
                            if (String(line.qty) !== String(settled)) {
                              updateLine(idx, { qty: settled });
                            }
                          }}
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        Unit cost (inc VAT)
                        <input
                          type="number"
                          step="0.01"
                          value={line.unitCostIncVat ?? ""}
                          onChange={(e) =>
                            updateLine(idx, {
                              unitCostIncVat:
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                            })
                          }
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]">
                        RRP (inc VAT)
                        <input
                          type="number"
                          step="0.01"
                          value={line.unitRrpIncVat ?? ""}
                          onChange={(e) =>
                            updateLine(idx, {
                              unitRrpIncVat:
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                            })
                          }
                          className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                        />
                      </label>
                    </div>
                  </div>
                ))}

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={busy || extractBusy}
                    className="cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
                  >
                    {busy ? "Writing…" : "Confirm → save COGS"}
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy || extractBusy}
                    className="cursor-pointer rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm font-medium text-[var(--foreground)]"
                  >
                    {isPage ? "Clear" : "Cancel"}
                  </button>
                </div>
              </div>
            ) : null}

            {result ? (
              <div className="mt-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)]">
                <p>
                  SellerBunker COGS: ledger created {result.ledger.created},
                  skipped {result.ledger.skipped}
                  {typeof result.ledger.sellerBunkerCogsUpdated === "number"
                    ? `, listings updated ${result.ledger.sellerBunkerCogsUpdated}`
                    : result.ledger.created > 0
                      ? " — unit cost updated on matching listings"
                      : ""}
                  {result.ledger.errors.length
                    ? `, errors ${result.ledger.errors.length}`
                    : ""}
                </p>
                {result.ledger.errors.map((e) => (
                  <p key={`${e.lineIndex}-${e.message}`} className="text-red-500">
                    Line {e.lineIndex}
                    {e.asin ? ` (${e.asin})` : ""}: {e.message}
                  </p>
                ))}
                {result.sheet ? (
                  <p className="mt-1">
                    Purchase sheet
                    {result.sheet.tabTitle
                      ? ` (${result.sheet.tabTitle})`
                      : ""}
                    : appended {result.sheet.appended ?? 0}, skipped duplicates{" "}
                    {result.sheet.skippedDuplicate ??
                      result.sheet.skipped ??
                      0}
                    {result.sheet.ok === false ? " — failed" : ""}
                  </p>
                ) : null}
                {(result.sheet?.errors ?? [])
                  .filter(Boolean)
                  .map((msg) => (
                    <p key={msg} className="text-red-500">
                      Purchase sheet: {msg}
                    </p>
                  ))}
                {result.sheet?.error ? (
                  <p className="text-red-500">
                    Purchase sheet: {result.sheet.error}
                  </p>
                ) : null}
                {result.prepInbound ? (
                  <p className="mt-1">
                    Blue30 Inbound
                    {result.prepInbound.tabTitle
                      ? ` (${result.prepInbound.tabTitle})`
                      : ""}
                    :{" "}
                    {result.prepInbound.skipped
                      ? result.prepInbound.reason || "skipped"
                      : `appended ${result.prepInbound.appended ?? 0}, skipped duplicates ${result.prepInbound.skippedDuplicate ?? 0}`}
                    {result.prepInbound.ok === false ? " — failed" : ""}
                  </p>
                ) : null}
                {(result.prepInbound?.errors ?? [])
                  .filter(Boolean)
                  .map((msg) => (
                    <p key={`prep-${msg}`} className="text-red-500">
                      Blue30 Inbound: {msg}
                    </p>
                  ))}
                {result.blue30Copy ? (
                  <p className="mt-1">
                    BLUE30 COPY SHEET
                    {result.blue30Copy.tabTitle
                      ? ` (${result.blue30Copy.tabTitle})`
                      : ""}
                    :{" "}
                    {result.blue30Copy.skipped
                      ? result.blue30Copy.reason || "skipped"
                      : `appended ${result.blue30Copy.appended ?? 0}, skipped duplicates ${result.blue30Copy.skippedDuplicate ?? 0}`}
                    {result.blue30Copy.ok === false ? " — failed" : ""}
                  </p>
                ) : null}
                {(result.blue30Copy?.errors ?? [])
                  .filter(Boolean)
                  .map((msg) => (
                    <p key={`copy-${msg}`} className="text-red-500">
                      BLUE30 COPY SHEET: {msg}
                    </p>
                  ))}
              </div>
            ) : null}
          </div>
  );

  return (
    <>
      {!isPage ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            reset();
            startManualEntry();
          }}
          title="Log a purchase manually or from a screenshot"
          className="min-h-10 w-full cursor-pointer rounded-lg bg-sb-accent px-3 py-2 text-sm font-semibold text-black hover:opacity-90 sm:w-auto"
        >
          {triggerLabel}
        </button>
      ) : null}

      {isPage || open ? (
        isPage ? (
          <div role="region" aria-labelledby="cogs-screenshot-title">
            {panel}
          </div>
        ) : (
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cogs-screenshot-title"
          >
            {panel}
          </div>
        )
      ) : null}
    </>
  );
}
