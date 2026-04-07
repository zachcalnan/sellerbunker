"use client";

import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { clerkAuthMonochromeAppearance } from "@/lib/clerk-auth-appearance";

export default function SignInFullOptionsPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="clerk-auth-shell fixed inset-0 z-[100] flex items-center justify-center p-4">
      <Link
        href="/sign-in"
        className="fixed left-4 top-4 z-[10000] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline shadow-lg transition hover:bg-[var(--foreground)]/5"
      >
        ← Simple sign-in
      </Link>
      <div className="relative z-10 flex w-full max-w-[calc(100vw-2rem)] justify-center">
        <SignIn
          appearance={clerkAuthMonochromeAppearance}
          fallbackRedirectUrl="/dashboard"
        />
      </div>
    </div>
  );
}
