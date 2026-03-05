"use client";

import { SignIn, SignOutButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect } from "react";

export default function SignInPage() {
  const { isSignedIn, isLoaded } = useAuth();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  if (!isLoaded) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--background)]/95 backdrop-blur-md">
        <p className="text-[var(--muted-foreground)]">Loading…</p>
      </div>
    );
  }

  // Already signed in: show a clear page with next step instead of letting Clerk redirect
  if (isSignedIn) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--background)]/95 backdrop-blur-md px-4">
        <div className="absolute left-4 top-4 z-10">
          <Link
            href="/"
            className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline transition hover:bg-[var(--foreground)]/5"
          >
            ← Back
          </Link>
        </div>
        <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 text-center">
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
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--background)]/95 backdrop-blur-md">
      <div className="absolute left-4 top-4 z-10">
        <Link
          href="/"
          className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline transition hover:bg-[var(--foreground)]/5"
        >
          ← Back
        </Link>
      </div>
      <div className="w-auto max-w-md">
        <SignIn fallbackRedirectUrl="/start-trial" />
      </div>
    </div>
  );
}


