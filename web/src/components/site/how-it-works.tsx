import { ISSUER } from "@/lib/config";

/** The sequence is the information: this is the order things happen in. */
const STEPS = [
  [
    "Pick a tracker",
    "Each one follows a disclosed source: an SEC filing, a public index, a legal disclosure. The holdings and weights are printed on the card before you spend anything.",
  ],
  [
    "Deposit SOL",
    "One transaction into a program-owned vault. You get the tracker's token, minted at NAV, which is vault assets divided by supply and nothing else. Your signed minimum is enforced on chain.",
  ],
  [
    "Redeem whenever",
    "Burn the token for SOL at NAV, any hour of any day. No lockup, no queue, no one to ask.",
  ],
] as const;

const FINE_PRINT = [
  {
    title: "NAV and minting",
    body: "Mint price is net assets divided by supply at the slot your transaction lands. Your signed minimum is enforced on chain, so a worse price reverts instead of costing you.",
  },
  {
    title: "Rebalancing",
    body: "Only the tracker authority can publish a new basket, and every change emits an on-chain event with a counter and timestamp. The card shows when weights last changed.",
  },
  {
    title: "The tokenized-stock layer",
    body: `Mainnet routes through ${ISSUER.name} by ${ISSUER.issuer}. You hold a claim on a tokenized share, not the share itself. Issuer risk is real.`,
  },
  {
    title: "Coverage gaps",
    body: "Only ~130 US equities are tokenized. Weights with no tokenized equivalent sit in the SOL sleeve, and each card states the percentage affected.",
  },
  {
    title: "Redemption reality",
    body: "Tokenized-equity books are thin when US markets are closed. The quote shows fee and minimum before you sign, not after.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="band border-b border-rule">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <header className="mb-12 flex flex-col items-start gap-3">
          <h2 className="display max-w-2xl text-[clamp(1.75rem,4vw,2.75rem)] text-ink">
            Three steps, <em>no fine print hidden.</em>
          </h2>
        </header>

        <ol className="grid gap-0 border-l border-rule">
          {STEPS.map(([title, body], i) => (
            <li
              key={title}
              className="relative grid gap-2 py-7 pl-8 sm:grid-cols-[10rem_1fr] sm:gap-8 sm:py-8"
            >
              <span
                aria-hidden
                className="absolute -left-[5px] top-[2.4rem] h-2.5 w-2.5 rounded-full grad-flow"
              />
              <span className="num text-sm font-semibold text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex max-w-xl flex-col gap-1.5">
                <h3 className="text-xl font-semibold tracking-tight text-ink">
                  {title}
                </h3>
                <p className="text-[0.9375rem] leading-relaxed text-muted">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <details className="group mt-8 overflow-hidden rounded-2xl border border-rule bg-bg">
          <summary className="num flex cursor-pointer items-center justify-between px-4 py-3 text-xs uppercase tracking-widest text-muted hover:text-ink">
            The mechanics nobody else explains
            <span aria-hidden className="group-open:hidden">
              +
            </span>
            <span aria-hidden className="hidden group-open:inline">
              −
            </span>
          </summary>
          <div className="grid border-t border-rule lg:grid-cols-2">
            {FINE_PRINT.map((item, i) => (
              <div
                key={item.title}
                className={`flex flex-col gap-1.5 border-b border-r border-rule p-5 last:border-b-0 ${
                  i === FINE_PRINT.length - 1 ? "lg:col-span-2" : ""
                }`}
              >
                <h3 className="text-base font-semibold tracking-tight text-ink">
                  {item.title}
                </h3>
                <p className="text-[0.8125rem] leading-relaxed text-muted">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
