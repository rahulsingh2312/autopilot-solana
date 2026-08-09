"use client";

import { SolMark } from "@/components/ui/sol-mark";
import { BRAND, EXPLORER, LIVE_TRACKERS, PROGRAM_ID } from "@/lib/config";
import {
  computeNav,
  formatNav,
  lamportsToSolNumber,
  truncateAddress,
} from "@/lib/format";
import { useVault } from "@/lib/vault/hooks";

function AddressLink({ address, label }: { address: string; label: string }) {
  return (
    <a
      href={EXPLORER("address", address)}
      target="_blank"
      rel="noreferrer"
      className="num text-[0.8125rem] text-ink underline decoration-dotted underline-offset-4 transition-colors hover:text-muted"
      title={address}
    >
      {label}
    </a>
  );
}

function VaultRow({ ticker }: { ticker: string }) {
  const { snapshot } = useVault(ticker, 15_000);
  const deployed = Boolean(snapshot?.tracker);

  return (
    <tr className="border-t border-rule">
      <th scope="row" className="num py-2.5 pr-3 text-left font-medium text-ink">
        <span className="flex items-center gap-2">
          {/* The mint's own artwork, the same file a wallet shows for this
              token. Anything drawn here instead would be a second identity
              for the same asset. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/tokens/${ticker.toLowerCase()}.png`}
            alt=""
            width={18}
            height={18}
            loading="lazy"
            decoding="async"
            className="h-[18px] w-[18px] shrink-0 rounded-full"
          />
          {ticker}
        </span>
      </th>
      <td className="py-2.5 pr-3">
        {snapshot ? (
          <AddressLink
            address={snapshot.vaultAddress}
            label={truncateAddress(snapshot.vaultAddress, 5)}
          />
        ) : (
          <span className="text-faint">…</span>
        )}
      </td>
      <td className="num py-2.5 pr-3 text-right tabular-nums text-ink">
        {deployed && snapshot ? (
          <>
            <SolMark className="mr-1" />
            <span className="grad-num font-semibold">
              {lamportsToSolNumber(snapshot.netAssets).toFixed(4)}
            </span>
          </>
        ) : (
          "n/a"
        )}
      </td>
      <td className="num py-2.5 text-right tabular-nums text-ink">
        {deployed && snapshot
          ? formatNav(computeNav(snapshot.netAssets, snapshot.supply))
          : "n/a"}
      </td>
    </tr>
  );
}

/**
 * No testimonials, no invented track record. The chain is the proof, read
 * live, with links a skeptic can click.
 */
export function Proof() {
  return (
    <section id="proof" className="border-b border-rule">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <header className="mb-10 flex flex-col items-start gap-3">
          <h2 className="display max-w-2xl text-[clamp(1.75rem,4vw,2.75rem)] text-ink">
            No testimonials. <em>The chain is the receipt.</em>
          </h2>
        </header>
        <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-start">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] border-collapse text-sm">
              <caption className="sr-only">
                Deployed vaults and live balances
              </caption>
              <thead>
                <tr className="text-left">
                  <th className="meta pb-2 pr-3 font-medium">Tracker</th>
                  <th className="meta pb-2 pr-3 font-medium">Vault</th>
                  <th className="meta pb-2 pr-3 text-right font-medium">
                    In vault
                  </th>
                  <th className="meta pb-2 text-right font-medium">NAV</th>
                </tr>
              </thead>
              <tbody>
                {LIVE_TRACKERS.map((t) => (
                  <VaultRow key={t.ticker} ticker={t.ticker} />
                ))}
              </tbody>
            </table>
          </div>

          <dl className="card flex min-w-[16rem] flex-col gap-3 p-5 text-[0.8125rem]">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="meta">Program</dt>
              <dd>
                <AddressLink
                  address={PROGRAM_ID}
                  label={truncateAddress(PROGRAM_ID, 5)}
                />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="meta">Audit</dt>
              <dd className="text-ink">Under audit.</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="meta">Source</dt>
              <dd>
                <a
                  href={BRAND.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="num text-ink underline decoration-dotted underline-offset-4 transition-colors hover:text-muted"
                >
                  repo
                </a>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
