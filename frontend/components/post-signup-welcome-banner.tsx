"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";

function PostSignupWelcomeBannerInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const welcome = searchParams.get("welcome") === "1";
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  if (!welcome || dismissed) return null;

  return (
    <div
      role="region"
      aria-label="Welcome"
      className="border-b border-sb-accent/25 bg-gradient-to-r from-sb-accent/15 via-sb-accent/10 to-transparent px-4 py-3 md:px-6"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--foreground)]">
            Welcome to SellerBunker
          </p>
          <p className="mt-0.5 text-sm text-[var(--muted-foreground)]">
            Connect your Amazon seller account to sync orders, inventory, and profit — so the dashboard can
            start working for you.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link
            href="/connect-amazon"
            className="inline-flex rounded-lg bg-sb-accent px-4 py-2 text-sm font-semibold text-black no-underline hover:opacity-90"
          >
            Connect Amazon
          </Link>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shown once after sign-up when redirected with `?welcome=1`. */
export function PostSignupWelcomeBanner() {
  return (
    <Suspense fallback={null}>
      <PostSignupWelcomeBannerInner />
    </Suspense>
  );
}
