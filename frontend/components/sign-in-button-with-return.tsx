"use client";

import { SignInButton } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo, type ReactNode } from "react";

type Props = { children: ReactNode };

function SignInButtonWithReturnInner({ children }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const forceRedirectUrl = useMemo(() => {
    if (!pathname) return "/dashboard";
    if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) return "/dashboard";
    const q = searchParams.toString();
    return q ? `${pathname}?${q}` : pathname;
  }, [pathname, searchParams]);

  return <SignInButton forceRedirectUrl={forceRedirectUrl}>{children}</SignInButton>;
}

/** Same as Clerk `SignInButton`, but returns the user to the current path (and query) after sign-in. */
export function SignInButtonWithReturn({ children }: Props) {
  return (
    <Suspense fallback={<SignInButton>{children}</SignInButton>}>
      <SignInButtonWithReturnInner>{children}</SignInButtonWithReturnInner>
    </Suspense>
  );
}
