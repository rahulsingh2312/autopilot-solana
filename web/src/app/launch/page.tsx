import type { Metadata } from "next";

import { Header } from "@/components/site/header";
import { Disclosure, Footer } from "@/components/site/footer";
import { WaitlistForm } from "./waitlist-form";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = {
  title: "Launch an index",
  description:
    "Pick tokenized stocks and weights, deploy a vault, get a ticker. Not shipped yet. Here is exactly what is missing.",
};

const SHIPPED = [
  {
    label: "The thing that runs a tracker",
    body: "Already generic. A tracker is not custom code, it is a list of tickers and weights. The Pelosi Tracker is one row of config, and a tracker you name would be another. Same code path, both of them. The only difference today is who is allowed to publish one.",
    done: true,
  },
  {
    label: "Buying and selling into a tracker",
    body: "All four instructions run on devnet today. Someone buying your tracker would take the same path they take into the Pelosi Tracker right now: SOL in, one token out, burn it back whenever they want.",
    done: true,
  },
  {
    label: "The screen where you make one",
    body: "Search tokenized tickers, set the weights to 100%, name it, publish. That screen does not exist. This is the actual missing piece.",
    done: false,
  },
  {
    label: "Telling your tracker from ours",
    body: "The Pelosi Tracker earns its trust from a filing anyone can go read. A tracker a stranger made has no filing behind it, so it has to earn trust some other way: who made it, how long it has been running, what is held in it, and whether the weights have ever moved. Every card already shows a rebalance count for exactly this reason.",
    done: false,
  },
  {
    label: "Paying you for it",
    body: "Every tracker already names its own fee recipient, so routing a cut to whoever made it is a config change. Deciding what that cut is, and who is on the hook for it, is not.",
    done: false,
  },
];

export default function LaunchPage() {
  return (
    <>
      <Header />
      <main>
        <section className="border-b border-rule">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:py-20">
            <div className="flex flex-col gap-5">
              <h1 className="display text-[clamp(2.25rem,5.5vw,3.75rem)] text-ink">
                Pick the stocks. Set the weights. <em>Get a ticker.</em>
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-muted">
                The end state is that anyone can make one. Pick the tokenized
                stocks, set the weights, name it, publish. It shows up on the
                shelf next to the Pelosi Tracker, people buy into it the same
                way, and you earn a cut of the fees on it.
              </p>
              {/* <p className="max-w-xl rounded-xl border border-rule bg-paper px-3.5 py-3 text-sm leading-relaxed text-ink">
                This is not shipped. There is no creator flow, no deploy button,
                and no fee split yet. Rather than a coming-soon page with
                nothing behind it, here is exactly what exists and what does
                not.
              </p> */}
            </div>

            <div className="card flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1">
                <h2 className="display text-2xl text-ink">
                  Early access
                </h2>
                <p className="text-[0.8125rem] leading-relaxed text-muted">
                  One email when the creator flow is real. No newsletter.
                </p>
              </div>
              <WaitlistForm />
            </div>
          </div>
        </section>

        <section className="border-b border-rule">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
            <h2 className="display mb-8 text-[clamp(1.75rem,4vw,2.75rem)] text-ink">
              What is built, <em>and what is not.</em>
            </h2>
            <ul className="grid gap-px border border-rule bg-[color:var(--rule)] sm:grid-cols-2">
              {SHIPPED.map((item) => (
                <li key={item.label} className="flex flex-col gap-2 bg-bg p-5">
                  <div className="flex items-center gap-2">
                    <span
                      className="num inline-flex h-5 items-center px-1.5 text-[0.625rem] uppercase tracking-wider"
                      style={{
                        background: item.done ? "var(--pos)" : "transparent",
                        color: item.done ? "var(--bg)" : "var(--ink-faint)",
                        border: item.done
                          ? "none"
                          : "1px solid var(--rule-strong)",
                      }}
                    >
                      {item.done ? "built" : "not yet"}
                    </span>
                    <h3 className="text-base font-semibold tracking-tight text-ink">
                      {item.label}
                    </h3>
                  </div>
                  <p className="text-[0.8125rem] leading-relaxed text-muted">
                    {item.body}
                  </p>
                </li>
              ))}
            </ul>

            <p className="mt-8 max-w-2xl text-[0.8125rem] leading-relaxed text-faint">
              {BRAND.name} ships the curated shelf first because a tracker a
              stranger made carries risks the Pelosi Tracker does not, and the
              screen that tells those two apart has to be designed before the
              publish button exists, not after.
            </p>
          </div>
        </section>

        <Disclosure />
      </main>
      <Footer />
    </>
  );
}
