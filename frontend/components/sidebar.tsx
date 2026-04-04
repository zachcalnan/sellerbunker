"use client";

import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  useAuth,
  useClerk,
} from "@clerk/nextjs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarketplaceSelector } from "./marketplace-selector";
import { DISCORD_INVITE_URL } from "@/lib/discord-invite";
import { getDevImpersonationHeaders, withImpersonateParam } from "@/lib/impersonation";
import { useRefCookie } from "@/hooks/use-ref-cookie";

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

function CostOfGoodsIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="currentColor"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path d="M128 96l0-16c0-44.2 86-80 192-80S512 35.8 512 80l0 16c0 30.6-41.3 57.2-102 70.7-2.4-2.8-4.9-5.5-7.4-8-15.5-15.3-35.5-26.9-56.4-35.5-41.9-17.5-96.5-27.1-154.2-27.1-21.9 0-43.3 1.4-63.8 4.1-.2-1.3-.2-2.7-.2-4.1zM432 353l0-46.2c15.1-3.9 29.3-8.5 42.2-13.9 13.2-5.5 26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zm0-96l0-33c0-4.5-.4-8.8-1-13 15.5-3.9 30-8.6 43.2-14.2s26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zM0 240l0-16c0-44.2 86-80 192-80s192 35.8 192 80l0 16c0 44.2-86 80-192 80S0 284.2 0 240zm384 96c0 44.2-86 80-192 80S0 380.2 0 336l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3l0 15.4zm0 80.6l0 15.4c0 44.2-86 80-192 80S0 476.2 0 432l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3z" />
    </svg>
  );
}

function InventoryIcon({ className }: { className?: string }) {
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
      <path d="M21 8a2 2 0 0 0-1.2-1.84l-7-3a2 2 0 0 0-1.6 0l-7 3A2 2 0 0 0 3 8v8a2 2 0 0 0 1.2 1.84l7 3a2 2 0 0 0 1.6 0l7-3A2 2 0 0 0 21 16Z" />
      <path d="M3.3 7.2 12 11l8.7-3.8" />
      <path d="M12 22V11" />
    </svg>
  );
}

function OrdersIcon({ className }: { className?: string }) {
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
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function ShipmentsIcon({ className }: { className?: string }) {
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
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18h2" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
    </svg>
  );
}

function ReplenishIcon({ className }: { className?: string }) {
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
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  );
}

function FbmOrdersIcon({ className }: { className?: string }) {
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
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function RepricerIcon({ className }: { className?: string }) {
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
      <path d="M12 2v4" />
      <path d="m4.93 4.93 2.83 2.83" />
      <path d="M2 12h4" />
      <path d="m4.93 19.07 2.83-2.83" />
      <path d="M12 18v4" />
      <path d="m19.07 19.07-2.83-2.83" />
      <path d="M22 12h-4" />
      <path d="m19.07 4.93-2.83 2.83" />
    </svg>
  );
}

function PpcIcon({ className }: { className?: string }) {
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
      <path d="m3 11 18-5v12L3 13v-2z" />
      <path d="M11 13v6" />
      <path d="M8 19h6" />
    </svg>
  );
}

const NAV_ITEMS: {
  label: string;
  href: string;
  icon?: typeof DashboardIcon;
  disabled?: boolean;
  tooltip?: string;
}[] = [
  { label: "Dashboard", href: "/dashboard", icon: DashboardIcon },
  { label: "Cost of Goods", href: "/cost-of-goods", icon: CostOfGoodsIcon },
  { label: "Inventory", href: "/inventory", icon: InventoryIcon },
  { label: "Orders", href: "/orders", icon: OrdersIcon },
  { label: "FBA Shipments", href: "/shipments", icon: ShipmentsIcon },
  { label: "Replenish", href: "/replenish", icon: ReplenishIcon },
  { label: "FBM Orders", href: "#", icon: FbmOrdersIcon, disabled: true, tooltip: "Coming soon" },
  { label: "Repricer", href: "#", icon: RepricerIcon, disabled: true, tooltip: "In development" },
  { label: "PPC", href: "#", icon: PpcIcon, disabled: true, tooltip: "Coming soon" },
];

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function Sidebar() {
  const { isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const refFromCookie = useRefCookie();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const [amazonConnected, setAmazonConnected] = useState<boolean | null>(null);
  const [connectingAmazon, setConnectingAmazon] = useState(false);
  const [disconnectingAmazon, setDisconnectingAmazon] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  const fetchAmazonStatus = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      const res = await fetch(`${BASE_URL}/api/amazon/account/summary`, {
        headers: { Authorization: `Bearer ${token}`, ...getDevImpersonationHeaders(devImpersonate) },
      });
      setAmazonConnected(res.ok);
    } catch {
      setAmazonConnected(false);
    }
  }, [isSignedIn, getToken, devImpersonate]);

  useEffect(() => {
    if (!isSignedIn) {
      setAmazonConnected(null);
      return;
    }
    void fetchAmazonStatus();
  }, [isSignedIn, fetchAmazonStatus]);

  const connectAmazon = async () => {
    if (!isSignedIn) return;
    router.push(withImpersonateParam("/connect-amazon", devImpersonate));
  };

  const disconnectAmazon = async () => {
    if (!isSignedIn) return;
    setOptionsOpen(false);
    setDisconnectingAmazon(true);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const res = await fetch(`${BASE_URL}/api/amazon/disconnect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        try {
          sessionStorage.removeItem("sellerbunker_initial_sync_pending");
          window.dispatchEvent(new CustomEvent("sellerbunker-amazon-disconnected"));
        } catch {}
        setAmazonConnected(false);
        await fetchAmazonStatus();
        router.refresh();
      }
    } finally {
      setDisconnectingAmazon(false);
    }
  };

  useEffect(() => {
    if (!optionsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (optionsRef.current?.contains(e.target as Node)) return;
      setOptionsOpen(false);
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [optionsOpen]);

  return (
    <aside className="flex gap-4 h-screen w-full flex-col border-r border-[var(--surface-border)] bg-[var(--surface)]">
      <Link
        href={withImpersonateParam("/dashboard", devImpersonate)}
        prefetch
        title="Go to dashboard"
        className="inline-flex w-fit shrink-0 cursor-pointer rounded-lg no-underline outline-none transition-[opacity,box-shadow] hover:opacity-90 focus-visible:ring-2 focus-visible:ring-sb-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
        aria-label="Go to dashboard"
      >
        <img
          src="/sellerbunker-logo2.png"
          alt=""
          draggable={false}
          className="sellerbunker-logo h-full max-h-20 w-auto p-4 object-contain object-left"
        />
      </Link>
      <nav className="flex-col gap-0.5 px-2" aria-label="Main">
        <SignedIn>
          {NAV_ITEMS.map(({ label, href, icon: Icon, disabled, tooltip }) => {
            if (disabled) {
              return (
                <div
                  key={label}
                  title={tooltip}
                  className="flex cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] opacity-70 blur-[0.5px] transition-all hover:opacity-90 hover:blur-0"
                  aria-disabled="true"
                >
                  {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                  {label}
                </div>
              );
            }
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={withImpersonateParam(href, devImpersonate)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors ${
                  isActive
                    ? "bg-sb-accent text-black"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                {label}
              </Link>
            );
          })}
        </SignedIn>
      </nav>
      <div className="min-h-0 flex-1" aria-hidden="true" />
      <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--surface-border)] px-4 py-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-center gap-3 py-1">
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Discord"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </a>
            <a
              href="https://instagram.com/sellerbunkerapp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="Instagram"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
              </svg>
            </a>
            <a
              href="https://tiktok.com/@sellerbunker"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              aria-label="TikTok"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
              </svg>
            </a>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--surface-border)]">
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                  isSignedIn ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
              {isSignedIn && amazonConnected === false ? (
                <button
                  type="button"
                  onClick={connectAmazon}
                  disabled={connectingAmazon}
                  className="cursor-pointer truncate text-left hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                  title="Connect Amazon for data"
                >
                  {connectingAmazon ? "Opening Amazon…" : "Connect Amazon for data"}
                </button>
              ) : isSignedIn && amazonConnected === true ? (
                <span className="truncate">Amazon connected</span>
              ) : (
                <span className="truncate">
                  {isSignedIn
                    ? "Authenticated"
                    : "Sign in for data"}
                </span>
              )}
            </div>
            <div className="flex items-center justify-center rounded-lg border border-[var(--surface-border)] px-2 py-1">
              <MarketplaceSelector />
            </div>
          </div>
          <SignedOut>
            <SignInButton>
              <button className="w-full cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-left text-sm font-medium text-[var(--foreground)]">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton
              unsafeMetadata={
                refFromCookie ? { ref: refFromCookie } : undefined
              }
            >
              <button className="w-full cursor-pointer rounded-lg bg-indigo-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-indigo-500">
                Sign up
              </button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <div className="relative" ref={optionsRef}>
              <button
                type="button"
                onClick={() => setOptionsOpen((o) => !o)}
                className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2 text-left text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                aria-expanded={optionsOpen}
                aria-haspopup="true"
              >
                <span>Options</span>
                <svg
                  className={`h-4 w-4 shrink-0 transition-transform ${optionsOpen ? "rotate-180" : ""}`}
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {optionsOpen && (
                <div
                  className="absolute bottom-full left-0 right-0 mb-1 flex flex-col overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] shadow-lg"
                  role="menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOptionsOpen(false);
                      void signOut({ redirectUrl: "/" });
                    }}
                    className="cursor-pointer px-3 py-2.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/10"
                  >
                    Log out
                  </button>
                  {amazonConnected === true && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void disconnectAmazon()}
                      disabled={disconnectingAmazon}
                      className="cursor-pointer px-3 py-2.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {disconnectingAmazon ? "Disconnecting…" : "Disconnect Amazon"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </SignedIn>
        </div>
      </div>
    </aside>
  );
}
