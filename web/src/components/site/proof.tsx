"use client";

import { SolMark } from "@/components/ui/sol-mark";
import { TokenTicker } from "@/components/ui/token-icon";
import { TokenMark, useXstocks } from "@/components/trackers/token-mark";
import {
  BRAND,
  CLUSTER,
  EXPLORER,
  LIVE_TRACKERS,
  PROGRAM_ID,
  TRACKERS,
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

/**
 * What the vault actually holds, as marks.
 *
 * A vault that has taken deposits but never had its legs bought holds only
 * SOL, and that is a materially different thing from one tracking its basket.
 * Showing the marks makes the difference visible without anyone reading a
 * number: four logos means four positions, no logos means the SOL never got
 * converted.
 */
function Holdings({ ticker }: { ticker: string }) {
  const { snapshot } = useVault(ticker, 15_000);
  const assets = useXstocks();
  const config = TRACKERS.find((t) => t.ticker === ticker);

  const held = (snapshot?.holdings ?? []).filter((h) => h.balance > 0n);
  if (!snapshot?.tracker) return <span className="text-faint">n/a</span>;
  if (held.length === 0) {
    return (
      <span className="num text-[0.6875rem] text-faint" title="Deposits have not been converted into the basket yet">
        SOL only
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      {held.map((h) => {
        // The basket is ordered, so index maps straight back to the leg the
        // config names — no matching on mint, which repeats across trackers.
        const leg = config?.legs[h.index];
        const symbol = leg?.symbol ?? "?";
        return (
          <span
            key={`${h.mint}-${h.index}`}
            title={`${symbol}: ${h.units.toLocaleString(undefined, { maximumFractionDigits: 6 })} units, ${
              h.actualBps !== null ? (h.actualBps / 100).toFixed(1) : "?"
            }% of the vault`}
          >
            <TokenMark
              symbol={symbol}
              asset={leg?.xstock ? assets[leg.xstock] : undefined}
              size={18}
            />
          </span>
        );
      })}
    </span>
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
            label={truncateAddress(snapshot.shareMintAddress, 4)}
          />
        ) : (
          <span className="text-faint">…</span>
        )}
      </td>
      {/* The vault as well as the token. They answer different questions —
          the mint is what you hold, the vault is where the assets sit — and a
          skeptic checking the second should not have to derive it. */}
      <td className="hidden py-2.5 pr-2 sm:table-cell sm:pr-3">
        {snapshot ? (
          <AddressLink
            address={snapshot.vaultAddress}
            label={truncateAddress(snapshot.vaultAddress, 4)}
          />
        ) : (
          <span className="text-faint">…</span>
        )}
      </td>
      <td className="py-2.5 pr-2 sm:pr-3">
        <Holdings ticker={ticker} />
      </td>
      <td className="num py-2.5 text-right tabular-nums text-ink sm:pr-3">
        {deployed && snapshot ? (
          <>
            <SolMark className="mr-1" />
            <span className="grad-num font-semibold">
              {lamportsToSolNumber(snapshot.netAssets).toFixed(4)}
            </span>
            {/* An unpriced leg makes the total a floor, not a valuation. */}
            {snapshot.navComplete ? null : (
              <span className="text-faint" title="A leg could not be priced, so this is a lower bound">
                {" "}+?
              </span>
            )}
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
                  <th className="meta hidden pb-2 pr-3 font-medium sm:table-cell">
                    Vault
                  </th>
                  <th className="meta pb-2 pr-3 font-medium">Holds</th>
                  <th className="meta pb-2 text-right font-medium sm:pr-3">
                    In vault
                  </th>
                  {/* NAV is the first thing to cut when the row will not fit a
                      phone: the SOL total beside it already carries the size. */}
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

              {/* <div className="flex items-baseline justify-between gap-4 border-t border-black/[0.07] px-5 py-3">
                <dt className="meta">Audit</dt>
                <dd className="flex items-center gap-1.5 text-ink">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e0a33a]"
                  />
                  Under audit
                </dd>
              </div> */}

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
