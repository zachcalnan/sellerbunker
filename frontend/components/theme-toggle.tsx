"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let initial: Theme = "dark";
    const stored = window.localStorage.getItem("theme");

    if (stored === "light" || stored === "dark") {
      initial = stored;
    } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
      initial = "light";
    }

    document.documentElement.dataset.theme = initial;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (typeof window !== "undefined") {
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("theme", next);
    }
  };

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle dark mode"
        className="inline-flex h-9 items-center rounded-full bg-transparent px-3 text-xs font-medium text-[var(--muted-foreground)] cursor-pointer"
      >
        Theme
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle dark mode"
      className="inline-flex h-9 items-center gap-2 rounded-full bg-transparent px-3 text-xs font-medium text-[var(--muted-foreground)] hover:opacity-80 transition-colors cursor-pointer"
    >
      <span className="relative flex h-4 w-7 items-center rounded-full bg-[var(--surface-border)]">
        <span
          className={`inline-block h-3 w-3 rounded-full bg-[var(--foreground)] transition-transform duration-200 ${
            isDark ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      <span className="uppercase tracking-[0.16em] text-[10px] text-[var(--muted-foreground)]">
        {isDark ? "Dark" : "Light"}
      </span>
    </button>
  );
}

