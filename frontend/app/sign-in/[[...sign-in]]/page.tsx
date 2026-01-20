"use client";

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-start justify-center mt-5 md:items-center md:mt-0">
      <div className="w-auto max-w-md">
        <SignIn />
      </div>
    </div>
  );
}


