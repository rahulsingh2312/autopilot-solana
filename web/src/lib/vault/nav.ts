/**
 * Valuing a vault the way the program values it.
 *
 * # Why this exists
 *
 * The site used to read net assets straight off the vault's lamport balance.
 * That was right for exactly as long as every vault held only SOL. The moment
 * habitSOL bought its four legs, the sleeve was 3% of the fund and the site
 * reported NAV as 0.0301 against a true 0.9792 — telling holders their token
 * was worth a thirtieth of its actual value.
 *
 * So this is not a display detail. It is the number, and it has to agree with
 * `value_tokenized_legs` to the lamport.
 *
 * # Integer math, deliberately
 *
 * Ported operation for operation from `oracle.rs::leg_value_lamports`,
 * including the order, because the order is load-bearing. Multiplying
 * everything up front overflows; dividing by the token's decimals first keeps
 * every intermediate in range. The early division truncates downward, which
 * rounds in favour of existing holders rather than an incoming depositor, and
 * that is the direction a fund should err in.
 *
 * `bigint` throughout for the same reason the program uses `u128`: a float
 * anywhere in the money path is a rounding argument nobody wins. The one
 * exception is the ScaledUiAmount multiplier, which the extension stores as an
 * `f64` — converted to fixed-point micros immediately, exactly as `to_micros`
 * does.
 */

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MULTIPLIER_SCALE = 1_000_000n;
const MULTIPLIER_SCALE_F = 1_000_000;
const MIN_MULTIPLIER_MICROS = 10_000n; // 0.01x
const MAX_MULTIPLIER_MICROS = 100_000_000n; // 100x

/** Token-2022 `ScaledUiAmountConfig`. */
const EXT_SCALED_UI_AMOUNT = 25;

/** Mint layout: base ends at 82, padding to 165, `account_type`, TLV from 166. */
const MINT_DECIMALS_OFFSET = 44;
const TLV_START = 166;
const ACCOUNT_TYPE_OFFSET = 165;

/** `PriceUpdateV2`, valid only once byte 40 is confirmed to be `Full` (1). */
const VERIFICATION_LEVEL = 40;
const FEED_ID = 41;
const PRICE = 73;
const EXPO = 89;
const PUBLISH_TIME = 93;

export type PythPrice = {
  price: bigint;
  exponent: number;
  publishTime: bigint;
  feedId: string;
};

/**
 * Parse a Pyth price account, or return null.
 *
 * Returns null rather than throwing on anything unexpected: this runs on every
 * poll of a public page, and a malformed account should render as "unknown"
 * rather than take the page down. The program is the thing that must reject
 * it, and it does.
 */
export function readPythPrice(data: Uint8Array): PythPrice | null {
  if (data.length < PUBLISH_TIME + 8) return null;
  // The variable-offset trap: `verification_level` is a borsh enum where
  // `Partial { u8 }` is two bytes and `Full` is one, so every offset past it
  // shifts. Checking Full first means the offsets below are exact.
  if (data[VERIFICATION_LEVEL] !== 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    feedId: Array.from(data.subarray(FEED_ID, FEED_ID + 32))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    price: view.getBigInt64(PRICE, true),
    exponent: view.getInt32(EXPO, true),
    publishTime: view.getBigInt64(PUBLISH_TIME, true),
  };
}

/** A mint's decimals. Present on both token programs at the same offset. */
export function readMintDecimals(data: Uint8Array): number | null {
  return data.length > MINT_DECIMALS_OFFSET ? data[MINT_DECIMALS_OFFSET] : null;
}

/**
 * Walk the Token-2022 TLV list for one extension.
 *
 * A mint with no extensions is 82 bytes and simply has no TLV region, which is
 * not an error — an ordinary SPL mint does not rebase.
 */
function findMintExtension(data: Uint8Array, extensionType: number): Uint8Array | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = TLV_START;
  while (cursor + 4 <= data.length) {
    const type = view.getUint16(cursor, true);
    const length = view.getUint16(cursor + 2, true);
    const start = cursor + 4;
    if (start + length > data.length) return null;
    if (type === extensionType) return data.subarray(start, start + length);
    cursor = start + length;
  }
  return null;
}

/**
 * The rebasing multiplier, in fixed-point micros. 1_000_000 means 1.0x.
 *
 * xStocks rebase on corporate actions — a split moves this rather than the
 * balance — so ignoring it misprices the leg by exactly the split ratio.
 */
export function scaledUiMultiplierMicros(mintData: Uint8Array, nowSeconds: bigint): bigint {
  const cfg = findMintExtension(mintData, EXT_SCALED_UI_AMOUNT);
  if (!cfg || cfg.length < 56) return MULTIPLIER_SCALE; // no extension: exactly 1.0x

  const view = new DataView(cfg.buffer, cfg.byteOffset, cfg.byteLength);
  const effectiveAt = view.getBigInt64(40, true);
  const raw = nowSeconds >= effectiveAt ? view.getFloat64(48, true) : view.getFloat64(32, true);

  // Float confined to this conversion, and the band checked afterwards so NaN
  // and infinity — which compare false against everything — cannot pass a
  // range test.
  if (!Number.isFinite(raw) || raw <= 0) return MULTIPLIER_SCALE;
  const micros = BigInt(Math.floor(raw * MULTIPLIER_SCALE_F));
  if (micros < MIN_MULTIPLIER_MICROS || micros > MAX_MULTIPLIER_MICROS) {
    return MULTIPLIER_SCALE;
  }
  return micros;
}

/** `value * 10^exponent`, as integer math in both directions. */
function applyExponent(value: bigint, exponent: number): bigint {
  if (exponent === 0) return value;
  const magnitude = 10n ** BigInt(Math.abs(exponent));
  return exponent > 0 ? value * magnitude : value / magnitude;
}

/**
 * One leg's value in lamports.
 *
 * Mirrors `oracle.rs::leg_value_lamports`, operation for operation.
 */
export function legValueLamports(params: {
  balance: bigint;
  decimals: number;
  multiplierMicros: bigint;
  equity: PythPrice;
  sol: PythPrice;
}): bigint {
  const { balance, decimals, multiplierMicros, equity, sol } = params;
  if (equity.price <= 0n || sol.price <= 0n) return 0n;
  if (balance === 0n) return 0n;

  const effectiveBalance = (balance * multiplierMicros) / 10n ** BigInt(decimals);
  const numerator = effectiveBalance * equity.price * LAMPORTS_PER_SOL;
  const denominator = MULTIPLIER_SCALE * sol.price;

  // Both feeds are USD-quoted, so only the difference in exponents survives.
  return applyExponent(numerator / denominator, equity.exponent - sol.exponent);
}

export type Holding = {
  /** Basket index, so a repeated mint stays distinguishable. */
  index: number;
  mint: string;
  /** Target share of the basket, in basis points. */
  weightBps: number;
  /** Raw base units the vault holds. */
  balance: bigint;
  decimals: number;
  /** Human-readable units, multiplier applied — what a wallet would show. */
  units: number;
  /** Value in lamports, by the program's own arithmetic. */
  lamports: bigint;
  /** Share of net assets, in basis points. Null while NAV is zero. */
  actualBps: number | null;
  /** Price of the underlying share in USD, for display. */
  priceUsd: number | null;
  /** True when the leg has no usable price, so its value is unknown, not zero. */
  unpriced: boolean;
};

/**
 * Net assets, and the composition behind them.
 *
 * `sleeve` is the vault's lamports minus the tracker's rent reserve — the rent
 * is not the fund's to spend or to count.
 *
 * A leg whose price cannot be read is reported as `unpriced` and contributes
 * nothing, and `complete` goes false. That distinction matters: a vault holding
 * an unpriceable leg has a NAV that is a lower bound, not a number, and the UI
 * has to be able to say so rather than quietly understating the fund the way
 * the lamport-only version did.
 */
export function computeNav(params: {
  sleeveLamports: bigint;
  holdings: Holding[];
}): { netAssets: bigint; legLamports: bigint; complete: boolean } {
  const legLamports = params.holdings.reduce((sum, h) => sum + h.lamports, 0n);
  return {
    netAssets: params.sleeveLamports + legLamports,
    legLamports,
    complete: params.holdings.every((h) => !h.unpriced),
  };
}
