import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Amazon Profit Calculator | SellerBunker",
  description:
    "Calculate your real Amazon profit after fees, VAT, shipping, and prep costs. Then track it automatically in SellerBunker.",
};

export default function AmazonProfitCalculatorPage() {
  return (
    <main className="landing-seo-bg min-h-screen px-4 py-16 text-[var(--foreground)] sm:px-6 lg:px-8">
      <style>{`
        .landing-seo-bg {
          --background: #e8ebf0;
          --foreground: #111827;
          --surface: #f3f5f8;
          --surface-border: #cbd5e1;
          --muted-foreground: #475569;
          background-image:
            radial-gradient(1200px 500px at 20% -10%, rgba(255, 255, 255, 0.95), transparent 60%),
            radial-gradient(900px 420px at 85% 0%, rgba(255, 255, 255, 0.65), transparent 60%),
            linear-gradient(180deg, #eef2f7 0%, #e2e8f0 100%);
          background-attachment: fixed;
        }
      `}</style>
      <section className="mx-auto w-full max-w-4xl rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 shadow-sm sm:p-10">
        <p className="text-sm leading-relaxed text-[var(--muted-foreground)] sm:text-base">
          Looking for an Amazon profit calculator?
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted-foreground)] sm:text-base">
          SellerBunker helps you estimate your real Amazon FBA profit by factoring in cost of goods, Amazon fees, and real selling data.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted-foreground)] sm:text-base">
          Unlike basic calculators, this gives you a more realistic view of your margins and ROI.
        </p>

        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
          Amazon Profit Calculator
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-tight sm:text-4xl">
          Amazon Profit Calculator — Estimate Your Real FBA Profit
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted-foreground)] sm:text-lg">
          Revenue alone does not show the true picture. SellerBunker helps you account
          for Amazon fees, VAT, shipping, prep, and other costs so you can track real
          profitability across products.
        </p>

        <div className="mt-8 overflow-hidden rounded-xl border border-[var(--surface-border)]">
          <Image
            src="/dashboard-preview.png"
            alt="SellerBunker dashboard preview"
            width={1280}
            height={720}
            className="h-auto w-full object-cover"
            priority
          />
        </div>

        <div className="mt-10">
          <h2 className="text-2xl font-bold text-[var(--foreground)] sm:text-3xl">
            How to Calculate Amazon FBA Profit
          </h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Selling price</li>
            <li>Minus Amazon referral fees</li>
            <li>Minus FBA fulfillment fees</li>
            <li>Minus cost of goods (COGS)</li>
            <li>Minus shipping and prep</li>
          </ul>
        </div>

        <div className="mt-10">
          <h2 className="text-2xl font-bold text-[var(--foreground)] sm:text-3xl">
            What Fees Should You Include in an Amazon Profit Calculator?
          </h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Referral fees</li>
            <li>FBA fees</li>
            <li>Storage fees</li>
            <li>Prep + shipping</li>
            <li>VAT</li>
          </ul>
        </div>

        <div className="mt-10">
          <h2 className="text-2xl font-bold text-[var(--foreground)] sm:text-3xl">
            FAQ
          </h2>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold text-[var(--foreground)]">
                Q: What is the best Amazon profit calculator?
              </p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                A: Most calculators give estimates. SellerBunker helps track real costs over time.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold text-[var(--foreground)]">
                Q: How accurate are Amazon profit calculators?
              </p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                A: Accuracy depends on including all costs like fees, VAT, and shipping.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sign-up"
            className="inline-flex items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-gray-100 sm:text-base"
          >
            Track it automatically with SellerBunker
          </Link>
          <Link
            href="/"
            className="inline-flex items-center rounded-xl border border-[var(--surface-border)] px-6 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--foreground)]/5 sm:text-base"
          >
            Back to SellerBunker
          </Link>
        </div>
      </section>
    </main>
  );
}
