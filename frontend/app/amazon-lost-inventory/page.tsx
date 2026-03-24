import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Amazon Lost Inventory — Reimbursements Guide | SellerBunker",
  description:
    "Learn how Amazon lost inventory happens, what reimbursements look like, and how to track discrepancies more clearly as an FBA seller.",
};

export default function AmazonLostInventoryPage() {
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
      <section className="mx-auto w-full max-w-5xl rounded-2xl border border-[var(--surface-border)] bg-[var(--surface)] p-8 shadow-sm sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
          Amazon Lost Inventory
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-tight sm:text-4xl">
          Amazon Lost Inventory — Are You Missing Reimbursements?
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted-foreground)] sm:text-lg">
          Amazon can lose or damage inventory — and you may not always be reimbursed automatically.
        </p>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-[var(--muted-foreground)] sm:text-lg">
          Learn how to identify lost inventory and track potential reimbursements more effectively.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sign-up"
            className="inline-flex items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-gray-100 sm:text-base"
          >
            Track your inventory with SellerBunker
          </Link>
          <Link
            href="/"
            className="inline-flex items-center rounded-xl border border-[var(--surface-border)] px-6 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--foreground)]/5 sm:text-base"
          >
            Back to SellerBunker
          </Link>
        </div>

        <div className="mt-10 rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-5 sm:p-6">
          <p className="text-[var(--muted-foreground)]">
            Amazon lost inventory is a common issue for FBA sellers.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            Items can go missing during receiving, transfers, or customer returns — and while Amazon may reimburse some losses, many cases go unnoticed.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            Understanding how lost inventory happens — and how to track it — can help you recover money that would otherwise be missed.
          </p>
        </div>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">What Counts as Lost Inventory?</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Lost inventory refers to items that Amazon cannot account for within the FBA system.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">This can happen when:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Shipments are received but not fully checked in</li>
            <li>Units are lost during warehouse transfers</li>
            <li>Customer returns are not properly processed</li>
            <li>Items are damaged or misplaced</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            These discrepancies can lead to missing stock — and lost revenue.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Amazon Doesn’t Always Catch Everything</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Amazon does issue reimbursements in some cases — but not all losses are automatically detected.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">In reality:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Some reimbursements are delayed</li>
            <li>Some require manual investigation</li>
            <li>Some may never be flagged at all</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            This means sellers can lose money without realising it.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Lost Inventory = Lost Profit</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Even small discrepancies can add up over time.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">Lost inventory can:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Reduce your available stock</li>
            <li>Impact your sales and rankings</li>
            <li>Tie up capital in missing units</li>
            <li>Lower your overall profitability</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            Without tracking, these losses often go unnoticed.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">The Hard Part: Identifying What’s Missing</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Amazon provides reports — but they can be difficult to interpret.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">Sellers often struggle to:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Match shipped vs received units</li>
            <li>Track inventory across multiple reports</li>
            <li>Identify discrepancies over time</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            This makes it hard to consistently spot lost inventory.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Track Inventory Discrepancies More Clearly</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            SellerBunker helps you get better visibility into your inventory by:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Tracking shipments and received units</li>
            <li>Highlighting potential discrepancies</li>
            <li>Helping you identify where inventory may be missing</li>
          </ul>
          <p className="mt-4 text-[var(--muted-foreground)]">
            This allows you to:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Spot issues earlier</li>
            <li>Investigate potential losses</li>
            <li>Stay more in control of your stock</li>
          </ul>
          <div className="mt-6">
            <Link
              href="/sign-up"
              className="inline-flex items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-gray-100 sm:text-base"
            >
              Track your inventory with SellerBunker
            </Link>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Example: Missing Units in a Shipment</h2>
          <div className="mt-4 rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-5">
            <ul className="space-y-2 text-[var(--muted-foreground)]">
              <li>Sent: 100 units</li>
              <li>Received: 94 units</li>
              <li>Missing: 6 units</li>
            </ul>
            <p className="mt-4 font-medium text-[var(--foreground)]">
              If not tracked, these discrepancies can be overlooked.
            </p>
            <p className="mt-2 text-[var(--muted-foreground)]">
              Even small gaps like this can add up across multiple shipments.
            </p>
          </div>
          <div className="mt-5 overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-2 shadow-sm">
            <Image
              src="/amazon-lost-inventory-example.png"
              alt="SellerBunker inventory and shipment dashboard showing missing units"
              width={1024}
              height={452}
              className="h-auto w-full rounded-lg object-contain"
            />
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Why Inventory Gets Lost</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Receiving errors</li>
            <li>Internal warehouse transfers</li>
            <li>Damaged or misplaced items</li>
            <li>Returns not processed correctly</li>
            <li>System discrepancies</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            Understanding these helps you know where to look.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">FAQ</h2>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">What is Amazon lost inventory?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                Lost inventory refers to items that Amazon cannot locate within its fulfilment network.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">Does Amazon reimburse lost inventory?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                Amazon may reimburse some lost or damaged items, but not all cases are automatically detected.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">How do I find lost inventory on Amazon?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                You need to compare shipment data, inventory reports, and reconciliation data to identify discrepancies.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">How long does Amazon take to reimburse lost inventory?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                Reimbursements can take days or weeks — and sometimes require manual action.
              </p>
            </div>
          </div>
        </section>

        <p className="mt-10 text-sm text-[var(--muted-foreground)]">
          Built by Amazon sellers who regularly deal with inventory discrepancies.
        </p>
      </section>
    </main>
  );
}
