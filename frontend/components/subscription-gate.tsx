"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";

const BILLING_BYPASSED =
  (process.env.NEXT_PUBLIC_BYPASS_BILLING ?? "").toLowerCase() === "true";

export function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (BILLING_BYPASSED) {
      setAllowed(true);
      return;
    }
    if (!isLoaded) return;
    // Dashboard remains accessible without active subscription.
    // Individual pages/components handle locked-state UI.
    setAllowed(true);
  }, [isLoaded]);

  if (!isLoaded || allowed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <p className="text-[var(--muted-foreground)]">Checking access…</p>
      </div>
    );
  }

  if (!allowed) {
    return null;
  }

  return <>{children}</>;
}
