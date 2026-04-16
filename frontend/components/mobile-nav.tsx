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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";
import { SettingsModal } from "./settings-modal";
import { NotificationsDropdown } from "./notifications-dropdown";
import { useFullscreen } from "@/contexts/fullscreen-context";
import { withImpersonateParam } from "@/lib/impersonation";
import { useRefCookie } from "@/hooks/use-ref-cookie";

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
      suppressHydrationWarning
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
      suppressHydrationWarning
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
      suppressHydrationWarning
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
      suppressHydrationWarning
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function FullscreenIcon({ className }: { className?: string }) {
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
      <path d="M4 4h6M14 4h6M20 4v6M20 14v6M20 20h-6M10 20H4M4 20V14M4 10V4" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
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
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const refFromCookie = useRefCookie();
  const searchParams = useSearchParams();
  const devImpersonate = searchParams.get("impersonate");
  const afterSignInUrl = useMemo(() => {
    if (!pathname) return "/dashboard";
    if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) return "/dashboard";
    const q = searchParams.toString();
    return q ? `${pathname}?${q}` : pathname;
  }, [pathname, searchParams]);
  const [open, setOpen] = useState(false);
  const [drawerSlideIn, setDrawerSlideIn] = useState(false);
  const drawerHasOpenedRef = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsMaskOpen, setNotificationsMaskOpen] = useState(false);
  const { setFullscreen } = useFullscreen();
  const { isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const [amazonConnected, setAmazonConnected] = useState<boolean | null>(null);
  const [connectingAmazon, setConnectingAmazon] = useState(false);
  const [disconnectingAmazon, setDisconnectingAmazon] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => setDrawerSlideIn(false), []);

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
      if (!token) {
        setConnectingAmazon(false);
        alert("Please sign in again and try connecting.");
        return;
      }
      const returnOrigin = typeof window !== 'undefined' ? window.location.origin : '';
      const params = new URLSearchParams({ region: 'EU' });
      if (returnOrigin) params.set('returnOrigin', returnOrigin);
      const res = await fetch(`${BASE_URL}/api/amazon/connect?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { url?: string; message?: string };
      if (!res.ok) {
        setConnectingAmazon(false);
        const msg = data?.message ?? res.statusText ?? "Connection request failed.";
        alert(`Could not start Amazon connection: ${msg}`);
        return;
      }
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setConnectingAmazon(false);
        alert("Could not get Amazon sign-in link. Please try again or contact support.");
      }
    } catch (e) {
      setConnectingAmazon(false);
      const msg = e instanceof Error ? e.message : "Network or server error.";
      alert(`Could not start Amazon connection: ${msg}`);
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

  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);

  useEffect(() => {
    if (open) {
      drawerHasOpenedRef.current = false;
      const frame = requestAnimationFrame(() => setDrawerSlideIn(true));
      return () => cancelAnimationFrame(frame);
    } else {
      setDrawerSlideIn(false);
    }
  }, [open]);

  useEffect(() => {
    if (drawerSlideIn) drawerHasOpenedRef.current = true;
  }, [drawerSlideIn]);

  useEffect(() => {
    if (open && !drawerSlideIn && drawerHasOpenedRef.current) {
      const t = setTimeout(() => setOpen(false), 300);
      drawerHasOpenedRef.current = false;
      return () => clearTimeout(t);
    }
  }, [open, drawerSlideIn]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, closeDrawer]);

  // When notifications dropdown shows its full-screen overlay, disable header clicks (e.g. burger)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOpen = () => setNotificationsMaskOpen(true);
    const handleClose = () => setNotificationsMaskOpen(false);
    window.addEventListener("sellerbunker-notifications-open", handleOpen);
    window.addEventListener("sellerbunker-notifications-close", handleClose);
    return () => {
      window.removeEventListener("sellerbunker-notifications-open", handleOpen);
      window.removeEventListener("sellerbunker-notifications-close", handleClose);
    };
  }, []);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 md:hidden">
        <Link
          href="/dashboard"
          prefetch
          title="Go to dashboard"
          className="flex h-full shrink-0 cursor-pointer items-center rounded-lg font-semibold tracking-tight text-[var(--foreground)] no-underline outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-sb-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
          aria-label="Go to dashboard"
        >
          <img
            src="/sellerbunker-logo2.png"
            alt=""
            draggable={false}
            className="sellerbunker-logo h-full w-auto p-2 object-contain object-left"
          />
        </Link>
        <div className="flex items-center gap-2">
          <NotificationsDropdown variant="iconOnly" />
          <button
            type="button"
            onClick={(e) => {
              if (notificationsMaskOpen) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              setOpen(true);
            }}
            aria-label="Open menu"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
          >
            <BurgerIcon className="h-6 w-6" />
          </button>
        </div>
      </header>

      {open && (
        <>
          <div
            className={`fixed inset-0 z-40 bg-[#0006] backdrop-blur-[20px] transition-opacity duration-300 ease-out md:hidden ${drawerSlideIn ? "opacity-100" : "opacity-0"}`}
            aria-hidden
            onClick={closeDrawer}
          />
          <div
            className={`fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col border-l border-[var(--surface-border)] bg-[var(--surface)] shadow-xl transition-transform duration-300 ease-out md:hidden ${drawerSlideIn ? "translate-x-0" : "translate-x-full"}`}
            role="dialog"
            aria-label="Menu"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4">
              <span className="text-sm font-medium text-[var(--muted-foreground)]">
                Menu
              </span>
              <button
                type="button"
                onClick={closeDrawer}
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
                  onClick={closeDrawer}
                >
                  Home
                </Link>
              </SignedOut>

              <SignedIn>
                <Link
                  href={withImpersonateParam("/dashboard", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/dashboard"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <DashboardIcon className="h-4 w-4 shrink-0" />
                  Dashboard
                </Link>

                <Link
                  href={withImpersonateParam("/cost-of-goods", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/cost-of-goods"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <CostOfGoodsIcon className="h-4 w-4 shrink-0" />
                  Cost of Goods
                </Link>

                <Link
                  href={withImpersonateParam("/inventory", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/inventory"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <InventoryIcon className="h-4 w-4 shrink-0" />
                  Inventory
                </Link>

                <Link
                  href={withImpersonateParam("/orders", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/orders"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <OrdersIcon className="h-4 w-4 shrink-0" />
                  Orders
                </Link>

                <Link
                  href={withImpersonateParam("/shipments", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/shipments"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <ShipmentsIcon className="h-4 w-4 shrink-0" />
                  FBA Shipments
                </Link>

                <Link
                  href={withImpersonateParam("/replenish", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/replenish"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                >
                  <ReplenishIcon className="h-4 w-4 shrink-0" />
                  Replenish
                </Link>

                <div
                  title="Coming soon"
                  className="flex cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--muted-foreground)] opacity-70 blur-[0.5px] transition-all hover:opacity-90 hover:blur-0"
                  aria-disabled="true"
                >
                  <FbmOrdersIcon className="h-4 w-4 shrink-0" />
                  FBM Orders
                </div>

                <Link
                  href={withImpersonateParam("/repricer", devImpersonate)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium no-underline transition-colors ${
                    pathname === "/repricer"
                      ? "bg-sb-accent text-black"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                  onClick={closeDrawer}
                  title="Password protected (testing)"
                >
                  <RepricerIcon className="h-4 w-4 shrink-0" />
                  Repricer
                </Link>
              </SignedIn>

              <div className="my-2 h-px bg-[var(--surface-border)]" />

              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    closeDrawer();
                    setFullscreen(true);
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)]"
                >
                  <FullscreenIcon className="h-4 w-4 shrink-0" />
                  Full screen dashboard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeDrawer();
                    setSettingsOpen(true);
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)]"
                >
                  <SettingsIcon className="h-4 w-4 shrink-0" />
                  Settings
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <LanguageSelector />
                <ThemeToggle />
              </div>

              <div className="min-h-0 flex-1" aria-hidden="true" />

              <div className="flex flex-col gap-2 border-t border-[var(--surface-border)] pt-4">
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
                </div>

                <SignedOut>
                  <div className="flex flex-col gap-2">
                    <SignInButton forceRedirectUrl={afterSignInUrl}>
                      <button
                        onClick={closeDrawer}
                        className="w-full cursor-pointer rounded-lg border border-[var(--surface-border)] bg-transparent px-3 py-2.5 text-left text-sm font-medium text-[var(--foreground)]"
                      >
                        Sign in
                      </button>
                    </SignInButton>
                    <SignUpButton
                      forceRedirectUrl="/dashboard?welcome=1"
                      unsafeMetadata={
                        refFromCookie ? { ref: refFromCookie } : undefined
                      }
                    >
                      <button
                        onClick={closeDrawer}
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
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOptionsOpen(false);
                            closeDrawer();
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
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
