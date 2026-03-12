"use client";

import { useAuth, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useDisplaySettings } from "@/contexts/display-settings-context";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

export default function SettingsPage() {
  const { isSignedIn, getToken } = useAuth();
  const [settings, setSettings] = useState<VatSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState({
    vatRegistrationType: "NON_VAT_REGISTERED",
    vatEffectiveDate: "",
    vatFlatRatePct: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${BASE_URL}/api/orgs/vat-settings`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load settings.");
      const data = (await res.json()) as VatSettings;
      setSettings(data);
      setForm({
        vatRegistrationType: data.vatRegistrationType ?? "NON_VAT_REGISTERED",
        vatEffectiveDate: data.vatEffectiveDate ? data.vatEffectiveDate.slice(0, 10) : "",
        vatFlatRatePct: data.vatFlatRatePct != null ? String(data.vatFlatRatePct) : "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isSignedIn) void load();
  }, [isSignedIn, load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = await getToken({ template: "backend" });
      const body: Record<string, unknown> = {
        vatRegistrationType: form.vatRegistrationType,
      };
      if (form.vatEffectiveDate.trim())
        body.vatEffectiveDate = form.vatEffectiveDate.trim() + "T00:00:00.000Z";
      else body.vatEffectiveDate = null;
      if (form.vatRegistrationType === "VAT_FLAT_RATE" && form.vatFlatRatePct.trim()) {
        const pct = Number(form.vatFlatRatePct);
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
      setNotice("Settings saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  const isFlatRate = form.vatRegistrationType === "VAT_FLAT_RATE";

  const { backgroundClass } = useDisplaySettings();

  return (
    <div className={`flex min-h-screen flex-col gap-6 ${backgroundClass} p-4 md:p-6`}>
      <SignedOut>
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <p className="text-[var(--muted-foreground)]">Sign in to change settings.</p>
          <SignInButton>
            <button className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold text-[var(--foreground)]">Settings</h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          VAT registration controls how profit and costs are shown and calculated. You can change this at any time; use the effective date so the app knows when to start using the new treatment.
        </p>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted-foreground)]">
            {notice}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-[var(--muted-foreground)]">Loading…</div>
        ) : (
          <div className="max-w-lg space-y-6 rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-4">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                VAT registration
              </label>
              <select
                value={form.vatRegistrationType}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    vatRegistrationType: e.target.value as VatSettings["vatRegistrationType"],
                  }))
                }
                className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
              >
                {VAT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                VAT effective date
              </label>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                From this date onwards, the app uses the VAT treatment above. Leave empty to apply from now.
              </p>
              <input
                type="date"
                value={form.vatEffectiveDate}
                onChange={(e) => setForm((prev) => ({ ...prev, vatEffectiveDate: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
              />
            </div>

            {isFlatRate && (
              <div>
                <label className="block text-sm font-medium text-[var(--foreground)]">
                  Flat rate VAT (%)
                </label>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  Applied to sales only; you enter gross costs with no VAT split.
                </p>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  value={form.vatFlatRatePct}
                  onChange={(e) => setForm((prev) => ({ ...prev, vatFlatRatePct: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-sb-accent"
                />
              </div>
            )}

            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        )}
      </SignedIn>
    </div>
  );
}
