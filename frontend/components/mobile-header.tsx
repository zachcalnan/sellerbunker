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
        className="flex shrink-0 items-center font-semibold text-[var(--foreground)] no-underline hover:opacity-80"
        aria-label="Seller Bunker home"
      >
        <img
          src="/sellerbunker-logo.png"
          alt="Seller Bunker"
          className="sellerbunker-logo h-16 w-auto min-w-[130px] object-contain object-left"
        />
      </Link>
      <span className="font-semibold tracking-tight text-[var(--foreground)]">
        <span className="font-bold">SELLER</span>
        <span className="font-normal"> BUNKER</span>
      </span>
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
