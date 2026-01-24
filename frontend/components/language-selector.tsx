"use client";

import { useEffect, useRef, useState } from "react";
import { FlagIcon, type FlagCode } from "./flags";

const LANGUAGES = [
  { code: "en", label: "English", flagCode: "gb" as FlagCode },
  { code: "es", label: "Español", flagCode: "es" as FlagCode },
  { code: "de", label: "Deutsch", flagCode: "de" as FlagCode },
  { code: "fr", label: "Français", flagCode: "fr" as FlagCode },
] as const;

type LangCode = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "preferred-language";

export function LanguageSelector() {
  const [lang, setLang] = useState<LangCode>("en");
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY) as LangCode | null;
    if (stored && LANGUAGES.some((l) => l.code === stored)) {
      setLang(stored);
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

  const current = LANGUAGES.find((l) => l.code === lang);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Select language"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={current?.label}
        className="flex h-9 w-10 cursor-pointer items-center justify-center hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--nav-active-border)]"
      >
        <FlagIcon code={current?.flagCode ?? "gb"} className="h-5 w-7" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Language options"
          className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-0.5 border border-[var(--surface-border)] bg-[var(--surface)] py-1 shadow-lg"
        >
          {LANGUAGES.map(({ code, label, flagCode }) => (
            <button
              key={code}
              role="option"
              aria-selected={lang === code}
              onClick={() => select(code)}
              title={label}
              className="flex h-9 w-10 cursor-pointer items-center justify-center px-2 hover:bg-[var(--foreground)]/5 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--nav-active-border)]"
            >
              <FlagIcon code={flagCode} className="h-5 w-7" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
