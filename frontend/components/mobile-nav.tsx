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
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const { signOut } = useClerk();
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
        headers: { Authorization: `Bearer ${token}` },
      });
      setAmazonConnected(res.ok);
    } catch {
      setAmazonConnected(false);
    }
  }, [isSignedIn, getToken]);

  useEffect(() => {
    if (!isSignedIn) {
      setAmazonConnected(null);
      return;
    }
    void fetchAmazonStatus();
  }, [isSignedIn, fetchAmazonStatus]);

  const connectAmazon = async () => {
    if (!isSignedIn) return;
    setConnectingAmazon(true);
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const res = await fetch(`${BASE_URL}/api/amazon/connect?region=EU`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { url?: string };
      if (data?.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }
    } finally {
      setConnectingAmazon(false);
    }
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
      if (res.ok) await fetchAmazonStatus();
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
              <SignedOut>
                <Link
                  href="/"
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  onClick={() => setOpen(false)}
                >
                  Home
                </Link>
              </SignedOut>

              <SignedIn>
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

                <Link
                  href="/cost-of-goods"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/cost-of-goods"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={() => setOpen(false)}
                >
                  <CostOfGoodsIcon className="h-4 w-4 shrink-0" />
                  Cost of Goods
                </Link>

                <Link
                  href="/inventory"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/inventory"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={() => setOpen(false)}
                >
                  <InventoryIcon className="h-4 w-4 shrink-0" />
                  Inventory
                </Link>

                <Link
                  href="/orders"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/orders"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={() => setOpen(false)}
                >
                  <OrdersIcon className="h-4 w-4 shrink-0" />
                  Orders
                </Link>

                <Link
                  href="/shipments"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/shipments"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={() => setOpen(false)}
                >
                  <ShipmentsIcon className="h-4 w-4 shrink-0" />
                  FBA Shipments
                </Link>

                <Link
                  href="/replenish"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/replenish"
                      ? "bg-[rgb(2,242,170)] text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={() => setOpen(false)}
                >
                  <ReplenishIcon className="h-4 w-4 shrink-0" />
                  Replenish
                </Link>
              </SignedIn>

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
                  {isSignedIn && amazonConnected === false ? (
                    <button
                      type="button"
                      onClick={connectAmazon}
                      disabled={connectingAmazon}
                      className="cursor-pointer truncate text-left hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                      title="Connect Amazon for data"
                    >
                      {connectingAmazon
                        ? "Opening Amazon…"
                        : "Connect Amazon for data"}
                    </button>
                  ) : isSignedIn && amazonConnected === true ? (
                    <span className="truncate">Amazon connected</span>
                  ) : (
                    <span className="truncate">
                      {isSignedIn ? "Authenticated" : "Sign in for data"}
                    </span>
                  )}
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
                  <div className="relative" ref={optionsRef}>
                    <button
                      type="button"
                      onClick={() => setOptionsOpen((o) => !o)}
                      className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2.5 text-left text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
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
                        className="absolute left-0 right-0 top-full z-10 mt-1 flex flex-col overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] shadow-lg"
                        role="menu"
                      >
                        <Link
                          href="/settings"
                          role="menuitem"
                          onClick={() => {
                            setOptionsOpen(false);
                            setOpen(false);
                          }}
                          className="block px-3 py-2.5 text-left text-sm text-[var(--foreground)] no-underline hover:bg-[var(--foreground)]/10"
                        >
                          Settings
                        </Link>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOptionsOpen(false);
                            setOpen(false);
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
            </nav>
          </div>
        </>
      )}
    </>
  );
}
