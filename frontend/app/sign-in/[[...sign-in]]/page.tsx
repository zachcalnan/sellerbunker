"use client";

import { SignOutButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo } from "react";
import { EmailPasswordSignIn } from "@/components/email-password-sign-in";
import { navigateAfterAuth, safeAppRedirectPath } from "@/lib/auth-redirect";

function usePostSignInRedirectTarget(): string | null {
  const searchParams = useSearchParams();
  return useMemo(() => {
    const fromQuery =
      searchParams.get("redirect_url") ?? searchParams.get("return_url") ?? undefined;
    if (!fromQuery) return null;
    return safeAppRedirectPath(fromQuery, "/dashboard");
  }, [searchParams]);
}

function SignInPageInner() {
  const { isSignedIn, isLoaded } = useAuth();
  const postSignInRedirect = usePostSignInRedirectTarget();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !postSignInRedirect) return;
    navigateAfterAuth(postSignInRedirect);
  }, [isLoaded, isSignedIn, postSignInRedirect]);

  // Only gate on loaded+signed-in. Waiting on isLoaded alone can hang forever (bad keys, adblock, slow Clerk).
  if (isLoaded && isSignedIn) {
    if (postSignInRedirect) {
      return (
        <div className="clerk-auth-shell fixed inset-0 z-[100] flex flex-col items-center justify-center backdrop-blur-md px-4">
          <p className="text-sm text-[var(--muted-foreground)]">Taking you to your dashboard…</p>
        </div>
      );
    }

    return (
      <div className="clerk-auth-shell fixed inset-0 z-[100] flex flex-col items-center justify-center backdrop-blur-md px-4">
        <div className="absolute left-4 top-4 z-10">
          <Link
            href="/"
            className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline transition hover:bg-[var(--foreground)]/5"
          >
            ← Back
          </Link>
        </div>
        <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 text-center">
          <Link href="/" className="mb-6 inline-block">
            <img
              src="/sellerbunker-logo.png"
              alt="SellerBunker"
              className="sellerbunker-logo mx-auto h-24 w-auto max-w-[min(88vw,26rem)] object-contain sm:h-28"
            />
          </Link>
          <h1 className="text-xl font-semibold text-[var(--foreground)]">You&apos;re already signed in</h1>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">
            Continue to start your trial or go to the dashboard.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/start-trial"
              className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black no-underline transition hover:bg-gray-100"
            >
              Start 14 day trial
            </Link>
            <Link
              href="/dashboard"
              className="rounded-lg border border-[var(--surface-border)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] no-underline transition hover:bg-[var(--foreground)]/5"
            >
              Go to dashboard
            </Link>
          </div>
          <SignOutButton signOutOptions={{ redirectUrl: "/" }}>
            <button
              type="button"
              className="mt-4 text-sm text-[var(--muted-foreground)] underline hover:no-underline"
            >
              Sign out
            </button>
          </SignOutButton>
        </div>
      </div>
    );
  }

  return (
    <div className="clerk-auth-shell fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md p-4">
      <Link
        href="/"
        className="fixed left-4 top-4 z-[10000] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline shadow-lg transition hover:bg-[var(--foreground)]/5"
      >
        ← Back
      </Link>
      <div className="relative z-10 flex w-full max-w-[calc(100vw-2rem)] flex-col items-center justify-center">
        <EmailPasswordSignIn defaultRedirect="/dashboard" />
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="clerk-auth-shell fixed inset-0 z-[100] flex items-center justify-center p-4">
          <p className="text-center text-sm text-[var(--muted-foreground)]">Loading sign-in…</p>
        </div>
      }
    >
      <SignInPageInner />
    </Suspense>
  );
}


