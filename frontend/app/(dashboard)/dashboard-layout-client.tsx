"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { Topbar } from "@/components/topbar";
import { SyncProgressBar } from "@/components/sync-progress-bar";
import { FullscreenProvider, useFullscreen } from "@/contexts/fullscreen-context";
import { DisplaySettingsProvider } from "@/contexts/display-settings-context";
import { NotificationsProvider } from "@/contexts/notifications-context";
import { SubscriptionGate } from "@/components/subscription-gate";
import { VatOnboardingModal } from "@/components/vat-onboarding-modal";
import { MarketplaceOnboardingModal } from "@/components/marketplace-onboarding-modal";
import { CogsPromptModal } from "@/components/cogs-prompt-modal";
import { MarketplaceProvider } from "@/contexts/marketplace-context";
import { StripeCheckoutButton } from "@/components/stripe-checkout-button";
import { PostSignupWelcomeBanner } from "@/components/post-signup-welcome-banner";
import { useState } from "react";

function DashboardLayoutInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isFullscreen } = useFullscreen();
  const { isSignedIn, getToken } = useAuth();
  const pathname = usePathname();
  const [hasSubscriptionAccess, setHasSubscriptionAccess] = useState<boolean | null>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const isLockedModule = hasSubscriptionAccess === false && pathname !== "/dashboard";

  useEffect(() => {
    if (!isSignedIn) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    let cancelled = false;
    const check = async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${baseUrl}/api/subscription/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { hasAccess?: boolean };
        if (!cancelled) setHasSubscriptionAccess(Boolean(data.hasAccess));
      } catch {
        if (!cancelled) setHasSubscriptionAccess(true);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, getToken]);

  // When entering fullscreen mode, use browser Fullscreen API so address bar/tabs are hidden
  useEffect(() => {
    if (!isFullscreen || !fullscreenRef.current) return;
    const el = fullscreenRef.current;
    el.requestFullscreen?.().catch(() => {
      // User denied or browser doesn't support; fallback is already full-viewport div
    });
  }, [isFullscreen]);

  if (isFullscreen) {
    return (
      <div
        ref={fullscreenRef}
        className="fixed inset-0 z-[100] flex min-h-screen w-full flex-col overflow-auto bg-[var(--background)]"
        role="application"
        aria-label="Dashboard full screen"
      >
        {children}
      </div>
    );
  }

  return (
    <>
      <VatOnboardingModal />
      <MarketplaceOnboardingModal />
      <CogsPromptModal />
      <NotificationsProvider>
        <MobileNav />
        <div className="hidden md:fixed md:inset-y-0 md:left-0 md:z-10 md:flex md:w-56">
          <Sidebar />
        </div>
        <main className="flex min-h-screen flex-col md:pl-56">
          <div className="hidden md:block">
            <Topbar />
          </div>
          <PostSignupWelcomeBanner />
          <SyncProgressBar />
          <div className="relative min-h-0 flex-1">
            <div className={isLockedModule ? "pointer-events-none select-none opacity-70 blur-[3px]" : ""}>
              {children}
            </div>
            {isLockedModule && (
              <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
                <div className="w-full max-w-md rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 text-center shadow-2xl">
                  <p className="text-lg font-semibold text-[var(--foreground)]">🔒 Unlock full access</p>
                  <p className="mt-2 text-sm text-[var(--muted-foreground)]">
                    This module is locked in preview mode. Upgrade to unlock full functionality.
                  </p>
                  <div className="mt-4">
                    <StripeCheckoutButton className="w-full rounded-lg bg-sb-accent px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90">
                      Unlock access
                    </StripeCheckoutButton>
                  </div>
                  <p className="mt-3 text-xs text-[var(--muted-foreground)]">
                    Need a free testing code? Reach out via Discord, Instagram, TikTok, or email support.
                  </p>
                </div>
              </div>
            )}
          </div>
        </main>
      </NotificationsProvider>
    </>
  );
}

export default function DashboardLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SubscriptionGate>
      <DisplaySettingsProvider>
        <MarketplaceProvider>
          <FullscreenProvider>
            <DashboardLayoutInner>{children}</DashboardLayoutInner>
          </FullscreenProvider>
        </MarketplaceProvider>
      </DisplaySettingsProvider>
    </SubscriptionGate>
  );
}
