"use client";

import { useEffect, useState } from "react";
import { readRefCookie } from "@/lib/ref-cookie";

/** Client-only: value from the `ref` cookie after mount. */
export function useRefCookie(): string | undefined {
  const [ref, setRef] = useState<string | undefined>(undefined);
  useEffect(() => {
    setRef(readRefCookie());
  }, []);
  return ref;
}
