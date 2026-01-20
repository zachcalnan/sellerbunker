"use client";

import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-start justify-center mt-5 md:items-center md:mt-0">
      <div className="w-auto max-w-md">
        <SignUp />
      </div>
    </div>
  );
}


