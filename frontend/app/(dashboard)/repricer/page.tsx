"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMarketplace } from "@/contexts/marketplace-context";

type CandidateSku = {
  productId: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  totalQty: number;
  /** Fulfillable / sellable quantity when synced from Amazon */
  availableQty?: number;
  activeUnits30d: number;
  currentListedPrice: number | null;
  currentListedPriceUpdatedAt: string | null;
  costOfGoods?: number | null;
  estimatedAmazonFeePerUnit?: number | null;
};

type SelectedSku = {
  productId: string;
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  ruleSetId?: string | null;
  ruleSetName?: string | null;
};

type RuleForm = {
  label: string;
  /** buy_box = featured buy box price; best_offer = lowest competitive offer from pricing API */
  priceReference: "buy_box" | "best_offer";
  minProfit: string;
  /** Optional listing-currency floor (combined with profit/ROI bounds). */
  minListPrice: string;
  /** Optional listing-currency ceiling. */
  maxListPrice: string;
  maxProfit: string;
  minRoiPct: string;
  maxRoiPct: string;
  durationDays: string;
  strategy: string;
  beatType: string;
  beatValue: string;
  ignoreAmazon: boolean;
  ignoreFbm: boolean;
  ignoreSellerViewsEnabled: boolean;
  ignoreSellerViewsBelow: string;
  ignoreSellerIds: string;
  minSellerFeedbackPct: string;
  cooldownMinutes: string;
  smartDelayEnabled: boolean;
};

type RulePresetApi = {
  id: string;
  name: string;
  isActive: boolean;
  chainAfterDays: number | null;
  followUpRuleSetId: string | null;
  rule1: Record<string, unknown>;
  rule2: Record<string, unknown>;
  assignedSkuCount?: number;
};

const CANDIDATE_PAGE_SIZE = 25;

/** `??` does not treat "" as missing — empty env breaks fetch URLs (hits Next, not Nest). */
function publicApiBaseUrl(): string {
  const t =
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_API_URL
      : undefined) ?? "";
  const s = String(t).trim();
  return s || "http://localhost:3001";
}

/**
 * What people actually read in the log table. Raw API strings stay in `title` on hover.
 */
function displayRepricerLogMessage(raw: string): string {
  const t = raw.trim();

  if (t === "Leaving price unchanged." || t.startsWith("No change:")) {
    return "No change — your price still fits the rules.";
  }
  if (
    t.startsWith("Skipped: no buy box on listing; leaving price unchanged.")
  ) {
    return "No buy box on the listing — price left as is.";
  }
  if (t.startsWith("Skipped: missing COGS")) {
    return "Skipped — add cost of goods to use profit/ROI rules.";
  }
  if (t.startsWith("Skipped: bounds invalid")) {
    return "Skipped — min and max price bounds conflict.";
  }
  if (t.startsWith("Skipped: missing current listed price")) {
    return "Skipped — no listing price on file for this SKU.";
  }
  if (t.startsWith("Skipped: no pricing rule assigned")) {
    return "Skipped — pick a rule preset and apply it to this SKU.";
  }

  const amazon =
    /^Amazon listing price updated (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?) \(([^)]+)\)\.?$/.exec(
      t,
    );
  if (amazon) {
    return `Amazon listing updated: ${amazon[1]} → ${amazon[2]}.`;
  }

  const dry =
    /^DRY-RUN: would update price from (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?) \(([^)]+)\)\.?$/.exec(
      t,
    );
  if (dry) {
    return `Dry run — would move price to ${dry[2]} (currently ${dry[1]}).`;
  }

  if (
    t.startsWith("LIVE: missing Amazon credentials") ||
    t.startsWith("LIVE: missing Amazon")
  ) {
    return "Could not update Amazon — credentials or seller ID missing.";
  }
  if (t.startsWith("LIVE: Amazon price update failed:")) {
    const rest = t.replace(/^LIVE: Amazon price update failed:\s*/i, "").trim();
    const short = rest.length > 100 ? `${rest.slice(0, 100)}…` : rest;
    return `Amazon price update failed: ${short}`;
  }

  if (
    t.includes("change happened outside this repricer") ||
    t.includes("Listing price in app is")
  ) {
    return "Price changed outside this repricer (sync, manual edit, or another tool).";
  }

  return t;
}

function repricerEventLabel(log: {
  kind: string;
  message: string;
  context?: unknown;
}): string {
  const ctx = log.context && typeof log.context === "object" ? (log.context as any) : null;
  const msg = String(log.message ?? "").trim();

  if (msg.startsWith("Skipped: missing COGS")) return "Missing COGS";
  if (msg.startsWith("Skipped: missing current listed price")) return "Missing price";
  if (msg.startsWith("Skipped: bounds invalid")) return "Bad bounds";
  if (msg.startsWith("Skipped: no buy box")) return "No buy box";
  if (msg.startsWith("Skipped: no pricing rule assigned")) return "No rule";
  if (msg.startsWith("LIVE: Amazon price update failed")) return "Amazon update failed";
  if (msg.startsWith("LIVE: missing Amazon credentials")) return "Missing Amazon creds";

  const strat = typeof ctx?.strategy === "string" ? ctx.strategy.trim() : "";
  const refLabel = ctx?.priceReference === "best_offer" ? "lowest offer" : "buy box";
  const refPrice =
    typeof ctx?.refPrice === "number" && Number.isFinite(ctx.refPrice) ? Number(ctx.refPrice) : null;
  const minP =
    typeof ctx?.bounds?.minPrice === "number" && Number.isFinite(ctx.bounds.minPrice)
      ? Number(ctx.bounds.minPrice)
      : null;
  const maxP =
    typeof ctx?.bounds?.maxPrice === "number" && Number.isFinite(ctx.bounds.maxPrice)
      ? Number(ctx.bounds.maxPrice)
      : null;

  const prettyStrat =
    strat === "match_buy_box"
      ? `Match ${refLabel}`
      : strat === "beat_buy_box"
        ? `Beat ${refLabel}`
        : strat === "stay_above_buy_box"
          ? `Stay above ${refLabel}`
          : strat === "no_buy_box"
            ? "Bounds only"
            : strat
              ? strat
              : "Bounds only";

  const bits: string[] = [prettyStrat];
  if (refPrice != null) bits.push(`ref ${refPrice.toFixed(2)}`);
  if (minP != null || maxP != null) {
    const b = `${minP != null ? minP.toFixed(2) : "—"}–${maxP != null ? maxP.toFixed(2) : "—"}`;
    bits.push(`bounds ${b}`);
  }

  if (log.kind === "error") return bits.join(" · ");
  return bits.join(" · ");
}

function logRowImpliesFlatPriceForDisplay(raw: string): boolean {
  const d = displayRepricerLogMessage(raw);
  return (
    d.startsWith("No change") ||
    d.startsWith("No buy box") ||
    raw.includes("Leaving price unchanged") ||
    raw.startsWith("No change:") ||
    raw.includes("Skipped: no buy box on listing")
  );
}

/** Rows the repricer writes every tick when nothing meaningful happened — hide from the activity feed. */
function isRepricerLogNoise(message: string, kind: string): boolean {
  if (kind === "error") return false;
  const m = message.trim();
  if (
    m === "Leaving price unchanged." ||
    m.startsWith("Leaving price unchanged")
  )
    return true;
  if (m.startsWith("No change:")) return true;
  if (m.startsWith("Skipped: no buy box on listing; leaving price unchanged"))
    return true;
  return false;
}

function localeForListingCurrency(currency: string): string {
  switch (currency) {
    case "GBP":
      return "en-GB";
    case "EUR":
      return "de-DE";
    case "CAD":
      return "en-CA";
    case "AUD":
      return "en-AU";
    case "USD":
    default:
      return "en-US";
  }
}

function clampNum(v: unknown): number | null {
  const n = v === "" || v == null ? null : Number(v);
  if (n == null) return null;
  return Number.isFinite(n) ? n : null;
}

function defaultRule(partial?: Partial<RuleForm>): RuleForm {
  return {
    label: "",
    priceReference: "buy_box",
    minProfit: "",
    minListPrice: "",
    maxListPrice: "",
    maxProfit: "",
    minRoiPct: "",
    maxRoiPct: "",
    durationDays: "7",
    strategy: "",
    beatType: "amount",
    beatValue: "0.10",
    ignoreAmazon: true,
    ignoreFbm: false,
    ignoreSellerViewsEnabled: false,
    ignoreSellerViewsBelow: "",
    ignoreSellerIds: "",
    minSellerFeedbackPct: "",
    cooldownMinutes: "20",
    smartDelayEnabled: true,
    ...partial,
  };
}

function durationDaysFromEndsAt(endsAt: string | null | undefined): string {
  if (!endsAt) return "7";
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return "7";
  const d = Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000));
  return String(Math.max(1, d));
}

function mapApiRuleToForm(
  r: Record<string, unknown> | undefined,
  fallbackStrategy: string,
): RuleForm {
  if (!r || typeof r !== "object")
    return defaultRule({ strategy: fallbackStrategy });
  const rawStrat = typeof r.strategy === "string" ? r.strategy.trim() : "";
  return defaultRule({
    label: typeof r.label === "string" ? r.label : "",
    priceReference:
      typeof r.priceReference === "string" &&
      r.priceReference.trim().toLowerCase() === "best_offer"
        ? "best_offer"
        : "buy_box",
    minProfit: r.minProfit != null ? String(r.minProfit) : "",
    minListPrice: r.minListPrice != null ? String(r.minListPrice) : "",
    maxListPrice: r.maxListPrice != null ? String(r.maxListPrice) : "",
    maxProfit: r.maxProfit != null ? String(r.maxProfit) : "",
    minRoiPct: r.minRoiPct != null ? String(r.minRoiPct) : "",
    maxRoiPct: r.maxRoiPct != null ? String(r.maxRoiPct) : "",
    durationDays: durationDaysFromEndsAt(r.endsAt as string | null),
    strategy: rawStrat || fallbackStrategy,
    beatType:
      typeof r.beatType === "string" && r.beatType ? r.beatType : "amount",
    beatValue: r.beatValue != null ? String(r.beatValue) : "0.10",
    ignoreAmazon: r.ignoreAmazon !== undefined ? Boolean(r.ignoreAmazon) : true,
    ignoreFbm: Boolean(r.ignoreFbm),
    ignoreSellerViewsEnabled: Boolean(r.ignoreSellerViewsEnabled),
    ignoreSellerViewsBelow:
      r.ignoreSellerViewsBelow != null ? String(r.ignoreSellerViewsBelow) : "",
    ignoreSellerIds: Array.isArray(r.ignoreSellerIds)
      ? r.ignoreSellerIds.join(", ")
      : "",
    minSellerFeedbackPct:
      r.minSellerFeedbackPct != null ? String(r.minSellerFeedbackPct) : "",
    cooldownMinutes:
      r.cooldownMinutes != null ? String(r.cooldownMinutes) : "20",
    smartDelayEnabled:
      r.smartDelayEnabled !== undefined ? Boolean(r.smartDelayEnabled) : true,
  });
}

function ruleFormToPayload(r: RuleForm, durationDays: string) {
  const toEndsAt = (d: string) => {
    const days = clampNum(d);
    if (days == null || days <= 0) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  };
  return {
    label: r.label.trim() || undefined,
    priceReference:
      r.priceReference === "best_offer" ? "best_offer" : "buy_box",
    minProfit: clampNum(r.minProfit),
    minListPrice: clampNum(r.minListPrice),
    maxListPrice: clampNum(r.maxListPrice),
    maxProfit: clampNum(r.maxProfit),
    minRoiPct: clampNum(r.minRoiPct),
    maxRoiPct: clampNum(r.maxRoiPct),
    endsAt: toEndsAt(durationDays),
    strategy: r.strategy,
    beatType: r.beatType,
    beatValue: clampNum(r.beatValue),
    ignoreAmazon: Boolean(r.ignoreAmazon),
    ignoreFbm: Boolean(r.ignoreFbm),
    ignoreSellerViewsEnabled: Boolean(r.ignoreSellerViewsEnabled),
    ignoreSellerViewsBelow: r.ignoreSellerViewsEnabled
      ? clampNum(r.ignoreSellerViewsBelow)
      : null,
    ignoreSellerIds: r.ignoreSellerIds
      ? r.ignoreSellerIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    minSellerFeedbackPct: clampNum(r.minSellerFeedbackPct),
    cooldownMinutes: clampNum(r.cooldownMinutes),
    smartDelayEnabled: Boolean(r.smartDelayEnabled),
  };
}

export default function RepricerPage() {
  const baseUrl = publicApiBaseUrl();
  const { isSignedIn, getToken } = useAuth();
  const { selectedMarketplaceId, selectedCurrency } = useMarketplace();

  const [pw, setPw] = useState<string>("");
  const [pwOk, setPwOk] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateSku[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidatePage, setCandidatePage] = useState(1);
  // Checkbox selection (UI-only); does NOT persist and should clear after Apply/Remove.
  const [selected, setSelected] = useState<Array<{ productId: string }>>([]);
  // Assigned rules for SKUs (from backend /selected); used to show "Pricing rule: X" on rows.
  const [assignments, setAssignments] = useState<SelectedSku[]>([]);
  const [query, setQuery] = useState("");

  const [ruleLibrary, setRuleLibrary] = useState<{
    presets: RulePresetApi[];
    activePresetId: string | null;
  }>({ presets: [], activePresetId: null });

  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [ruleTab, setRuleTab] = useState<0 | 1>(0);
  const [showSecondRule, setShowSecondRule] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [presetName, setPresetName] = useState("My pricing preset");
  const [applyPresetToRepricer, setApplyPresetToRepricer] = useState(true);
  const [chainAfterDays, setChainAfterDays] = useState("");
  const [followUpRuleSetId, setFollowUpRuleSetId] = useState("");

  const [rule1, setRule1] = useState<RuleForm>(() =>
    defaultRule({ strategy: "match_buy_box" }),
  );
  const [rule2, setRule2] = useState<RuleForm>(() =>
    defaultRule({ strategy: "beat_buy_box" }),
  );

  const [logs, setLogs] = useState<
    Array<{
      id: string;
      sku: string;
      asin?: string | null;
      context?: unknown;
      kind: string;
      message: string;
      prevPrice: number | null;
      nextPrice: number | null;
      createdAt: string;
      lastCheckedAt?: string | null;
    }>
  >([]);
  const [repricerLastEngineAt, setRepricerLastEngineAt] = useState<
    string | null
  >(null);
  const [logsLoadErr, setLogsLoadErr] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  /** Listing updates, dry runs, actionable skips, errors — not idle "no change" ticks. */
  const visibleLogs = useMemo(
    () => logs.filter((l) => !isRepricerLogNoise(l.message, l.kind)),
    [logs],
  );
  /** Last-clicked SKU row — use "Apply" on a saved rule to assign it to that preset. */
  const [pinnedProductId, setPinnedProductId] = useState<string | null>(null);
  const [assigningPresetId, setAssigningPresetId] = useState<string | null>(
    null,
  );

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: "backend" });
    const repricerPw =
      pw ||
      (typeof window !== "undefined"
        ? (sessionStorage.getItem("sellerbunker_repricer_pw") ?? "")
        : "");
    return {
      Authorization: `Bearer ${token}`,
      "x-repricer-password": repricerPw,
      ...(selectedMarketplaceId
        ? { "x-marketplace-id": selectedMarketplaceId }
        : {}),
    } as Record<string, string>;
  }, [getToken, pw, selectedMarketplaceId]);

  const ping = useCallback(async () => {
    const headers = await authHeaders();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/repricer/ping`, { headers });
    } catch {
      throw new Error(
        "Could not reach the API. Is the backend running, and does NEXT_PUBLIC_API_URL match it? (After a CORS change, restart the backend.)",
      );
    }
    if (!res.ok) throw new Error("Invalid repricer password");
    return true;
  }, [authHeaders, baseUrl]);

  const loadRuleLibrary = useCallback(async () => {
    if (!isSignedIn || !pwOk) return;
    try {
      const headers = await authHeaders();
      const res = await fetch(`${baseUrl}/api/repricer/rules`, { headers });
      if (!res.ok) {
        setRuleLibrary({ presets: [], activePresetId: null });
        return;
      }
      const data = (await res.json()) as {
        presets?: RulePresetApi[];
        activePresetId?: string | null;
      };
      setRuleLibrary({
        presets: Array.isArray(data.presets) ? data.presets : [],
        activePresetId: data.activePresetId ?? null,
      });
    } catch {
      setRuleLibrary({ presets: [], activePresetId: null });
    }
  }, [isSignedIn, pwOk, authHeaders, baseUrl]);

  const load = useCallback(async () => {
    if (!isSignedIn) return;
    setLoading(true);
    setErr(null);
    try {
      const headers = await authHeaders();
      const params = new URLSearchParams({
        page: String(candidatePage),
        pageSize: String(CANDIDATE_PAGE_SIZE),
      });
      const q = query.trim();
      if (q) params.set("q", q);
      const [candRes, selRes] = await Promise.all([
        fetch(`${baseUrl}/api/repricer/candidates?${params.toString()}`, {
          headers,
        }),
        fetch(`${baseUrl}/api/repricer/selected`, { headers }),
      ]);
      if (!candRes.ok || !selRes.ok) {
        throw new Error("Could not load repricer data");
      }
      const candJson = (await candRes.json()) as
        | CandidateSku[]
        | { items?: CandidateSku[]; total?: number };
      const sel = (await selRes.json()) as SelectedSku[];
      if (Array.isArray(candJson)) {
        setCandidates(candJson);
        setCandidateTotal(candJson.length);
      } else {
        setCandidates(Array.isArray(candJson.items) ? candJson.items : []);
        setCandidateTotal(
          typeof candJson.total === "number" ? candJson.total : 0,
        );
      }
      setAssignments(Array.isArray(sel) ? sel : []);
    } catch (e) {
      const msg =
        e instanceof Error && e.message === "Failed to fetch"
          ? "Could not reach the API. Check the backend URL (NEXT_PUBLIC_API_URL) and that the server is running."
          : e instanceof Error
            ? e.message
            : "Failed to load repricer";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, authHeaders, baseUrl, candidatePage, query]);

  const loadLogs = useCallback(async () => {
    if (!isSignedIn) return;
    setLogsLoading(true);
    setLogsLoadErr(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${baseUrl}/api/repricer/logs?limit=200`, {
        headers,
      });
      if (!res.ok) {
        const body = await res.text();
        let detail = body;
        try {
          const j = JSON.parse(body) as { message?: string };
          if (j?.message) detail = j.message;
        } catch {
          /* use raw */
        }
        // Keep showing previous rows — do not clear logs on failed refresh (avoids flash empty → back).
        setLogsLoadErr(
          `Could not refresh logs (HTTP ${res.status}). Still showing last loaded data. ${detail ? detail.slice(0, 200) : "Check API URL and repricer password."}`,
        );
        return;
      }
      const data = (await res.json()) as
        | Array<{
            id: string;
            sku: string;
            asin?: string | null;
            context?: unknown;
            kind: string;
            message: string;
            prevPrice: number | null;
            nextPrice: number | null;
            createdAt: string;
          }>
        | {
            logs?: Array<{
              id: string;
              sku: string;
              asin?: string | null;
              context?: unknown;
              kind: string;
              message: string;
              prevPrice: number | null;
              nextPrice: number | null;
              createdAt: string;
              lastCheckedAt?: string | null;
            }>;
            lastEngineAt?: string | null;
          };
      if (Array.isArray(data)) {
        setLogs(data);
        setRepricerLastEngineAt(null);
      } else {
        setLogs(Array.isArray(data.logs) ? data.logs : []);
        setRepricerLastEngineAt(
          data.lastEngineAt != null && data.lastEngineAt !== undefined
            ? String(data.lastEngineAt)
            : null,
        );
      }
      setLogsLoadErr(null);
    } catch (e) {
      setLogsLoadErr(
        `${e instanceof Error ? e.message : "Network error"}. Still showing last loaded data if any.`,
      );
    } finally {
      setLogsLoading(false);
    }
  }, [isSignedIn, authHeaders, baseUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = sessionStorage.getItem("sellerbunker_repricer_pw");
    if (stored) setPw(stored);
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    if (!pw) return;
    (async () => {
      try {
        await ping();
        setPwOk(true);
        setPwErr(null);
      } catch (e) {
        setPwOk(false);
        setPwErr(e instanceof Error ? e.message : "Invalid password");
      }
    })();
  }, [isSignedIn, pw, ping]);

  useEffect(() => {
    if (!pwOk) return;
    void load();
  }, [pwOk, load]);

  useEffect(() => {
    if (!pwOk) return;
    void loadLogs();
  }, [pwOk, loadLogs]);

  useEffect(() => {
    if (!pwOk) return;
    void loadRuleLibrary();
  }, [pwOk, loadRuleLibrary]);

  const resetRuleModal = useCallback(() => {
    setEditingPresetId(null);
    setPresetName("My pricing preset");
    setApplyPresetToRepricer(true);
    setRuleTab(0);
    setShowSecondRule(false);
    setChainAfterDays("");
    setFollowUpRuleSetId("");
    setRule1(defaultRule({ strategy: "" }));
    setRule2(defaultRule({ strategy: "" }));
  }, []);

  const openCreateRuleModal = useCallback(() => {
    resetRuleModal();
    setRuleModalOpen(true);
  }, [resetRuleModal]);

  const fillModalFromPreset = useCallback((p: RulePresetApi) => {
    setEditingPresetId(p.id);
    setPresetName(p.name || "My pricing preset");
    setChainAfterDays(p.chainAfterDays != null ? String(p.chainAfterDays) : "");
    setFollowUpRuleSetId(p.followUpRuleSetId ?? "");
    const r1 = mapApiRuleToForm(
      p.rule1 as Record<string, unknown>,
      "match_buy_box",
    );
    const r2 = mapApiRuleToForm(
      p.rule2 as Record<string, unknown>,
      "beat_buy_box",
    );
    setRule1(r1);
    setRule2(r2);
    const r2raw = p.rule2 as Record<string, unknown>;
    const hasSecond =
      Boolean(typeof r2raw?.label === "string" && r2raw.label.trim()) ||
      r2raw?.minProfit != null ||
      Boolean(typeof r2raw?.strategy === "string" && r2raw.strategy.trim());
    setShowSecondRule(hasSecond);
    setRuleTab(0);
  }, []);

  const openEditPreset = useCallback(
    (id: string) => {
      const p = ruleLibrary?.presets.find((x) => x.id === id);
      if (p) {
        fillModalFromPreset(p);
        setApplyPresetToRepricer(p.isActive);
        setRuleModalOpen(true);
      }
    },
    [ruleLibrary?.presets, fillModalFromPreset],
  );

  const applyPreset = useCallback(
    async (presetId: string) => {
      setErr(null);
      try {
        const headers = await authHeaders();
        const res = await fetch(`${baseUrl}/api/repricer/rules/apply`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ presetId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error((data as any)?.message ?? "Could not apply preset");
        await loadRuleLibrary();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not apply preset");
      }
    },
    [authHeaders, baseUrl, loadRuleLibrary],
  );

  const selectedIds = useMemo(
    () => new Set(selected.map((s) => s.productId)),
    [selected],
  );
  const assignmentsByProductId = useMemo(() => {
    const m = new Map<string, SelectedSku>();
    for (const s of assignments) m.set(s.productId, s);
    return m;
  }, [assignments]);

  const selectedOrPinnedProductIds = useMemo(() => {
    const list =
      selected.length > 0
        ? selected.map((s) => s.productId)
        : pinnedProductId
          ? [pinnedProductId]
          : [];
    return [...new Set(list)];
  }, [selected, pinnedProductId]);

  /** SKUs currently in the repricer cohort — removing deletes the row. */
  const removableRuleProductIds = useMemo(() => {
    return selectedOrPinnedProductIds.filter((pid) =>
      assignmentsByProductId.has(pid),
    );
  }, [selectedOrPinnedProductIds, assignmentsByProductId]);
  const candidatePageCount = Math.max(
    1,
    Math.ceil(candidateTotal / CANDIDATE_PAGE_SIZE) || 1,
  );

  const chainTargetOptions = useMemo(() => {
    const list = ruleLibrary?.presets ?? [];
    return list.filter((p) => p.id !== editingPresetId);
  }, [ruleLibrary?.presets, editingPresetId]);

  const toggleSelect = useCallback(
    (c: CandidateSku) => {
      setSelected((prev) => {
        const exists = prev.some((p) => p.productId === c.productId);
        if (exists) {
          const next = prev.filter((p) => p.productId !== c.productId);
          const willBeEmpty = next.length === 0;
          if (willBeEmpty) setPinnedProductId(null);
          else if (pinnedProductId === c.productId) setPinnedProductId(null);
          return next;
        }

        return [...prev, { productId: c.productId }];
      });
    },
    [pinnedProductId, assignments],
  );

  const saveSelected = useCallback(async () => {
    setErr(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${baseUrl}/api/repricer/selected`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: selected.map((s) => s.productId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error((data as any)?.message ?? "Failed to save selection");
      await load();
      await loadRuleLibrary();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save selection");
    }
  }, [authHeaders, baseUrl, selected, load, loadRuleLibrary]);

  const assignPinnedToPreset = useCallback(
    async (ruleSetId: string) => {
      if (!pinnedProductId) {
        setErr(
          "Click a SKU row to choose which SKU to assign, then click Apply.",
        );
        return;
      }
      setAssigningPresetId(ruleSetId);
      setErr(null);
      try {
        const headers = await authHeaders();
        const res = await fetch(`${baseUrl}/api/repricer/assign-sku`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ productId: pinnedProductId, ruleSetId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error(
            (data as any)?.message ?? "Could not assign SKU to this rule",
          );
        await load();
        await loadRuleLibrary();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not assign SKU");
      } finally {
        setAssigningPresetId(null);
      }
    },
    [pinnedProductId, authHeaders, baseUrl, load, loadRuleLibrary],
  );

  const assignSelectedToPreset = useCallback(
    async (ruleSetId: string) => {
      const productIds =
        selected.length > 0
          ? selected.map((s) => s.productId)
          : pinnedProductId
            ? [pinnedProductId]
            : [];
      if (productIds.length === 0) {
        setErr(
          "Select one or more SKUs (checkboxes) or pin a SKU row, then click Apply.",
        );
        return;
      }

      setAssigningPresetId(ruleSetId);
      setErr(null);
      try {
        const headers = await authHeaders();
        // Apply to all selected SKUs (or the pinned SKU when none selected).
        // Do this sequentially to keep requests predictable and avoid rate spikes.
        for (const productId of productIds) {
          const res = await fetch(`${baseUrl}/api/repricer/assign-sku`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ productId, ruleSetId }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(
              (data as any)?.message ??
                "Could not assign one or more SKUs to this rule",
            );
          }
        }
        await load();
        await loadRuleLibrary();
        // UX: once assigned, clear checkbox highlights so the list doesn't stay "selected".
        setSelected([]);
        setPinnedProductId(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not assign SKU(s)");
      } finally {
        setAssigningPresetId(null);
      }
    },
    [selected, pinnedProductId, authHeaders, baseUrl, load, loadRuleLibrary],
  );

  const removeRuleFromSelected = useCallback(async () => {
    if (selectedOrPinnedProductIds.length === 0) {
      setErr(
        "Select one or more SKUs (checkboxes) or pin a SKU row, then click Remove from repricer.",
      );
      return;
    }
    if (removableRuleProductIds.length === 0) {
      setErr("None of the selected SKUs are in the repricer (10 SKU) list.");
      return;
    }
    setAssigningPresetId("remove-rule");
    setErr(null);
    try {
      const headers = await authHeaders();
      for (const productId of removableRuleProductIds) {
        const res = await fetch(`${baseUrl}/api/repricer/unassign-sku`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((data as any)?.message ?? "Could not remove SKU");
        }
      }
      await load();
      await loadRuleLibrary();
      setSelected([]);
      setPinnedProductId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove SKU");
    } finally {
      setAssigningPresetId(null);
    }
  }, [
    selectedOrPinnedProductIds,
    removableRuleProductIds,
    authHeaders,
    baseUrl,
    load,
    loadRuleLibrary,
  ]);

  const saveRules = useCallback(async () => {
    setSavingRules(true);
    setErr(null);
    try {
      const headers = await authHeaders();
      const r1p = ruleFormToPayload(rule1, rule1.durationDays);
      const r2p = showSecondRule
        ? ruleFormToPayload(rule2, rule2.durationDays)
        : ruleFormToPayload(defaultRule({ strategy: "" }), "7");
      const payload: Record<string, unknown> = {
        id: editingPresetId ?? undefined,
        name: presetName.trim() || "My pricing preset",
        setAsActive: applyPresetToRepricer,
        chainAfterDays: chainAfterDays.trim() ? clampNum(chainAfterDays) : null,
        followUpRuleSetId: followUpRuleSetId.trim() || null,
        rule1: r1p,
        rule2: r2p,
      };
      const res = await fetch(`${baseUrl}/api/repricer/rules`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error((data as any)?.message ?? "Failed to save rules");
      setRuleModalOpen(false);
      await loadRuleLibrary();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save rules");
    } finally {
      setSavingRules(false);
    }
  }, [
    authHeaders,
    baseUrl,
    rule1,
    rule2,
    presetName,
    applyPresetToRepricer,
    chainAfterDays,
    followUpRuleSetId,
    editingPresetId,
    showSecondRule,
    loadRuleLibrary,
  ]);

  const deleteRulePreset = useCallback(
    async (presetId: string, presetName?: string) => {
      const name = (presetName ?? "").trim() || "this rule";
      if (typeof window === "undefined") return;
      const ok = window.confirm(
        `Delete "${name}"?\n\nThis will delete the pricing rule and unassign any SKUs currently using it.`,
      );
      if (!ok) return;

      setErr(null);
      try {
        const headers = await authHeaders();
        const res = await fetch(`${baseUrl}/api/repricer/rules/${presetId}`, {
          method: "DELETE",
          headers,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((data as any)?.message ?? "Failed to delete rule");
        }
        await load();
        await loadRuleLibrary();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to delete rule");
      }
    },
    [authHeaders, baseUrl, load, loadRuleLibrary],
  );

  const fmtCur = useCallback(
    (n: number | null) => {
      if (n == null) return "—";
      return new Intl.NumberFormat(localeForListingCurrency(selectedCurrency), {
        style: "currency",
        currency: selectedCurrency,
      }).format(n);
    },
    [selectedCurrency],
  );

  const expectedProfitAndRoi = useCallback(
    (c: CandidateSku): { profit: number | null; roiPct: number | null } => {
      const price =
        c.currentListedPrice != null && Number.isFinite(Number(c.currentListedPrice))
          ? Number(c.currentListedPrice)
          : null;
      const cogs =
        c.costOfGoods != null && Number.isFinite(Number(c.costOfGoods)) && Number(c.costOfGoods) > 0
          ? Number(c.costOfGoods)
          : null;
      const fee =
        c.estimatedAmazonFeePerUnit != null && Number.isFinite(Number(c.estimatedAmazonFeePerUnit))
          ? Math.abs(Number(c.estimatedAmazonFeePerUnit))
          : null;
      if (price == null || cogs == null) return { profit: null, roiPct: null };
      const profit = price - (fee ?? 0) - cogs;
      const roiPct = cogs > 0 ? (profit / cogs) * 100 : null;
      return {
        profit: Number.isFinite(profit) ? Math.round(profit * 100) / 100 : null,
        roiPct: roiPct != null && Number.isFinite(roiPct) ? Math.round(roiPct * 10) / 10 : null,
      };
    },
    [],
  );

  const ruleTabLabel = (slot: 0 | 1) => {
    const r = slot === 0 ? rule1 : rule2;
    const fallback = slot === 0 ? "Step 1" : "Step 2";
    return r.label.trim() || fallback;
  };

  const renderRuleFields = (
    r: RuleForm,
    setR: (fn: (p: RuleForm) => RuleForm) => void,
  ) => (
    <>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">
          Price reference
        </span>
        <select
          value={r.priceReference}
          onChange={(e) =>
            setR((p) => ({
              ...p,
              priceReference:
                e.target.value === "best_offer" ? "best_offer" : "buy_box",
            }))
          }
          className="sb-select rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sb-accent/40"
        >
          <option value="buy_box">Buy box (featured offer)</option>
          <option value="best_offer">Lowest competitive offer</option>
        </select>
        <p className="text-[10px] text-[var(--muted-foreground)]">
          Choose whether match/beat/stay rules use the buy box price or the
          lowest offer returned in competitive pricing.
        </p>
      </label>

      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">
          Strategy (vs reference)
        </span>
        <select
          value={r.strategy}
          onChange={(e) => setR((p) => ({ ...p, strategy: e.target.value }))}
          className="sb-select rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sb-accent/40"
        >
          <option value="">—</option>
          <option value="no_buy_box">No repricing vs reference</option>
          <option value="match_buy_box">Match reference price</option>
          <option value="beat_buy_box">Beat reference by X</option>
          <option value="stay_above_buy_box">Stay X above reference</option>
        </select>
      </label>

      {r.strategy === "beat_buy_box" || r.strategy === "stay_above_buy_box" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              X type
            </span>
            <select
              value={r.beatType}
              onChange={(e) =>
                setR((p) => ({ ...p, beatType: e.target.value }))
              }
              className="sb-select rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sb-accent/40"
            >
              <option value="amount">£ amount</option>
              <option value="percent">% percent</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              X value
            </span>
            <input
              value={r.beatValue}
              onChange={(e) =>
                setR((p) => ({ ...p, beatValue: e.target.value }))
              }
              placeholder={r.beatType === "percent" ? "e.g. 2.5" : "e.g. 0.10"}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
        </>
      ) : null}

      <div className="space-y-3 sm:col-span-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Minimum profit
            </span>
            <input
              value={r.minProfit}
              onChange={(e) =>
                setR((p) => ({ ...p, minProfit: e.target.value }))
              }
              placeholder="e.g. 2.50"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Maximum profit
            </span>
            <input
              value={r.maxProfit}
              onChange={(e) =>
                setR((p) => ({ ...p, maxProfit: e.target.value }))
              }
              placeholder="e.g. 25.00"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Minimum price
            </span>
            <input
              value={r.minListPrice}
              onChange={(e) =>
                setR((p) => ({ ...p, minListPrice: e.target.value }))
              }
              placeholder={`e.g. 19.99 ${selectedCurrency}`}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
            <span className="text-[10px] text-[var(--muted-foreground)]">
              Hard floor in listing currency (optional).
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Maximum price
            </span>
            <input
              value={r.maxListPrice}
              onChange={(e) =>
                setR((p) => ({ ...p, maxListPrice: e.target.value }))
              }
              placeholder={`e.g. 49.99 ${selectedCurrency}`}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
            <span className="text-[10px] text-[var(--muted-foreground)]">
              Hard ceiling in listing currency (optional).
            </span>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Minimum ROI %
            </span>
            <input
              value={r.minRoiPct}
              onChange={(e) =>
                setR((p) => ({ ...p, minRoiPct: e.target.value }))
              }
              placeholder="e.g. 15%"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Maximum ROI %
            </span>
            <input
              value={r.maxRoiPct}
              onChange={(e) =>
                setR((p) => ({ ...p, maxRoiPct: e.target.value }))
              }
              placeholder="e.g. 250%"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
        </div>
      </div>

      <div className="sm:col-span-2 space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          Conditions
        </p>

        <p className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          Ignore
        </p>
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5">
          <span className="text-sm text-[var(--foreground)]">
            Ignore Amazon as competitor
          </span>
          <input
            type="checkbox"
            checked={r.ignoreAmazon}
            onChange={(e) =>
              setR((p) => ({ ...p, ignoreAmazon: e.target.checked }))
            }
            className="h-4 w-4 shrink-0 accent-[var(--sb-accent)]"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5">
          <span className="text-sm text-[var(--foreground)]">
            Ignore FBM sellers
          </span>
          <input
            type="checkbox"
            checked={r.ignoreFbm}
            onChange={(e) =>
              setR((p) => ({ ...p, ignoreFbm: e.target.checked }))
            }
            className="h-4 w-4 shrink-0 accent-[var(--sb-accent)]"
          />
        </label>
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--foreground)]">
            <span>Ignore sellers with fewer than</span>
            <input
              value={r.ignoreSellerViewsBelow}
              onChange={(e) =>
                setR((p) => ({ ...p, ignoreSellerViewsBelow: e.target.value }))
              }
              disabled={!r.ignoreSellerViewsEnabled}
              placeholder="1000"
              inputMode="numeric"
              className="w-24 rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40 disabled:opacity-40"
            />
            <span className="text-[var(--muted-foreground)]">reviews</span>
          </div>
          <input
            type="checkbox"
            checked={r.ignoreSellerViewsEnabled}
            onChange={(e) =>
              setR((p) => ({
                ...p,
                ignoreSellerViewsEnabled: e.target.checked,
              }))
            }
            className="h-4 w-4 shrink-0 self-end sm:self-center accent-[var(--sb-accent)]"
            aria-label="Enable ignoring sellers below this review count"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Ignore seller IDs (comma-separated)
            </span>
            <input
              value={r.ignoreSellerIds}
              onChange={(e) =>
                setR((p) => ({ ...p, ignoreSellerIds: e.target.value }))
              }
              placeholder="e.g. A1ABC..., A2DEF..."
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Min seller feedback %
            </span>
            <input
              value={r.minSellerFeedbackPct}
              onChange={(e) =>
                setR((p) => ({ ...p, minSellerFeedbackPct: e.target.value }))
              }
              placeholder="e.g. 90"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-medium text-[var(--muted-foreground)]">
              Cooldown (minutes)
            </span>
            <input
              value={r.cooldownMinutes}
              onChange={(e) =>
                setR((p) => ({ ...p, cooldownMinutes: e.target.value }))
              }
              placeholder="e.g. 20"
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40 sm:max-w-xs"
            />
          </label>
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/40 px-3 py-2.5">
          <span className="text-sm text-[var(--foreground)]">
            Smart delay (avoid price wars)
          </span>
          <input
            type="checkbox"
            checked={r.smartDelayEnabled}
            onChange={(e) =>
              setR((p) => ({ ...p, smartDelayEnabled: e.target.checked }))
            }
            className="h-4 w-4 shrink-0 accent-[var(--sb-accent)]"
          />
        </label>
      </div>
    </>
  );

  if (!isSignedIn) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-[var(--muted-foreground)]">
          Sign in to use the repricer.
        </p>
        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded-lg bg-sb-accent px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90"
          >
            Sign in
          </button>
        </SignInButton>
      </div>
    );
  }

  if (!pwOk) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-xl">
          <h1 className="text-lg font-semibold text-[var(--foreground)]">
            Repricer (testing)
          </h1>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">
            Enter the repricer password to continue.
          </p>
          <div className="mt-4">
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
            {pwErr ? (
              <p className="mt-2 text-xs text-red-400">{pwErr}</p>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                try {
                  await ping();
                  sessionStorage.setItem("sellerbunker_repricer_pw", pw);
                  setPwOk(true);
                  setPwErr(null);
                } catch (e) {
                  setPwOk(false);
                  setPwErr(e instanceof Error ? e.message : "Invalid password");
                }
              }}
              className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-sb-accent px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90"
            >
              Unlock repricer
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] p-4 text-[var(--foreground)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Repricer</h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              &nbsp;
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openCreateRuleModal}
              className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-semibold text-black hover:opacity-90"
            >
              Create pricing rule
            </button>
          </div>
        </div>

        <p className="text-xs text-[var(--muted-foreground)]">
          Tick one or more SKUs below, then click{" "}
          <span className="font-medium text-[var(--foreground)]">Apply</span>{" "}
          next to a rule to assign that pricing rule to all checked SKUs. (If
          none are checked, you can still pin a single SKU row and apply.) Use{" "}
          <span className="font-medium text-[var(--foreground)]">
            Remove from repricer
          </span>{" "}
          to free a slot.
        </p>

        <div className="max-w-3xl rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">
            Saved pricing rules
          </h2>
          {ruleLibrary.presets.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted-foreground)]">
              No saved templates yet, or the list could not be loaded (check the
              backend is running and DB migrations are applied). Use{" "}
              <span className="font-medium text-[var(--foreground)]">
                Create pricing rule
              </span>{" "}
              to add one.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {ruleLibrary.presets.map((p) => {
                const skuCount = p.assignedSkuCount ?? 0;
                const showActiveBadge = Boolean(p.isActive) && skuCount > 0;
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--surface-border)] bg-[var(--background)]/40 px-2 py-2"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div className="w-14 shrink-0">
                        {showActiveBadge ? (
                          <span className="inline-flex rounded-lg bg-sb-accent/20 px-3 py-1.5 text-xs font-semibold text-[var(--foreground)]">
                            Active
                          </span>
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {p.name || "Untitled"}
                        </div>
                        <div className="text-[10px] text-[var(--muted-foreground)]">
                          {showActiveBadge
                            ? "Active default"
                            : "Not active"}
                          {" · "}
                          <span className="text-[var(--foreground)]/90">
                            {skuCount} {skuCount === 1 ? "SKU" : "SKUs"}
                          </span>
                        </div>
                      </div>
                    </div>
                      <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        disabled={
                          assigningPresetId === p.id ||
                          (selected.length === 0 && !pinnedProductId)
                        }
                        title={
                          selected.length > 0
                            ? "Assign all checked SKUs to this pricing rule"
                            : pinnedProductId
                              ? "Assign the pinned SKU to this pricing rule"
                              : "Tick SKUs (checkboxes) or pin a SKU row first"
                        }
                        onClick={() => void assignSelectedToPreset(p.id)}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                          selected.length > 0 || pinnedProductId
                            ? "bg-emerald-500 text-black hover:bg-emerald-400"
                            : "border border-[var(--surface-border)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                        }`}
                      >
                        {assigningPresetId === p.id ? "Applying…" : "Apply"}
                      </button>
                      <button
                        type="button"
                        disabled={
                          assigningPresetId === "remove-rule" ||
                          removableRuleProductIds.length === 0
                        }
                        title={
                          removableRuleProductIds.length > 0
                            ? "Remove selected SKU(s) from the repricer (frees a slot)"
                            : selected.length > 0 || pinnedProductId
                              ? "Selected SKU(s) are not in the repricer list"
                              : "Tick SKUs (checkboxes) or pin a SKU row first"
                        }
                        onClick={() => void removeRuleFromSelected()}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                          removableRuleProductIds.length > 0
                            ? "border border-amber-400/50 bg-amber-400/5 text-amber-200/90 hover:bg-amber-400/10"
                            : "border border-[var(--surface-border)] bg-transparent text-[var(--muted-foreground)] opacity-40"
                        }`}
                      >
                        {assigningPresetId === "remove-rule"
                          ? "Removing…"
                          : "Remove from repricer"}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditPreset(p.id)}
                        className="rounded-lg border border-[var(--surface-border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteRulePreset(p.id, p.name)}
                        className="rounded-lg border border-red-500/40 bg-transparent px-2.5 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/10"
                        title="Delete this pricing rule"
                      >
                        Delete rule
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {err ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/50 px-3 py-2 text-sm">
              Select SKUs below, then click Apply on a pricing rule.
            </div>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCandidatePage(1);
              }}
              placeholder="Search SKU / ASIN / title"
              className="w-full max-w-sm rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
            />
          </div>

          {loading ? (
            <div className="mt-4 text-sm text-[var(--muted-foreground)]">
              Loading…
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-2">
              {candidates.map((c) => {
                const isSel = selectedIds.has(c.productId);
                const isPinned = pinnedProductId === c.productId;
                const assigned = assignmentsByProductId.get(c.productId);
                const exp = expectedProfitAndRoi(c);
                return (
                  <div
                    key={c.productId}
                    className={`flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left transition ${
                      isPinned
                        ? "ring-2 ring-sb-accent/60 ring-offset-2 ring-offset-[var(--background)]"
                        : ""
                    } ${
                      isSel
                        ? "border-sb-accent bg-sb-accent/10"
                        : "border-[var(--surface-border)] hover:bg-[var(--foreground)]/5"
                    }`}
                  >
                    <label className="flex shrink-0 cursor-pointer items-center px-1">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSelect(c)}
                        className="h-4 w-4 accent-[var(--sb-accent)]"
                        aria-label={`Include ${c.sku} in bulk save to active preset`}
                      />
                    </label>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`Pin row for SKU ${c.sku}`}
                      onClick={() => setPinnedProductId(c.productId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setPinnedProductId(c.productId);
                        }
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-sb-accent/40"
                    >
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-[var(--background)]/50 ring-1 ring-[var(--surface-border)]">
                        {c.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.imageUrl}
                            alt={c.title ?? c.sku}
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1 select-text">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="truncate text-sm font-semibold">
                            {c.sku}
                          </span>
                          {c.asin ? (
                            <span
                              className="font-mono text-xs text-[var(--muted-foreground)]"
                              title={c.asin}
                            >
                              ASIN {c.asin}
                            </span>
                          ) : (
                            <span className="text-xs text-[var(--muted-foreground)]">
                              ASIN —
                            </span>
                          )}
                          <span className="select-none text-xs text-[var(--muted-foreground)]">
                            {c.availableQty != null && c.availableQty > 0
                              ? `Available ${c.availableQty}`
                              : `In stock ${c.totalQty}`}
                          </span>
                          <span className="select-none text-xs text-[var(--muted-foreground)]">
                            Sales (30d) {c.activeUnits30d}
                          </span>
                        </div>
                        <div
                          className="mt-0.5 line-clamp-2 select-text text-xs text-[var(--muted-foreground)]"
                          title={c.title ?? undefined}
                        >
                          {c.title ?? "—"}
                        </div>
                        {assigned?.ruleSetName ? (
                          <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                            Pricing rule:{" "}
                            <span className="font-semibold text-emerald-400">
                              {assigned.ruleSetName}
                            </span>
                          </div>
                        ) : isSel ? (
                          <div className="mt-1 text-[10px] text-amber-200/90">
                            Pin this row and click Apply on a saved rule to
                            assign.
                          </div>
                        ) : null}
                      </div>
                      <div className="shrink-0 select-none text-right">
                        <div className="text-sm font-semibold tabular-nums">
                          {fmtCur(c.currentListedPrice)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                          Profit{" "}
                          <span className="font-medium text-[var(--foreground)] tabular-nums">
                            {exp.profit != null ? fmtCur(exp.profit) : "—"}
                          </span>
                          {" · "}
                          ROI{" "}
                          <span className="font-medium text-[var(--foreground)] tabular-nums">
                            {exp.roiPct != null ? `${exp.roiPct.toFixed(1)}%` : "—"}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                          {c.currentListedPriceUpdatedAt
                            ? `refreshed ${new Date(c.currentListedPriceUpdatedAt).toLocaleString()}`
                            : ""}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {candidates.length === 0 ? (
                <div className="text-sm text-[var(--muted-foreground)]">
                  No SKUs with available inventory match your search.
                </div>
              ) : null}
            </div>
          )}
          {!loading && candidateTotal > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--surface-border)] pt-4 text-sm text-[var(--muted-foreground)]">
              <span>
                Showing {(candidatePage - 1) * CANDIDATE_PAGE_SIZE + 1}–
                {Math.min(candidatePage * CANDIDATE_PAGE_SIZE, candidateTotal)}{" "}
                of {candidateTotal}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={candidatePage <= 1}
                  onClick={() => setCandidatePage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-[var(--surface-border)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="tabular-nums text-[var(--foreground)]">
                  Page {candidatePage} / {candidatePageCount}
                </span>
                <button
                  type="button"
                  disabled={candidatePage >= candidatePageCount}
                  onClick={() => setCandidatePage((p) => p + 1)}
                  className="rounded-lg border border-[var(--surface-border)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Repricer log
              </h2>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                Only real activity: Amazon listing updates, dry runs that would
                change price, skips that need your attention, and errors.
                Routine &quot;no change&quot; checks are hidden. Hover a message
                for the raw server text. Refresh to reload.
              </p>
              {repricerLastEngineAt ? (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Last repricer run:{" "}
                  <span className="font-medium text-[var(--foreground)] tabular-nums">
                    {new Date(repricerLastEngineAt).toLocaleString()}
                  </span>
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={loadLogs}
              className="rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
            >
              {logsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div className="mt-3 max-h-[min(60vh,560px)] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--surface-border)] text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  <th className="py-2 pr-3">Time (last check)</th>
                  <th className="py-2 pr-3">ASIN</th>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Message</th>
                  <th className="py-2 pl-3">Price</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((l) => {
                  const effectiveNext =
                    l.nextPrice != null
                      ? l.nextPrice
                      : l.prevPrice != null &&
                          logRowImpliesFlatPriceForDisplay(l.message)
                        ? l.prevPrice
                        : null;
                  const delta =
                    l.prevPrice != null &&
                    effectiveNext != null &&
                    Number.isFinite(effectiveNext - l.prevPrice)
                      ? effectiveNext - l.prevPrice
                      : null;
                  return (
                    <tr
                      key={l.id}
                      className="border-b border-[var(--surface-border)] last:border-b-0"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap text-[10px] text-[var(--muted-foreground)]">
                        {new Date(
                          l.lastCheckedAt ?? l.createdAt,
                        ).toLocaleString()}
                      </td>
                      <td
                        className="py-2 pr-3 font-mono text-[10px] text-[var(--muted-foreground)]"
                        title={l.asin ?? undefined}
                      >
                        {l.asin ? `ASIN ${l.asin}` : "ASIN —"}
                      </td>
                      <td
                        className="py-2 pr-3 text-[10px] font-medium text-[var(--foreground)]"
                        title={l.message}
                      >
                        {repricerEventLabel(l)}
                      </td>
                      <td
                        className="py-2 pr-3 max-w-[min(28rem,55vw)] text-[var(--muted-foreground)]"
                        title={l.message}
                      >
                        {displayRepricerLogMessage(l.message)}
                      </td>
                      <td className="py-2 pl-3 tabular-nums">
                        {l.prevPrice != null || l.nextPrice != null ? (
                          <div className="flex items-center justify-start gap-2">
                            {delta != null && delta !== 0 ? (
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] font-semibold ${
                                  delta > 0
                                    ? "text-emerald-400"
                                    : "text-red-400"
                                }`}
                                title="Change from previous price"
                              >
                                <span aria-hidden="true">
                                  {delta > 0 ? "▲" : "▼"}
                                </span>
                                <span>{fmtCur(Math.abs(delta))}</span>
                              </span>
                            ) : delta === 0 ? (
                              <span className="text-[10px] text-[var(--muted-foreground)]">
                                —
                              </span>
                            ) : null}
                            <span>
                              {`${fmtCur(l.prevPrice)} → ${effectiveNext != null ? fmtCur(effectiveNext) : "—"}`}
                            </span>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-sm">
                      {logsLoadErr ? (
                        <span className="text-amber-400">{logsLoadErr}</span>
                      ) : logsLoading ? (
                        <span className="text-[var(--muted-foreground)]">
                          Loading…
                        </span>
                      ) : logs.length > 0 ? (
                        <span className="text-[var(--muted-foreground)]">
                          No listing changes or alerts in the loaded history —
                          only routine &quot;no change&quot; / no-buy-box checks
                          were returned, and those are hidden here.
                        </span>
                      ) : repricerLastEngineAt ? (
                        <span className="text-[var(--muted-foreground)]">
                          No log rows returned (table may be empty in the
                          database). Last engine touch:{" "}
                          {new Date(repricerLastEngineAt).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-[var(--muted-foreground)]">
                          No rows yet. If the repricer has run, the database may
                          have no log history for this org (e.g. after a bad
                          deploy). Run the worker and tap Refresh.
                        </span>
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {ruleModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => !savingRules && setRuleModalOpen(false)}
        >
          <div
            className="flex max-h-[min(100dvh-0.5rem,920px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-[var(--surface-border)] p-4 sm:p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-[var(--foreground)]">
                    Pricing rules
                  </h2>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                    Safety first: strict bounds. No Amazon price updates are
                    sent until explicitly enabled.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => !savingRules && setRuleModalOpen(false)}
                  className="shrink-0 rounded-lg border border-[var(--surface-border)] px-3 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                >
                  Close
                </button>
              </div>

              <label className="mt-4 flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--muted-foreground)]">
                  Preset name
                </span>
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="e.g. Holiday buy box"
                  className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
                />
              </label>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRuleTab(0)}
                  className={`max-w-[10rem] truncate rounded-lg px-3 py-2 text-sm font-semibold ${
                    ruleTab === 0
                      ? "bg-sb-accent text-black"
                      : "border border-[var(--surface-border)] text-[var(--foreground)]"
                  }`}
                  title={ruleTabLabel(0)}
                >
                  {ruleTabLabel(0)}
                </button>
                {showSecondRule ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setRuleTab(1)}
                      className={`max-w-[10rem] truncate rounded-lg px-3 py-2 text-sm font-semibold ${
                        ruleTab === 1
                          ? "bg-sb-accent text-black"
                          : "border border-[var(--surface-border)] text-[var(--foreground)]"
                      }`}
                      title={ruleTabLabel(1)}
                    >
                      {ruleTabLabel(1)}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowSecondRule(false);
                        setRuleTab(0);
                        setRule2(defaultRule({ strategy: "" }));
                      }}
                      className="rounded-lg border border-[var(--surface-border)] px-2 py-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
                      title="Remove second step"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setShowSecondRule(true);
                      setRuleTab(1);
                    }}
                    className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--surface-border)] text-lg font-bold text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
                    aria-label="Add another rule step"
                  >
                    +
                  </button>
                )}
              </div>

              <label className="mt-3 flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--muted-foreground)]">
                  Name for this step (shown on tab after save)
                </span>
                <input
                  value={ruleTab === 0 ? rule1.label : rule2.label}
                  onChange={(e) =>
                    ruleTab === 0
                      ? setRule1((p) => ({ ...p, label: e.target.value }))
                      : setRule2((p) => ({ ...p, label: e.target.value }))
                  }
                  placeholder={
                    ruleTab === 0 ? "e.g. Launch pricing" : "e.g. Steady state"
                  }
                  className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-5">
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {ruleTab === 0
                  ? renderRuleFields(rule1, setRule1)
                  : renderRuleFields(rule2, setRule2)}
              </div>

              <div className="mt-6 border-t border-[var(--surface-border)] pt-4">
                <label className="flex flex-col gap-1 sm:max-w-xs">
                  <span className="text-xs font-medium text-[var(--muted-foreground)]">
                    Rule duration (days)
                  </span>
                  <input
                    value={
                      ruleTab === 0 ? rule1.durationDays : rule2.durationDays
                    }
                    onChange={(e) =>
                      ruleTab === 0
                        ? setRule1((p) => ({
                            ...p,
                            durationDays: e.target.value,
                          }))
                        : setRule2((p) => ({
                            ...p,
                            durationDays: e.target.value,
                          }))
                    }
                    placeholder="e.g. 7"
                    className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
                  />
                </label>
              </div>

              <div className="mt-3 border-t border-[var(--surface-border)] pt-4">
                <h3 className="text-sm font-semibold text-[var(--foreground)]">
                  Then switch preset
                </h3>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  After this many days, optionally switch to another saved
                  pricing rule (for example, after a launch period).
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--muted-foreground)]">
                      After (days)
                    </span>
                    <input
                      value={chainAfterDays}
                      onChange={(e) => setChainAfterDays(e.target.value)}
                      placeholder="e.g. 14 — leave empty to disable"
                      className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-sb-accent/40"
                    />
                  </label>
                  <label className="flex flex-col gap-1 sm:col-span-1">
                    <span className="text-xs font-medium text-[var(--muted-foreground)]">
                      Use pricing rule
                    </span>
                    <select
                      value={followUpRuleSetId}
                      onChange={(e) => setFollowUpRuleSetId(e.target.value)}
                      className="sb-select rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sb-accent/40"
                    >
                      <option value="">— None —</option>
                      {chainTargetOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || "Untitled"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={applyPresetToRepricer}
                  onChange={(e) => setApplyPresetToRepricer(e.target.checked)}
                />
                <span className="text-xs text-[var(--muted-foreground)]">
                  Apply this preset to repricing (set as active). You can save
                  without applying.
                </span>
              </label>
            </div>

            <div className="shrink-0 border-t border-[var(--surface-border)] p-4 sm:p-5">
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRuleModalOpen(false)}
                  disabled={savingRules}
                  className="rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveRules}
                  disabled={savingRules}
                  className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
                >
                  {savingRules ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
