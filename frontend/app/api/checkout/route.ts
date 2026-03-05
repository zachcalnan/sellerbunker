import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getStripe, STRIPE_BASIC_PLAN_PRODUCT_ID } from "@/lib/stripe";

/**
 * GET /api/checkout
 * Diagnostic: check if Stripe is configured and the basic plan has a price.
 * Returns: { stripeConfigured: boolean, priceFound: boolean, message?: string }
 */
export async function GET() {
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_"));
  let priceFound = false;
  let message: string | undefined;

  if (stripeConfigured) {
    try {
      const stripe = getStripe();
      const prices = await stripe.prices.list({
        product: STRIPE_BASIC_PLAN_PRODUCT_ID,
        active: true,
        type: "recurring",
      });
      priceFound = prices.data.length > 0;
      if (!priceFound) {
        message = `No active recurring price for product ${STRIPE_BASIC_PLAN_PRODUCT_ID}. Add a subscription price in Stripe Dashboard → Products.`;
      }
    } catch (err) {
      message = err instanceof Error ? err.message : "Stripe request failed";
    }
  } else {
    message =
      "STRIPE_SECRET_KEY is missing or invalid. Add it to the frontend .env (or .env.local) — the checkout API runs on the Next.js server.";
  }

  return NextResponse.json({
    stripeConfigured,
    priceFound,
    productId: STRIPE_BASIC_PLAN_PRODUCT_ID,
    ...(message && { message }),
  });
}

/**
 * POST /api/checkout
 * Creates a Stripe Checkout Session for the basic plan (Starter).
 * Body (optional): { successUrl?: string, cancelUrl?: string }
 * Returns: { url: string } to redirect the user to Stripe Checkout.
 */
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  let body: { successUrl?: string; cancelUrl?: string } = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = await request.json();
    }
  } catch {
    // ignore
  }

  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    request.headers.get("origin") ??
    "http://localhost:3000";
  // After payment, land on start-trial with session_id so we can confirm subscription (works without webhook)
  const successUrl = body.successUrl ?? `${base}/start-trial?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl ?? `${base}/start-trial?checkout=cancelled`;

  try {
    const stripe = getStripe();
    // Get the default price for the basic plan product (required for Checkout Session)
    const prices = await stripe.prices.list({
      product: STRIPE_BASIC_PLAN_PRODUCT_ID,
      active: true,
      type: "recurring",
    });

    const price = prices.data[0];
    if (!price) {
      console.error("No active recurring price found for product", STRIPE_BASIC_PLAN_PRODUCT_ID);
      return NextResponse.json(
        { error: "Basic plan price not configured in Stripe" },
        { status: 500 }
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 14,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      allow_promotion_codes: true,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: "Failed to create checkout session" },
        { status: 500 }
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Checkout failed";
    console.error("Checkout session error:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
