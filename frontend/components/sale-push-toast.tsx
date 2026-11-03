"use client";

import { useEffect, useState } from "react";

type SaleToast = {
  id: number;
  title: string;
  profitLabel: string;
  imageUrl: string | null;
};

/**
 * In-app green profit toast when a sale push arrives while SellerBunker is open.
 * Lock-screen notifications cannot color text; this matches the app's emerald profit style.
 */
export function SalePushToast() {
  const [toast, setToast] = useState<SaleToast | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "SB_SALE_PUSH") return;
      const title = String(data.title ?? "New sale");
      const profitLabel = String(data.profitLabel ?? data.body ?? "");
      const imageUrl =
        typeof data.icon === "string"
          ? data.icon
          : typeof data.image === "string"
            ? data.image
            : null;
      const id = Date.now();
      setToast({ id, title, profitLabel, imageUrl });
      window.setTimeout(() => {
        setToast((cur) => (cur?.id === id ? null : cur));
      }, 6000);
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[90] flex justify-center px-3 sm:top-4">
      <div className="pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl border border-emerald-500/40 bg-[var(--surface)] px-3 py-2.5 shadow-xl">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--background)]">
          {toast.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={toast.imageUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="text-[10px] text-[var(--muted-foreground)]">Sale</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--foreground)]">
            {toast.title}
          </p>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-emerald-400">
            {toast.profitLabel}
          </p>
        </div>
      </div>
    </div>
  );
}
