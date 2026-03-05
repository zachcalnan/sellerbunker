"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { StripeCheckoutButton } from "@/components/stripe-checkout-button";

const accentColor = "rgb(96, 165, 250)";

function StartTrialContent() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [checking, setChecking] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);

  const justPaid = searchParams.get("checkout") === "success";
  const sessionId = searchParams.get("session_id") ?? undefined;
  const [confirming, setConfirming] = useState(false);

  const confirmAndGoToDashboard = async () => {
    if (!sessionId) {
      router.push("/dashboard");
      return;
    }
    setConfirming(true);
    try {
      const token = await getToken({ template: "backend" });
      if (token) {
        const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
        await fetch(`${baseUrl}/api/stripe/confirm-checkout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        });
      }
    } finally {
      setConfirming(false);
    }
    router.push("/dashboard");
  };

  // When we have session_id from Stripe success URL: confirm checkout on backend (records subscription without waiting for webhook)
  useEffect(() => {
    if (!sessionId || !isLoaded || !isSignedIn) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${baseUrl}/api/stripe/confirm-checkout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        });
        if (cancelled) return;
        if (res.ok) {
          setHasAccess(true);
          router.replace("/dashboard");
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, isLoaded, isSignedIn, router, getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/");
      return;
    }
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    async function check() {
      try {
        const token = await getToken({ template: "backend" });
        if (!token) {
          setChecking(false);
          return;
        }
        const res = await fetch(`${baseUrl}/api/subscription/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setChecking(false);
          return;
        }
        const data = (await res.json()) as { hasAccess?: boolean; lockoutAt?: string | null };
        if (data.hasAccess) {
          setHasAccess(true);
          router.replace("/dashboard");
          return;
        }
      } catch {
        // ignore
      }
      setChecking(false);
    }
    check();
  }, [isLoaded, isSignedIn, router, getToken]);

  // After Stripe redirect with ?checkout=success but no session_id (or confirm-checkout not yet done): poll until we have access
  useEffect(() => {
    if (!justPaid || !isLoaded || !isSignedIn || hasAccess) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    const delays = [800, 1800, 3500, 5500, 8500, 12000];
    const timeouts = delays.map((ms) =>
      setTimeout(async () => {
        try {
          const token = await getToken({ template: "backend" });
          if (!token) return;
          const res = await fetch(`${baseUrl}/api/subscription/status`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const data = (await res.json()) as { hasAccess?: boolean; lockoutAt?: string | null };
          if (data.hasAccess) router.replace("/dashboard");
        } catch {
          // ignore
        }
      }, ms)
    );
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [justPaid, isLoaded, isSignedIn, hasAccess, router, getToken]);

  // Just paid: keep showing loading and polling until we redirect to dashboard (don't show the form)
  if (justPaid && !hasAccess) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--background)] px-4 text-center text-[var(--foreground)]">
        <p className="text-[var(--muted-foreground)]">Setting up your account…</p>
        <p className="text-sm text-[var(--muted-foreground)]">Redirecting you to the dashboard.</p>
        <p className="mt-4 text-sm text-[var(--muted-foreground)]">
          <button
            type="button"
            onClick={confirmAndGoToDashboard}
            disabled={confirming}
            className="underline hover:no-underline disabled:opacity-50"
          >
            {confirming ? "Setting up…" : "Click here if you're not redirected"}
          </button>
        </p>
      </div>
    );
  }

  if (!isLoaded || checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <p className="text-[var(--muted-foreground)]">Checking access…</p>
      </div>
    );
  }

  if (hasAccess) {
    return null;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--background)] px-4 text-[var(--foreground)]">
      <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 text-center">
        <h1 className="text-2xl font-bold">Start your 14-day trial</h1>
        <p className="mt-3 text-[var(--muted-foreground)]">
          Add a card to start your free trial. You won&apos;t be charged until the trial ends.
        </p>
        <div className="mt-8">
          <StripeCheckoutButton
            className="w-full rounded-xl px-6 py-3.5 text-base font-semibold text-black transition hover:opacity-90"
            style={{ backgroundColor: accentColor }}
          >
            Continue to checkout
          </StripeCheckoutButton>
        </div>
        <p className="mt-6 text-sm text-[var(--muted-foreground)]">
          <Link href="/" className="underline hover:no-underline">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function StartTrialPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
          <p className="text-[var(--muted-foreground)]">Checking access…</p>
        </div>
      }
    >
      <StartTrialContent />
    </Suspense>
  );
}
