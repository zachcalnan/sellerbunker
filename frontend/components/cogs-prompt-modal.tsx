"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const COGS_PROMPT_SEEN_KEY = "sellerbunker_cogs_prompt_seen";

export function CogsPromptModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(COGS_PROMPT_SEEN_KEY) === "1") return;

    const onSyncComplete = () => {
      setOpen(true);
    };

    window.addEventListener("sellerbunker-sync-complete", onSyncComplete);
    return () => window.removeEventListener("sellerbunker-sync-complete", onSyncComplete);
  }, []);

  const handleGotIt = () => {
    try {
      localStorage.setItem(COGS_PROMPT_SEEN_KEY, "1");
    } catch {}
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cogs-prompt-title"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-xl">
        <h2 id="cogs-prompt-title" className="text-lg font-semibold text-[var(--foreground)]">
          Next step: fill out your Cost of Goods
        </h2>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          After the sync, add your product costs so your profit and ROI are accurate. You can do this in{" "}
          <strong className="text-[var(--foreground)]">Cost of Goods</strong> in the left sidebar.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <Link
            href="/cost-of-goods"
            className="rounded-lg bg-[rgb(2,242,170)] px-4 py-2 text-sm font-medium text-black hover:opacity-90"
            onClick={handleGotIt}
          >
            Go to Cost of Goods
          </Link>
          <button
            type="button"
            onClick={handleGotIt}
            className="rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
