"use client";

import { useMemo, useState } from "react";
import { useAction, useClient } from "@solana/react";
import type { Address } from "@solana/kit";

import type { AppClient } from "@/app/providers";
import { EXPLORER, type TrackerConfig } from "@/lib/config";
import {
  computeNav,
  formatPpm,
  formatNav,
  formatShares,
  formatSol,
  lamportsToSolNumber,
  solToLamports,
} from "@/lib/format";
import { findAssociatedTokenPda } from "@/lib/vault/program";
import {
  buildOracleAccounts,
  findAssociatedTokenPdaFor,
} from "@/lib/vault/oracle";
import {
  fetchLookupTables,
  measureBatch,
  packSwapPlans,
  planSwapToSol,
  sendSwapBatch,
} from "@/lib/vault/exit";
import { tokenProgramOfMint } from "@/lib/leg-bindings";
import {
  explainTransactionError,
  getCreateAssociatedTokenIdempotentInstruction,
  getDepositInstruction,
  getRedeemForSolInstruction,
  getRedeemInKindInstruction,
} from "@/lib/vault/instructions";
import type { VaultSnapshot } from "@/lib/vault/hooks";
import { useShareBalance, useSolBalance } from "@/lib/vault/hooks";
import { TokenTicker } from "@/components/ui/token-icon";
import {
  useWalletAddress,
  ConnectButton,
} from "@/components/wallet/connect-button";

/** Half a percent. NAV only moves between quote and landing if someone else
 *  transacts in the same slot, so this is generous rather than tight. */
const SLIPPAGE_BPS = 50n;

/** Leave enough SOL behind to pay fees and the share account's rent. */
const RESERVE_LAMPORTS = 5_000_000n;

/**
 * `stocks` is `redeem_in_kind`: it delivers a pro-rata slice of every leg
 * rather than SOL.
 *
 * It is not an advanced option, it is the exit that always works. Redeeming
 * for SOL pays out of the sleeve, so a vault that has bought its basket can
 * only cover a small redemption that way — habitSOL holds 3% in SOL and 97% in
 * stock, and the program computes the full claim and then fails the reserve
 * check rather than paying part of it. It is also oracle-free, so it keeps
 * working when a Pyth feed is stale and valuation reverts.
 */
type Mode = "buy" | "redeem" | "stocks";

/**
 * The inline trade surface: glass tabs, glass input, gradient submit. Lives
 * inside the hero fund panel — buying no longer needs a modal.
 */
export function TradeForm({
  tracker,
  snapshot,
  onSettled,
}: {
  tracker: TrackerConfig;
  snapshot: VaultSnapshot;
  onSettled: () => void;
}) {
  const client = useClient<AppClient>();
  const owner = useWalletAddress();
  const [mode, setMode] = useState<Mode>("buy");
  /** Progress text while a multi-step exit runs. */
  const [step, setStep] = useState<string | null>(null);
  /** Legs too thin to sell, delivered as stock instead. */
  const [partial, setPartial] = useState<string[]>([]);
  const [amount, setAmount] = useState("");

  const { lamports: solBalance, refresh: refreshSol } = useSolBalance(owner);
  const { shares, refresh: refreshShares } = useShareBalance(
    owner,
    snapshot.shareMintAddress,
  );

  const trackerAccount = snapshot.tracker!;
  const nav = computeNav(snapshot.netAssets, snapshot.supply);

  /**
   * The largest SOL redemption the sleeve can actually settle.
   *
   * `redeem_for_sol` checks the holder's *gross* claim against the vault's
   * lamports, so anything above this computes a correct payout and then
   * reverts. Showing it lets the form say so before the wallet does.
   */
  const maxSolRedeemShares =
    snapshot.netAssets > 0n && snapshot.supply > 0n
      ? (snapshot.sleeveLamports * snapshot.supply) / snapshot.netAssets
      : snapshot.supply;

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const quote = useMemo(() => {
    if (!valid) return null;

    if (mode === "buy") {
      const lamportsIn = solToLamports(parsed);
      const fee =
        (lamportsIn * BigInt(trackerAccount.depositFeePpm)) / 1_000_000n;
      const net = lamportsIn - fee;
      const sharesOut =
        snapshot.supply === 0n || snapshot.netAssets === 0n
          ? net
          : (net * snapshot.supply) / snapshot.netAssets;
      const minOut = (sharesOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      return { lamportsIn, fee, net, out: sharesOut, minOut };
    }

    const sharesIn = solToLamports(parsed);
    const gross =
      snapshot.supply === 0n
        ? 0n
        : (snapshot.netAssets * sharesIn) / snapshot.supply;
    const fee = (gross * BigInt(trackerAccount.redeemFeePpm)) / 1_000_000n;
    const net = gross - fee;
    const minOut = (net * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    return { lamportsIn: sharesIn, fee, net, out: net, minOut };
  }, [valid, parsed, mode, snapshot, trackerAccount]);

  /**
   * What an in-kind redemption delivers, per leg.
   *
   * `vault_balance × shares ÷ supply`, with the fee taken as a haircut that
   * stays in the vault. No oracle: this is the same arithmetic the program
   * does, and it is correct at any price.
   */
  const inKindQuote = useMemo(() => {
    if (!valid || mode !== "stocks" || snapshot.supply === 0n) return null;
    const sharesIn = solToLamports(parsed);
    const afterFee =
      (sharesIn * (1_000_000n - BigInt(trackerAccount.redeemFeePpm))) /
      1_000_000n;
    return snapshot.holdings.map((h) => ({
      index: h.index,
      mint: h.mint,
      decimals: h.decimals,
      amount: (h.balance * afterFee) / snapshot.supply,
    }));
  }, [valid, parsed, mode, snapshot, trackerAccount]);

  const insufficient =
    mode === "buy"
      ? quote
        ? quote.lamportsIn + RESERVE_LAMPORTS > solBalance
        : false
      : quote
        ? quote.lamportsIn > shares
        : false;

  const paused = trackerAccount.paused && mode === "buy";

  const {
    dispatch,
    isRunning,
    error,
    data: signature,
    reset,
  } = useAction(async (signal: AbortSignal) => {
    if (!owner || !quote) throw new Error("Connect a wallet first.");

    const holderShares = await findAssociatedTokenPda(
      owner,
      snapshot.shareMintAddress,
    );

    /**
     * Set when the pre-sale could not raise the full claim.
     *
     * Declared here because it decides which instruction is built, and that
     * decision is made further down than the sale that sets it.
     */
    let soldShort = false;

    if (sellThrough) {
      setStep("Selling your share");
      const prepared = await fetch("/api/vault/prepare-redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: tracker.ticker,
          owner,
          shares: quote.lamportsIn.toString(),
        }),
        signal,
      }).then((r) => r.json());

      if (prepared.error) throw new Error(prepared.error);

      /**
       * A leg that will not route does not fail the exit.
       *
       * Some positions are too thin to sell at all: every route Jupiter
       * returns for them is wider than a Solana transaction can hold, at any
       * size. Refusing the whole redemption over one such leg would strand a
       * holder in a fund they asked to leave.
       *
       * So the sale takes what it can, and the redemption switches to in-kind:
       * the holder receives the SOL that was raised plus the unsold positions
       * as stock, in the same single transaction. They are told which, and
       * they are out either way.
       */
      if (!prepared.ready) {
        soldShort = true;
        setPartial(prepared.unsold ?? []);
      }

      // Nothing needs rebuilding. The instruction carries the share count and
      // the program recomputes the payout from the vault as it stands, so the
      // sale that just happened is already reflected. `minLamportsOut` still
      // guards the holder against the sleeve being drained in between.
      setStep("Claiming your SOL");
    }

    // The share account has to exist before a deposit can mint into it.
    //
    // The Anchor program created it inline with `init_if_needed`; the Pinocchio
    // program deliberately does not, because that constraint drags in the
    // associated-token program and an instruction class with a known
    // reinitialization footgun. So the caller creates it — idempotently, so a
    // returning depositor pays nothing and there is no round trip to check
    // first, and no race between checking and sending.
    //
    // Without this the deposit fails account validation with
    // InvalidAccountOwner: an account that does not exist is system-owned, so
    // it is not a token account.
    // Both directions value the basket, so both carry the oracle accounts.
    // These are derived, not fetched: every one is checked on chain against the
    // leg it claims to price, so a wrong address fails the transaction rather
    // than mispricing it.
    const oracleAccounts = await buildOracleAccounts(
      trackerAccount,
      snapshot.vaultAddress,
      (mint) => tokenProgramOfMint(mint) as Address,
    );

    // In-kind delivery needs, per leg in basket order: the mint, the vault's
    // token account, and the holder's. No oracle accounts — this path never
    // consults a price, which is exactly why it still works when one is stale.
    // The stocks tab always takes delivery. Selling for SOL normally settles
    // out of the refilled sleeve — unless a leg could not be sold, in which
    // case in-kind is what delivers both the SOL raised and the stub position.
    const takesBasket = mode === "stocks" || soldShort;

    const legAccounts: Address[] = [];
    if (takesBasket) {
      for (const h of snapshot.holdings) {
        const tokenProgram = tokenProgramOfMint(h.mint) as Address;
        legAccounts.push(
          h.mint as Address,
          await findAssociatedTokenPdaFor(
            snapshot.vaultAddress,
            h.mint as Address,
            tokenProgram,
          ),
          await findAssociatedTokenPdaFor(
            owner,
            h.mint as Address,
            tokenProgram,
          ),
        );
      }
    }

    const instruction = takesBasket
      ? getRedeemInKindInstruction({
          holder: owner,
          tracker: snapshot.trackerAddress,
          shareMint: snapshot.shareMintAddress,
          vault: snapshot.vaultAddress,
          holderShares,
          sharesIn: quote.lamportsIn,
          legAccounts,
        })
      : mode === "buy"
        ? getDepositInstruction({
            depositor: owner,
            tracker: snapshot.trackerAddress,
            shareMint: snapshot.shareMintAddress,
            vault: snapshot.vaultAddress,
            feeRecipient: trackerAccount.feeRecipient,
            depositorShares: holderShares,
            lamportsIn: quote.lamportsIn,
            minSharesOut: quote.minOut,
            oracleAccounts,
          })
        : getRedeemForSolInstruction({
            holder: owner,
            tracker: snapshot.trackerAddress,
            shareMint: snapshot.shareMintAddress,
            vault: snapshot.vaultAddress,
            feeRecipient: trackerAccount.feeRecipient,
            holderShares,
            sharesIn: quote.lamportsIn,
            minLamportsOut: quote.minOut,
            oracleAccounts,
          });

    const instructions =
      mode === "buy"
        ? [
            getCreateAssociatedTokenIdempotentInstruction({
              payer: owner,
              owner,
              mint: snapshot.shareMintAddress,
              ata: holderShares,
            }),
            instruction,
          ]
        : takesBasket
          ? [
              // The program creates nothing, so the holder needs a token
              // account for every leg before it can be paid into. Idempotent,
              // so a second redemption pays no rent and there is no round trip
              // to check first.
              ...(await Promise.all(
                snapshot.holdings.map(async (h) => {
                  const tokenProgram = tokenProgramOfMint(h.mint) as Address;
                  return getCreateAssociatedTokenIdempotentInstruction({
                    payer: owner,
                    owner,
                    mint: h.mint as Address,
                    ata: await findAssociatedTokenPdaFor(
                      owner,
                      h.mint as Address,
                      tokenProgram,
                    ),
                    tokenProgram,
                  });
                }),
              )),
              instruction,
            ]
          : [instruction];

    /**
     * Selling for SOL out of a vault that holds stock.
     *
     * The sleeve cannot cover it and the program will not sell on the holder's
     * behalf, so the sale happens here: take the basket in kind, then sell each
     * leg through Jupiter from the holder's own wallet.
     *
     * Sequential, and it has to be. `redeem_in_kind` pays
     * `vault_balance × shares ÷ supply`, and the vault's balance can move
     * between quoting and signing — so the amounts are read back after the burn
     * rather than assumed. Each leg is then quoted against what actually
     * arrived.
     */
    /**
     * Selling for SOL out of a fully invested vault.
     *
     * The vault sells the holder's share first, server-side, in its own name.
     * Only then is a signature requested, and it is a plain `redeem_for_sol`
     * settled out of the sleeve — one transaction, no Jupiter, nothing for the
     * holder to sign twice.
     */

    const result = await client.sendTransaction(instructions, {
      abortSignal: signal,
    });

    setStep(null);
    onSettled();
    refreshSol();
    refreshShares();

    /**
     * A deposit arrives as SOL and buys nothing by itself.
     *
     * Left alone it drags the fund against its own basket until somebody
     * rebalances, and every later depositor dilutes the basket further toward
     * cash. So the settle route is told immediately.
     *
     * Deliberately not awaited, and deliberately swallowed: the deposit has
     * already landed and the holder's shares are already theirs. Whether the
     * vault converts that SOL in the next ten seconds or the next ten minutes
     * changes nothing about what they own, and a failure here must not be
     * reported as a failed deposit.
     */
    if (mode === "buy") {
      void fetch("/api/vault/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: tracker.ticker }),
      }).catch(() => {});
    }

    return result.context.signature as string;
  });

  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- read below */
  /**
   * Whether selling for SOL has to go the long way round.
   *
   * Below the sleeve, `redeem_for_sol` settles it in one transaction. Above it,
   * that instruction computes a correct payout and then reverts on its reserve
   * check, so the exit becomes take-in-kind plus a sale per leg. Same outcome,
   * more signatures.
   */
  const sellThrough =
    mode === "redeem" &&
    quote !== null &&
    quote.lamportsIn > maxSolRedeemShares;

  const disabled =
    !owner || !valid || !quote || insufficient || isRunning || paused;

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Trade direction"
        className="glass-inset grid grid-cols-3 gap-1 p-1"
      >
        {(["buy", "redeem", "stocks"] as Mode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setAmount("");
              reset();
            }}
            className="num rounded-xl px-2 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider transition-colors sm:px-3 sm:text-xs"
            style={{
              background: mode === m ? "var(--ink)" : "transparent",
              color: mode === m ? "#ffffff" : "var(--ink-muted)",
            }}
          >
            {m === "buy"
              ? "Buy"
              : m === "redeem"
                ? "Sell for SOL"
                : "Take stocks"}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="meta">
          {mode === "buy" ? (
            "SOL to deposit"
          ) : (
            <>
              <TokenTicker ticker={tracker.ticker} size={13} /> to burn
            </>
          )}
        </span>
        <div className="glass-inset flex items-center gap-2 px-4 focus-within:border-rule-strong">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) {
                setAmount(v);
                reset();
              }
            }}
            className="num h-12 w-full min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-faint"
          />
          <button
            onClick={() => {
              const max =
                mode === "buy"
                  ? solBalance > RESERVE_LAMPORTS
                    ? solBalance - RESERVE_LAMPORTS
                    : 0n
                  : shares;
              setAmount(lamportsToSolNumber(max).toFixed(6));
              reset();
            }}
            className="num text-[0.625rem] uppercase tracking-wider text-muted hover:text-ink"
          >
            Max
          </button>
        </div>
        <span className="num text-[0.6875rem] text-faint">
          {mode === "buy" ? (
            `Wallet ${formatSol(solBalance)} SOL · NAV ${formatNav(nav)}`
          ) : (
            <>
              You hold {formatShares(shares)}{" "}
              <TokenTicker ticker={tracker.ticker} size={13} />
            </>
          )}
        </span>
      </label>

      {quote ? (
        <dl className="glass-inset flex flex-col gap-2 p-4 text-[0.8125rem]">
          {/* What you get, first and largest. The fee used to head this list
              at the same weight, which made a 0.0006 SOL charge read as the
              headline of the trade. It stays on screen, because this is the
              moment before signing and hiding it is what "hidden fee" means,
              but it belongs under the number it is subtracted from. */}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="font-medium text-ink">You receive</dt>
            <dd className="num text-[0.9375rem] font-semibold tabular-nums text-ink">
              {mode === "buy" ? (
                <>
                  {formatShares(quote.out)}{" "}
                  <TokenTicker ticker={tracker.ticker} size={16} />
                </>
              ) : mode === "stocks" ? (
                `${inKindQuote?.length ?? 0} holdings`
              ) : (
                `${formatSol(quote.out)} SOL`
              )}
            </dd>
          </div>

          {/* In kind, the payout is a list, not a number. Spelling out each
              leg is the whole point of the option: the holder is choosing to
              take the assets rather than their value. */}
          {mode === "stocks" && inKindQuote ? (
            <ul className="flex flex-col gap-1 border-t border-rule pt-2 text-[0.75rem]">
              {inKindQuote.map((leg) => {
                const symbol = tracker.legs[leg.index]?.symbol ?? "?";
                return (
                  <li
                    key={`${leg.mint}-${leg.index}`}
                    className="flex justify-between gap-3"
                  >
                    <span className="text-muted">{symbol}</span>
                    <span className="num tabular-nums text-ink">
                      {(Number(leg.amount) / 10 ** leg.decimals).toLocaleString(
                        undefined,
                        {
                          maximumFractionDigits: 6,
                        },
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* `redeem_for_sol` pays from the sleeve and checks the holder's
              gross claim against it, so past this point the transaction
              reverts rather than paying part. Better said here than by a
              wallet. */}
          {sellThrough ? (
            <p className="border-t border-rule pt-2 text-[0.75rem] text-muted">
              Your share of the stocks is sold first, then you sign once to
              claim the SOL. Takes a few seconds.
            </p>
          ) : null}

          <div className="flex flex-col gap-1 border-t border-rule pt-2 text-[0.75rem] text-faint">
            {mode === "stocks" ? (
              <div className="flex justify-between gap-3">
                <dt>
                  Redemption fee
                  <span className="num ml-1">0.00%</span>
                  {/* <span className="num ml-1">({formatPpm(trackerAccount.redeemFeePpm)})</span> */}
                </dt>
                {/* Taken as a haircut on the delivered amounts, which stays in
                    the vault for the remaining holders rather than being swept
                    out in dust-sized transfers. */}
                <dd className="num tabular-nums">held back in kind</dd>
              </div>
            ) : (
              <>
                <div className="flex justify-between gap-3">
                  <dt>
                    {mode === "buy" ? "Protocol fee" : "Redemption fee"}
                    <span className="num ml-1">
                      (
                      {/* {formatPpm(
                    mode === "buy"
                      ? trackerAccount.depositFeePpm
                      : trackerAccount.redeemFeePpm,
                  )} */}
                      0.00% )
                    </span>
                  </dt>
                  {/* <dd className="num tabular-nums">{formatSol(quote.fee)} SOL</dd> */}
                  <dd className="num tabular-nums">0.00 SOL</dd>
                </div>
              </>
            )}
          </div>
        </dl>
      ) : null}

      {!owner ? (
        <ConnectButton variant="action" className="w-full" />
      ) : (
        <button
          onClick={() => dispatch()}
          disabled={disabled}
          className="btn btn-grad w-full"
        >
          {isRunning
            ? (step ?? "Confirm in your wallet")
            : paused
              ? "Deposits paused"
              : insufficient
                ? mode === "buy"
                  ? "Not enough SOL"
                  : `Not enough ${tracker.ticker}`
                : !valid
                  ? "Enter an amount"
                  : mode === "buy"
                    ? `Buy ${tracker.ticker}`
                    : mode === "stocks"
                      ? "Take the stocks"
                      : sellThrough
                        ? "Sell the basket for SOL"
                        : "Redeem for SOL"}
        </button>
      )}

      {/* Said after the fact, not before: the holder asked for SOL and got
          most of it, and the rest arrived as stock they can sell whenever. */}
      {partial.length > 0 && !error ? (
        <p className="rounded-xl border border-rule bg-paper px-3.5 py-2.5 text-[0.8125rem] leading-snug text-muted">
          {partial.join(" and ")} {partial.length > 1 ? "were" : "was"} too thin
          to sell right now, so {partial.length > 1 ? "they came" : "it came"}{" "}
          to your wallet as stock. Everything else came as SOL.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="break-words rounded-xl border border-neg/50 bg-neg/10 px-3.5 py-2.5 text-[0.8125rem] leading-snug text-neg"
        >
          {explainTransactionError(error)}
        </p>
      ) : null}

      {signature ? (
        <p className="rounded-xl border border-pos/50 bg-pos/10 px-3.5 py-2.5 text-[0.8125rem] leading-snug text-pos">
          Confirmed.{" "}
          <a
            href={EXPLORER("tx", signature)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View the transaction
          </a>
        </p>
      ) : null}

      {/* <p className="text-[0.6875rem] leading-relaxed text-faint">
        The vault holds SOL & tokenized equities on mainnet.
      </p> */}
    </div>
  );
}
