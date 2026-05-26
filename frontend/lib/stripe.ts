/**
 * Stripe server-side helper.
 *
 * Required in the FRONTEND .env (or .env.local) — checkout runs on the Next.js server:
 * - STRIPE_SECRET_KEY (from Stripe Dashboard → Developers → API keys)
 *
 * Optional:
 * - STRIPE_BASIC_PLAN_PRODUCT_ID (default: prod_UaVYwmbiuDsv6w — Basic subscription)
 */
import Stripe from "stripe";

let _stripe: Stripe | null = null;

/** Stripe client (lazy-initialized so build succeeds when STRIPE_SECRET_KEY is unset). */
export function getStripe(): Stripe {
  if (!_stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is required. Add it to your .env file.");
    }
    _stripe = new Stripe(secretKey, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

/** Basic plan product ID (Starter). Override with STRIPE_BASIC_PLAN_PRODUCT_ID in .env. */
export const STRIPE_BASIC_PLAN_PRODUCT_ID =
  process.env.STRIPE_BASIC_PLAN_PRODUCT_ID ?? "prod_UaVYwmbiuDsv6w";
