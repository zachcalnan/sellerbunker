"use client";

import { SignIn, useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { clerkAuthMonochromeAppearance } from "@/lib/clerk-auth-appearance";
import { safeAppRedirectPath } from "@/lib/auth-redirect";

type Props = {
  /** Used when no `redirect_url` query param (Clerk / middleware). */
  defaultRedirect?: string;
};

function clerkErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "errors" in err) {
    const errors = (err as { errors?: Array<{ message?: string; longMessage?: string }> })
      .errors;
    const first = errors?.[0];
    if (first?.longMessage) return first.longMessage;
    if (first?.message) return first.message;
  }
  if (err instanceof Error) return err.message;
  return "Sign-in failed. Please try again.";
}

function EmailPasswordSignInInner({ defaultRedirect = "/dashboard" }: Props) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsFullClerkUi, setNeedsFullClerkUi] = useState(false);

  const redirectUrl = useMemo(() => {
    const fromQuery =
      searchParams.get("redirect_url") ?? searchParams.get("return_url") ?? undefined;
    return safeAppRedirectPath(fromQuery, defaultRedirect);
  }, [searchParams, defaultRedirect]);

  if (!isLoaded) {
    return (
      <p className="text-center text-sm text-[var(--muted-foreground)]">Loading sign-in…</p>
    );
  }
  if (!signIn || !setActive) {
    return (
      <p className="text-center text-sm text-[var(--muted-foreground)]">
        Sign-in is unavailable. Refresh the page.
      </p>
    );
  }

  const activeSignIn = signIn;
  const activateSession = setActive;

  if (needsFullClerkUi) {
    return (
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-lg">
        <Link href="/" className="block text-center">
          <img
            src="/sellerbunker-logo.png"
            alt="SellerBunker"
            className="sellerbunker-logo mx-auto h-24 w-auto max-w-[min(92vw,26rem)] object-contain sm:h-32"
          />
        </Link>
        <p className="text-center text-sm text-[var(--muted-foreground)]">
          Additional verification is required. Complete sign-in below.
        </p>
        <SignIn
          appearance={clerkAuthMonochromeAppearance}
          fallbackRedirectUrl={redirectUrl}
        />
        <button
          type="button"
          className="text-sm text-[var(--foreground)] underline hover:no-underline"
          onClick={() => setNeedsFullClerkUi(false)}
        >
          ← Back to email and password
        </button>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email") ?? "").trim();
    const password = String(new FormData(form).get("password") ?? "");
    if (!email || !password) {
      setError("Enter your email and password.");
      setLoading(false);
      return;
    }

    try {
      await activeSignIn.create({
        strategy: "password",
        identifier: email,
        password,
      });

      if (activeSignIn.status === "complete" && activeSignIn.createdSessionId) {
        await activateSession({ session: activeSignIn.createdSessionId });
        router.push(redirectUrl);
        return;
      }

      if (
        activeSignIn.status === "needs_second_factor" ||
        activeSignIn.status === "needs_first_factor" ||
        activeSignIn.status === "needs_new_password"
      ) {
        setNeedsFullClerkUi(true);
        return;
      }

      setError("Could not complete sign-in. Try again or use full sign-in options below.");
    } catch (err) {
      setError(clerkErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-6 shadow-lg"
    >
      <Link href="/" className="block text-center">
        <img
          src="/sellerbunker-logo.png"
          alt="SellerBunker"
          className="sellerbunker-logo mx-auto h-24 w-auto max-w-[min(92vw,26rem)] object-contain sm:h-32"
        />
      </Link>
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">Sign in</h2>
        <p className="text-xs text-[var(--muted-foreground)]">
          Use the email and password for your SellerBunker account.
        </p>
      </div>
      <div className="space-y-3">
        <div>
          <label htmlFor="sb-signin-email" className="mb-1 block text-xs font-medium text-[var(--foreground)]">
            Email
          </label>
          <input
            id="sb-signin-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none ring-neutral-500/40 placeholder:text-[var(--muted-foreground)] focus:ring-2"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="sb-signin-password" className="mb-1 block text-xs font-medium text-[var(--foreground)]">
            Password
          </label>
          <input
            id="sb-signin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none ring-sb-accent/40 placeholder:text-[var(--muted-foreground)] focus:ring-2"
            placeholder="••••••••"
          />
        </div>
      </div>
      {error ? (
        <p className="rounded-lg border border-neutral-600 bg-neutral-900/80 px-3 py-2 text-sm text-neutral-200">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-white py-2.5 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-xs text-[var(--muted-foreground)]">
        <Link href="/sign-up" className="text-[var(--foreground)] underline hover:text-white">
          Create an account
        </Link>
        {" · "}
        <Link href="/sign-in/full" className="underline hover:no-underline">
          Full sign-in options
        </Link>{" "}
        (password reset, MFA)
      </p>
    </form>
  );
}

/**
 * Single-screen email + password sign-in. Honors Clerk `redirect_url` / `return_url` query params
 * (e.g. after middleware sends user to sign-in). Wrapped in `Suspense` for `useSearchParams`.
 */
export function EmailPasswordSignIn(props: Props) {
  return (
    <Suspense
      fallback={
        <p className="text-center text-sm text-[var(--muted-foreground)]">Loading sign-in…</p>
      }
    >
      <EmailPasswordSignInInner {...props} />
    </Suspense>
  );
}
