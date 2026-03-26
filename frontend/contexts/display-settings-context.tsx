"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY_BG = "display-settings-background";
const STORAGE_KEY_RING = "display-settings-ring-color";

export type BackgroundTheme = "dark" | "light" | "blue" | "pink" | "green";

const BACKGROUND_CLASSES: Record<BackgroundTheme, string> = {
  dark: "bg-dark-shine",
  light: "bg-light-shine",
  blue: "bg-blue-shine",
  pink: "bg-pink-shine",
  green: "bg-green-shine",
};

// Match the landing-page dashboard mock accent by default.
const DEFAULT_RING_COLOR = "rgb(96, 165, 250)";

function readBackground(): BackgroundTheme {
  if (typeof window === "undefined") return "dark";
  const s = sessionStorage.getItem(STORAGE_KEY_BG);
  if (s && ["dark", "light", "blue", "pink", "green"].includes(s))
    return s as BackgroundTheme;
  return "dark";
}

function readRingColor(): string {
  if (typeof window === "undefined") return DEFAULT_RING_COLOR;
  return sessionStorage.getItem(STORAGE_KEY_RING) ?? DEFAULT_RING_COLOR;
}

type DisplaySettingsContextValue = {
  backgroundTheme: BackgroundTheme;
  setBackgroundTheme: (t: BackgroundTheme) => void;
  backgroundClass: string;
  ringColor: string;
  setRingColor: (c: string) => void;
  applyDisplaySettings: (opts: { background?: BackgroundTheme; ringColor?: string }) => void;
};

const DisplaySettingsContext = createContext<DisplaySettingsContextValue | null>(null);

export function DisplaySettingsProvider({ children }: { children: ReactNode }) {
  const [backgroundTheme, setBackgroundThemeState] = useState<BackgroundTheme>("dark");
  const [ringColor, setRingColorState] = useState<string>(DEFAULT_RING_COLOR);

  useEffect(() => {
    setBackgroundThemeState(readBackground());
    setRingColorState(readRingColor());
  }, []);

  const backgroundClass = useMemo(
    () => BACKGROUND_CLASSES[backgroundTheme],
    [backgroundTheme],
  );

  // Apply accent (theme) colour to the document so buttons, rings, sync bar, etc. use it
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--sb-accent", ringColor);
  }, [ringColor]);

  const setBackgroundTheme = useCallback((t: BackgroundTheme) => {
    setBackgroundThemeState(t);
    try {
      sessionStorage.setItem(STORAGE_KEY_BG, t);
    } catch {}
  }, []);

  const setRingColor = useCallback((c: string) => {
    setRingColorState(c);
    try {
      sessionStorage.setItem(STORAGE_KEY_RING, c);
    } catch {}
  }, []);

  const applyDisplaySettings = useCallback(
    (opts: { background?: BackgroundTheme; ringColor?: string }) => {
      if (opts.background != null) setBackgroundTheme(opts.background);
      if (opts.ringColor != null) setRingColor(opts.ringColor);
    },
    [setBackgroundTheme, setRingColor],
  );

  const value: DisplaySettingsContextValue = useMemo(
    () => ({
      backgroundTheme,
      setBackgroundTheme,
      backgroundClass,
      ringColor,
      setRingColor,
      applyDisplaySettings,
    }),
    [
      backgroundTheme,
      setBackgroundTheme,
      backgroundClass,
      ringColor,
      setRingColor,
      applyDisplaySettings,
    ],
  );

  return (
    <DisplaySettingsContext.Provider value={value}>
      {children}
    </DisplaySettingsContext.Provider>
  );
}

export function useDisplaySettings(): DisplaySettingsContextValue {
  const ctx = useContext(DisplaySettingsContext);
  if (!ctx) {
    return {
      backgroundTheme: "dark",
      setBackgroundTheme: () => {},
      backgroundClass: BACKGROUND_CLASSES.dark,
      ringColor: DEFAULT_RING_COLOR,
      setRingColor: () => {},
      applyDisplaySettings: () => {},
    };
  }
  return ctx;
}
