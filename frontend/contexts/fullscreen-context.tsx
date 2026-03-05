"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type FullscreenContextValue = {
  isFullscreen: boolean;
  setFullscreen: (value: boolean) => void;
};

const FullscreenContext = createContext<FullscreenContextValue | null>(null);

export function FullscreenProvider({ children }: { children: ReactNode }) {
  const [isFullscreen, setFullscreen] = useState(false);

  // Sync with browser fullscreen: when user exits via Escape or browser UI, update state
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const setFullscreenStable = useCallback((value: boolean) => {
    setFullscreen(value);
  }, []);

  return (
    <FullscreenContext.Provider
      value={{ isFullscreen, setFullscreen: setFullscreenStable }}
    >
      {children}
    </FullscreenContext.Provider>
  );
}

export function useFullscreen(): FullscreenContextValue {
  const ctx = useContext(FullscreenContext);
  if (!ctx) {
    return {
      isFullscreen: false,
      setFullscreen: () => {},
    };
  }
  return ctx;
}
