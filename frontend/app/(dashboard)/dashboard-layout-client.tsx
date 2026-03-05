"use client";

import { useEffect, useRef } from "react";
import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { Topbar } from "@/components/topbar";
import { FullscreenProvider, useFullscreen } from "@/contexts/fullscreen-context";
import { DisplaySettingsProvider } from "@/contexts/display-settings-context";

function DashboardLayoutInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isFullscreen } = useFullscreen();
  const fullscreenRef = useRef<HTMLDivElement>(null);

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
      <MobileNav />
      <div className="hidden md:fixed md:inset-y-0 md:left-0 md:z-10 md:flex md:w-56">
        <Sidebar />
      </div>
      <main className="flex min-h-screen flex-col md:pl-56">
        <Topbar />
        <div className="min-h-0 flex-1">{children}</div>
      </main>
    </>
  );
}

export default function DashboardLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DisplaySettingsProvider>
      <FullscreenProvider>
        <DashboardLayoutInner>{children}</DashboardLayoutInner>
      </FullscreenProvider>
    </DisplaySettingsProvider>
  );
}
