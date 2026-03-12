"use client";

import { SignOutButton, useAuth, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
import {
  useDisplaySettings,
  type BackgroundTheme,
} from "@/contexts/display-settings-context";

const VAT_TYPES = [
  { value: "NON_VAT_REGISTERED", label: "Non VAT registered" },
  { value: "VAT_STANDARD", label: "VAT registered (standard)" },
  { value: "VAT_FLAT_RATE", label: "VAT registered (flat rate)" },
] as const;

type VatSettings = {
  vatRegistrationType: string;
  vatEffectiveDate: string | null;
  vatFlatRatePct: number | null;
  vatRatePct: number | null;
  vatCostsIncludeVat: boolean | null;
};

const BACKGROUND_OPTIONS: { value: BackgroundTheme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "blue", label: "Blue" },
  { value: "pink", label: "Pink" },
  { value: "green", label: "Green" },
];

/** Theme/accent colour presets – used for buttons, rings, sync bar, and all green accents */
const THEME_COLOUR_SCHEMES: { id: string; label: string; color: string }[] = [
  { id: "green", label: "Green", color: "rgb(2, 242, 170)" },
  { id: "blue", label: "Blue", color: "rgb(59, 130, 246)" },
  { id: "violet", label: "Violet", color: "rgb(168, 85, 247)" },
  { id: "rose", label: "Rose", color: "rgb(236, 72, 153)" },
  { id: "amber", label: "Amber", color: "rgb(245, 158, 11)" },
  { id: "emerald", label: "Emerald", color: "rgb(34, 197, 94)" },
  { id: "red", label: "Red", color: "rgb(239, 68, 68)" },
  { id: "teal", label: "Teal", color: "rgb(20, 184, 166)" },
  { id: "sky", label: "Sky", color: "rgb(14, 165, 233)" },
  { id: "fuchsia", label: "Fuchsia", color: "rgb(217, 70, 239)" },
];

function toHex(color: string): string {
  if (color.startsWith("#")) return color;
  const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return "#02f2aa";
  const r = Math.max(0, Math.min(255, parseInt(m[1], 10)));
  const g = Math.max(0, Math.min(255, parseInt(m[2], 10)));
  const b = Math.max(0, Math.min(255, parseInt(m[3], 10)));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "rgb(2, 242, 170)";
  return `rgb(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)})`;
}

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { getToken } = useAuth();
  const { user } = useUser();
  const {
    backgroundTheme,
    ringColor,
    applyDisplaySettings,
  } = useDisplaySettings();

  const [vatForm, setVatForm] = useState({
    vatRegistrationType: "NON_VAT_REGISTERED",
    vatEffectiveDate: "",
    vatFlatRatePct: "",
  });
  const [vatLoading, setVatLoading] = useState(false);
  const [vatSaving, setVatSaving] = useState(false);
  const [vatError, setVatError] = useState<string | null>(null);
  const [vatNotice, setVatNotice] = useState<string | null>(null);

  const [displayBg, setDisplayBg] = useState<BackgroundTheme>(backgroundTheme);
  const [displayRingColor, setDisplayRingColor] = useState(ringColor);
  const [displayApplied, setDisplayApplied] = useState(false);

  type SectionKey = "details" | "vat" | "display" | "subscription";
  const [openSection, setOpenSection] = useState<SectionKey | null>(null);
  const [faqModalOpen, setFaqModalOpen] = useState(false);
  const [amazonSellerId, setAmazonSellerId] = useState<string | null | "loading">(null);
  const [subscriptionPlan, setSubscriptionPlan] = useState<string | null | "loading">(null);
  const [subscriptionLockoutAt, setSubscriptionLockoutAt] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelSubscriptionLoading, setCancelSubscriptionLoading] = useState(false);
  const [cancelSubscriptionError, setCancelSubscriptionError] = useState<string | null>(null);

  const loadVat = useCallback(async () => {
    setVatLoading(true);
    setVatError(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${BASE_URL}/api/orgs/vat-settings`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load settings.");
      const data = (await res.json()) as VatSettings;
      setVatForm({
        vatRegistrationType: data.vatRegistrationType ?? "NON_VAT_REGISTERED",
        vatEffectiveDate: data.vatEffectiveDate ? data.vatEffectiveDate.slice(0, 10) : "",
        vatFlatRatePct: data.vatFlatRatePct != null ? String(data.vatFlatRatePct) : "",
      });
    } catch (e) {
      setVatError(e instanceof Error ? e.message : "Error");
    } finally {
      setVatLoading(false);
    }
  }, [getToken]);

  const loadAmazonAccount = useCallback(async () => {
    setAmazonSellerId("loading");
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setAmazonSellerId(null);
        return;
      }
      const res = await fetch(`${BASE_URL}/api/amazon/account/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { sellerId?: string };
        setAmazonSellerId(data.sellerId ?? null);
      } else {
        setAmazonSellerId(null);
      }
    } catch {
      setAmazonSellerId(null);
    }
  }, [getToken]);

  useEffect(() => {
    if (open) {
      void loadVat();
      setDisplayBg(backgroundTheme);
      setDisplayRingColor(ringColor);
      setDisplayApplied(false);
      setOpenSection(null);
      setAmazonSellerId(null);
      setSubscriptionPlan(null);
      setSubscriptionLockoutAt(null);
      setSubscriptionStatus(null);
    }
  }, [open, loadVat, backgroundTheme, ringColor]);

  useEffect(() => {
    if (open && openSection === "details") {
      void loadAmazonAccount();
    }
  }, [open, openSection, loadAmazonAccount]);

  const loadSubscription = useCallback(async () => {
    setSubscriptionPlan("loading");
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setSubscriptionPlan(null);
        return;
      }
      const res = await fetch(`${BASE_URL}/api/subscription/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          plan?: string | null;
          lockoutAt?: string | null;
          status?: string | null;
        };
        setSubscriptionPlan(data.plan ?? null);
        setSubscriptionLockoutAt(data.lockoutAt ?? null);
        setSubscriptionStatus(data.status ?? null);
      } else {
        setSubscriptionPlan(null);
        setSubscriptionLockoutAt(null);
        setSubscriptionStatus(null);
      }
    } catch {
      setSubscriptionPlan(null);
      setSubscriptionLockoutAt(null);
      setSubscriptionStatus(null);
    }
  }, [getToken]);

  useEffect(() => {
    if (open && openSection === "subscription") {
      void loadSubscription();
    }
  }, [open, openSection, loadSubscription]);

  const confirmCancelSubscription = useCallback(async () => {
    setCancelSubscriptionError(null);
    setCancelSubscriptionLoading(true);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setCancelSubscriptionError("Not signed in");
        return;
      }
      const res = await fetch(`${BASE_URL}/api/subscription/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { lockoutAt?: string; message?: string };
      if (!res.ok) {
        setCancelSubscriptionError((data as { message?: string }).message ?? "Failed to cancel");
        return;
      }
      setShowCancelConfirm(false);
      await loadSubscription();
    } catch (e) {
      setCancelSubscriptionError(e instanceof Error ? e.message : "Failed to cancel");
    } finally {
      setCancelSubscriptionLoading(false);
    }
  }, [getToken, loadSubscription]);

  const saveVat = async () => {
    setVatSaving(true);
    setVatError(null);
    setVatNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      const body: Record<string, unknown> = {
        vatRegistrationType: vatForm.vatRegistrationType,
      };
      if (vatForm.vatEffectiveDate.trim())
        body.vatEffectiveDate = vatForm.vatEffectiveDate.trim() + "T00:00:00.000Z";
      else body.vatEffectiveDate = null;
      if (vatForm.vatRegistrationType === "VAT_FLAT_RATE" && vatForm.vatFlatRatePct.trim()) {
        const pct = Number(vatForm.vatFlatRatePct);
        body.vatFlatRatePct = Number.isFinite(pct) ? pct : null;
      }
      const res = await fetch(`${BASE_URL}/api/orgs/vat-settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to save.");
      }
      setVatNotice("VAT settings saved.");
      await loadVat();
    } catch (e) {
      setVatError(e instanceof Error ? e.message : "Error");
    } finally {
      setVatSaving(false);
    }
  };

  const applyDisplay = () => {
    applyDisplaySettings({ background: displayBg, ringColor: displayRingColor });
    setDisplayApplied(true);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex justify-end bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--surface-border)] bg-[var(--surface)] shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
          <h2 id="settings-modal-title" className="text-lg font-semibold text-[var(--foreground)]">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-0">
          {/* My details */}
          <section className="border-b border-[var(--surface-border)]">
            <button
              type="button"
              onClick={() => setOpenSection((s) => (s === "details" ? null : "details"))}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
              aria-expanded={openSection === "details"}
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                My details
              </h3>
              <svg
                className={`h-5 w-5 shrink-0 text-[var(--muted-foreground)] transition-transform ${openSection === "details" ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSection === "details" && (
              <div className="border-t border-[var(--surface-border)] px-4 pb-4 pt-2">
                <p className="text-sm font-medium text-[var(--foreground)]">Logged in as</p>
                <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                  {user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "—"}
                </p>
                <p className="mt-3 text-sm font-medium text-[var(--foreground)]">Amazon account</p>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  {amazonSellerId === "loading"
                    ? "Loading…"
                    : amazonSellerId ?? "Not connected"}
                </p>
                <div className="mt-4 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/50 p-3">
                  <p className="text-sm font-medium text-[var(--foreground)]">Change password</p>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    Use the <strong>Manage account</strong> link below to change your password or update your email.
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Your account — link to Clerk account page */}
          <section className="border-b border-[var(--surface-border)]">
            <Link
              href="/account"
              onClick={onClose}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                Manage account
              </h3>
              <svg
                className="h-5 w-5 shrink-0 text-[var(--muted-foreground)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </section>

          {/* FAQ */}
          <section className="border-b border-[var(--surface-border)]">
            <button
              type="button"
              onClick={() => setFaqModalOpen(true)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                FAQ
              </h3>
              <svg
                className="h-5 w-5 shrink-0 text-[var(--muted-foreground)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </section>

          {/* VAT settings */}
          <section className="border-b border-[var(--surface-border)]">
            <button
              type="button"
              onClick={() => setOpenSection((s) => (s === "vat" ? null : "vat"))}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
              aria-expanded={openSection === "vat"}
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                VAT settings
              </h3>
              <svg
                className={`h-5 w-5 shrink-0 text-[var(--muted-foreground)] transition-transform ${openSection === "vat" ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSection === "vat" && (
            <div className="border-t border-[var(--surface-border)] px-4 pb-4 pt-2">
            {vatError && (
              <p className="mb-2 text-sm text-red-600 dark:text-red-400">{vatError}</p>
            )}
            {vatNotice && (
              <p className="mb-2 text-sm text-emerald-600 dark:text-emerald-400">{vatNotice}</p>
            )}
            {vatLoading ? (
              <p className="text-sm text-[var(--muted-foreground)]">Loading…</p>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--foreground)]">VAT registration</label>
                  <select
                    value={vatForm.vatRegistrationType}
                    onChange={(e) =>
                      setVatForm((prev) => ({
                        ...prev,
                        vatRegistrationType: e.target.value,
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
                  >
                    {VAT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--foreground)]">VAT effective date</label>
                  <input
                    type="date"
                    value={vatForm.vatEffectiveDate}
                    onChange={(e) => setVatForm((prev) => ({ ...prev, vatEffectiveDate: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
                  />
                </div>
                {vatForm.vatRegistrationType === "VAT_FLAT_RATE" && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--foreground)]">Flat rate VAT (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={vatForm.vatFlatRatePct}
                      onChange={(e) => setVatForm((prev) => ({ ...prev, vatFlatRatePct: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={saveVat}
                  disabled={vatSaving}
                  className="rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
                >
                  {vatSaving ? "Saving…" : "Save VAT settings"}
                </button>
              </div>
            )}
            </div>
            )}
          </section>

          {/* Display settings */}
          <section className="border-b border-[var(--surface-border)]">
            <button
              type="button"
              onClick={() => setOpenSection((s) => (s === "display" ? null : "display"))}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
              aria-expanded={openSection === "display"}
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                Display settings
              </h3>
              <svg
                className={`h-5 w-5 shrink-0 text-[var(--muted-foreground)] transition-transform ${openSection === "display" ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSection === "display" && (
            <div className="border-t border-[var(--surface-border)] px-4 pb-4 pt-2">
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-medium text-[var(--foreground)]">Background (free space)</p>
                <div className="flex flex-wrap gap-2">
                  {BACKGROUND_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDisplayBg(opt.value)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                        displayBg === opt.value
                          ? "bg-sb-accent text-black"
                          : "border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-[var(--foreground)]">
                  Theme colour (buttons, rings &amp; accents)
                </p>
                <p className="mb-2 text-[10px] text-[var(--muted-foreground)]">
                  Choose a colour scheme – all green accents (buttons, progress bars, nav) use this colour.
                </p>
                <div className="flex flex-wrap gap-2">
                  {THEME_COLOUR_SCHEMES.map((scheme) => (
                    <button
                      key={scheme.id}
                      type="button"
                      onClick={() => setDisplayRingColor(scheme.color)}
                      className={`flex h-8 min-w-[4rem] items-center gap-1.5 rounded-lg border-2 px-2 transition hover:scale-[1.02] ${
                        displayRingColor === scheme.color
                          ? "border-[var(--foreground)] bg-[var(--surface-hover)]"
                          : "border-[var(--surface-border)] bg-[var(--background)] hover:bg-[var(--foreground)]/5"
                      }`}
                      title={scheme.color}
                      aria-label={`Theme: ${scheme.label}`}
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full"
                        style={{ backgroundColor: scheme.color }}
                      />
                      <span className="text-xs font-medium text-[var(--foreground)]">{scheme.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="color"
                    value={toHex(displayRingColor)}
                    onChange={(e) => setDisplayRingColor(hexToRgb(e.target.value))}
                    className="h-8 w-8 cursor-pointer rounded border border-[var(--surface-border)] bg-transparent"
                  />
                  <span className="text-xs text-[var(--muted-foreground)]">Custom colour</span>
                </div>
              </div>
              <button
                type="button"
                onClick={applyDisplay}
                className="rounded-lg bg-sb-accent px-3 py-2 text-sm font-medium text-black hover:opacity-90"
              >
                Apply display settings
              </button>
              {displayApplied && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">Display settings applied.</p>
              )}
            </div>
            </div>
            )}
          </section>

          {/* Subscription */}
          <section>
            <button
              type="button"
              onClick={() => setOpenSection((s) => (s === "subscription" ? null : "subscription"))}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--foreground)]/5"
              aria-expanded={openSection === "subscription"}
            >
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
                Subscription
              </h3>
              <svg
                className={`h-5 w-5 shrink-0 text-[var(--muted-foreground)] transition-transform ${openSection === "subscription" ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSection === "subscription" && (
            <div className="border-t border-[var(--surface-border)] px-4 pb-4 pt-2">
              <p className="text-sm font-medium text-[var(--foreground)]">Your plan</p>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                {subscriptionPlan === "loading"
                  ? "Loading…"
                  : subscriptionPlan ?? "No active subscription"}
              </p>
              {subscriptionLockoutAt && (
                <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                  {subscriptionStatus === "trialing" ? (
                    <>
                      Basic subscription. Next billing on{" "}
                      {new Date(subscriptionLockoutAt).toLocaleDateString(undefined, {
                        dateStyle: "long",
                      })}
                      .
                    </>
                  ) : subscriptionStatus === "canceled" ? (
                    <>
                      Your subscription will end on{" "}
                      {new Date(subscriptionLockoutAt).toLocaleDateString(undefined, {
                        dateStyle: "long",
                      })}
                      . You keep access until then.
                    </>
                  ) : (
                    <>
                      Your subscription will end on{" "}
                      {new Date(subscriptionLockoutAt).toLocaleDateString(undefined, {
                        dateStyle: "long",
                      })}
                      .
                    </>
                  )}
                </p>
              )}
              {(subscriptionStatus === "active" || subscriptionStatus === "trialing") && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      setCancelSubscriptionError(null);
                      setShowCancelConfirm(true);
                    }}
                    className="rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)]"
                  >
                    Cancel subscription
                  </button>
                </div>
              )}
              {showCancelConfirm && (
                <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    Cancel subscription?
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                    You’ll keep access until{" "}
                    {subscriptionLockoutAt
                      ? new Date(subscriptionLockoutAt).toLocaleDateString(undefined, {
                          dateStyle: "long",
                        })
                      : "the end of your billing period"}
                    . After that you’ll need to resubscribe to continue.
                  </p>
                  {cancelSubscriptionError && (
                    <p className="mt-2 text-sm text-red-500">{cancelSubscriptionError}</p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowCancelConfirm(false);
                        setCancelSubscriptionError(null);
                      }}
                      disabled={cancelSubscriptionLoading}
                      className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium hover:bg-[var(--foreground)]/5"
                    >
                      Keep subscription
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmCancelSubscription()}
                      disabled={cancelSubscriptionLoading}
                      className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {cancelSubscriptionLoading ? "Cancelling…" : "Yes, cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>
            )}
          </section>

          {/* Log out */}
          <section className="border-t border-[var(--surface-border)]">
            <div className="px-4 py-4">
              <SignOutButton signOutOptions={{ redirectUrl: "/" }}>
                <button
                  type="button"
                  className="w-full rounded-lg border border-[var(--surface-border)] bg-transparent px-4 py-2.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                >
                  Log out
                </button>
              </SignOutButton>
            </div>
          </section>
        </div>
      </div>

      {/* FAQ modal */}
      {faqModalOpen && (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="faq-modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFaqModalOpen(false);
          }}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3">
              <h2 id="faq-modal-title" className="text-lg font-semibold text-[var(--foreground)]">
                FAQ
              </h2>
              <button
                type="button"
                onClick={() => setFaqModalOpen(false)}
                className="rounded p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/10 hover:text-[var(--foreground)]"
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-5 px-4 py-4 text-sm">
              <div>
                <h3 className="font-semibold text-[var(--foreground)]">What is Seller Bunker?</h3>
                <p className="mt-1 text-[var(--muted-foreground)]">
                  Seller Bunker is your dashboard for FBA selling. Connect your Amazon seller account to see inventory, orders, shipments, profit and cost of goods in one place.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-[var(--foreground)]">How do I get around?</h3>
                <p className="mt-1 text-[var(--muted-foreground)]">
                  Use the left sidebar to move between sections: <strong>Dashboard</strong> for an overview, <strong>Inventory</strong> for stock levels, <strong>Orders</strong> for sales, <strong>Shipments</strong> for FBA inbound, and <strong>Cost of goods</strong> to log and track product costs. The settings icon in the top-right opens this menu.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-[var(--foreground)]">Why does data take a while to load?</h3>
                <p className="mt-1 text-[var(--muted-foreground)]">
                  After you connect Amazon, we sync your data in the background. The first sync can take a few minutes depending on how much history you have. Tables and charts load from our servers—if you see a loading state, wait a moment or refresh. You can keep using the app while syncing finishes.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-[var(--foreground)]">Where do I connect Amazon?</h3>
                <p className="mt-1 text-[var(--muted-foreground)]">
                  In the left sidebar at the bottom, use <strong>Connect Amazon for data</strong>. Once connected, you’ll see “Amazon connected” there and data will start syncing.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
