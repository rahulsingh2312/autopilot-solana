import { Header } from "@/components/site/header";
import { Hero } from "@/components/site/hero";
import { HowItWorks } from "@/components/site/how-it-works";
import { Proof } from "@/components/site/proof";
import { Disclosure, Footer } from "@/components/site/footer";
import { TrackerRow } from "@/components/trackers/tracker-row";
import { TrackerSelectionProvider } from "@/components/trackers/selection";
import { TRACKERS } from "@/lib/config";

export function SectionHead({
  title,
  blurb,
}: {
  title: React.ReactNode;
  blurb?: string;
}) {
  return (
    <header className="mb-10 flex flex-col items-start gap-3">
      <h2 className="display max-w-2xl text-[clamp(1.75rem,4vw,2.75rem)] text-ink">
        {title}
      </h2>
      {blurb ? (
        <p className="max-w-xl text-[0.9375rem] leading-relaxed text-muted">
          {blurb}
        </p>
      ) : null}
    </header>
  );
}

export default function Home() {
  return (
    <>
      <Header />
      <TrackerSelectionProvider>
        <main>
          <Hero />

        <section id="trackers" className="border-b border-rule">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
            <SectionHead
              title={
                <>
                  Famous portfolios, <em>one token each.</em>
                </>
              }
              blurb="Every vault below is live on Solana devnet, and every number on it is read from the chain while you look at it."
            />
            <ul className="grid gap-4 sm:grid-cols-2">
              {TRACKERS.map((tracker, i) => (
                <TrackerRow key={tracker.ticker} tracker={tracker} index={i} />
              ))}
            </ul>
          </div>
        </section>

          <HowItWorks />
          <Proof />
          <Disclosure />
        </main>
      </TrackerSelectionProvider>
      <Footer />
    </>
  );
}
