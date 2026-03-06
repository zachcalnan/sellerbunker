"use client";

import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  useAuth,
} from "@clerk/nextjs";
import Link from "next/link";
import Image from "next/image";
import { useState, useRef, useEffect } from "react";

const accentColor = "rgb(96, 165, 250)";
const accentMuted = "rgba(96, 165, 250, 0.15)";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Shows Sign in + Dashboard (→ sign-in page) when signed out OR signed in with no subscription; else Dashboard → /dashboard */
function NavAuthButtons() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setHasSubscription(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken({ template: "backend" });
        if (!token || cancelled) return;
        const res = await fetch(`${API_URL}/api/subscription/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { hasAccess?: boolean };
          setHasSubscription(!!data.hasAccess);
        } else {
          setHasSubscription(false);
        }
      } catch {
        if (!cancelled) setHasSubscription(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, getToken]);

  // Signed out: Sign in → sign-in page; Dashboard → sign-up page
  if (!isLoaded || !isSignedIn) {
    return (
      <div className="flex items-center gap-2">
        <SignInButton mode="redirect" forceRedirectUrl="/start-trial">
          <button className="text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition px-2 py-1.5 rounded-lg hover:bg-[var(--foreground)]/5">
            Sign in
          </button>
        </SignInButton>
        <a
          href="/sign-up"
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black no-underline transition hover:bg-gray-100"
        >
          Dashboard
        </a>
      </div>
    );
  }

  // Signed in with subscription: Dashboard → /dashboard
  if (hasSubscription === true) {
    return (
      <Link
        href="/dashboard"
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black no-underline transition hover:bg-gray-100"
      >
        Dashboard
      </Link>
    );
  }

  // Signed in but no subscription (or still loading): Sign in → sign-in; Dashboard → sign-up
  return (
    <div className="flex items-center gap-2">
      <SignInButton mode="redirect" forceRedirectUrl="/start-trial">
        <button className="text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition px-2 py-1.5 rounded-lg hover:bg-[var(--foreground)]/5">
          Sign in
        </button>
      </SignInButton>
      <a
        href="/sign-up"
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black no-underline transition hover:bg-gray-100"
      >
        Dashboard
      </a>
    </div>
  );
}

function NavDropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--foreground)]/5 transition"
      >
        {label}
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] py-1 shadow-lg" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Something went wrong.");
        return;
      }
      setStatus("success");
      setName("");
      setEmail("");
      setSubject("");
      setMessage("");
    } catch {
      setStatus("error");
      setErrorMessage("Network error. Please try again.");
    }
  }

  return (
    <section id="contact" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
          Get in contact
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-[var(--muted-foreground)]">
          Send us a message and we&apos;ll get back to you at support@sellerbunker.com.
        </p>
        <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-4">
          <div>
            <label htmlFor="contact-name" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Name
            </label>
            <input
              id="contact-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-4 py-2.5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:ring-2 focus:ring-[var(--surface-border)]"
              placeholder="Your name"
            />
          </div>
          <div>
            <label htmlFor="contact-email" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              id="contact-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-4 py-2.5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:ring-2 focus:ring-[var(--surface-border)]"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="contact-subject" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Subject
            </label>
            <input
              id="contact-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-4 py-2.5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:ring-2 focus:ring-[var(--surface-border)]"
              placeholder="What's this about?"
            />
          </div>
          <div>
            <label htmlFor="contact-message" className="block text-sm font-medium text-[var(--foreground)] mb-1">
              Message <span className="text-red-400">*</span>
            </label>
            <textarea
              id="contact-message"
              required
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-4 py-2.5 text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:ring-2 focus:ring-[var(--surface-border)] resize-y min-h-[120px]"
              placeholder="Your message..."
            />
          </div>
          {status === "success" && (
            <p className="text-sm font-medium text-green-500">Message sent. We&apos;ll reply to your email soon.</p>
          )}
          {status === "error" && (
            <p className="text-sm font-medium text-red-400">{errorMessage}</p>
          )}
          <button
            type="submit"
            disabled={status === "sending"}
            className="rounded-xl px-6 py-3 text-base font-semibold text-black transition disabled:opacity-50"
            style={{ backgroundColor: accentColor }}
          >
            {status === "sending" ? "Sending..." : "Send message"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div
      className="min-h-screen bg-[var(--background)] text-[var(--foreground)]"
      data-theme="dark"
    >
      {/* Force dark theme for landing */}
      <style>{`
        .landing-page { --background: #000; --foreground: #e5e7eb; --surface: #0a0a0a; --surface-border: #262626; --muted-foreground: #94a3b8; }
      `}</style>

      {/* Navigation */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--surface-border)] bg-[var(--background)]/95 backdrop-blur">
        <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between pl-2 pr-4 sm:h-16 sm:pl-2 sm:pr-6 lg:pl-4 lg:pr-8">
          <Link href="/" className="-ml-2 flex shrink-0 items-center overflow-visible font-semibold no-underline hover:opacity-80 sm:-ml-2 lg:-ml-4" aria-label="SellerBunker home">
            <img
              src="/sellerbunker-logo.png"
              alt="SellerBunker"
              className="sellerbunker-logo mt-0.5 -mb-1 h-24 w-auto min-w-[360px] max-w-[520px] object-contain object-left sm:mt-1 sm:-mb-2 sm:h-36 sm:min-w-[432px] sm:max-w-[648px]"
            />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <NavDropdown label="Product">
              <Link href="#features" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                Features
              </Link>
              <Link href="#dashboard-preview" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                See the dashboard
              </Link>
              <Link href="#how-it-works" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                How it works
              </Link>
              <span className="block px-4 py-2 text-sm text-[var(--muted-foreground)]/70 select-none pointer-events-none italic" aria-hidden>
                Repricer — coming soon
              </span>
            </NavDropdown>
            <NavDropdown label="Pricing">
              <Link href="#pricing" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                View plans
              </Link>
            </NavDropdown>
            <SignedIn>
              <Link
                href="/start-trial"
                className="rounded-lg bg-transparent px-4 py-2 text-sm font-medium text-white no-underline transition border-t-2 border-b-2 border-white hover:bg-white/10"
              >
                Start 14 day free trial
              </Link>
            </SignedIn>
            <SignedOut>
              <SignUpButton mode="redirect" forceRedirectUrl="/start-trial" signInForceRedirectUrl="/start-trial">
                <button
                  className="rounded-lg bg-transparent px-4 py-2 text-sm font-medium text-white transition border-t-2 border-b-2 border-white hover:bg-white/10"
                >
                  Start 14 day free trial
                </button>
              </SignUpButton>
            </SignedOut>
            <NavDropdown label="Get in contact">
              <Link href="#contact" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                Contact form
              </Link>
              <a href="mailto:support@sellerbunker.com" className="block px-4 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--foreground)]/5 no-underline">
                Email us
              </a>
            </NavDropdown>
            <div className="ml-2 h-6 w-px bg-[var(--surface-border)]" />
            <NavAuthButtons />
          </div>
        </nav>
      </header>

      <main className="landing-page pt-20 sm:pt-24">
        {/* 1. Hero - no blurred background, dashboard mockup on the right */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--background)]">
          <div className="mx-auto max-w-7xl px-4 pt-2 pb-8 sm:px-6 sm:pt-3 sm:pb-12 lg:px-8 lg:pt-4 lg:pb-16">
            <div className="grid gap-10 lg:grid-cols-2 lg:gap-16 lg:items-center">
              <div>
                <h1 className="text-4xl font-bold tracking-tight text-[var(--foreground)] sm:text-5xl lg:text-6xl">
                  Your Amazon profit.{" "}
                  <span style={{ color: accentColor }}>Finally under control.</span>
                </h1>
                <p className="mt-4 max-w-xl text-lg text-[var(--muted-foreground)]">
                  SellerBunker tracks sales, profit, inventory, and ROI in one powerful dashboard designed for serious Amazon sellers—whether you sell FBA (Fulfilled by Amazon), FBM (Fulfilled by Merchant), or both.
                </p>
                <div className="mt-6 flex flex-wrap gap-4">
                  <SignedOut>
                    <SignUpButton mode="redirect" forceRedirectUrl="/start-trial" signInForceRedirectUrl="/start-trial">
                      <button
                        className="rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-black shadow-lg transition hover:bg-gray-100"
                      >
                        Start free trial
                      </button>
                    </SignUpButton>
                  </SignedOut>
                  <SignedIn>
                    <Link
                      href="/dashboard"
                      className="rounded-xl px-6 py-3.5 text-base font-semibold text-black shadow-lg transition hover:opacity-90"
                      style={{ backgroundColor: accentColor }}
                    >
                      Go to dashboard
                    </Link>
                  </SignedIn>
                </div>
                <div className="mt-6 flex flex-wrap items-center gap-6 text-sm text-[var(--muted-foreground)]">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
                    Built with ease of use in mind
                  </span>
                </div>
              </div>
              <div className="relative">
                <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-2xl ring-1 ring-black/10">
                  <div className="aspect-[16/10] flex flex-col p-4 sm:p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-widest text-[var(--muted-foreground)]">Performance snapshot</span>
                      <span className="rounded bg-[var(--surface-border)]/50 px-2 py-1 text-[10px] text-[var(--muted-foreground)]">Last 30 days</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
                      {[
                        { label: "Profit", value: "£2,847", color: accentColor },
                        { label: "Sales", value: "£12,430", color: "#4F46E5" },
                        { label: "Units", value: "1,240", color: "#F97316" },
                        { label: "ROI", value: "34%", color: "#EC4899" },
                      ].map((card) => (
                        <div
                          key={card.label}
                          className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)]/50 p-3 flex flex-col justify-center"
                          style={{
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 1px rgba(255,255,255,0.08), 0 0 20px -4px rgba(255,255,255,0.15), 0 0 0 2px rgba(255,255,255,0.2)",
                          }}
                        >
                          <span className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">{card.label}</span>
                          <span className="text-lg font-semibold" style={{ color: card.color }}>{card.value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 h-24 rounded-lg border border-[var(--surface-border)] bg-[var(--background)]/30 flex items-end gap-0.5 px-1 pb-1">
                      {[40, 65, 45, 80, 55, 70, 90, 60, 75, 85, 70, 95].map((h, i) => (
                        <div
                          key={i}
                          className="flex-1 rounded-t min-h-[4px] transition"
                          style={{ height: `${h}%`, backgroundColor: accentColor, opacity: 0.8 }}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">Sales v Profit · Revenue vs profit</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Dashboard demo - clean screenshot below hero */}
        <section id="dashboard-preview" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/50 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-2xl font-bold text-[var(--foreground)] sm:text-3xl mb-10">
              See your Amazon business (FBA &amp; FBM) at a glance
            </h2>
            <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] shadow-xl w-full max-w-7xl mx-auto">
              <Image
                src="/dashboard-preview.png"
                alt="SellerBunker dashboard — profit, sales, inventory and ROI"
                width={1600}
                height={1000}
                className="w-full h-auto object-contain"
                priority={false}
              />
            </div>
          </div>
        </section>

        {/* 2. Problem section */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Stop guessing your Amazon profits
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-[var(--muted-foreground)]">
              SellerBunker replaces messy spreadsheets and confusing Amazon reports with one clear dashboard—for FBA and FBM sellers alike.
            </p>
            <ul className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                "Amazon reports are confusing",
                "You don't know your true profit",
                "Inventory is hard to track",
                "Reordering decisions are guesswork",
                "You manage everything in spreadsheets",
              ].map((problem) => (
                <li
                  key={problem}
                  className="flex items-center gap-3 rounded-xl border border-[var(--surface-border)] bg-[var(--background)] px-4 py-3"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--foreground)]" style={{ backgroundColor: accentMuted }}>
                    <span className="text-sm" style={{ color: accentColor }}>✕</span>
                  </span>
                  <span className="text-[var(--foreground)]">{problem}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 3. Dashboard highlight */}
        <section className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              See your entire Amazon business in one dashboard
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-[var(--muted-foreground)]">
              Instantly understand how your products are performing with real-time sales, profit, and ROI tracking.
            </p>
            <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { title: "Profit tracking", desc: "True profit after fees & COGS" },
                { title: "Sales performance", desc: "Revenue and units sold" },
                { title: "ROI & margins", desc: "Per product and category" },
                { title: "Inventory summary", desc: "FBA status and stock value" },
                { title: "Recent orders", desc: "Profit per order at a glance" },
                { title: "Category performance", desc: "Sales, profit, ROI by category" },
                { title: "Sales vs profit charts", desc: "Time range filters" },
                { title: "Performance snapshot", desc: "Key metrics in one view" },
              ].map((item) => (
                <div
                  key={item.title}
                  className="rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-5"
                >
                  <h3 className="font-semibold text-[var(--foreground)]" style={{ color: accentColor }}>{item.title}</h3>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4. Features */}
        <section id="features" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Built for how you sell
            </h2>
            <div className="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Profit analytics</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Track real profit after Amazon fees, cost of goods, shipping, and VAT — in one place.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Inventory tracking</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Never run out of stock again. FBA inventory tracking, stock value, and potential profit visibility.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Order tracking</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Monitor recent orders, profit per order, and ROI per product.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Replenishment tools</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Know exactly when to reorder based on sales velocity.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Sales vs profit analytics</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  Visualize performance with sales vs profit charts, snapshots, and time range filters.
                </p>
              </div>
              <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6">
                <h3 className="text-lg font-semibold text-[var(--foreground)]">Cost breakdown & P&amp;L</h3>
                <p className="mt-2 text-[var(--muted-foreground)]">
                  COGS, referral, FBA fees, VAT adjustment — all in one profit &amp; loss view.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 5. How it works */}
        <section id="how-it-works" className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              How it works
            </h2>
            <div className="mt-16 grid gap-10 md:grid-cols-3">
              {[
                { step: 1, title: "Connect Amazon", desc: "Secure Amazon API integration. Create an account and link your Amazon seller account in minutes." },
                { step: 2, title: "Import your data", desc: "SellerBunker pulls your listings, fees, shipments and last 30 days of order data by default—you can specify up to two years of order data, please email us." },
                { step: 3, title: "Track profit", desc: "After an initial sync, fill out your costs (unit cost, prep, delivery, etc.) and instantly see true profit and business performance in your dashboard." },
              ].map(({ step, title, desc }) => (
                <div key={step} className="relative text-center">
                  <div
                    className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold text-black"
                    style={{ backgroundColor: accentColor }}
                  >
                    {step}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-[var(--foreground)]">{title}</h3>
                  <p className="mt-2 text-[var(--muted-foreground)]">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 6. Who it's for */}
        <section className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              For every type of Amazon seller (FBA &amp; FBM)
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--muted-foreground)]">
              Whether you fulfill through Amazon (FBA) or ship yourself (FBM), SellerBunker gives you one view of profit, inventory, and orders.
            </p>
            <div className="mt-16 grid gap-8 md:grid-cols-3">
              {[
                { title: "Online arbitrage (FBA & FBM)", desc: "Track profit across many SKUs. See which products actually make money." },
                { title: "Wholesale sellers (FBA & FBM)", desc: "Monitor inventory and margins at scale. Reorder before you run out." },
                { title: "Private label (FBA & FBM)", desc: "Understand performance across products. Optimize based on real profit." },
              ].map((item) => (
                <div
                  key={item.title}
                  className="rounded-2xl border border-[var(--surface-border)] bg-[var(--background)] p-6 text-center"
                >
                  <h3 className="text-lg font-semibold text-[var(--foreground)]">{item.title}</h3>
                  <p className="mt-2 text-[var(--muted-foreground)]">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 7. Comparison */}
        <section className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              SellerBunker vs spreadsheets
            </h2>
            <div className="mt-12 overflow-hidden rounded-2xl border border-[var(--surface-border)]">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--surface-border)] bg-[var(--surface)]">
                    <th className="px-6 py-4 font-semibold text-[var(--foreground)]">Feature</th>
                    <th className="px-6 py-4 font-semibold text-[var(--foreground)]">SellerBunker</th>
                    <th className="px-6 py-4 font-semibold text-[var(--muted-foreground)]">Spreadsheets</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { feature: "Profit tracking", sb: "✓ Automated", other: "Manual" },
                    { feature: "Inventory view", sb: "✓ Clear", other: "Messy" },
                    { feature: "Sales analytics", sb: "✓ Built-in", other: "Limited" },
                    { feature: "ROI tracking", sb: "✓ Automatic", other: "Manual" },
                  ].map((row) => (
                    <tr key={row.feature} className="border-b border-[var(--surface-border)] last:border-0">
                      <td className="px-6 py-4 text-[var(--foreground)]">{row.feature}</td>
                      <td className="px-6 py-4 font-medium" style={{ color: accentColor }}>{row.sb}</td>
                      <td className="px-6 py-4 text-[var(--muted-foreground)]">{row.other}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* 8. Pricing */}
        <section id="pricing" className="border-b border-[var(--surface-border)] bg-[var(--surface)]/30 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Simple pricing
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-center text-[var(--muted-foreground)]">
              Start with a free trial. No credit card required.
            </p>
            <div className="mt-16 grid gap-8 md:grid-cols-3">
              {[
                { name: "Starter", price: "£14.99", period: "month", orders: "Up to 5,000 orders per month", note: "Testing price for initial users", priceSubline: "Two weeks free, then", cta: "Start free trial", featured: true, badge: "For initial testing" },
                { name: "Growth", price: "TBC", period: "", orders: "5,000 – 50,000 orders per month", cta: "Start free trial", featured: false },
                { name: "Pro", price: "TBC", period: "", orders: "Unlimited orders per month", cta: "Start free trial", featured: false },
              ].map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-2xl border p-6 ${
                    plan.featured
                      ? "border-[var(--surface-border)] ring-2"
                      : "border-[var(--surface-border)] bg-[var(--background)]"
                  }`}
                  style={plan.featured ? { borderColor: accentColor, boxShadow: `0 0 0 1px ${accentColor}` } : undefined}
                >
                  {plan.featured && (
                    <span className="inline-block rounded-full px-3 py-0.5 text-xs font-medium text-black" style={{ backgroundColor: accentColor }}>
                      {"badge" in plan && plan.badge ? plan.badge : "Most popular"}
                    </span>
                  )}
                  <h3 className="mt-4 text-xl font-semibold text-[var(--foreground)]">{plan.name}</h3>
                  {"priceSubline" in plan && plan.priceSubline && (
                    <p className="mt-2 text-sm text-[var(--muted-foreground)]">{plan.priceSubline}</p>
                  )}
                  <p className="mt-1">
                    <span className="text-3xl font-bold text-[var(--foreground)]">{plan.price}</span>
                    {plan.period ? <span className="text-[var(--muted-foreground)]">/{plan.period}</span> : null}
                  </p>
                  <p className="mt-2 text-sm text-[var(--muted-foreground)]">{plan.orders}</p>
                  {"note" in plan && plan.note && (
                    <p className="mt-1 text-xs text-[var(--muted-foreground)] italic">{plan.note}</p>
                  )}
                  {plan.name === "Starter" ? (
                    <>
                      <SignedOut>
                        <SignUpButton mode="redirect" forceRedirectUrl="/start-trial" signInForceRedirectUrl="/start-trial">
                          <button
                            className="mt-6 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-gray-100"
                          >
                            {plan.cta}
                          </button>
                        </SignUpButton>
                      </SignedOut>
                      <SignedIn>
                        <Link
                          href="/start-trial"
                          className="mt-6 flex w-full items-center justify-center rounded-xl bg-white py-3 text-sm font-semibold text-black transition hover:bg-gray-100"
                        >
                          {plan.cta}
                        </Link>
                      </SignedIn>
                    </>
                  ) : (
                    <SignUpButton mode="redirect" forceRedirectUrl="/start-trial" signInForceRedirectUrl="/start-trial">
                      <button
                        className={`mt-6 w-full rounded-xl py-3 text-sm font-semibold transition ${
                          plan.featured ? "bg-white text-black hover:bg-gray-100" : "border border-[var(--surface-border)] text-[var(--foreground)] hover:bg-[var(--surface)]"
                        }`}
                      >
                        {plan.cta}
                      </button>
                    </SignUpButton>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Contact form */}
        <ContactForm />
        {/* 9. Social proof placeholder */}
        <section className="border-b border-[var(--surface-border)] py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 className="text-center text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Trusted by Amazon sellers
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-center text-[var(--muted-foreground)]">
              Built by real Amazon FBA and FBM sellers—ex developers and market professionals—who know what you need to run your business.
            </p>
          </div>
        </section>

        {/* 10. Final CTA */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
            <h2 className="text-3xl font-bold text-[var(--foreground)] sm:text-4xl">
              Take control of your Amazon profits today
            </h2>
            <p className="mt-4 text-lg text-[var(--muted-foreground)]">
              Start your free trial. Connect Amazon (FBA or FBM). See your true profit in minutes.
            </p>
            <div className="mt-10">
<SignedOut>
              <SignUpButton mode="redirect" forceRedirectUrl="/start-trial" signInForceRedirectUrl="/start-trial">
                <button
                  className="rounded-xl bg-white px-8 py-4 text-lg font-semibold text-black transition hover:bg-gray-100"
                >
                  Start free trial
                </button>
              </SignUpButton>
            </SignedOut>
              <SignedIn>
                <Link
                  href="/dashboard"
                  className="inline-block rounded-xl px-8 py-4 text-lg font-semibold text-black transition hover:opacity-90"
                  style={{ backgroundColor: accentColor }}
                >
                  Go to dashboard
                </Link>
              </SignedIn>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--surface-border)] py-4">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row sm:gap-4">
            <img
              src="/sellerbunker-logo.png"
              alt="SellerBunker"
              className="sellerbunker-logo h-12 w-auto max-w-[140px] object-contain object-left opacity-90 sm:h-14 sm:max-w-[160px]"
            />
            <div className="text-center sm:text-left">
              <p className="text-xs text-[var(--muted-foreground)]">
                The profit command center for Amazon FBA &amp; FBM sellers.
              </p>
              <p className="mt-1 text-[10px] text-[var(--muted-foreground)]/80">
                Repricer coming soon once beta testing of the dashboard is complete.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://discord.gg/sellerbunker"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join Discord"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                </svg>
              </a>
              <a
                href="https://www.tiktok.com/@sellerbunker"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join TikTok"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                </svg>
              </a>
              <a
                href="https://www.instagram.com/sellerbunker"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
                aria-label="Join Instagram"
              >
                <svg className="h-5 w-5 sm:h-6 sm:w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
