"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

const VAT_OPTIONS = [
  { value: "NON_VAT_REGISTERED", label: "Not VAT registered", description: "We'll show profit and figures without VAT treatment." },
  { value: "VAT_STANDARD", label: "VAT registered (standard)", description: "We'll calculate and show revenue, costs and profit with standard VAT." },
  { value: "VAT_FLAT_RATE", label: "VAT registered (flat rate)", description: "We'll apply flat rate VAT to sales; you can set the % in Settings." },
] as const;

type VatType = (typeof VAT_OPTIONS)[number]["value"];

export function VatOnboardingModal() {
  const { isSignedIn, getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<VatType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const checkVat = useCallback(async () => {
    if (!isSignedIn) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setLoading(false);
        return;
      }
      const res = await fetch(`${baseUrl}/api/orgs/vat-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { vatRegistrationType?: string | null };
      setOpen(data.vatRegistrationType == null || data.vatRegistrationType === "");
    } catch {
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, getToken, baseUrl]);

  useEffect(() => {
    if (!isSignedIn) return;
    void checkVat();
  }, [isSignedIn, checkVat]);

  const handleContinue = async () => {
    if (selected == null) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) {
        setError("Please sign in again.");
        setSaving(false);
        return;
      }
      const today = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const body: Record<string, unknown> = {
        vatRegistrationType: selected,
        vatEffectiveDate: today,
      };
      if (selected === "VAT_FLAT_RATE") {
        body.vatFlatRatePct = 16.5;
      }
      const res = await fetch(`${baseUrl}/api/orgs/vat-settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || "Failed to save. Try again.");
        setSaving(false);
        return;
      }
      setOpen(false);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  if (!open || loading) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vat-onboarding-title"
      aria-describedby="vat-onboarding-desc"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-xl">
        <h2 id="vat-onboarding-title" className="text-lg font-semibold text-[var(--foreground)]">
          Choose your VAT settings
        </h2>
        <p id="vat-onboarding-desc" className="mt-1 text-sm text-[var(--muted-foreground)]">
          So we can calculate and show the correct figures. You can change this later in Settings.
        </p>

        <div className="mt-4 space-y-2">
          {VAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSelected(opt.value)}
              className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                selected === opt.value
                  ? "border-sb-accent bg-sb-accent/10 text-[var(--foreground)]"
                  : "border-[var(--surface-border)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--surface-border)]/80"
              }`}
            >
              <span className="font-medium">{opt.label}</span>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{opt.description}</p>
            </button>
          ))}
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleContinue}
            disabled={selected == null || saving}
            className="rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {saving ? "Saving…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
