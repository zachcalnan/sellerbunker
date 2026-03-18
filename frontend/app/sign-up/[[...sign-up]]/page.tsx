"use client";

import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect } from "react";

export default function SignUpPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="clerk-auth-shell fixed inset-0 z-[100] flex items-center justify-center bg-[var(--background)]/95 backdrop-blur-md p-4">
      <Link
        href="/"
        className="fixed left-4 top-4 z-[10000] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline shadow-lg transition hover:bg-[var(--foreground)]/5"
      >
        ← Back
      </Link>
      <div className="relative z-10 flex w-full max-w-[calc(100vw-2rem)] justify-center">
        <SignUp />
      </div>
    </div>
  );
}


