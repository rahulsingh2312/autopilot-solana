/**
 * Every knob the worker reads, resolved once and typed.
 *
 * Nothing here has a secret default. A missing signer key degrades the worker
 * to read-only rather than throwing at import: ingestion and planning are
 * useful on their own, and a box that cannot sign should still be able to tell
 * you what it would have signed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const str = (key: string, fallback?: string): string => {
  const value = process.env[key]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${key}`);
};

const int = (key: string, fallback: number): number => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${key} must be an integer`);
  return value;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

export type Cluster = "devnet" | "mainnet-beta";

const CLUSTER = str("CLUSTER", "devnet") as Cluster;

/**
 * SEC requires a descriptive User-Agent carrying a contact address on every
 * request to EDGAR, and blocks by IP when it is missing. This is not optional
 * politeness, it is their published access policy.
 */
const SEC_USER_AGENT = str(
  "SEC_USER_AGENT",
  "Autopilot Research (rahulsinghhh2312@gmail.com)",
);

/**
 * Reads the operator keypair the same way the existing scripts do, so the
 * worker and `scripts/*.mjs` are provably the same authority.
 */
function loadSignerBytes(): Uint8Array | null {
  const inline = process.env.SIGNER_SECRET_KEY?.trim();
  if (inline) {
    try {
      return Uint8Array.from(JSON.parse(inline) as number[]);
    } catch {
      throw new Error("SIGNER_SECRET_KEY must be a JSON array of bytes");
    }
  }

  const path =
    process.env.SIGNER_KEYPAIR_PATH?.trim() ??
    join(homedir(), ".config", "solana", "id.json");
  try {
    return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  } catch {
    return null;
  }
}

const signerBytes = loadSignerBytes();

export const env = {
  cluster: CLUSTER,
  rpcUrl: str(
    "RPC_URL",
    CLUSTER === "devnet"
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com",
  ),
  get rpcWsUrl(): string {
    return process.env.RPC_WS_URL?.trim() ?? this.rpcUrl.replace(/^http/, "ws");
  },

  programId: str("PROGRAM_ID", "8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK"),

  /** Null means read-only: the worker plans and serves, but never signs. */
  signerBytes,
  get canSign(): boolean {
    return signerBytes !== null;
  },

  databasePath: str("DATABASE_PATH", join(process.cwd(), "data", "autopilot.db")),

  port: int("PORT", 8787),
  /** Bearer token for the mutating half of the HTTP API. */
  adminToken: process.env.ADMIN_TOKEN?.trim() ?? null,

  secUserAgent: SEC_USER_AGENT,

  /**
   * Where congressional disclosures come from.
   *
   * `houseClerk` is the default and the primary source: the Clerk's own PTR
   * PDFs, free, official, no key and no terms of service. Every paid product
   * in this space is reselling a parse of these same documents.
   *
   * `quiver` remains for the Senate and for anyone who would rather pay than
   * run poppler; `none` disables congress trackers entirely.
   */
  congressProvider: (process.env.CONGRESS_PROVIDER?.trim() ?? "houseClerk") as
    | "none"
    | "houseClerk"
    | "quiver",
  quiverApiKey: process.env.QUIVER_API_KEY?.trim() ?? null,

  /**
   * Hermes starts requiring a key on 2026-08-18. The Doura Labs endpoint is
   * the upgraded backend and is the default here so the worker does not break
   * on that date unattended.
   */
  hermesUrl: str("HERMES_URL", "https://pyth.dourolabs.app/hermes"),
  pythApiKey: process.env.PYTH_API_KEY?.trim() ?? null,

  jupiterApiUrl: str("JUPITER_API_URL", "https://lite-api.jup.ag/swap/v1"),

  /** Seconds between source polls and between plan evaluations. */
  ingestIntervalSec: int("INGEST_INTERVAL_SEC", 900),
  executeIntervalSec: int("EXECUTE_INTERVAL_SEC", 300),

  /**
   * A plan is only worth a transaction if something actually moved. 25 bps of
   * summed absolute weight drift is roughly "one position changed by a
   * quarter percent", below which we would be paying fees to publish noise.
   */
  minDriftBps: int("MIN_DRIFT_BPS", 25),

  /** Never execute automatically unless explicitly turned on. */
  autoPublish: bool("AUTO_PUBLISH", false),
  autoSwap: bool("AUTO_SWAP", false),

  /** Slippage ceiling for every Jupiter route the executor builds. */
  swapSlippageBps: int("SWAP_SLIPPAGE_BPS", 100),
} as const;

export const isMainnet = env.cluster === "mainnet-beta";
