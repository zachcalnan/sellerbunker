"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { withImpersonateParam } from "@/lib/impersonation";

function PurchasesRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const impersonate = searchParams.get("impersonate");

  useEffect(() => {
    router.replace(withImpersonateParam("/replenish", impersonate));
  }, [router, impersonate]);

  return (
    <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">
      Redirecting to Replenish…
    </div>
  );
}

export default function PurchasesPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full px-6 py-10 text-sm text-[var(--muted-foreground)]">
          Loading…
        </div>
      }
    >
      <PurchasesRedirect />
    </Suspense>
  );
}
