"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const START_TRIAL_PATH = "/start-trial";
const BILLING_BYPASSED =
  (process.env.NEXT_PUBLIC_BYPASS_BILLING ?? "").toLowerCase() === "true";

export function SubscriptionGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (BILLING_BYPASSED) {
      setAllowed(true);
      return;
    }
    if (!isLoaded || !isSignedIn) {
      if (isLoaded && !isSignedIn) setAllowed(true);
      return;
    }
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${baseUrl}/api/subscription/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setAllowed(false);
          router.replace(START_TRIAL_PATH);
          return;
        }
        const data = (await res.json()) as { hasAccess?: boolean };
        if (data.hasAccess) {
          setAllowed(true);
        } else {
          setAllowed(false);
          router.replace(START_TRIAL_PATH);
        }
      } catch {
        if (!cancelled) {
          setAllowed(false);
          router.replace(START_TRIAL_PATH);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, router, getToken]);

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
