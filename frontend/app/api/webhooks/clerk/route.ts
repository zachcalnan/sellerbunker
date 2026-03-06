import { verifyWebhook } from "@clerk/backend/webhooks";
import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

/**
 * Clerk sends user.deleted (and other events) here.
 * We verify the request, then tell the backend to delete the user's subscription
 * and clear clerkId so re-sign-up goes through payment again.
 */
export async function POST(request: NextRequest) {
  try {
    const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (!signingSecret) {
      console.error("CLERK_WEBHOOK_SIGNING_SECRET is not set");
      return NextResponse.json(
        { error: "Webhook not configured" },
        { status: 500 }
      );
    }

    const evt = await verifyWebhook(request, { signingSecret });

    if (evt.type !== "user.deleted") {
      return NextResponse.json({ received: true }, { status: 200 });
    }

    const clerkId = (evt.data as { id?: string })?.id;
    if (!clerkId) {
      console.error("[Clerk webhook] user.deleted event missing data.id", evt);
      return NextResponse.json(
        { error: "user.deleted event missing user id" },
        { status: 400 }
      );
    }

    if (!WEBHOOK_SECRET) {
      console.error("CLERK_WEBHOOK_SECRET (for backend) is not set");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 }
      );
    }

    const backendUrl = `${API_URL}/api/clerk/user-deleted`;
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ clerkId }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        "[Clerk webhook] Backend user-deleted failed:",
        res.status,
        backendUrl,
        text
      );
      return NextResponse.json(
        { error: "Backend failed to process user deletion" },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[Clerk webhook] Verification or processing error:", err);
    return NextResponse.json(
      { error: "Webhook verification failed" },
      { status: 400 }
    );
  }
}
