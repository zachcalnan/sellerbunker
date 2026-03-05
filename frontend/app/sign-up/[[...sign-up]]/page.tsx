"use client";

import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect } from "react";

export default function SignUpPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--background)]/95 backdrop-blur-md">
      <div className="absolute left-4 top-4 z-10">
        <Link
          href="/"
          className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] no-underline transition hover:bg-[var(--foreground)]/5"
        >
          ← Back
        </Link>
      </div>
      <div className="w-auto max-w-md">
        <SignUp />
      </div>
    </div>
  );
}


