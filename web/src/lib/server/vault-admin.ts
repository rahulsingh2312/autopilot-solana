/**
 * Server-side vault operations, signed by the manager key.
 *
 * # Why a server key exists at all
 *
 * A holder must sign exactly one transaction. That is only possible if the
 * vault already holds the SOL it is about to pay out — the vault cannot sell
 * inside a redemption (four Jupiter routes will not fit in one transaction),
 * and nobody else can sell the holder's tokens for them afterwards.
 *
 * So the selling happens *before* the signature, on the server, in the vault's
 * own name. The holder clicks once, waits a few seconds, and signs once.
 *
 * # What this key can and cannot do
 *
 * The manager role repositions the basket and nothing else. It cannot upgrade
 * the program, change fees, pause, withdraw, or reassign roles — those belong
 * to the authority, which is a different key and is not on this server. So the
 * worst a compromise of this key achieves is trading the vault's assets around
 * the basket at market prices, bounded on every trade by `min_amount_out`.
 *
 * That is a real risk and a deliberately small one. It is the price of the
 * holder signing once.
 */

import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";

import { LEG_BINDINGS } from "@/lib/leg-bindings";
import { decodeTracker, findTrackerPda, findVaultPda } from "@/lib/vault/program";
import { findAssociatedTokenPdaFor, findPythPriceAccount } from "@/lib/vault/oracle";
import { legValueLamports, readMintDecimals, readPythPrice, scaledUiMultiplierMicros } from "@/lib/vault/nav";

const PROGRAM_ID = "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY" as Address;
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const JUP_API = "https://lite-api.jup.ag/swap/v1";
const WSOL = "So11111111111111111111111111111111111111112" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const IX_SWAP_LEG = 5;

/** The measured stack ceiling in `swap_leg.rs`. */
const ROUTE_LIMIT = 46;

/** Headroom so a redemption is not defeated by a lamport of price drift. */
const OVERSELL_BPS = 200n;

const decode64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function managerSigner() {
  const raw = process.env.MANAGER_SECRET_KEY;
  if (!raw) throw new Error("MANAGER_SECRET_KEY is not set");
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
}

export function serverRpc() {
  const url = process.env.MAINNET_RPC_URL;
  if (!url) throw new Error("MAINNET_RPC_URL is not set");
  return createSolanaRpc(url);
}

type Rpc = ReturnType<typeof serverRpc>;

export type VaultView = {
  trackerAddress: Address;
  vault: Address;
  shareMint: Address;
  manager: Address;
  supply: bigint;
  sleeve: bigint;
  netAssets: bigint;
  legs: {
    mint: Address;
    symbol: string;
    /** Target share of the basket. Not uniform: ouroSOL runs 25/20/20/20/10/5. */
    weightBps: number;
    tokenProgram: Address;
    ata: Address;
    amount: bigint;
    decimals: number;
    lamports: bigint;
  }[];
};

/**
 * Read a vault in as few RPC calls as possible.
 *
 * Two round trips: the tracker, then everything the valuation depends on in a
 * single `getMultipleAccounts`. This runs on a user action rather than a timer
 * precisely so it stays cheap.
 */
export async function readVault(rpc: Rpc, ticker: string): Promise<VaultView | null> {
  const trackerAddress = await findTrackerPda(ticker);
  const vault = await findVaultPda(trackerAddress);

  const { value: info } = await rpc
    .getAccountInfo(trackerAddress, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!info) return null;
  const tracker = decodeTracker(decode64(info.data[0]));
  // Null means the bytes are not a tracker of the layout this client knows —
  // wrong tag, wrong version, or too short. Treated as "no vault" rather than
  // decoded optimistically, because every number below would otherwise be read
  // from an account whose shape we guessed.
  if (!tracker) return null;

  const solPriceAddress = await findPythPriceAccount(SOL_FEED);
  const legMeta = [];
  const addresses: Address[] = [vault, tracker.shareMint, solPriceAddress];
  for (const leg of tracker.legs) {
    const binding = Object.values(LEG_BINDINGS).find((b) => b.mint === leg.mint);
    if (!binding) continue;
    const tokenProgram = binding.tokenProgram as Address;
    const ata = await findAssociatedTokenPdaFor(vault, leg.mint, tokenProgram);
    legMeta.push({ binding, tokenProgram, ata, mint: leg.mint, feedId: leg.feedId, weightBps: leg.weightBps });
    addresses.push(ata, leg.mint, await findPythPriceAccount(leg.feedId));
  }

  const { value } = await rpc
    .getMultipleAccounts(addresses, { commitment: "confirmed", encoding: "base64" })
    .send();

  const vaultLamports = value[0] ? BigInt(value[0].lamports) : 0n;
  const supply = value[1] ? new DataView(decode64(value[1].data[0]).buffer).getBigUint64(36, true) : 0n;
  const sol = value[2] ? readPythPrice(decode64(value[2].data[0])) : null;
  const sleeve = vaultLamports > tracker.rentReserve ? vaultLamports - tracker.rentReserve : 0n;
  const now = BigInt(Math.floor(Date.now() / 1000));

  const legs = legMeta.map((m, i) => {
    const [taInfo, mintInfo, priceInfo] = value.slice(3 + i * 3, 6 + i * 3);
    const amount = taInfo ? new DataView(decode64(taInfo.data[0]).buffer).getBigUint64(64, true) : 0n;
    const mintData = mintInfo ? decode64(mintInfo.data[0]) : null;
    const decimals = mintData ? (readMintDecimals(mintData) ?? 8) : 8;
    const equity = priceInfo ? readPythPrice(decode64(priceInfo.data[0])) : null;
    const lamports =
      equity && sol && amount > 0n && mintData
        ? legValueLamports({
            balance: amount,
            decimals,
            multiplierMicros: scaledUiMultiplierMicros(mintData, now),
            equity,
            sol,
          })
        : 0n;
    return {
      mint: m.mint,
      symbol: m.binding.symbol,
      weightBps: m.weightBps,
      tokenProgram: m.tokenProgram,
      ata: m.ata,
      amount,
      decimals,
      lamports,
    };
  });

  return {
    trackerAddress,
    vault,
    shareMint: tracker.shareMint,
    manager: tracker.manager,
    supply,
    sleeve,
    netAssets: sleeve + legs.reduce((s, l) => s + l.lamports, 0n),
    legs,
  };
}

type RoutePlan = {
  routeData: Uint8Array;
  accounts: { pubkey: Address; isSigner: boolean; isWritable: boolean }[];
  minOut: bigint;
  lookupTables: Record<string, Address[]>;
};

/** A Jupiter route that fits the program's account bound. Direct routes first. */
async function planRoute(
  rpc: Rpc,
  vault: Address,
  inputMint: Address,
  outputMint: Address,
  amountIn: bigint,
): Promise<RoutePlan | null> {
  /**
   * Ordered cheapest-to-send first, ending unconstrained.
   *
   * The last entry is not a formality. A thin pair at small size often has no
   * direct route and no route inside a `maxAccounts` hint either, yet routes
   * perfectly well when the router is left alone — PEPx and XOMx at half a
   * cent's worth returned "No routes found" for every constrained attempt and
   * a two-hop Raydium route when asked without one. Stopping at the hints made
   * those legs unsellable and a redemption unsettleable.
   *
   * The account count is still checked afterwards, so an unconstrained route
   * that is too wide is rejected rather than sent.
   */
  const attempts = [
    { onlyDirectRoutes: true, shared: false },
    { maxAccounts: 20, shared: true },
    { maxAccounts: 28, shared: true },
    { shared: true },
  ];

  for (const a of attempts) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountIn),
      slippageBps: "300",
    });
    if ("maxAccounts" in a && a.maxAccounts) params.set("maxAccounts", String(a.maxAccounts));
    if ("onlyDirectRoutes" in a && a.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");

    const quote = await fetch(`${JUP_API}/quote?${params}`).then((r) => r.json());
    if (!quote?.outAmount) continue;

    const built = await fetch(`${JUP_API}/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: vault,
        wrapAndUnwrapSol: false,
        useSharedAccounts: a.shared,
        skipUserAccountsRpcCalls: false,
      }),
    }).then((r) => r.json());

    const ix = built?.swapInstruction;
    if (!ix || ix.programId !== JUPITER_PROGRAM) continue;
    if (ix.accounts.length > ROUTE_LIMIT) continue;

    const lookupTables: Record<string, Address[]> = { ...(built.addressesByLookupTableAddress ?? {}) };
    const missing = ((built.addressLookupTableAddresses ?? []) as Address[]).filter((t) => !lookupTables[t]);
    if (missing.length > 0) {
      const { value } = await rpc
        .getMultipleAccounts(missing, { commitment: "confirmed", encoding: "base64" })
        .send();
      const dec = getAddressDecoder();
      value.forEach((acc, i) => {
        if (!acc) return;
        const d = decode64(acc.data[0]);
        const list: Address[] = [];
        for (let o = 56; o + 32 <= d.length; o += 32) list.push(dec.decode(d.subarray(o, o + 32)));
        lookupTables[missing[i]] = list;
      });
    }

    return {
      routeData: decode64(ix.data),
      accounts: ix.accounts,
      minOut: BigInt(quote.otherAmountThreshold ?? quote.outAmount),
      lookupTables,
    };
  }
  return null;
}

const roleOf = (a: { isSigner: boolean; isWritable: boolean }) =>
  a.isSigner
    ? a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
    : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

/**
 * Sell one leg into the vault's SOL sleeve.
 *
 * Returns the signature, or null when no route fits — the caller decides
 * whether the shortfall it leaves matters.
 */
export async function sellLegForSol(
  rpc: Rpc,
  signer: Awaited<ReturnType<typeof managerSigner>>,
  v: VaultView,
  leg: VaultView["legs"][number],
  amount: bigint,
): Promise<string | null> {
  if (amount <= 0n || amount > leg.amount) return null;

  const vaultWsol = await findAssociatedTokenPdaFor(v.vault, WSOL, TOKEN_PROGRAM);
  const plan = await planRoute(rpc, v.vault, leg.mint, WSOL, amount);
  if (!plan) return null;

  const instructions: Instruction[] = [];
  const { value: wsolInfo } = await rpc
    .getAccountInfo(vaultWsol, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!wsolInfo) {
    // The program wraps into this account but creates nothing.
    instructions.push({
      programAddress: ATA_PROGRAM,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: vaultWsol, role: AccountRole.WRITABLE },
        { address: v.vault, role: AccountRole.READONLY },
        { address: WSOL, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1]),
    });
  }

  instructions.push({
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
      { address: v.trackerAddress, role: AccountRole.READONLY },
      { address: v.vault, role: AccountRole.WRITABLE },
      { address: leg.ata, role: AccountRole.WRITABLE },
      { address: vaultWsol, role: AccountRole.WRITABLE },
      { address: leg.mint, role: AccountRole.READONLY },
      { address: WSOL, role: AccountRole.READONLY },
      { address: leg.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
      ...plan.accounts.map((a) => ({
        address: a.pubkey,
        // The vault signs by seeds inside the program, never at this level.
        role:
          a.pubkey === v.vault
            ? a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
            : roleOf(a),
      })),
    ],
    data: cat(new Uint8Array([IX_SWAP_LEG]), u64le(amount), u64le(plan.minOut), plan.routeData),
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  if (Object.keys(plan.lookupTables).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(message, plan.lookupTables) as typeof message;
  }

  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);

  const { value: sim } = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      commitment: "confirmed",
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (sim.err) return null;

  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 45; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) return null;
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/**
 * Raise enough SOL in the sleeve to settle `shares`, by selling legs pro-rata.
 *
 * Sells slightly more than the claim so a few seconds of price drift between
 * this and the holder's signature does not leave the redemption a lamport
 * short — the excess simply stays in the sleeve and is reinvested later.
 *
 * Legs are sold largest first: fewer, bigger trades cost less in fees than
 * many small ones, and a thin leg that will not route is then a smaller
 * problem rather than a blocking one.
 */
export async function raiseForRedemption(
  rpc: Rpc,
  signer: Awaited<ReturnType<typeof managerSigner>>,
  v: VaultView,
  shares: bigint,
): Promise<{ raised: bigint; sold: string[]; shortfall: bigint; unsold: string[] }> {
  if (v.supply === 0n) return { raised: v.sleeve, sold: [], shortfall: 0n, unsold: [] };

  const claim = (v.netAssets * shares) / v.supply;
  const target = claim + (claim * OVERSELL_BPS) / 10_000n;
  const sold: string[] = [];

  const unsold: string[] = [];
  if (v.sleeve >= target) return { raised: v.sleeve, sold, shortfall: 0n, unsold };

  let need = target - v.sleeve;
  const legs = [...v.legs].filter((l) => l.amount > 0n).sort((a, b) => (b.lamports > a.lamports ? 1 : -1));

  for (const leg of legs) {
    if (need <= 0n) break;
    // Sell the smaller of what is still needed and what this leg holds.
    const wanted = need < leg.lamports ? need : leg.lamports;
    const fraction = Number(wanted) / Number(leg.lamports);
    const amount = BigInt(Math.ceil(Number(leg.amount) * Math.min(fraction, 1)));

    const sig = await sellLegForSol(rpc, signer, v, leg, amount > leg.amount ? leg.amount : amount);
    if (!sig) { unsold.push(leg.symbol); continue; }
    sold.push(sig);
    need -= wanted;
  }

  const { value: after } = await rpc.getBalance(v.vault, { commitment: "confirmed" }).send();
  const raised = BigInt(after);
  return { raised, sold, shortfall: need > 0n ? need : 0n, unsold };
}

/**
 * Buy a leg with SOL from the sleeve. The mirror of `sellLegForSol`.
 */
export async function buyLegWithSol(
  rpc: Rpc,
  signer: Awaited<ReturnType<typeof managerSigner>>,
  v: VaultView,
  leg: VaultView["legs"][number],
  lamports: bigint,
): Promise<string | null> {
  if (lamports <= 0n) return null;

  const vaultWsol = await findAssociatedTokenPdaFor(v.vault, WSOL, TOKEN_PROGRAM);
  const plan = await planRoute(rpc, v.vault, WSOL, leg.mint, lamports);
  if (!plan) return null;

  const instructions: Instruction[] = [];
  const { value: wsolInfo } = await rpc
    .getAccountInfo(vaultWsol, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!wsolInfo) {
    instructions.push({
      programAddress: ATA_PROGRAM,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: vaultWsol, role: AccountRole.WRITABLE },
        { address: v.vault, role: AccountRole.READONLY },
        { address: WSOL, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1]),
    });
  }

  instructions.push({
    programAddress: PROGRAM_ID,
    accounts: [
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
      { address: v.trackerAddress, role: AccountRole.READONLY },
      { address: v.vault, role: AccountRole.WRITABLE },
      { address: vaultWsol, role: AccountRole.WRITABLE },
      { address: leg.ata, role: AccountRole.WRITABLE },
      { address: WSOL, role: AccountRole.READONLY },
      { address: leg.mint, role: AccountRole.READONLY },
      { address: leg.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
      ...plan.accounts.map((a) => ({
        address: a.pubkey,
        role:
          a.pubkey === v.vault
            ? a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
            : roleOf(a),
      })),
    ],
    data: cat(new Uint8Array([IX_SWAP_LEG]), u64le(lamports), u64le(plan.minOut), plan.routeData),
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m),
  );
  if (Object.keys(plan.lookupTables).length > 0) {
    message = compressTransactionMessageUsingAddressLookupTables(message, plan.lookupTables) as typeof message;
  }

  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const { value: sim } = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      commitment: "confirmed",
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (sim.err) return null;

  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 45; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) return null;
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** The vault keeps only what it needs to operate. Not a share of the fund. */
export const FLOOR_LAMPORTS = 2_000_000n;

/** Below this a trade costs more in spread than the position is worth. */
export const MIN_TRADE_LAMPORTS = 5_000_000n;

/**
 * Put idle SOL to work.
 *
 * Called after a deposit lands, and after a redemption that left the sleeve
 * fat — the two ways a vault ends up holding cash it was not meant to hold. A
 * holder paid SOL to own stocks; SOL sitting in the vault is not what they
 * bought, and it drags the fund against its own basket for as long as it sits.
 *
 * Buys the most underweight leg first, so a single pass moves the basket
 * further toward its published weights than spreading the same money evenly
 * would.
 */
export async function investIdleSol(
  rpc: Rpc,
  signer: Awaited<ReturnType<typeof managerSigner>>,
  v: VaultView,
): Promise<{ invested: bigint; bought: string[] }> {
  const spendable = v.sleeve > FLOOR_LAMPORTS ? v.sleeve - FLOOR_LAMPORTS : 0n;
  if (spendable < MIN_TRADE_LAMPORTS) return { invested: 0n, bought: [] };

  const investable = v.netAssets > FLOOR_LAMPORTS ? v.netAssets - FLOOR_LAMPORTS : 0n;
  const shortfalls = v.legs
    // The tracker's own weight, not an assumed equal split — ouroSOL runs
    // 25/20/20/20/10/5 and treating that as six equal legs would buy the wrong
    // basket entirely.
    .map((leg) => ({ leg, target: (investable * BigInt(leg.weightBps)) / 10_000n }))
    .map(({ leg, target }) => ({ leg, short: target > leg.lamports ? target - leg.lamports : 0n }))
    .filter((x) => x.short > 0n)
    .sort((a, b) => (b.short > a.short ? 1 : -1));

  let budget = spendable;
  let invested = 0n;
  const bought: string[] = [];

  for (const { leg, short } of shortfalls) {
    if (budget < MIN_TRADE_LAMPORTS) break;
    const amount = short < budget ? short : budget;
    if (amount < MIN_TRADE_LAMPORTS) continue;
    const sig = await buyLegWithSol(rpc, signer, v, leg, amount);
    if (!sig) continue;
    bought.push(leg.symbol);
    invested += amount;
    budget -= amount;
  }

  return { invested, bought };
}
