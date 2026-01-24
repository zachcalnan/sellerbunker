"use client";

import { SignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function SignUpPage() {
  const router = useRouter();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex cursor-pointer items-start justify-center bg-[var(--background)]/60 backdrop-blur-md pt-5 md:items-center md:pt-0"
      onClick={() => router.push("/")}
    >
      <div
        className="w-auto max-w-md cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        <SignUp />
      </div>
    </div>
  );
}


