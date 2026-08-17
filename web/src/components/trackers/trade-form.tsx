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
import { buildOracleAccounts } from "@/lib/vault/oracle";
import { tokenProgramOfMint } from "@/lib/leg-bindings";
import {
  explainTransactionError,
  getCreateAssociatedTokenIdempotentInstruction,
  getDepositInstruction,
  getRedeemForSolInstruction,
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

type Mode = "buy" | "redeem";

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
  const [amount, setAmount] = useState("");

  const { lamports: solBalance, refresh: refreshSol } = useSolBalance(owner);
  const { shares, refresh: refreshShares } = useShareBalance(
    owner,
    snapshot.shareMintAddress,
  );

  const trackerAccount = snapshot.tracker!;
  const nav = computeNav(snapshot.netAssets, snapshot.supply);

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

    const instruction =
      mode === "buy"
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
        : [instruction];

    const result = await client.sendTransaction(instructions, {
      abortSignal: signal,
    });

    onSettled();
    refreshSol();
    refreshShares();
    return result.context.signature as string;
  });

  const disabled =
    !owner || !valid || !quote || insufficient || isRunning || paused;

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Trade direction"
        className="glass-inset grid grid-cols-2 gap-1 p-1"
      >
        {(["buy", "redeem"] as Mode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setAmount("");
              reset();
            }}
            className="num rounded-xl px-3 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors"
            style={{
              background: mode === m ? "var(--ink)" : "transparent",
              color: mode === m ? "#ffffff" : "var(--ink-muted)",
            }}
          >
            {m === "buy" ? "Buy with SOL" : "Redeem for SOL"}
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
              ) : (
                `${formatSol(quote.out)} SOL`
              )}
            </dd>
          </div>

          <div className="flex flex-col gap-1 border-t border-rule pt-2 text-[0.75rem] text-faint">
            <div className="flex justify-between gap-3">
              <dt>
                {mode === "buy" ? "Protocol fee" : "Redemption fee"}
                <span className="num ml-1">
                  (
                  {formatPpm(
                    mode === "buy"
                      ? trackerAccount.depositFeePpm
                      : trackerAccount.redeemFeePpm,
                  )}
                  )
                </span>
              </dt>
              <dd className="num tabular-nums">{formatSol(quote.fee)} SOL</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Minimum after slippage</dt>
              <dd className="num tabular-nums">
                {mode === "buy"
                  ? formatShares(quote.minOut)
                  : `${formatSol(quote.minOut)} SOL`}
              </dd>
            </div>
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
            ? "Confirm in your wallet"
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
                    : "Redeem for SOL"}
        </button>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-neg/50 bg-neg/10 px-3.5 py-2.5 text-[0.8125rem] leading-snug text-neg"
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
