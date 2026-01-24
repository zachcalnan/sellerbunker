"use client";

import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";

export function MobileHeader() {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--surface-border)] bg-[var(--surface)] px-4 md:hidden">
      <Link
        href="/"
        className="font-semibold text-[var(--foreground)] no-underline hover:opacity-80"
      >
        <span className="font-bold">SELLER</span>
        <span className="font-normal">BUNKER</span>
      </Link>
      <div className="flex items-center gap-4">
        <SignedOut>
          <SignInButton>
            <button className="cursor-pointer text-sm font-medium">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton>
            <button className="cursor-pointer rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              Sign up
            </button>
          </SignUpButton>
        </SignedOut>
        <SignedIn>
          <UserButton afterSignOutUrl="/" />
        </SignedIn>
      </div>
    </header>
  );
}
