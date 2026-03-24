import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Amazon FBA Shipment Delays — Receiving Times Guide | SellerBunker",
  description:
    "Understand Amazon FBA shipment delays and typical receiving times. Learn how to track delays and shipment timelines more clearly with SellerBunker.",
};

export default function FbaShipmentDelaysPage() {
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
          Amazon shipment tracking · FBA receiving times
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-tight sm:text-4xl">
          Amazon FBA Shipment Delays — How Long Does It Really Take?
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-[var(--muted-foreground)] sm:text-lg">
          Struggling with delayed FBA shipments?
          <br />
          Track how long Amazon takes to receive your inventory and get a clearer picture of your stock timelines.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sign-up"
            className="inline-flex items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-gray-100 sm:text-base"
          >
            Track your shipments with SellerBunker
          </Link>
          <Link
            href="/"
            className="inline-flex items-center rounded-xl border border-[var(--surface-border)] px-6 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--foreground)]/5 sm:text-base"
          >
            Back to SellerBunker
          </Link>
        </div>

        <div className="mt-8 overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-2 shadow-sm">
          <Image
            src="/fba-shipments-table.png"
            alt="SellerBunker FBA shipments dashboard showing receiving status and missing units"
            width={1024}
            height={452}
            className="h-auto w-full rounded-lg object-contain"
            priority
          />
        </div>

        <div className="mt-10 rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-5 sm:p-6">
          <p className="text-[var(--muted-foreground)]">
            Amazon FBA shipment delays are one of the most common issues sellers face.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            Whether your inventory is stuck in “receiving” or taking longer than expected to become available, understanding FBA processing times is critical for managing stock and cash flow.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            This page helps you understand how long Amazon typically takes to receive shipments — and how to track delays more effectively.
          </p>
        </div>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Why Are Your FBA Shipments Delayed?</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Amazon doesn’t always receive inventory immediately after delivery.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            Common causes of FBA shipment delays include:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Warehouse congestion</li>
            <li>Seasonal spikes (Q4, Prime events)</li>
            <li>Staffing shortages</li>
            <li>Split shipments across multiple fulfilment centres</li>
            <li>Manual checks or discrepancies</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            This means your stock can sit in “receiving” for days — or even weeks.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Typical Amazon FBA Receiving Times</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">In most cases:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Small parcel deliveries: 2-5 days</li>
            <li>Larger shipments / pallets: 5-10+ days</li>
            <li>Peak periods: 10-20+ days</li>
          </ul>
          <p className="mt-4 text-[var(--muted-foreground)]">
            However, these are only estimates — actual times can vary significantly.
          </p>
          <p className="mt-3 font-medium text-[var(--foreground)]">
            Without tracking, it’s hard to know if your shipment is delayed or just slow.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">
            FBA Delays Can Impact Your Business More Than You Think
          </h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            When your inventory is delayed:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>You go out of stock</li>
            <li>You lose sales and ranking</li>
            <li>Your cash flow slows down</li>
            <li>You can’t reinvest in new inventory</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            Even a few days of delay can significantly affect performance.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">The Hard Part: Knowing What’s “Normal”</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            Amazon doesn’t make it easy to track receiving performance over time.
          </p>
          <p className="mt-3 text-[var(--muted-foreground)]">
            You might see:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>“Delivered”</li>
            <li>“Receiving”</li>
            <li>“Checked-in”</li>
          </ul>
          <p className="mt-4 text-[var(--muted-foreground)]">
            But you don’t get:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Clear timelines</li>
            <li>Historical averages</li>
            <li>Benchmark data</li>
          </ul>
          <p className="mt-4 font-medium text-[var(--foreground)]">
            So it’s hard to know when something is actually wrong.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Track Your FBA Shipment Timelines More Clearly</h2>
          <p className="mt-4 text-[var(--muted-foreground)]">
            SellerBunker helps you get a clearer view of your shipments by:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Tracking when shipments are sent and received</li>
            <li>Helping you understand typical receiving times</li>
            <li>Giving you better visibility into delays across your inventory</li>
          </ul>
          <p className="mt-4 text-[var(--muted-foreground)]">
            This allows you to:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted-foreground)]">
            <li>Spot slow shipments earlier</li>
            <li>Plan stock more effectively</li>
            <li>Reduce uncertainty around inventory</li>
          </ul>
          <div className="mt-6">
            <Link
              href="/sign-up"
              className="inline-flex items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-gray-100 sm:text-base"
            >
              Start tracking your shipments
            </Link>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">Example FBA Shipment Timeline</h2>
          <div className="mt-4 rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-5">
            <ul className="space-y-2 text-[var(--muted-foreground)]">
              <li>Day 0: Shipment delivered</li>
              <li>Day 2: Receiving starts</li>
              <li>Day 5: Partially checked in</li>
              <li>Day 8: Fully available</li>
            </ul>
            <p className="mt-4 font-medium text-[var(--foreground)]">
              Without tracking, this can feel like a delay — even if it’s normal.
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold sm:text-3xl">FAQ</h2>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">What causes Amazon FBA shipment delays?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                Delays are usually caused by warehouse congestion, high volume periods, or processing backlogs.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">How long should FBA receiving take?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                Typically 2-5 days for small shipments, but this can extend to 10+ days during busy periods.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">When should I be concerned about a delay?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                If your shipment has been in “receiving” for more than 7-10 days, it may be worth investigating.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--surface-border)] bg-[var(--background)] p-4">
              <p className="font-semibold">Can you speed up Amazon receiving?</p>
              <p className="mt-2 text-[var(--muted-foreground)]">
                No — but you can plan better by understanding average timelines and delays.
              </p>
            </div>
          </div>
        </section>

        <p className="mt-10 text-sm text-[var(--muted-foreground)]">
          Built by active Amazon sellers who deal with FBA delays daily.
        </p>
      </section>
    </main>
  );
}
