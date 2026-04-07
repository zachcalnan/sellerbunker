"use client";

import { RedirectToSignIn } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { safeAppRedirectPath } from "@/lib/auth-redirect";

function RedirectToSignInInner({ fallback = "/dashboard" }: { fallback?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const redirectUrl = useMemo(() => {
    const explicit =
      searchParams.get("redirect_url") ?? searchParams.get("return_url") ?? undefined;
    if (explicit) return safeAppRedirectPath(explicit, fallback);
    if (!pathname) return fallback;
    if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) return fallback;
    const q = searchParams.toString();
    const path = q ? `${pathname}?${q}` : pathname;
    return safeAppRedirectPath(path, fallback);
  }, [pathname, searchParams, fallback]);

  return <RedirectToSignIn redirectUrl={redirectUrl} />;
}

/**
 * Redirects signed-out users to Clerk sign-in, preserving return path (and query) where possible.
 */
export function RedirectToSignInWithReturn({ fallback = "/dashboard" }: { fallback?: string }) {
  return (
    <Suspense fallback={<RedirectToSignIn />}>
      <RedirectToSignInInner fallback={fallback} />
    </Suspense>
  );
}
