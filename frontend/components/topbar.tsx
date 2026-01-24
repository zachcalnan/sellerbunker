"use client";

import { LanguageSelector } from "./language-selector";
import { ThemeToggle } from "./theme-toggle";

export function Topbar() {
  return (
    <header
      className="hidden md:flex h-14 shrink-0 items-center justify-end gap-3 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4"
      role="banner"
    >
      <div className="flex items-center gap-3">
        <LanguageSelector />
        <ThemeToggle />
      </div>
    </header>
  );
}
