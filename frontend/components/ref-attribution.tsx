"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { setRefCookieIfAbsent } from "@/lib/ref-cookie";

/**
 * On any page load with ?ref=, persist the code in a first-party cookie (60d) if not already set.
 */
export function RefAttribution() {
  const searchParams = useSearchParams();
  useEffect(() => {
    const ref = searchParams.get("ref");
    if (ref) setRefCookieIfAbsent(ref);
  }, [searchParams]);
  return null;
}
