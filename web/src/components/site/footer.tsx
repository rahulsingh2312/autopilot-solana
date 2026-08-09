import Link from "next/link";

import { BRAND, IMAGE_CREDITS, ISSUER, TRACKERS } from "@/lib/config";

const SUBJECTS = TRACKERS.map((t) => t.subject).join(", ");

/** The one paragraph that must always be visible, plus the rest on demand. */
export function Disclosure() {
  return (
    <section aria-label="Risk disclosure" className="band border-b border-rule">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 sm:px-6">
        <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted">
          Not an ETF, not a registered fund, not investment advice. Token
          holders have no shareholder rights. Not affiliated with {SUBJECTS},
          or anyone else a tracker follows. Solana program is under going Audit.
        </p>
        <details className="group max-w-3xl">
          <summary className="num cursor-pointer list-none text-[0.6875rem] uppercase tracking-widest text-faint hover:text-ink">
            <span className="group-open:hidden">Full disclosure +</span>
            <span className="hidden group-open:inline">Less −</span>
          </summary>
          <div className="flex flex-col gap-3 pt-3 text-[0.8125rem] leading-relaxed text-muted">
            <p>
              On mainnet, vaults would hold tokenized equities issued by{" "}
              {ISSUER.issuer} under the {ISSUER.name} programme. That is a
              claim on an issuer, not a share registered to you, and it carries
              issuer, custody, and redemption risk a brokerage account does
              not.
            </p>
            <p>
              Solana program is currently under audit. Names
              are used to describe publicly disclosed information, nothing
              more. Full terms, privacy, and risk pages are linked below.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="mt-auto overflow-hidden">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-8 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <span className="text-[0.8125rem] text-faint">{BRAND.tagline}</span>

          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-muted">
            <Link href="/launch" className="transition-colors hover:text-ink">
              Launch an index
            </Link>
            <Link href="/legal/terms" className="transition-colors hover:text-ink">
              Terms
            </Link>
            <Link href="/legal/privacy" className="transition-colors hover:text-ink">
              Privacy
            </Link>
            <Link href="/legal/risk" className="transition-colors hover:text-ink">
              Risk
            </Link>
            <a
              href={`mailto:${BRAND.contactEmail}`}
              className="transition-colors hover:text-ink"
            >
              Contact
            </a>
            <a
              href={BRAND.repo}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              Source
            </a>
          </nav>
        </div>

        <p className="border-t border-rule pt-4 text-[0.6875rem] leading-relaxed text-faint">
          Portraits are dot-matrix halftone renderings derived from:{" "}
          {IMAGE_CREDITS.map((credit, i) => (
            <span key={credit.subject}>
              {i > 0 ? "; " : ""}
              {credit.subject} by {credit.author},{" "}
              <a
                href={credit.licenseUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-ink"
              >
                {credit.license}
              </a>
            </span>
          ))}
          . Holdings are reproduced from public SEC filings as filed.
        </p>
      </div>

      {/* The Marinade move: the wordmark as a landscape, cropped by the fold. */}
      <p
        aria-hidden
        className="display pointer-events-none select-none whitespace-nowrap text-center text-[clamp(6rem,22vw,18rem)] leading-[0.72] text-ink"
        style={{ marginBottom: "-0.28em", opacity: 0.06 }}
      >
        {BRAND.name}
        <em>.</em>
      </p>
    </footer>
  );
}
