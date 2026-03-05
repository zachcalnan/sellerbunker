"use client";

import { useState } from "react";

type Props = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Button that creates a Stripe Checkout Session and redirects to Stripe.
 * Requires the user to be signed in (use inside SignedIn).
 */
export function StripeCheckoutButton({ children, className, style }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Checkout failed");
      if (data.url) window.location.href = data.url;
      else throw new Error("No checkout URL returned");
    } catch (e) {
      console.error(e);
      setLoading(false);
      alert(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={className}
      style={style}
    >
      {loading ? "Redirecting…" : children}
    </button>
  );
}
