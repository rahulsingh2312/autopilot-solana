"use client";

import Link from "next/link";

import { BRAND, CLUSTER } from "@/lib/config";
import { ConnectButton } from "@/components/wallet/connect-button";

export function NetworkBadge() {
  const isDevnet = CLUSTER === "devnet";
  return (
    <span
      className="num inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-[0.625rem] font-semibold uppercase tracking-widest text-muted"
      title={
        isDevnet
          ? "Running on Solana devnet. The SOL here is test SOL and has no value."
          : "Running on Solana mainnet."
      }
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: isDevnet
            ? "linear-gradient(93deg, var(--grad-a), var(--grad-b))"
            : "var(--pos)",
        }}
      />
      {isDevnet ? "Devnet" : "Mainnet"}
    </span>
  );
}

export function Header() {
  return (
    <header className="site-header">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/copycat-dark.png"
            alt=""
            aria-hidden
            className="h-8 w-8 -translate-y-px"
          />
          <span className="display text-[1.375rem] text-ink">
            {BRAND.name}
            <span className="grad-num">.</span>
          </span>
        </Link>

        <NetworkBadge />

        <nav className="ml-auto hidden items-center gap-6 text-[0.8125rem] font-medium text-muted sm:flex">
          <a href="/#trackers" className="transition-colors hover:text-ink">
            Trackers
          </a>
          <a href="/#how" className="transition-colors hover:text-ink">
            How it works
          </a>
          <a href="/#proof" className="transition-colors hover:text-ink">
            On-chain proof
          </a>
          <Link href="/launch" className="transition-colors hover:text-ink">
            Launch an index
          </Link>
        </nav>

        <div className="ml-auto sm:ml-4">
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
