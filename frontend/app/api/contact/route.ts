import { NextRequest, NextResponse } from "next/server";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = "support@sellerbunker.com";
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "SellerBunker Contact <onboarding@resend.dev>";

export async function POST(request: NextRequest) {
  if (!RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Email is not configured. Set RESEND_API_KEY." },
      { status: 503 }
    );
  }

  let body: { name?: string; email?: string; subject?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const subject = String(body.subject ?? "Contact form").trim();
  const message = String(body.message ?? "").trim();

  if (!email || !message) {
    return NextResponse.json(
      { error: "Email and message are required." },
      { status: 400 }
    );
  }

  const html = `
    <p><strong>From:</strong> ${escapeHtml(name || "(not given)")} &lt;${escapeHtml(email)}&gt;</p>
    <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
    <hr />
    <pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(message)}</pre>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      reply_to: email,
      subject: `[SellerBunker] ${subject}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", res.status, err);
    return NextResponse.json(
      { error: "Failed to send message. Please try again or email us directly." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
