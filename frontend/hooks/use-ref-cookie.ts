"use client";

import { useState } from "react";
import { readRefCookie } from "@/lib/ref-cookie";

/** Client-only: value from the `ref` cookie (read synchronously). */
export function useRefCookie(): string | undefined {
  const [ref] = useState<string | undefined>(() => readRefCookie());
  return ref;
}
