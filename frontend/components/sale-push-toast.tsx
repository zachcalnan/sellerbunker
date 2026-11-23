"use client";

import { useEffect, useState } from "react";

type SaleToast = {
  id: number;
  title: string;
};

/**
 * In-app toast when a sale push arrives while SellerBunker is open.
 * Title already has `Sold: … — ✅ £X.XX profit` once — do not repeat the amount.
 */
export function SalePushToast() {
  const [toast, setToast] = useState<SaleToast | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "SB_SALE_PUSH") return;
      const title = String(data.title ?? "New sale").replace(/^Sale\s*[·•\-–—]\s*/i, "");
      const id = Date.now();
      setToast({ id, title });
      window.setTimeout(() => {
        setToast((cur) => (cur?.id === id ? null : cur));
      }, 6000);
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  if (!toast) return null;

  const GREEN = "#10B981";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[90] flex justify-center px-3 sm:top-4">
      <div className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-emerald-400/35 bg-[var(--surface)] px-3.5 py-3 shadow-2xl">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl"
          style={{ backgroundColor: GREEN, color: "#fff" }}
          aria-hidden
        >
          ✓
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: GREEN, WebkitTextFillColor: GREEN }}
          >
            New sale
          </p>
          <p className="truncate text-sm font-medium text-[var(--foreground)]">
            {toast.title}
          </p>
        </div>
      </div>
    </div>
  );
}
