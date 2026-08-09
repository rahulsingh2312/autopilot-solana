"use client";

// Must precede every @solana/kit import: Safari lacks DisposableStack.
import "@/lib/polyfills";

import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { ClientProvider } from "@solana/react";

import { CHAIN, RPC_URL, RPC_WS_URL } from "@/lib/config";

/** One client for the whole app. The connected wallet fills payer and identity. */
export const client = createClient()
  .use(walletSigner({ chain: CHAIN }))
  .use(solanaRpc({ rpcUrl: RPC_URL, rpcSubscriptionsUrl: RPC_WS_URL }));

export type AppClient = Awaited<typeof client>;

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClientProvider client={client}>{children}</ClientProvider>;
}
