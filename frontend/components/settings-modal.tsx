"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
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

const RING_PALETTE = [
  "rgb(2, 242, 170)",
  "rgb(59, 130, 246)",
  "rgb(168, 85, 247)",
  "rgb(236, 72, 153)",
  "rgb(245, 158, 11)",
  "rgb(34, 197, 94)",
  "rgb(239, 68, 68)",
  "rgb(20, 184, 166)",
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

  type SectionKey = "vat" | "display" | "subscription";
  const [openSection, setOpenSection] = useState<SectionKey | null>(null);

  const loadVat = useCallback(async () => {
    setVatLoading(true);
    setVatError(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch("/api/orgs/vat-settings", {
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

  useEffect(() => {
    if (open) {
      void loadVat();
      setDisplayBg(backgroundTheme);
      setDisplayRingColor(ringColor);
      setDisplayApplied(false);
      setOpenSection(null);
    }
  }, [open, loadVat, backgroundTheme, ringColor]);

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
      const res = await fetch("/api/orgs/vat-settings", {
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
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-xl"
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
                  className="rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
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
                          ? "bg-[rgb(2,242,170)] text-black"
                          : "border border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-[var(--foreground)]">Rings colour</p>
                <div className="flex flex-wrap gap-2">
                  {RING_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setDisplayRingColor(color)}
                      className="h-8 w-8 rounded-full border-2 border-[var(--surface-border)] transition hover:scale-110"
                      style={{ backgroundColor: color }}
                      title={color}
                      aria-label={`Choose ${color}`}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="color"
                    value={toHex(displayRingColor)}
                    onChange={(e) => setDisplayRingColor(hexToRgb(e.target.value))}
                    className="h-8 w-8 cursor-pointer rounded border border-[var(--surface-border)] bg-transparent"
                  />
                  <span className="text-xs text-[var(--muted-foreground)]">Custom</span>
                </div>
              </div>
              <button
                type="button"
                onClick={applyDisplay}
                className="rounded-lg bg-[rgb(2,242,170)] px-3 py-2 text-sm font-medium text-black hover:opacity-90"
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
            <p className="text-sm text-[var(--muted-foreground)]">
              Manage your plan and billing. (Coming soon.)
            </p>
            </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
