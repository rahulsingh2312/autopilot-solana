"use client";

import { SolMark } from "@/components/ui/sol-mark";
import { TokenTicker } from "@/components/ui/token-icon";
import {
  BRAND,
  CLUSTER,
  EXPLORER,
  LIVE_TRACKERS,
  PROGRAM_ID,
} from "@/lib/config";
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
      <th scope="row" className="num py-2.5 pr-2 text-left font-medium text-ink sm:pr-3">
        <TokenTicker ticker={ticker} size={18} />
      </th>
      <td className="py-2.5 pr-2 sm:pr-3">
        {snapshot ? (
          <AddressLink
            address={snapshot.shareMintAddress}
            label={truncateAddress(snapshot.shareMintAddress, 5)}
          />
        ) : (
          <span className="text-faint">…</span>
        )}
      </td>
      <td className="num py-2.5 text-right tabular-nums text-ink sm:pr-3">
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
      <td className="num hidden py-2.5 text-right tabular-nums text-ink sm:table-cell">
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
            <table className="w-full border-collapse text-[0.8125rem] sm:text-sm">
              <caption className="sr-only">
                Deployed vaults and live balances
              </caption>
              <thead>
                <tr className="text-left">
                  <th className="meta pb-2 pr-3 font-medium">Tracker</th>
                  <th className="meta pb-2 pr-3 font-medium">Token</th>
                  <th className="meta pb-2 text-right font-medium sm:pr-3">
                    In vault
                  </th>
                  {/* NAV is 1.0000 on every live vault today and it is the first
                      thing to cut when the row will not fit a phone. */}
                  <th className="meta hidden pb-2 text-right font-medium sm:table-cell">
                    NAV
                  </th>
                </tr>
              </thead>
              <tbody>
                {LIVE_TRACKERS.map((t) => (
                  <VaultRow key={t.ticker} ticker={t.ticker} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Glass, like the fund panel: this is the same kind of object, a
              pane of facts laid over the page rather than a card sitting in
              it. Rows are separated by hairlines instead of gaps so the three
              read as one record. */}
          <div className="glass min-w-[17rem] overflow-hidden">
            <div className="flex items-center gap-2 border-b border-black/[0.07] px-5 py-3">
              <span
                aria-hidden
                className="grad-flow h-1.5 w-1.5 shrink-0 rounded-full"
              />
              <span className="meta">Verify it yourself</span>
            </div>

            <dl className="flex flex-col text-[0.8125rem]">
              <div className="flex items-baseline justify-between gap-4 px-5 py-3">
                <dt className="meta">Program</dt>
                <dd>
                  <AddressLink
                    address={PROGRAM_ID}
                    label={truncateAddress(PROGRAM_ID, 5)}
                  />
                </dd>
              </div>

              <div className="flex items-baseline justify-between gap-4 border-t border-black/[0.07] px-5 py-3">
                <dt className="meta">Network</dt>
                <dd className="num text-ink">
                  {CLUSTER === "devnet" ? "Solana devnet" : "Solana mainnet"}
                </dd>
              </div>

              <div className="flex items-baseline justify-between gap-4 border-t border-black/[0.07] px-5 py-3">
                <dt className="meta">Audit</dt>
                <dd className="flex items-center gap-1.5 text-ink">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e0a33a]"
                  />
                  Under audit
                </dd>
              </div>

              <div className="flex items-baseline justify-between gap-4 border-t border-black/[0.07] px-5 py-3">
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
      </div>
    </section>
  );
}
