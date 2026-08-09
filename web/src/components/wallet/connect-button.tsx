"use client";

import { useEffect, useState } from "react";
import type { Address } from "@solana/kit";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useIsWalletReady,
  useWallets,
} from "@solana/kit-plugin-wallet/react";

import { client } from "@/app/providers";
import { truncateAddress } from "@/lib/format";

export function useWalletAddress(): Address | undefined {
  const connected = useConnectedWallet(client);
  return connected?.account.address as Address | undefined;
}

export function ConnectButton({ className = "" }: { className?: string }) {
  const ready = useIsWalletReady(client);
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect, isRunning: connecting } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [open, setOpen] = useState(false);

  // Wallet Standard discovery only exists in the browser, so the server always
  // renders the "looking" state while the client can know the answer on its
  // first paint. Holding the placeholder until after mount keeps the two
  // renders identical instead of tearing hydration on every page load.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const base =
    "num inline-flex h-10 items-center gap-2 rounded-full border px-4 text-xs font-semibold uppercase tracking-wide transition-all";

  if (!mounted || !ready) {
    return (
      <span
        className={`${base} border-rule text-faint ${className}`}
        aria-live="polite"
      >
        Looking for wallets
      </span>
    );
  }

  if (connected) {
    return (
      <button
        onClick={() => disconnect()}
        className={`${base} border-transparent bg-ink text-white hover:opacity-90 ${className}`}
        title={connected.account.address}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-current"
        />
        {truncateAddress(connected.account.address)}
      </button>
    );
  }

  // Nothing installed is a real state, and a dead "Connect" button is worse
  // than telling someone what to do about it.
  if (wallets.length === 0) {
    return (
      <a
        href="https://solana.com/solana-wallets"
        target="_blank"
        rel="noreferrer"
        className={`${base} border-rule-strong text-ink hover:bg-paper ${className}`}
      >
        Get a wallet
      </a>
    );
  }

  if (wallets.length === 1) {
    return (
      <button
        disabled={connecting}
        onClick={() => connect(wallets[0])}
        className={`${base} border-transparent bg-ink text-white hover:opacity-90 disabled:opacity-60 ${className}`}
      >
        {connecting ? "Approve in wallet" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <button
        disabled={connecting}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`${base} w-full border-transparent bg-ink text-white hover:opacity-90 disabled:opacity-60`}
      >
        {connecting ? "Approve in wallet" : "Connect wallet"}
      </button>
      {open ? (
        <div
          role="menu"
          className="card absolute right-0 z-50 mt-2 w-52 p-1.5"
        >
          {wallets.map((wallet) => (
            <button
              key={wallet.name}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                connect(wallet);
              }}
              className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs text-ink hover:bg-bg"
            >
              {wallet.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={wallet.icon} alt="" className="h-4 w-4" />
              ) : null}
              {wallet.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
