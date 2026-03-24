"use client";

import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import Image from "next/image";
import { useState, useRef, useEffect, type ComponentType } from "react";
import { FlagIcon } from "@/components/flags";

const accentColor = "rgb(96, 165, 250)";
const accentMuted = "rgba(96, 165, 250, 0.15)";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const navAuthFadeClass = "transition-opacity duration-400";

let navAuthFadeDone = false;

/** Shows Sign in + Dashboard (→ sign-in page) when signed out OR signed in with no subscription; else Dashboard → /dashboard */
function NavAuthButtons({ skipFade }: { skipFade?: boolean } = {}) {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);
  const [isVisible, setIsVisible] = useState(skipFade || navAuthFadeDone);

  useEffect(() => {
    if (skipFade) return;
    if (isLoaded && isSignedIn && hasSubscription === null) {
      setIsVisible(false);
    }
  }, [skipFade, isLoaded, isSignedIn, hasSubscription]);

  useEffect(() => {
    if (skipFade) return;
    const showingContent = !isLoaded || !isSignedIn || hasSubscription !== null;
    if (showingContent) {
      if (navAuthFadeDone) {
        setIsVisible(true);
        return;
      }
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true);
          navAuthFadeDone = true;
        });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [skipFade, isLoaded, isSignedIn, hasSubscription]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setHasSubscription(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${API_URL}/api/subscription/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { hasAccess?: boolean };
          setHasSubscription(!!data.hasAccess);
        } else {
          setHasSubscription(false);
        }
      } catch {
        if (!cancelled) setHasSubscription(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, getToken]);

  const wrapperClass = `${skipFade ? "" : navAuthFadeClass} flex w-[9.25rem] items-center justify-end gap-1 lg:w-[10.75rem] lg:gap-2 ${skipFade || isVisible ? "opacity-100" : "opacity-0"}`;

  const signInClass =
    "cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)] no-underline transition hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)] lg:py-2 lg:text-sm";
  const dashClass =
    "cursor-pointer rounded-lg bg-white px-2 py-1.5 text-xs font-medium text-black no-underline transition hover:bg-gray-100 lg:px-4 lg:py-2 lg:text-sm";

  // Signed out: plain links — Clerk SignInButton can hang on click; /sign-in page still uses Clerk.
  if (!isLoaded || !isSignedIn) {
    return (
      <div className={wrapperClass}>
        <Link href="/sign-in" className={signInClass}>
          Sign in
        </Link>
        <Link href="/sign-up" className={dashClass}>
          Dashboard
        </Link>
      </div>
    );
  }

  if (hasSubscription === null && !skipFade) {
    return (
      <div className="flex w-[9.25rem] items-center justify-end gap-1 lg:w-[10.75rem] lg:gap-2" aria-hidden>
        <span className="rounded-lg px-2 py-1.5 text-xs lg:py-2 lg:text-sm invisible">Sign in</span>
        <span className="rounded-lg px-2 py-1.5 text-xs lg:px-4 lg:py-2 lg:text-sm invisible">Dashboard</span>
      </div>
    );
  }

  // Signed in with subscription (or skipFade: show Dashboard immediately while subscription loads)
  if (hasSubscription === true || (skipFade && isSignedIn && hasSubscription === null)) {
    return (
      <div className={wrapperClass}>
        <span className="rounded-lg px-2 py-1.5 text-xs lg:py-2 lg:text-sm invisible" aria-hidden>
          Sign in
        </span>
        <Link
          href="/dashboard"
          className="cursor-pointer rounded-lg bg-white px-2 py-1.5 text-xs font-medium text-black no-underline transition hover:bg-gray-100 lg:px-4 lg:py-2 lg:text-sm"
        >
          Dashboard
        </Link>
      </div>
    );
  }

  // Signed in but no subscription
  return (
    <div className={wrapperClass}>
      <Link href="/sign-in" className={signInClass}>
        Sign in
      </Link>
      <Link href="/sign-up" className={dashClass}>
        Dashboard
      </Link>
    </div>
  );
}

/** Divider + Sign in/Dashboard: visible fallbacks while Clerk loads. */
function NavAuthSlot() {
  const { isLoaded } = useAuth();
  if (!isLoaded) {
    return (
      <>
        <div className="ml-1 h-5 w-px bg-[var(--surface-border)] lg:ml-2 lg:h-6" aria-hidden />
        <div className="flex w-[9.25rem] items-center justify-end gap-1 lg:w-[10.75rem] lg:gap-2">
          <a
            href="/sign-in"
            className="cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)] no-underline transition hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)] lg:py-2 lg:text-sm"
          >
            Sign in
          </a>
          <a
            href="/sign-up"
            className="cursor-pointer rounded-lg bg-white px-2 py-1.5 text-xs font-medium text-black no-underline transition hover:bg-gray-100 lg:px-4 lg:py-2 lg:text-sm"
          >
            Dashboard
          </a>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="ml-1 h-5 w-px bg-[var(--surface-border)] lg:ml-2 lg:h-6" />
      <NavAuthButtons skipFade />
    </>
  );
}

const heroCtaBorderClass = "border-2 border-[#1d4ed8] shadow-lg";
const heroCtaClass = `inline-flex rounded-xl px-5 py-2.5 text-sm font-semibold transition sm:px-6 sm:py-3 sm:text-base ${heroCtaBorderClass}`;

/** Hero CTA — use isSignedIn only; SignedOut/SignedIn + opacity fade could render nothing or stay invisible. */
function HeroCtaSlot() {
  const { isLoaded, isSignedIn } = useAuth();
  const discordCta = (
    <a
      href="https://discord.gg/sbDwPbV9"
      target="_blank"
      rel="noopener noreferrer"
      className={`${heroCtaClass} inline-flex min-h-[2.75rem] min-w-0 flex-1 items-center justify-center gap-2 text-black hover:opacity-90 sm:flex-initial`}
      style={{ backgroundColor: accentColor }}
    >
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
      </svg>
      Join the discord
    </a>
  );

  const ctaRowClass =
    "flex w-full min-w-0 flex-row flex-wrap items-stretch gap-3 sm:w-auto sm:flex-nowrap";

  const ctaPair = (
    <div className={ctaRowClass}>
      <Link
        href="/sign-up"
        className={`${heroCtaClass} inline-flex min-h-[2.75rem] min-w-0 flex-1 justify-center text-black hover:opacity-90 sm:flex-initial`}
        style={{ backgroundColor: accentColor }}
      >
        Try free today
      </Link>
      {discordCta}
    </div>
  );

  if (!isLoaded) {
    return (
      <div className={ctaRowClass}>
        <a
          href="/sign-up"
          className={`${heroCtaClass} inline-flex min-h-[2.75rem] min-w-0 flex-1 justify-center text-black hover:opacity-90 sm:flex-initial`}
          style={{ backgroundColor: accentColor }}
        >
          Try free today
        </a>
        {discordCta}
      </div>
    );
  }

  if (!isSignedIn) {
    return ctaPair;
  }

  return (
    <Link
      href="/dashboard"
      className={`${heroCtaClass} inline-flex w-full justify-center text-black hover:opacity-90 sm:w-auto`}
      style={{ backgroundColor: accentColor }}
    >
      Go to dashboard
    </Link>
  );
}

const bottomCtaClass = "inline-flex rounded-xl border border-transparent px-8 py-4 text-lg font-semibold transition";

function BottomCtaSlot() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <a
        href="/sign-up"
        className={`${bottomCtaClass} inline-flex w-full justify-center text-black hover:opacity-90 sm:w-auto`}
        style={{ backgroundColor: accentColor }}
      >
        Join the private beta
      </a>
    );
  }

  if (!isSignedIn) {
    return (
      <Link
        href="/sign-up"
        className={`${bottomCtaClass} inline-flex w-full justify-center text-black hover:opacity-90 sm:w-auto`}
        style={{ backgroundColor: accentColor }}
      >
        Join the private beta
      </Link>
    );
  }

  return (
    <Link
      href="/dashboard"
      className={`${bottomCtaClass} inline-flex w-full justify-center text-black hover:opacity-90 sm:w-auto`}
      style={{ backgroundColor: accentColor }}
    >
      Go to dashboard
    </Link>
  );
}

type MockNavIcon = ComponentType<{ className?: string }>;

function MockIconDashboard({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="19 19 38 38" fill="currentColor" stroke="currentColor" strokeWidth="0.2" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M 19,19L 36,19L 36,36L 19,36L 19,19 Z M 19,40L 36,40L 36,57L 19,57L 19,40 Z M 40,57L 40,40L 57,40L 57,57L 40,57 Z M 40,36L 40,19L 57,19L 57,36L 40,36 Z" />
    </svg>
  );
}

function MockIconCostOfGoods({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" className={className} aria-hidden>
      <path d="M128 96l0-16c0-44.2 86-80 192-80S512 35.8 512 80l0 16c0 30.6-41.3 57.2-102 70.7-2.4-2.8-4.9-5.5-7.4-8-15.5-15.3-35.5-26.9-56.4-35.5-41.9-17.5-96.5-27.1-154.2-27.1-21.9 0-43.3 1.4-63.8 4.1-.2-1.3-.2-2.7-.2-4.1zM432 353l0-46.2c15.1-3.9 29.3-8.5 42.2-13.9 13.2-5.5 26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zm0-96l0-33c0-4.5-.4-8.8-1-13 15.5-3.9 30-8.6 43.2-14.2s26.1-12.2 37.8-20.3l0 15.4c0 26.8-31.5 50.5-80 65zM0 240l0-16c0-44.2 86-80 192-80s192 35.8 192 80l0 16c0 44.2-86 80-192 80S0 284.2 0 240zm384 96c0 44.2-86 80-192 80S0 380.2 0 336l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3l0 15.4zm0 80.6l0 15.4c0 44.2-86 80-192 80S0 476.2 0 432l0-15.4c11.6 8.1 24.5 14.7 37.8 20.3 41.9 17.5 96.5 27.1 154.2 27.1s112.3-9.7 154.2-27.1c13.2-5.5 26.1-12.2 37.8-20.3z" />
    </svg>
  );
}

function MockIconInventory({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M21 8a2 2 0 0 0-1.2-1.84l-7-3a2 2 0 0 0-1.6 0l-7 3A2 2 0 0 0 3 8v8a2 2 0 0 0 1.2 1.84l7 3a2 2 0 0 0 1.6 0l7-3A2 2 0 0 0 21 16Z" />
      <path d="M3.3 7.2 12 11l8.7-3.8" />
      <path d="M12 22V11" />
    </svg>
  );
}

function MockIconOrders({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function MockIconShipments({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18h2" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
    </svg>
  );
}

function MockIconReplenish({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  );
}

function MockIconFbmOrders({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function MockIconRepricer({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
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

const HERO_MOCK_NAV: { label: string; icon: MockNavIcon; disabled?: boolean }[] = [
  { label: "Dashboard", icon: MockIconDashboard },
  { label: "Cost of Goods", icon: MockIconCostOfGoods },
  { label: "Inventory", icon: MockIconInventory },
  { label: "Orders", icon: MockIconOrders },
  { label: "FBA Shipments", icon: MockIconShipments },
  { label: "Replenish", icon: MockIconReplenish },
  { label: "FBM Orders", icon: MockIconFbmOrders, disabled: true },
  { label: "Repricer", icon: MockIconRepricer, disabled: true },
];

function HeroDashboardMock() {
  const donutCards = [
    { label: "Profit", value: "£8,492", sub: "24.9%", color: "#60A5FA" },
    { label: "Sales", value: "£34,130", sub: "Revenue", color: "#818CF8" },
    { label: "Units", value: "2,148", sub: "Sold", color: "#FB923C" },
    { label: "ROI", value: "31%", sub: "ROI", color: "#F472B6" },
  ];
  const salesProfitBars: Array<{ revenuePct: number; profitPct: number }> = [
    { revenuePct: 42, profitPct: 22 },
    { revenuePct: 56, profitPct: 31 },
    { revenuePct: 49, profitPct: 26 },
    { revenuePct: 63, profitPct: 34 },
    { revenuePct: 58, profitPct: 29 },
    { revenuePct: 70, profitPct: 38 },
    { revenuePct: 66, profitPct: 35 },
    { revenuePct: 79, profitPct: 41 },
    { revenuePct: 74, profitPct: 39 },
    { revenuePct: 86, profitPct: 45 },
    { revenuePct: 90, profitPct: 48 },
    { revenuePct: 84, profitPct: 44 },
  ];
  const recentOrders = [
    { title: "Wireless Earbuds Pro", sku: "WB-PRIME-001", price: "£39.99", profit: "£12.25", roi: "31%", thumb: "https://picsum.photos/seed/sb-earbuds/48/48" },
    { title: "Compact Air Purifier", sku: "AIR-HOME-120", price: "£52.50", profit: "£14.80", roi: "28%", thumb: "https://picsum.photos/seed/sb-purifier/48/48" },
    { title: "LED Desk Lamp", sku: "OFFICE-LAMP-2", price: "£24.95", profit: "£6.40", roi: "25%", thumb: "https://picsum.photos/seed/sb-lamp/48/48" },
    { title: "Silicone Kitchen Set", sku: "KITCH-SET-8", price: "£19.99", profit: "£5.20", roi: "26%", thumb: "https://picsum.photos/seed/sb-kitchen/48/48" },
  ];
  const inventoryRows = [
    { status: "FBA Available", qty: "1,284", stockValue: "£38,520" },
    { status: "Inbound", qty: "412", stockValue: "£9,880" },
    { status: "Reserved", qty: "96", stockValue: "£2,430" },
  ];
  const categoryTiles = [
    { title: "Sales", segments: [{ c: "#4F46E5", l: "Electronics", v: "£18k" }, { c: "#10B981", l: "Home", v: "£9k" }] },
    { title: "Profit", segments: [{ c: "#F59E0B", l: "Sports", v: "£4.2k" }, { c: "#EC4899", l: "Toys", v: "£2.1k" }] },
    { title: "ROI", segments: [{ c: "#60A5FA", l: "Beauty", v: "42%" }, { c: "#818CF8", l: "Kitchen", v: "31%" }] },
    { title: "Units", segments: [{ c: "#FB923C", l: "OA", v: "820" }, { c: "#34D399", l: "PL", v: "340" }] },
  ];
  const costRows = [
    { label: "Total COGS", value: "£12,400.00" },
    { label: "Referral (sales fee)", value: "£4,820.50" },
    { label: "FBA (sales fee)", value: "£3,110.25" },
    { label: "Prep fees", value: "£640.00" },
  ];
  const topSellerRows = [
    { title: "Wireless Earbuds Pro", sku: "WB-PRIME-001", qty: "412", rev: "£12,420", profit: "£3,890" },
    { title: "Fitness Smart Band", sku: "FIT-BAND-02", qty: "298", rev: "£8,940", profit: "£2,100" },
    { title: "Pet Water Fountain", sku: "PET-H2O-1", qty: "156", rev: "£4,680", profit: "£1,240" },
  ];

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#050505] shadow-[0_20px_60px_-24px_rgba(2,6,23,0.8)]">
      <div className="border-b border-[#262626] bg-[#0b0b0b]">
        <div className="flex h-11 min-w-0 items-center justify-between gap-1.5 px-2 sm:h-12 sm:gap-2 sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
            <img src="/sellerbunker-logo2.png" alt="SellerBunker" className="h-5 w-auto shrink-0 object-contain sm:h-6" />
            <span className="hidden shrink-0 text-[10px] font-medium uppercase tracking-[0.2em] text-[#9ca3af] md:inline">
              Dashboard
            </span>
            <span className="hidden h-5 w-px shrink-0 bg-[#333] md:block" aria-hidden />
            <button
              type="button"
              className="flex min-w-0 max-w-[42%] cursor-default items-center gap-1 rounded-lg px-1 py-1 text-[#9ca3af] transition hover:bg-white/5 hover:text-white sm:max-w-[55%] md:max-w-none md:flex-initial md:gap-2 md:px-2 md:py-1.5"
              aria-label="Notifications — sample preview"
            >
              <span className="hidden h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500 ring-2 ring-amber-500/35 sm:inline-flex" aria-hidden />
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md md:h-8 md:w-8" aria-hidden>
                <svg className="h-4 w-4 md:h-[18px] md:w-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </span>
              <span className="truncate text-[8px] font-medium sm:text-[9px] md:text-[10px]">
                <span className="hidden lg:inline">Notifications — Click for details</span>
                <span className="lg:hidden">Alerts</span>
              </span>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            className="flex h-8 w-8 cursor-default items-center justify-center rounded-lg text-[#9ca3af] transition hover:bg-white/5 hover:text-white"
            aria-label="Full screen dashboard"
            title="Full screen"
          >
            <svg className="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
              <path d="M4 4h6M14 4h6M20 4v6M20 14v6M20 20h-6M10 20H4M4 20V14M4 10V4" />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-8 w-8 cursor-default items-center justify-center rounded-lg text-[#9ca3af] transition hover:bg-white/5 hover:text-white"
            aria-label="Settings"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden>
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-8 w-9 cursor-default items-center justify-center rounded-lg text-[#9ca3af] transition hover:bg-white/5 hover:text-white"
            aria-label="Language"
            title="Language"
          >
            <FlagIcon code="gb" className="h-4 w-7 rounded-sm shadow-sm" />
          </button>
          <div
            className="inline-flex h-8 cursor-default items-center gap-1.5 rounded-full px-2 text-[#9ca3af] sm:gap-2 sm:pl-2 sm:pr-2.5"
            aria-hidden
            title="Dark mode"
          >
            <span className="relative flex h-3.5 w-6 items-center rounded-full bg-[#333] sm:h-4 sm:w-7">
              <span className="inline-block h-2.5 w-2.5 translate-x-3 rounded-full bg-white sm:h-3 sm:w-3 sm:translate-x-3.5" />
            </span>
            <span className="hidden text-[9px] font-medium uppercase tracking-[0.16em] text-[#9ca3af] sm:inline">
              Dark
            </span>
          </div>
        </div>
        </div>

        <div
          className="flex items-center gap-2 border-b-2 border-[#60A5FA]/45 bg-[#080808] px-3 py-1.5 sm:px-4 sm:py-2"
          role="status"
          aria-label="Sample alerts"
        >
          <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-amber-400 sm:text-[9px]">
            Alert
          </span>
          <p className="min-w-0 flex-1 text-[8px] leading-snug text-[#d1d5db] sm:text-[10px]">
            12 units may be missing from inbound shipments — open Notifications to review. 3 SKUs still need cost data for accurate ROI.
          </p>
          <button
            type="button"
            className="hidden shrink-0 rounded p-1 text-[#6b7280] transition hover:bg-white/5 hover:text-[#d1d5db] sm:block"
            aria-label="Dismiss preview"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[#262626] bg-[#0a0a0a] px-3 py-1.5 sm:px-4 sm:py-2">
          <span className="hidden shrink-0 text-[9px] font-medium text-white sm:inline sm:text-[10px]">Orders sync</span>
          <div className="h-1.5 min-w-[72px] flex-1 rounded-full bg-[#60A5FA]/20 sm:min-w-[120px] sm:max-w-[220px]">
            <div className="h-full w-[72%] rounded-full bg-[#60A5FA] transition-all" />
          </div>
          <span className="shrink-0 text-[9px] tabular-nums font-medium text-[#9ca3af] sm:text-[10px]">72%</span>
        </div>
      </div>

      <div className="grid h-[min(400px,58vh)] grid-cols-[80px_minmax(0,1fr)] sm:h-[460px] sm:grid-cols-[108px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-[#262626] bg-[#080808]">
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-1.5 text-[9px] sm:gap-1 sm:p-2 sm:text-[10px]">
            {HERO_MOCK_NAV.map((item, idx) => {
              const Icon = item.icon;
              const isActive = idx === 0 && !item.disabled;
              const isDisabled = item.disabled;
              return (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition sm:gap-2 sm:px-2 sm:py-1.5 ${
                    isDisabled
                      ? "cursor-default text-[#6b7280] opacity-75 hover:bg-[#111111] hover:opacity-90"
                      : isActive
                        ? "bg-[#1f2937] text-white"
                        : "text-[#9ca3af] hover:bg-[#111827] hover:text-white"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-90 sm:h-4 sm:w-4" />
                  <span className="min-w-0 leading-tight">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="shrink-0 border-t border-[#262626] px-2 py-3 sm:px-3">
            <div className="flex items-center justify-center gap-2.5 text-[#9ca3af]">
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </span>
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
                </svg>
              </span>
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
                </svg>
              </span>
            </div>
          </div>
        </aside>

        <div className="hero-dashboard-mock-scroll min-h-0 overflow-y-scroll overflow-x-hidden bg-[#050505] pr-1 sm:pr-2">
          <div className="p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex w-full flex-col rounded-2xl border border-[#262626] bg-[#0b0b0b] p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9ca3af]">
                    Performance Snapshot
                  </h2>
                  <span className="text-[10px] text-[#9ca3af]">Last 30 days</span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {donutCards.map((card) => (
                    <div key={card.label} className="flex flex-col items-center gap-2">
                      <div
                        className="flex h-16 w-16 items-center justify-center rounded-full border-[3px] text-center transition-transform duration-200 hover:scale-105"
                        style={{ borderColor: card.color }}
                      >
                        <div className="flex flex-col leading-none">
                          <span className="text-[10px] font-semibold text-white">{card.value}</span>
                          <span className="mt-1 text-[9px] text-[#9ca3af]">{card.sub}</span>
                        </div>
                      </div>
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-[#9ca3af]">{card.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex w-full flex-col rounded-xl bg-[#0b0b0b] p-4 ring-1 ring-[#262626]">
                <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[#9ca3af]">
                  Recent orders
                </h2>
                <div className="max-h-36 overflow-y-auto">
                  <div className="flex w-full items-center gap-2 border-b border-[#262626] pb-1 text-[9px] font-medium uppercase tracking-wider text-[#9ca3af]">
                    <span className="min-w-0 flex-1">Product</span>
                    <div className="flex shrink-0 items-center justify-end gap-2">
                      <span className="w-12 text-center">Price</span>
                      <span className="w-12 text-center">Profit</span>
                      <span className="w-8 text-center">ROI</span>
                    </div>
                  </div>
                  {recentOrders.map((row) => (
                    <div key={row.sku} className="flex items-center gap-2 border-b border-[#262626] py-1.5 text-[10px] last:border-0 hover:bg-[#111111]">
                      <div className="flex min-w-0 flex-1 items-start gap-1.5">
                        <div className="h-6 w-6 shrink-0 overflow-hidden rounded bg-[#111111] ring-1 ring-[#262626]">
                          <img src={row.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-white">{row.title}</p>
                          <p className="text-[9px] text-[#9ca3af]">{row.sku}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-end gap-2 tabular-nums text-white">
                        <span className="w-12 text-center">{row.price}</span>
                        <span className="w-12 text-center">{row.profit}</span>
                        <span className="w-8 text-center">{row.roi}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 w-full flex-col overflow-hidden rounded-xl bg-[#0b0b0b] p-4 ring-1 ring-[#262626]">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-[#9ca3af]">
                    Sales v Profit
                  </h2>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-[9px] text-[#9ca3af]">
                      <span className="h-2 w-2 rounded-sm bg-[#60A5FA]" aria-hidden />
                      Revenue
                    </span>
                    <span className="flex items-center gap-1 text-[9px] text-[#9ca3af]">
                      <span className="h-2 w-2 rounded-sm bg-emerald-500" aria-hidden />
                      Profit
                    </span>
                    <span className="text-[10px] text-[#9ca3af]">30 days</span>
                  </div>
                </div>
                <div className="flex h-32 justify-between gap-0.5 rounded-lg bg-[#030303] px-2 pb-2 pt-3 sm:gap-1">
                  {salesProfitBars.map((row, i) => (
                    <div
                      key={i}
                      className="flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 px-px sm:gap-1"
                    >
                      <div
                        className="min-h-[6px] w-[42%] max-w-[20px] shrink-0 rounded-sm bg-gradient-to-t from-[#60A5FA] to-[#818CF8] opacity-90 shadow-sm shadow-black/40 transition-all duration-200 hover:opacity-100 sm:w-[45%]"
                        style={{ height: `${row.revenuePct}%` }}
                        title="Revenue"
                      />
                      <div
                        className="min-h-[6px] w-[42%] max-w-[20px] shrink-0 rounded-sm bg-gradient-to-t from-emerald-600 to-emerald-400 opacity-95 shadow-sm shadow-black/40 transition-all duration-200 hover:opacity-100 sm:w-[45%]"
                        style={{ height: `${row.profitPct}%` }}
                        title="Profit"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex w-full flex-col rounded-xl bg-[#0b0b0b] p-3 ring-1 ring-[#262626]">
                <h2 className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[#9ca3af]">
                  Inventory summary
                </h2>
                <table className="w-full text-[9px]">
                  <thead>
                    <tr className="border-b border-[#262626] text-[8px] font-medium uppercase tracking-wider text-[#9ca3af]">
                      <th className="py-0.5 pr-1 text-left">Status</th>
                      <th className="py-0.5 px-1 text-center">Qty</th>
                      <th className="py-0.5 pl-1 text-center">Stock value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryRows.map((row) => (
                      <tr key={row.status} className="border-b border-[#262626] last:border-b-0 hover:bg-[#111111]">
                        <td className="py-1 pr-1 text-white">{row.status}</td>
                        <td className="py-1 px-1 text-center tabular-nums text-white">{row.qty}</td>
                        <td className="py-1 pl-1 text-center tabular-nums text-white">{row.stockValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="mt-4 border-t border-[#262626] pt-4">
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9ca3af]">
              Top categories by metric
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {categoryTiles.map((tile) => (
                <div key={tile.title} className="rounded-lg border border-[#262626] bg-[#0b0b0b]/80 p-2 transition hover:bg-[#111111]">
                  <p className="mb-2 text-[9px] font-semibold uppercase tracking-wider text-[#9ca3af]">{tile.title}</p>
                  <div className="space-y-1.5">
                    {tile.segments.map((s) => (
                      <div key={s.l} className="flex items-center justify-between gap-1 text-[9px]">
                        <span className="flex min-w-0 items-center gap-1 text-white">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: s.c }} />
                          <span className="truncate">{s.l}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-[#d1d5db]">{s.v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <div className="flex flex-col rounded-xl bg-[#0b0b0b] p-4 ring-1 ring-[#262626]">
              <h3 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[#9ca3af]">Cost Breakdown</h3>
              <p className="mb-2 text-[9px] text-[#6b7280]">Last 30 days · sample costs</p>
              <table className="w-full text-[10px]">
                <tbody>
                  {costRows.map((r) => (
                    <tr key={r.label} className="border-b border-[#262626] last:border-0">
                      <td className="py-1.5 pr-2 text-[#d1d5db]">{r.label}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums text-white">{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col rounded-xl bg-[#0b0b0b] p-4 ring-1 ring-[#262626]">
              <h3 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[#9ca3af]">Top Sellers (this month)</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[240px] text-[9px]">
                  <thead>
                    <tr className="border-b border-[#262626] text-[8px] font-medium uppercase tracking-wider text-[#9ca3af]">
                      <th className="py-1 pr-1 text-left">Title</th>
                      <th className="py-1 px-1 text-center">Qty</th>
                      <th className="py-1 px-1 text-center">Rev</th>
                      <th className="py-1 pl-1 text-center">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSellerRows.map((r) => (
                      <tr key={r.sku} className="border-b border-[#262626] last:border-0 hover:bg-[#111111]">
                        <td className="max-w-[7rem] truncate py-1 pr-1 font-medium text-white" title={r.title}>{r.title}</td>
                        <td className="py-1 px-1 text-center tabular-nums text-[#d1d5db]">{r.qty}</td>
                        <td className="py-1 px-1 text-center tabular-nums text-[#d1d5db]">{r.rev}</td>
                        <td className="py-1 pl-1 text-center tabular-nums text-emerald-400">{r.profit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="mt-4 mb-1 rounded-xl bg-[#0b0b0b] p-4 ring-1 ring-[#262626]">
            <h3 className="mb-2 text-sm font-medium uppercase tracking-[0.2em] text-[#9ca3af]">Profit &amp; Loss</h3>
            <p className="mb-3 text-[9px] text-[#6b7280]">Sample period · illustrative only</p>
            <table className="w-full text-[10px]">
              <tbody>
                <tr className="border-b border-[#262626]">
                  <td className="py-1.5 text-white">Revenue</td>
                  <td className="py-1.5 text-right tabular-nums text-white">£34,130.00</td>
                </tr>
                <tr className="border-b border-[#262626]">
                  <td className="py-1.5 text-[#9ca3af]">Total selling costs</td>
                  <td className="py-1.5 text-right tabular-nums text-[#d1d5db]">−£21,840.50</td>
                </tr>
                <tr className="border-b border-[#262626]">
                  <td className="py-1.5 text-[#9ca3af]">Total fixed costs</td>
                  <td className="py-1.5 text-right tabular-nums text-[#d1d5db]">−£1,200.00</td>
                </tr>
                <tr className="bg-[#111111]/80 font-semibold">
                  <td className="py-2 text-white">Total profit</td>
                  <td className="py-2 text-right tabular-nums text-emerald-400">£11,089.50</td>
                </tr>
              </tbody>
            </table>
          </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-white/30 transition duration-300 group-hover:ring-white/50" />
    </div>
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

function NavDropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition hover:bg-[var(--foreground)]/5 hover:text-[var(--foreground)] lg:px-3 lg:py-2 lg:text-sm"
        aria-expanded={open}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] py-1 shadow-lg" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Hue rotation per slot so fallback image still shows 5 different accent colours (0, 72, 144, 216, 288 deg). */
const FALLBACK_HUE_ROTATIONS = [0, 72, 144, 216, 288];

/** Five dashboard theme screenshots: 3 on top, 2 below; hover brings one to the front. */
function CustomizableDashboardStack() {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const fallbackSrc = "/dashboard-preview.png";
  const cards = [
    { src: "/dashboard-display-1.png", alt: "Dashboard theme 1" },
    { src: "/dashboard-display-2.png", alt: "Dashboard theme 2" },
    { src: "/dashboard-display-3.png", alt: "Dashboard theme 3" },
    { src: "/dashboard-display-4.png", alt: "Dashboard theme 4" },
    { src: "/dashboard-display-5.png", alt: "Dashboard theme 5" },
  ];
  const getSrc = (i: number) => (failedUrls.has(cards[i].src) ? fallbackSrc : cards[i].src);
  const useFallbackTint = (i: number) => failedUrls.has(cards[i].src);

  return (
    <div className="relative mx-auto grid w-full max-w-7xl grid-cols-3 gap-5 py-5">
      {/* Top row: 3 images */}
      {cards.slice(0, 3).map((item, i) => {
        const isHovered = hoveredIndex === i;
        return (
          <div
            key={i}
            className="relative cursor-pointer transition-all duration-300 ease-out"
            style={{
              zIndex: isHovered ? 50 : i + 1,
              transform: isHovered ? "scale(1.18)" : "scale(1)",
            }}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
              <div
                className="relative aspect-video w-full overflow-hidden rounded-lg"
              style={
                useFallbackTint(i)
                  ? { filter: `hue-rotate(${FALLBACK_HUE_ROTATIONS[i]}deg)` }
                  : undefined
              }
            >
              <Image
                src={getSrc(i)}
                alt={item.alt}
                fill
                className="object-cover object-left"
                sizes="(max-width: 1024px) 33vw, 520px"
                unoptimized
                onError={() => setFailedUrls((prev) => new Set(prev).add(item.src))}
              />
            </div>
          </div>
        );
      })}
      {/* Bottom row: 2 images, centered under the 3 */}
      <div className="col-span-3 flex justify-center gap-5">
        {cards.slice(3, 5).map((item, i) => {
          const idx = i + 3;
          const isHovered = hoveredIndex === idx;
          return (
            <div
              key={idx}
              className="relative w-[calc(33.333%-0.35rem)] max-w-[520px] cursor-pointer transition-all duration-300 ease-out"
              style={{
                zIndex: isHovered ? 50 : idx + 1,
                transform: isHovered ? "scale(1.18)" : "scale(1)",
              }}
              onMouseEnter={() => setHoveredIndex(idx)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <div
                className="relative aspect-video w-full overflow-hidden rounded-lg"
                style={
                  useFallbackTint(idx)
                    ? { filter: `hue-rotate(${FALLBACK_HUE_ROTATIONS[idx]}deg)` }
                    : undefined
                }
              >
                <Image
                  src={getSrc(idx)}
                  alt={item.alt}
                  fill
                  className="object-cover object-left"
                  sizes="(max-width: 1024px) 40vw, 520px"
                  unoptimized
                  onError={() => setFailedUrls((prev) => new Set(prev).add(item.src))}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Something went wrong.");
        return;
      }
      setStatus("success");
      setName("");
      setEmail("");
      setSubject("");
      setMessage("");
    } catch {
      setStatus("error");
      setErrorMessage("Network error. Please try again.");
    }
  }

  return (
    <section id="contact" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
          Get in contact
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-[var(--muted-foreground)]">
          Send us a message and we&apos;ll get back to you at support@sellerbunker.com.
        </p>
        <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-4">
          <div>
            <label htmlFor="contact-name" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Name
            </label>
            <input
              id="contact-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white text-gray-900 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40"
              placeholder="Your name"
            />
          </div>
          <div>
            <label htmlFor="contact-email" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              id="contact-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white text-gray-900 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="contact-subject" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Subject
            </label>
            <input
              id="contact-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white text-gray-900 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40"
              placeholder="What's this about?"
            />
          </div>
          <div>
            <label htmlFor="contact-message" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Message <span className="text-red-400">*</span>
            </label>
            <textarea
              id="contact-message"
              required
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white text-gray-900 placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 resize-y min-h-[120px]"
              placeholder="Your message..."
            />
          </div>
          {status === "success" && (
            <p className="text-sm font-medium text-green-500">Message sent. We&apos;ll reply to your email soon.</p>
          )}
          {status === "error" && (
            <p className="text-sm font-medium text-red-400">{errorMessage}</p>
          )}
          <button
            type="submit"
            disabled={status === "sending"}
            className="rounded-xl px-6 py-3 text-base font-semibold text-black transition disabled:opacity-50"
            style={{ backgroundColor: accentColor }}
          >
            {status === "sending" ? "Sending..." : "Send message"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default function LandingPage() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [drawerSlideIn, setDrawerSlideIn] = useState(false);
  const [heroVisualReady, setHeroVisualReady] = useState(false);
  const [belowHeroReady, setBelowHeroReady] = useState(false);
  const [problemCardsVisible, setProblemCardsVisible] = useState(false);
  const [positivePointsPop, setPositivePointsPop] = useState(false);
  const drawerHasOpenedRef = useRef(false);
  const problemCardsRef = useRef<HTMLDivElement | null>(null);
  const positivePointsRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (mobileNavOpen) {
      drawerHasOpenedRef.current = false;
      const frame = requestAnimationFrame(() => setDrawerSlideIn(true));
      return () => cancelAnimationFrame(frame);
    } else {
      setDrawerSlideIn(false);
    }
  }, [mobileNavOpen]);

  useEffect(() => {
    if (drawerSlideIn) drawerHasOpenedRef.current = true;
  }, [drawerSlideIn]);

  useEffect(() => {
    if (mobileNavOpen && !drawerSlideIn && drawerHasOpenedRef.current) {
      const t = setTimeout(() => setMobileNavOpen(false), 300);
      drawerHasOpenedRef.current = false;
      return () => clearTimeout(t);
    }
  }, [mobileNavOpen, drawerSlideIn]);

  useEffect(() => {
    const heroTimer = setTimeout(() => setHeroVisualReady(true), 120);
    const belowTimer = setTimeout(() => setBelowHeroReady(true), 280);
    return () => {
      clearTimeout(heroTimer);
      clearTimeout(belowTimer);
    };
  }, []);

  useEffect(() => {
    const node = problemCardsRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible) {
          setProblemCardsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.28, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = positivePointsRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible) {
          setPositivePointsPop(true);
          observer.disconnect();
        }
      },
      { threshold: 0.34, rootMargin: "0px 0px -8% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const closeDrawer = () => setDrawerSlideIn(false);

  return (
    <div
      className="min-h-screen min-h-[100dvh] w-full max-w-[100vw] overflow-x-hidden bg-[var(--background)] text-[var(--foreground)]"
      data-theme="dark"
    >
      {/* Force dark theme for landing */}
      <style>{`
        .landing-page {
          --background: #e8ebf0;
          --foreground: #111827;
          --surface: #f3f5f8;
          --surface-border: #cbd5e1;
          --muted-foreground: #475569;
          background-image:
            radial-gradient(1200px 500px at 20% -10%, rgba(255, 255, 255, 0.95), transparent 60%),
            radial-gradient(900px 420px at 85% 0%, rgba(255, 255, 255, 0.65), transparent 60%),
            linear-gradient(180deg, #eef2f7 0%, #e2e8f0 100%);
          background-attachment: fixed;
        }
        .hero-dashboard-mock-scroll {
          scrollbar-gutter: stable;
          scrollbar-width: thin;
          scrollbar-color: #6b7280 #111827;
        }
        .hero-dashboard-mock-scroll::-webkit-scrollbar {
          width: 10px;
        }
        .hero-dashboard-mock-scroll::-webkit-scrollbar-track {
          background: #111827;
          border-radius: 6px;
          margin: 4px 0;
        }
        .hero-dashboard-mock-scroll::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, #6b7280, #4b5563);
          border-radius: 6px;
          border: 2px solid #111827;
        }
        .hero-dashboard-mock-scroll::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, #9ca3af, #6b7280);
        }
        @keyframes positive-point-pop {
          0% {
            transform: scale(1);
            box-shadow: 0 1px 2px rgba(2, 6, 23, 0.08);
          }
          40% {
            transform: scale(1.07);
            box-shadow: 0 18px 35px -18px rgba(2, 6, 23, 0.45);
          }
          100% {
            transform: scale(1);
            box-shadow: 0 1px 2px rgba(2, 6, 23, 0.08);
          }
        }
      `}</style>
      {/* Navigation: on mobile stacked + centered smaller buttons; on lg single row */}
      <div className="w-full border-b border-[var(--surface-border)] bg-[#202225] shadow-[0_10px_30px_-20px_rgba(148,163,184,0.55)]">
        <header className="mx-auto flex h-14 max-w-7xl shrink-0 items-center justify-between gap-3 px-4 lg:h-20 lg:gap-4 lg:border-none lg:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3 md:gap-5 lg:gap-8">
          <Link
            href="/"
            className="flex shrink-0 items-center py-1.5 font-semibold no-underline md:-ml-1 lg:-ml-2"
            aria-label="SellerBunker home"
          >
            <img
              src="/sellerbunker-logo2.png"
              alt="SellerBunker"
              className="sellerbunker-logo block h-7 w-auto max-h-8 max-w-[9.5rem] object-contain object-left sm:h-8 sm:max-h-9 sm:max-w-[11rem] lg:h-9 lg:max-h-10 lg:max-w-[12.5rem]"
            />
          </Link>
          <nav
            className="hidden min-w-0 items-center sm:flex sm:flex-nowrap sm:gap-0"
            aria-label="Site sections"
          >
            <div className="ml-1 border-l border-white/45 pl-3 lg:ml-2 lg:pl-4">
              <NavDropdown label="Product">
                <Link href="#features" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  Features
                </Link>
                <Link href="#dashboard-preview" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  See the dashboard
                </Link>
                <Link href="#how-it-works" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  How it works
                </Link>
                <span className="block px-4 py-2.5 text-sm text-[var(--muted-foreground)]" aria-hidden>
                  Repricer module coming soon
                </span>
              </NavDropdown>
            </div>
            <div className="ml-2 border-l border-white/45 pl-3 lg:ml-3 lg:pl-4">
              <NavDropdown label="Pricing">
                <Link href="#pricing" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  View plans
                </Link>
              </NavDropdown>
            </div>
            <div className="ml-2 border-l border-white/45 pl-3 lg:ml-3 lg:pl-4">
              <NavDropdown label="Get in contact">
                <Link href="#contact" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  Contact form
                </Link>
                <a href="mailto:support@sellerbunker.com" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  Email us
                </a>
                <a href="https://discord.gg/sbDwPbV9" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                  <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
                  </svg>
                  Discord
                </a>
              </NavDropdown>
            </div>
          </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden sm:flex sm:items-center">
              <NavAuthSlot />
            </div>
            <button
              type="button"
              onClick={() => setMobileNavOpen((open) => !open)}
              aria-label="Open menu"
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-[var(--foreground)]/5 sm:hidden"
            >
              <BurgerIcon className="h-6 w-6" />
            </button>
          </div>
        </header>
      </div>

      {/* Mobile nav drawer (matches dashboard style) */}
      {mobileNavOpen && (
        <>
          <div
            className={`fixed inset-0 z-40 bg-[#0006] backdrop-blur-[20px] transition-opacity duration-300 ease-out sm:hidden ${drawerSlideIn ? "opacity-100" : "opacity-0"}`}
            aria-hidden
            onClick={closeDrawer}
          />
          <div
            className={`fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col border-l border-[var(--surface-border)] bg-[var(--surface)] shadow-xl transition-transform duration-300 ease-out sm:hidden ${drawerSlideIn ? "translate-x-0" : "translate-x-full"}`}
            role="dialog"
            aria-label="Menu"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4">
              <span className="text-sm font-medium text-[var(--muted-foreground)]">Menu</span>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close menu"
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-4">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                onClick={() => {
                  document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
                  closeDrawer();
                }}
              >
                <span>Product</span>
              </button>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                onClick={() => {
                  document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" });
                  closeDrawer();
                }}
              >
                <span>Pricing</span>
              </button>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
                onClick={() => {
                  document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" });
                  closeDrawer();
                }}
              >
                <span>Get in contact</span>
              </button>
            </nav>
            <div className="border-t border-[var(--surface-border)] px-3 py-3">
              <div className="flex justify-end">
                <NavAuthButtons skipFade />
              </div>
            </div>
          </div>
        </>
      )}

      <main className="landing-page w-full max-w-[100vw] overflow-x-hidden lg:pt-12">
        {/* 1. Hero - no blurred background, dashboard mockup on the right */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--background)]">
          <div className="mx-auto w-full max-w-[min(100%,88rem)] px-5 pt-5 pb-10 sm:px-6 sm:pt-3 sm:pb-12 lg:px-8 lg:pt-4 lg:pb-16 xl:max-w-[min(100%,96rem)] xl:px-10 2xl:pr-16">
            <div className="grid gap-12 lg:grid-cols-[minmax(20rem,1.1fr)_minmax(0,1.9fr)] lg:gap-10 lg:items-center xl:grid-cols-[minmax(22rem,1fr)_minmax(34rem,2fr)] xl:gap-12">
              <div className="min-w-0 lg:max-w-2xl xl:max-w-[44rem]">
                <h1 className="text-3xl font-bold leading-tight tracking-normal text-[var(--foreground)] sm:text-4xl lg:text-5xl">
                  See your{" "}
                  <span className="whitespace-nowrap">REAL Amazon profit</span>
                  {" "}
                  <span className="whitespace-nowrap">— not just revenue</span>
                </h1>
                <p className="mt-4 max-w-xl text-base leading-relaxed text-[var(--muted-foreground)] sm:mt-4 sm:text-lg">
                  Track profit, inventory, lost shipments and restocking in one simple dashboard
                </p>
                <div className="mt-4 flex flex-wrap gap-3 sm:mt-6 sm:gap-4">
                  <HeroCtaSlot />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-[var(--muted-foreground)] sm:mt-6 sm:gap-6 sm:text-sm">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
                    Built with ease of use in mind
                  </span>
                </div>
              </div>
              <div
                className={`relative mx-auto mt-2 w-full max-w-[980px] transform-gpu transition-all duration-700 ease-out sm:mt-4 lg:mt-0 lg:ml-auto lg:w-[min(100%,920px)] lg:max-w-[920px] lg:translate-x-0 xl:w-[min(100%,1040px)] xl:max-w-[1040px] xl:translate-x-6 2xl:w-[min(100%,1160px)] 2xl:max-w-[1160px] 2xl:translate-x-10 ${heroVisualReady ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
              >
                <div className="rounded-2xl bg-gradient-to-br from-white/80 via-white/35 to-white/5 p-[1.5px] shadow-[0_18px_50px_-28px_rgba(255,255,255,0.65)]">
                  <HeroDashboardMock />
                </div>
              </div>
            </div>
          </div>
        </section>

        <div
          className={`transform-gpu transition-all duration-700 ease-out ${belowHeroReady ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}
        >
        {/* 2. Problem section */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Amazon doesn&apos;t show you the full picture:
            </h2>
            <div className="mx-auto mt-8 grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_80px_minmax(280px,0.88fr)] lg:items-start lg:gap-0">
              <ul className="space-y-3 text-left text-[var(--foreground)] lg:pr-2">
                {[
                  "You don't know your real profit",
                  "Inventory goes missing",
                  "Shipments get delayed",
                  "You restock blindly",
                ].map((item) => (
                  <li
                    key={item}
                    className="flex min-h-[88px] items-center rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]/90 px-5 py-4 text-lg font-semibold leading-snug shadow-sm transition-transform duration-200 ease-out hover:-translate-y-1 hover:scale-[1.015] hover:shadow-[0_12px_26px_-14px_rgba(2,6,23,0.45)] sm:text-[1.15rem]"
                  >
                    <span className="inline-flex items-start gap-3">
                      <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] ring-1 ring-[var(--surface-border)]">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accentColor }} />
                      </span>
                      <span>{item}</span>
                    </span>
                  </li>
                ))}
              </ul>

              <div className="hidden grid-rows-4 gap-3 lg:grid" aria-hidden>
                <svg className="h-[88px] w-full" viewBox="0 0 80 88" preserveAspectRatio="none">
                  <defs>
                    <marker id="problem-connector-arrow" markerWidth="7" markerHeight="7" refX="6.2" refY="3" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L6.5,3 L0,6 z" fill="#64748b" />
                    </marker>
                  </defs>
                  <path d="M6,44 C24,38 56,38 74,44" fill="none" stroke="#64748b" strokeOpacity="0.88" strokeWidth="1.5" markerEnd="url(#problem-connector-arrow)" />
                </svg>
                <svg className="h-[88px] w-full" viewBox="0 0 80 88" preserveAspectRatio="none">
                  <path d="M6,44 C24,38 56,38 74,44" fill="none" stroke="#64748b" strokeOpacity="0.88" strokeWidth="1.5" markerEnd="url(#problem-connector-arrow)" />
                </svg>
                <svg className="h-[88px] w-full" viewBox="0 0 80 88" preserveAspectRatio="none">
                  <path d="M6,44 C24,38 56,38 74,44" fill="none" stroke="#64748b" strokeOpacity="0.88" strokeWidth="1.5" markerEnd="url(#problem-connector-arrow)" />
                </svg>
                <svg className="h-[88px] w-full" viewBox="0 0 80 88" preserveAspectRatio="none">
                  <path d="M6,44 C24,38 56,38 74,44" fill="none" stroke="#64748b" strokeOpacity="0.88" strokeWidth="1.5" markerEnd="url(#problem-connector-arrow)" />
                </svg>
              </div>

              <div ref={problemCardsRef} className="hidden space-y-3 lg:block lg:pl-2">
                <div
                  className={`flex min-h-[88px] items-center rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]/90 p-4 shadow-sm transition-all duration-600 ease-out ${
                    problemCardsVisible ? "translate-x-0 opacity-100" : "-translate-x-8 opacity-0"
                  }`}
                  style={{ transitionDelay: "0ms" }}
                >
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[#dbeafe] text-[#1d4ed8]">
                      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M7 7h7a3 3 0 010 6H9a3 3 0 000 6h8" />
                      </svg>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">Revenue is visible, real margin is hidden.</p>
                  </div>
                </div>
                <div
                  className={`flex min-h-[88px] items-center rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]/90 p-4 shadow-sm transition-all duration-600 ease-out ${
                    problemCardsVisible ? "translate-x-0 opacity-100" : "-translate-x-8 opacity-0"
                  }`}
                  style={{ transitionDelay: "110ms" }}
                >
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[#dcfce7] text-[#166534]">
                      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7" />
                      </svg>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">Stock counts drift between shipped and received.</p>
                  </div>
                </div>
                <div
                  className={`flex min-h-[88px] items-center rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]/90 p-4 shadow-sm transition-all duration-600 ease-out ${
                    problemCardsVisible ? "translate-x-0 opacity-100" : "-translate-x-8 opacity-0"
                  }`}
                  style={{ transitionDelay: "220ms" }}
                >
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[#fef3c7] text-[#b45309]">
                      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h8M8 12h6M3 4h18v16H3z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4l2 2" />
                      </svg>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">Shipments sit in transit without clear ETA.</p>
                  </div>
                </div>
                <div
                  className={`flex min-h-[88px] items-center rounded-xl border border-[var(--surface-border)] bg-[var(--surface)]/90 p-4 shadow-sm transition-all duration-600 ease-out ${
                    problemCardsVisible ? "translate-x-0 opacity-100" : "-translate-x-8 opacity-0"
                  }`}
                  style={{ transitionDelay: "330ms" }}
                >
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-[#ede9fe] text-[#6d28d9]">
                      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h16M12 4l8 8-8 8" />
                      </svg>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">Reorders happen without demand or lead-time confidence.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mx-auto mt-10 max-w-4xl sm:mt-12">
              <div className="relative h-10 overflow-hidden rounded-xl border border-white/20 bg-[var(--surface)]/70 sm:h-12">
                <span className="absolute -left-10 top-1.5 h-[2px] w-24 -rotate-12 bg-gradient-to-r from-transparent via-[#93c5fd] to-transparent opacity-90 sm:top-2" />
                <span className="absolute left-1/4 top-5 h-[2px] w-20 -rotate-[18deg] bg-gradient-to-r from-transparent via-[#60a5fa] to-transparent opacity-80 sm:top-6" />
                <span className="absolute right-1/3 top-3 h-[2px] w-24 -rotate-[14deg] bg-gradient-to-r from-transparent via-[#a78bfa] to-transparent opacity-85 sm:top-4" />
                <span className="absolute right-6 top-7 h-[2px] w-16 -rotate-[24deg] bg-gradient-to-r from-transparent via-[#38bdf8] to-transparent opacity-75 sm:top-8" />
              </div>
            </div>

            <div className="mx-auto mt-14 max-w-5xl rounded-2xl border border-white/20 bg-[var(--background)]/70 p-7 sm:mt-16 sm:p-12">
              <p className="text-center text-3xl font-extrabold tracking-tight text-[var(--foreground)] sm:text-5xl">
                SellerBunker brings everything together:
              </p>
              <ul ref={positivePointsRef} className="mt-8 grid gap-5 sm:mt-12 sm:gap-6 sm:grid-cols-2">
                {[
                  { text: "Real profit tracking", emblem: "📈", person: "🧑‍💻" },
                  { text: "Missing inventory detection", emblem: "🛡️", person: "🧑‍🔬" },
                  { text: "Shipment delay tracking", emblem: "⏱️", person: "🧑‍💼" },
                  { text: "Smart replenishment", emblem: "🎯", person: "🧑‍💼" },
                ].map((item, idx) => (
                  <li
                    key={item.text}
                    className="flex items-center justify-between gap-4 rounded-xl border border-white/30 bg-[var(--surface)]/95 px-6 py-5 text-lg font-semibold leading-snug text-[var(--foreground)] shadow-[0_8px_24px_rgba(0,0,0,0.2)] sm:px-7 sm:py-6 sm:text-xl"
                    style={
                      positivePointsPop
                        ? {
                            animation: "positive-point-pop 760ms cubic-bezier(0.22, 1, 0.36, 1) both",
                            animationDelay: `${idx * 170}ms`,
                            transformOrigin: "center center",
                          }
                        : undefined
                    }
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base font-bold text-black"
                        style={{ backgroundColor: accentColor }}
                      >
                        ✓
                      </span>
                      <span>{item.text}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-white/70 px-2 text-lg" aria-hidden>
                        {item.emblem}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="dashboard-preview" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/50 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h3 className="mb-8 text-center text-xl font-bold text-[var(--foreground)] sm:text-2xl">
              Customise your Amazon dashboard display
            </h3>
            <CustomizableDashboardStack />
          </div>
        </section>

        {/* Track your REAL profit */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--background)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Track your REAL profit
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-[var(--muted-foreground)]">
              We include every cost so you see true profit—not just revenue. Supports both VAT-registered and non-VAT-registered sellers.
            </p>
            <ul className="mx-auto mt-12 flex max-w-2xl flex-col gap-3 sm:mx-0 sm:max-w-none sm:grid sm:grid-cols-2 lg:grid-cols-3">
              {[
                "Amazon fees",
                "VAT",
                "Prep costs",
                "Shipping",
                "Refunds",
                "Lost inventory",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-3 rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-3"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-medium text-black"
                    style={{ backgroundColor: accentColor }}
                  >
                    ✓
                  </span>
                  <span className="text-[var(--foreground)]">{item}</span>
                </li>
              ))}
            </ul>
            <div className="mx-auto mt-14 max-w-sm rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-lg">
              <p className="text-center text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Example: one sale</p>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between text-[var(--foreground)]">
                  <span>Sale price</span>
                  <span className="tabular-nums">£24.99</span>
                </div>
                <div className="flex justify-between text-[var(--muted-foreground)]">
                  <span>Amazon fees (FBA &amp; Referral)</span>
                  <span className="tabular-nums">−£8.40</span>
                </div>
                <div className="flex justify-between text-[var(--muted-foreground)]">
                  <span>Prep cost</span>
                  <span className="tabular-nums">−£0.60</span>
                </div>
                <div className="flex justify-between text-[var(--muted-foreground)]">
                  <span>Inbound shipping</span>
                  <span className="tabular-nums">−£0.50</span>
                </div>
                <div className="flex justify-between text-[var(--muted-foreground)]">
                  <span>VAT</span>
                  <span className="tabular-nums">−£3.40</span>
                </div>
              </div>
              <div className="mt-4 flex justify-between border-t border-[var(--surface-border)] pt-4 text-base font-semibold" style={{ color: accentColor }}>
                <span>True profit</span>
                <span className="tabular-nums">£12.09</span>
              </div>
            </div>
          </div>
        </section>

        {/* 4. Features */}
        <section id="features" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Built for how you sell
            </h2>
            <div className="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Profit analytics</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Track real profit after Amazon fees, cost of goods, shipping, and VAT — in one place.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Inventory tracking</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Never run out of stock again. FBA inventory tracking, stock value, and potential profit visibility.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Order tracking</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Monitor recent orders, profit per order, and ROI per product.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Replenishment tools</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Know exactly when to reorder based on sales velocity.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Sales vs profit analytics</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Visualize performance with sales vs profit charts, snapshots, and time range filters.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Cost breakdown & P&amp;L</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  COGS, referral, FBA fees, VAT adjustment — all in one profit &amp; loss view.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 5. How it works */}
        <section id="how-it-works" className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              How it works
            </h2>
            <div className="mt-16 grid gap-10 md:grid-cols-3">
              {[
                { step: 1, title: "Connect Amazon", desc: "Secure Amazon API integration. Create an account and link your Amazon seller account in minutes." },
                { step: 2, title: "Import your data", desc: "SellerBunker pulls your listings, fees, shipments and last 30 days of order data by default—you can specify up to two years of order data, please email us." },
                { step: 3, title: "Track profit", desc: "After an initial sync, fill out your costs (unit cost, prep, delivery, etc.) and instantly see true profit and business performance in your dashboard." },
              ].map(({ step, title, desc }) => (
                <div key={step} className="relative text-center">
                  <div
                    className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold text-black"
                    style={{ backgroundColor: accentColor }}
                  >
                    {step}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-[var(--foreground)]">{title}</h3>
                  <p className="mt-2 text-[var(--muted-foreground)]">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 6. Who it's for */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              For every type of Amazon seller (FBA &amp; FBM)
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--muted-foreground)]">
              Whether you fulfill through Amazon (FBA) or ship yourself (FBM), and whether you&apos;re VAT registered or not, SellerBunker gives you one view of profit, inventory, and orders.
            </p>
            <div className="mt-16 grid gap-8 md:grid-cols-3">
              {[
                { title: "Online arbitrage (FBA & FBM)", desc: "Track profit across many SKUs. See which products actually make money." },
                { title: "Wholesale sellers (FBA & FBM)", desc: "Monitor inventory and margins at scale. Reorder before you run out." },
                { title: "Private label (FBA & FBM)", desc: "Understand performance across products. Optimize based on real profit." },
              ].map((item) => (
                <div
                  key={item.title}
                  className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6 text-center"
                >
                  <h3 className="text-lg font-semibold text-[var(--foreground)]">{item.title}</h3>
                  <p className="mt-2 text-[var(--muted-foreground)]">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 7. Comparison */}
        <section className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              SellerBunker vs spreadsheets
            </h2>
            <div className="mt-12 overflow-hidden rounded-2xl border border-[var(--surface-border)]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)]">
                    <th className="px-6 py-4 font-semibold text-[var(--foreground)]">Feature</th>
                    <th className="px-6 py-4 font-semibold text-[var(--foreground)]">SellerBunker</th>
                    <th className="px-6 py-4 font-semibold text-[var(--muted-foreground)]">Spreadsheets</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { feature: "Profit tracking", sb: "✓ Automated", other: "Manual" },
                    { feature: "Inventory view", sb: "✓ Clear", other: "Messy" },
                    { feature: "Sales analytics", sb: "✓ Built-in", other: "Limited" },
                    { feature: "ROI tracking", sb: "✓ Automatic", other: "Manual" },
                  ].map((row) => (
                    <tr key={row.feature} className="border-b border-[var(--surface-border)] last:border-0">
                      <td className="px-6 py-4 text-[var(--foreground)]">{row.feature}</td>
                      <td className="px-6 py-4 font-medium" style={{ color: accentColor }}>{row.sb}</td>
                      <td className="px-6 py-4 text-[var(--muted-foreground)]">{row.other}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Repricer in development */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--surface-border)] bg-[var(--background)] px-4 py-1.5 text-sm font-semibold uppercase tracking-wider text-[var(--foreground)] shadow-sm">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-hidden />
              Coming soon
            </div>
            <h2 className="text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Repricer module in development
            </h2>
            <p className="mt-4 text-lg text-[var(--muted-foreground)]">
              We&apos;re building a repricer to help you stay competitive on Amazon. It will integrate with your existing SellerBunker dashboard—more updates as we get closer to launch.
            </p>
            <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-[var(--muted-foreground)]">
              We currently support UK marketplaces within the EU region while in early beta, and will be covering all EU markets very soon.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm text-[var(--muted-foreground)]">
              <span className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5">Automated repricing</span>
              <span className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5">Dashboard integration</span>
              <span className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5">Stay competitive</span>
            </div>
          </div>
        </section>

        {/* 8. Pricing */}
        <section id="pricing" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Simple pricing
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-[var(--muted-foreground)]">
              We are currently in beta testing meaning it is completely free for users until development is over — please join the{" "}
              <a
                href="https://discord.gg/sbDwPbV9"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-[var(--foreground)] underline hover:no-underline"
              >
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
                </svg>
                Discord
              </a>{" "}
              to request the free sign up code.
            </p>
            <div className="mt-16 grid gap-8 md:grid-cols-3">
              {[
                { name: "Starter", price: "£14.99", period: "month", orders: "Up to 5,000 orders per month", note: "Testing price for initial users", priceSubline: "Two weeks free, then", cta: "Try free today", featured: true, badge: "For initial testing" },
                { name: "Growth", price: "£26.99", period: "month", orders: "5,000 – 50,000 orders per month", priceSubline: "Two weeks free, then", cta: "Try free today", featured: false },
                { name: "Pro", price: "£44.99", period: "month", orders: "50,000+ orders per month", priceSubline: "Two weeks free, then", cta: "Try free today", featured: false },
              ].map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-2xl border p-6 ${plan.featured
                      ? "border-[var(--surface-border)] ring-2"
                      : "border-[var(--surface-border)] bg-[var(--background)]"
                    }`}
                  style={plan.featured ? { borderColor: accentColor, boxShadow: `0 0 0 1px ${accentColor}` } : undefined}
                >
                  {plan.featured && (
                    <span className="inline-block rounded-full px-3 py-0.5 text-xs font-medium text-black" style={{ backgroundColor: accentColor }}>
                      {"badge" in plan && plan.badge ? plan.badge : "Most popular"}
                    </span>
                  )}
                  <h3 className="mt-4 text-xl font-semibold text-[var(--foreground)]">{plan.name}</h3>
                  {"priceSubline" in plan && plan.priceSubline && (
                    <p className="mt-2 text-sm text-[var(--muted-foreground)]">{plan.priceSubline}</p>
                  )}
                  <p className="mt-1">
                    <span className="text-3xl font-bold text-[var(--foreground)]">{plan.price}</span>
                    {plan.period ? <span className="text-[var(--muted-foreground)]">/{plan.period}</span> : null}
                  </p>
                  <p className="mt-2 text-sm text-[var(--muted-foreground)]">{plan.orders}</p>
                  {"note" in plan && plan.note && (
                    <p className="mt-1 text-xs text-[var(--muted-foreground)] italic">{plan.note}</p>
                  )}
                  {plan.name === "Starter" ? (
                    <>
                      <SignedOut>
                        <Link
                          href="/sign-up"
                          className="mt-6 flex w-full items-center justify-center rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-gray-100 no-underline"
                        >
                          {plan.cta}
                        </Link>
                      </SignedOut>
                      <SignedIn>
                        <Link
                          href="/start-trial"
                          className="mt-6 flex w-full items-center justify-center rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-gray-100"
                        >
                          {plan.cta}
                        </Link>
                      </SignedIn>
                    </>
                  ) : (
                    <>
                      <SignedOut>
                        <Link
                          href="/sign-up"
                          className={`mt-6 flex w-full items-center justify-center rounded-xl py-3 text-sm font-semibold no-underline transition ${plan.featured ? "bg-white text-black hover:bg-gray-100" : "border border-[var(--surface-border)] text-[var(--foreground)] hover:bg-[var(--surface)]"
                            }`}
                        >
                          {plan.cta}
                        </Link>
                      </SignedOut>
                      <SignedIn>
                        <Link
                          href="/start-trial"
                          className={`mt-6 flex w-full items-center justify-center rounded-xl py-3 text-sm font-semibold no-underline transition ${plan.featured ? "bg-white text-black hover:bg-gray-100" : "border border-[var(--surface-border)] text-[var(--foreground)] hover:bg-[var(--surface)]"
                            }`}
                        >
                          {plan.cta}
                        </Link>
                      </SignedIn>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Contact form */}
        <ContactForm />
        {/* 9. Social proof placeholder */}
        <section className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Trusted by Amazon sellers
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-center text-[var(--muted-foreground)]">
              After years selling across UK &amp; EU, we were frustrated by the lack of accurate profit analytics and the cost of the tools out there.
            </p>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--foreground)] font-medium">
              SellerBunker was built to solve this.
            </p>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--muted-foreground)]">
              Already used by Amazon sellers running 7-figure businesses. We want to deliver better functionality than the competition at a more cost-effective price.
            </p>
          </div>
        </section>

        {/* 10. Final CTA */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Join the private beta
            </h2>
            <p className="mt-4 text-lg text-[var(--muted-foreground)]">
              Get free access while we build SellerBunker — we will send you a code once accepted into the group that you can use at checkout.
            </p>
            <div className="mt-10">
              <BottomCtaSlot />
            </div>
            <a
              href="https://discord.gg/sbDwPbV9"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex items-center justify-center gap-3 rounded-xl border-2 border-white/25 bg-white/5 px-8 py-4 text-lg font-semibold text-[var(--foreground)] transition hover:bg-white/10 hover:border-white/35 no-underline"
            >
              <svg className="h-8 w-8 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
              </svg>
              Join our Discord
            </a>
          </div>
        </section>
        </div>
      </main>

      <footer className="border-t border-[var(--surface-border)] py-4">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row sm:gap-4">
            <img
              src="/sellerbunker-logo2.png"
              alt="SellerBunker"
              className="sellerbunker-logo h-12 w-auto max-w-[140px] object-contain object-left opacity-90 sm:h-14 sm:max-w-[160px]"
            />
            <div className="text-center sm:text-left">
              <p className="text-xs text-[var(--muted-foreground)]">
                The profit command center for Amazon FBA &amp; FBM sellers.
              </p>
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]/80">
                Repricer coming soon once beta testing of the dashboard is complete.
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] sm:justify-start">
                <span className="text-[var(--muted-foreground)]/75">Guides:</span>
                <Link
                  href="/amazon-lost-inventory"
                  className="text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] no-underline"
                >
                  Lost inventory
                </Link>
                <Link
                  href="/fba-shipment-delays"
                  className="text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] no-underline"
                >
                  Shipment delays
                </Link>
                <Link
                  href="/amazon-profit-calculator"
                  className="text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] no-underline"
                >
                  Profit calculator
                </Link>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://discord.gg/sbDwPbV9"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join Discord"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
              <a
                href="https://www.tiktok.com/@sellerbunker"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join TikTok"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
                </svg>
              </a>
              <a
                href="https://www.instagram.com/sellerbunker"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join Instagram"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
