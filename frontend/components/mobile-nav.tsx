"use client";

import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="19 19 38 38"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="0.2"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M 19,19L 36,19L 36,36L 19,36L 19,19 Z M 19,40L 36,40L 36,57L 19,57L 19,40 Z M 40,57L 40,40L 57,40L 57,57L 40,57 Z M 40,36L 40,19L 57,19L 57,36L 40,36 Z" />
    </svg>
  );
}

function BurgerIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const [amazonConnected, setAmazonConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isSignedIn) {
      setAmazonConnected(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        const res = await fetch(`${BASE_URL}/api/amazon/account/summary`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        setAmazonConnected(res.ok);
      } catch {
        if (!cancelled) setAmazonConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open]);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 md:hidden">
        <Link
          href="/"
          className="font-semibold tracking-tight text-[var(--foreground)] no-underline hover:opacity-80"
        >
          <span className="font-bold">SELLER</span>
          <span className="font-normal">BUNKER</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
        >
          <BurgerIcon className="h-6 w-6" />
        </button>
      </header>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col border-l border-[var(--surface-border)] bg-[var(--surface)] shadow-xl md:hidden"
            role="dialog"
            aria-label="Menu"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4">
              <span className="text-sm font-medium text-[var(--muted-foreground)]">
                Menu
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-4">
              <Link
                href="/"
                className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                  pathname === "/"
                    ? "bg-[rgb(2,242,170)] text-black"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
                onClick={() => setOpen(false)}
              >
                <DashboardIcon className="h-4 w-4 shrink-0" />
                Dashboard
              </Link>

              <div className="my-2 h-px bg-[var(--surface-border)]" />

              <div className="flex flex-wrap items-center gap-2">
                <LanguageSelector />
                <ThemeToggle />
              </div>

              <div className="min-h-0 flex-1" aria-hidden="true" />

              <div className="flex flex-col gap-2 border-t border-[var(--surface-border)] pt-4">
                <div className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--surface-border)]">
                  <span
                    className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                      isSignedIn ? "bg-emerald-400" : "bg-amber-400"
                    }`}
                  />
                  <span className="truncate">
                    {isSignedIn
                      ? amazonConnected === true
                        ? "Amazon connected"
                        : amazonConnected === false
                          ? "Connect Amazon for data"
                          : "Authenticated"
                      : "Sign in for data"}
                  </span>
                </div>

                <SignedOut>
                  <div className="flex flex-col gap-2">
                    <SignInButton>
                      <button
                        onClick={() => setOpen(false)}
                        className="w-full cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2.5 text-left text-sm font-medium text-[var(--foreground)]"
                      >
                        Sign in
                      </button>
                    </SignInButton>
                    <SignUpButton>
                      <button
                        onClick={() => setOpen(false)}
                        className="w-full cursor-pointer rounded-lg bg-indigo-600 px-3 py-2.5 text-center text-sm font-medium text-white hover:bg-indigo-500"
                      >
                        Sign up
                      </button>
                    </SignUpButton>
                  </div>
                </SignedOut>
                <SignedIn>
                  <div className="flex items-center gap-2 rounded-lg px-3 py-2.5">
                    <UserButton afterSignOutUrl="/" />
                    {email ? (
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-[var(--muted-foreground)]"
                        title={email}
                      >
                        {email}
                      </span>
                    ) : (
                      <span className="truncate text-xs text-[var(--muted-foreground)]">
                        Account
                      </span>
                    )}
                  </div>
                </SignedIn>
              </div>
            </nav>
          </div>
        </>
      )}
    </>
  );
}
