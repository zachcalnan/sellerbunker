"use client";

import { useEffect, useState } from "react";

type SaleToast = {
  id: number;
  title: string;
  profitLabel: string;
  imageUrl: string | null;
};

type SaleLine = {
  amount: string;
  kind: "profit" | "sale" | "plain";
};

/** Pull the money off the push label. A leading minus is not profit. */
function splitSaleLabel(label: string): SaleLine {
  const trimmed = label.trim();
  const match = trimmed.match(/^(.*)\s+(profit|sale)$/i);
  const amount = (match?.[1] ?? trimmed).trim();
  const word = (match?.[2] ?? "").toLowerCase();
  if (!amount || /^-|£\s*-|£-|−/.test(amount)) {
    return { amount: "New sale", kind: "plain" };
  }
  if (word === "profit") return { amount, kind: "profit" };
  if (word === "sale") return { amount, kind: "sale" };
  return { amount, kind: "plain" };
}

/**
 * In-app toast when a sale push arrives while SellerBunker is open.
 * The figure in green is profit made. A fee recorded as the whole sale
 * used to land here as −£64.99; that minus is not shown.
 */
export function SalePushToast() {
  const [toast, setToast] = useState<SaleToast | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "SB_SALE_PUSH") return;
      const title = String(data.title ?? "New sale").replace(/^Sale\s*[·•\-–—]\s*/i, "");
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

  const line = splitSaleLabel(toast.profitLabel);
  const moneyLine = line.kind === "profit" || line.kind === "sale";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[90] flex justify-center px-3 sm:top-4">
      <div className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-emerald-400/35 bg-[var(--surface)] px-3.5 py-3 shadow-2xl">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--background)]">
          {toast.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={toast.imageUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="text-[10px] text-[var(--muted-foreground)]">Sale</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400">
            New sale
          </p>
          <p className="truncate text-sm text-[var(--foreground)]">{toast.title}</p>
          <p
            className={
              moneyLine
                ? "mt-1 text-xl font-semibold tabular-nums leading-none text-emerald-400"
                : "mt-1 text-base font-semibold tabular-nums leading-none text-[var(--foreground)]"
            }
          >
            {line.amount}
            {line.kind === "profit" ? (
              <span className="ml-1.5 align-middle text-xs font-medium tracking-wide text-emerald-300">
                profit
              </span>
            ) : line.kind === "sale" ? (
              <span className="ml-1.5 align-middle text-xs font-medium tracking-wide text-emerald-300">
                sale
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
