"use client";

import { useEffect, useRef, useState } from "react";
import { FlagIcon, type FlagCode } from "./flags";

const LANGUAGES = [
  { code: "en", label: "English", flagCode: "gb" as FlagCode, enabled: true },
  { code: "es", label: "Español", flagCode: "es" as FlagCode, enabled: false },
  { code: "de", label: "Deutsch", flagCode: "de" as FlagCode, enabled: false },
  { code: "fr", label: "Français", flagCode: "fr" as FlagCode, enabled: false },
] as const;

type LangCode = (typeof LANGUAGES)[number]["code"];

const UK_ONLY_TOOLTIP = "Only support UK marketplaces. All European coming soon.";
const COMING_SOON_TOOLTIP = "All European coming soon.";

const STORAGE_KEY = "preferred-language";

export function LanguageSelector() {
  const [lang, setLang] = useState<LangCode>("en");
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY) as LangCode | null;
    const entry = stored && LANGUAGES.find((l) => l.code === stored);
    if (entry?.enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLang(entry.code);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = (next: LangCode) => {
    const entry = LANGUAGES.find((l) => l.code === next);
    if (!entry?.enabled) return;
    setLang(next);
    setOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  };

  if (!mounted) {
    return (
      <div className="h-9 w-10 shrink-0" aria-hidden />
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Select language"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={UK_ONLY_TOOLTIP}
        className="flex h-9 w-10 cursor-pointer items-center justify-center hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--nav-active-border)]"
      >
        <FlagIcon code="gb" className="h-5 w-7" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Language options"
          className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-0.5 border border-[var(--surface-border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {LANGUAGES.map(({ code, label, flagCode, enabled }) => (
            <button
              key={code}
              type="button"
              role="option"
              aria-selected={lang === code}
              aria-disabled={!enabled}
              onClick={() => select(code)}
              title={enabled ? label : COMING_SOON_TOOLTIP}
              disabled={!enabled}
              className={`flex h-9 w-10 items-center justify-center px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)] ${enabled ? "cursor-pointer hover:bg-[var(--foreground)]/5" : "cursor-not-allowed opacity-50"}`}
            >
              <FlagIcon code={flagCode} className="h-5 w-7" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
