import { Header } from "@/components/site/header";
import { Hero } from "@/components/site/hero";
import { HowItWorks } from "@/components/site/how-it-works";
import { Proof } from "@/components/site/proof";
import { Disclosure, Footer } from "@/components/site/footer";
import { TrackerRow } from "@/components/trackers/tracker-row";
import { TrackerSelectionProvider } from "@/components/trackers/selection";
import { TRACKERS } from "@/lib/config";
import { loadReturnsPayload } from "@/lib/returns-server";

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

/**
 * Funds ordered by trailing-year backtest, best first.
 *
 * Ranked on the server rather than in the browser so the grid does not
 * reshuffle under the reader a second after it paints. A fund whose basket
 * cannot be priced keeps its config order at the back rather than being
 * dropped — an unmeasurable basket is still a real vault.
 */
async function rankedTrackers() {
  const { trackers } = await loadReturnsPayload();
  const oneYear = new Map(
    trackers.map((entry) => [
      entry.ticker,
      entry.windows.find((w) => w.label === "1Y")?.value ?? null,
    ]),
  );

  return [...TRACKERS].sort((a, b) => {
    const left = oneYear.get(a.ticker);
    const right = oneYear.get(b.ticker);
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return right - left;
  });
}

export default async function Home() {
  const trackers = await rankedTrackers();

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
              blurb="Ordered by how the basket would have done over the last year. Every vault is live on Solana devnet, and every number on it is read from the chain while you look at it."
            />
            <ul className="grid gap-4 sm:grid-cols-2">
              {trackers.map((tracker, i) => (
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
