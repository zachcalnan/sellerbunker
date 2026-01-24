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

const NAV_ITEMS: {
  label: string;
  href: string;
  icon?: typeof DashboardIcon;
}[] = [{ label: "Dashboard", href: "/", icon: DashboardIcon }];

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function Sidebar() {
  const { user } = useUser();
  const { isSignedIn, getToken } = useAuth();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const pathname = usePathname();
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

  return (
    <aside className="flex h-screen w-full flex-col border-r border-[var(--surface-border)] bg-[var(--surface)]">
      <div className="flex shrink-0 flex-col gap-1 px-4 py-5">
        <Link
          href="/"
          className="font-semibold tracking-tight text-[var(--foreground)] no-underline hover:opacity-80"
        >
          <span className="font-bold">SELLER</span>
          <span className="font-normal">BUNKER</span>
        </Link>
      </div>
      <nav className="flex shrink-0 flex-col gap-0.5 px-2" aria-label="Main">
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
          const isActive = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors ${
                isActive
                  ? "bg-[rgb(2,242,170)] text-black"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {Icon ? (
                <Icon className="h-4 w-4 shrink-0" />
              ) : null}
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1" aria-hidden="true" />
      <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--surface-border)] px-4 py-4">
        <div className="flex flex-col gap-2">
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
            <SignInButton>
              <button className="w-full cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-left text-sm font-medium text-[var(--foreground)]">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button className="w-full cursor-pointer rounded-lg bg-indigo-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-indigo-500">
                Sign up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <div className="flex items-center gap-2 rounded-lg bg-transparent px-3 py-2">
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
      </div>
    </aside>
  );
}
