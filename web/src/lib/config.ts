/**
 * Every address, ticker, fee, link, and piece of tracker copy lives here.
 * Launch day is a one-line edit, not a search-and-replace across components.
 */

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet") as
  | "devnet"
  | "mainnet-beta";

/**
 * Where the browser sends RPC.
 *
 * `NEXT_PUBLIC_` means this is compiled into the client bundle and readable by
 * anyone who opens devtools, so a keyed endpoint here is a public endpoint.
 * That is a deliberate choice — the quota is the exposure, and the owner would
 * rather pay for a shared key than run a proxy hop. Rotate it if it gets
 * scraped; nothing signs with it.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (CLUSTER === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com");

export const RPC_WS_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_WS_URL ?? RPC_URL.replace(/^http/, "ws");

/**
 * The Wallet Standard chain identifier — **not** the RPC cluster name.
 *
 * The two differ for mainnet and only for mainnet: the cluster is
 * `mainnet-beta`, the chain is `solana:mainnet`. Interpolating the cluster
 * produced `solana:mainnet-beta`, which no wallet declares support for, so
 * Wallet Standard discovery matched nothing and the site told everyone with a
 * wallet installed to go and get a wallet.
 *
 * Devnet hid the bug for as long as it lasted, because `solana:devnet` is both
 * the cluster name and the chain id.
 */
export const CHAIN = (CLUSTER === "mainnet-beta"
  ? "solana:mainnet"
  : "solana:devnet") as "solana:mainnet" | "solana:devnet";

/**
 * The Pinocchio program. Same product, a quarter of the binary.
 *
 * This is a *different program id* from the Anchor deployment
 * (`8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK`), so every PDA derived from
 * it is different too: the trackers, vaults and share mints seeded under the
 * old program are unreachable through this client and have to be re-created.
 * Nothing migrates — the seeds are the same but the program id is part of the
 * derivation.
 */
export const PROGRAM_ID =
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
  "7Z3DAC8q4vgFr2ofxXonHT2jgJx3xk1bmQHsRjUmVAnY";

/**
 * How often a tracker's source is re-read for changes, in seconds.
 *
 * Stated on the fund card and again in every token's on-chain metadata. Those
 * two disagreeing would be a card and a wallet describing the same asset
 * differently, so the number lives here and both read it.
 */
export const WATCH_SECONDS = 30;

export const BRAND = {
  name: "Copycat",
  wordmark: "COPYCAT",
  byline: "by Copycat",
  domain: "sol.copycat.my",
  tagline: "Famous portfolios, one token each.",
  contactEmail: "rahulsinghhh2312@gmail.com",
  repo: "https://github.com/rahulsingh2312/autopilot-solana",
  twitter: "https://x.com",
} as const;

export const EXPLORER = (
  kind: "address" | "tx",
  value: string,
  cluster: string = CLUSTER,
) =>
  `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${value}${
    cluster === "devnet" ? "?cluster=devnet" : ""
  }`;

/** Matches MAX_FEE_PPM in the program (3%). The UI cannot show a fee the chain would reject. */
export const MAX_FEE_PPM = 30_000;

export type LegSource = "13f" | "editorial" | "disclosure";

export type Leg = {
  symbol: string;
  company: string;
  weightBps: number;
  /**
   * Whether a tokenized equivalent exists on the xStocks lineup today. Legs
   * with `tokenized: false` have no on-chain equivalent, so their weight sits
   * in the SOL sleeve instead of being quietly dropped from the basket.
   */
  tokenized: boolean;
  /** xStocks ticker, only when `tokenized` is true. */
  xstock?: string;
};

export type TrackerStatus = "live" | "frozen" | "soon";

export type TrackerConfig = {
  ticker: string;
  name: string;
  status: TrackerStatus;
  /** Distinct spot color per tracker, used across all three visual worlds. */
  accent: string;
  accentInk: string;
  portrait: string | null;
  portraitAlt: string;
  subject: string;
  /** One line under the name. Voice of the strategy, not of a fund. */
  hook: string;
  about: string[];
  source: string;
  sourceUrl: string;
  rebalance: string;
  filingDelay: string;
  legs: Leg[];
  /**
   * The share token's mint address.
   *
   * A ground vanity keypair rather than a PDA, so every tracker's token starts
   * with `warh`. The program takes it as a caller-supplied signer at
   * initialization and sets its authority to the tracker PDA, so only the
   * program can ever mint a share — the address is chosen, the control is not.
   *
   * It has to live here because it cannot be derived: the frontend needs it
   * before it can fetch anything, and the private keys are gitignored under
   * `.keys/`.
   */
  shareMint: string;
  /** Shown verbatim on the card. The uncomfortable fact, stated first. */
  caveat: string;
};

/**
 * The share mint for a ticker.
 *
 * Throws rather than returning undefined: a missing mint means the frontend
 * would silently read the wrong account, and NAV rendered from the wrong mint
 * is worse than a page that fails to load.
 */
export function shareMintOf(ticker: string): string {
  const t = TRACKERS.find((x) => x.ticker === ticker);
  if (!t) throw new Error(`unknown tracker: ${ticker}`);
  return t.shareMint;
}

export const TRACKERS: TrackerConfig[] = [
  {
    ticker: "ouroSOL",
    shareMint: "warhrH6rKkufjAJTJc7hCojpBekk9BbUiP3vLW33rPM",
    name: "Ouroboros",
    status: "live",
    accent: "#F7931A",
    accentInk: "#05080F",
    portrait: "/avatars/ourosol.png",
    portraitAlt: "A snake eating its own tail",
    subject: "Crypto, listed",
    hook: "Six companies whose earnings run on crypto. Bought with crypto.",
    about: [
      "Six public companies that are, underneath the filings, leveraged bets on the same thing you are paying with. Circle issues USDC and keeps the interest on the float. Strategy is a bitcoin holding company with a software segment bolted on, and STRC is the preferred stock it issues to buy more. Coinbase and Robinhood own the toll booths. GameStop is what happens when a retailer works out the balance sheet is more interesting than the stores.",
      "The name is the argument. You spend SOL to mint a token holding equities whose value tracks the price of crypto, a position that eats its own tail. Every leg is priced by Pyth against the underlying listed share, so the vault always knows exactly what it holds.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.sec.gov/edgar/search/",
    rebalance: "Quarterly, back to target weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "This is not diversification. It is the same trade six times. When crypto falls these fall together, and usually harder than the asset they track, because most of them carry leverage or hold the asset outright. Buying it with SOL means a drawdown hits the vault and your denominator at once.",
    legs: [
      { symbol: "COIN", company: "Coinbase", weightBps: 2500, tokenized: true, xstock: "COINx" },
      { symbol: "CRCL", company: "Circle", weightBps: 2000, tokenized: true, xstock: "CRCLx" },
      { symbol: "HOOD", company: "Robinhood", weightBps: 2000, tokenized: true, xstock: "HOODx" },
      { symbol: "MSTR", company: "Strategy", weightBps: 2000, tokenized: true, xstock: "MSTRx" },
      { symbol: "STRC", company: "Strategy Preferred", weightBps: 1000, tokenized: true, xstock: "STRCx" },
      { symbol: "GME", company: "GameStop", weightBps: 500, tokenized: true, xstock: "GMEx" },
    ],
  },
  {
    ticker: "habitSOL",
    shareMint: "warhzFfwBvvR7wxqAhP4p4sisv63mijSL77oHE1Jti2",
    name: "Habit",
    status: "live",
    accent: "#DC2626",
    accentInk: "#FFFFFF",
    portrait: "/avatars/habitsol.png",
    portraitAlt: "A takeaway coffee cup",
    subject: "Things people do not stop buying",
    hook: "Fast food, sugar, caffeine and fuel. Demand nobody votes on.",
    about: [
      "McDonald's, Coca-Cola, PepsiCo and Exxon Mobil, equally weighted. Managers call this defensive. The plainer version: none of these are decisions. Nobody evaluates whether to buy a Coke, and nobody stops commuting because the market fell.",
      "That is the whole thesis. Four companies selling into demand that shows up whatever the market is doing, compounding through cycles that wipe out the exciting stuff. It is the part of the lineup that is not a bet on technology, on crypto, or on somebody's disclosed trades.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.sec.gov/edgar/search/",
    rebalance: "Quarterly, back to equal weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "Boring is not safe. Three of these four sell things a growing share of buyers are trying to consume less of, and the fourth sells the thing the energy transition is aimed at. Equal weight puts a quarter of the basket in a single oil major, so an oil shock moves it more than the word defensive suggests.",
    legs: [
      { symbol: "MCD", company: "McDonald's", weightBps: 2500, tokenized: true, xstock: "MCDx" },
      { symbol: "KO", company: "Coca-Cola", weightBps: 2500, tokenized: true, xstock: "KOx" },
      { symbol: "PEP", company: "PepsiCo", weightBps: 2500, tokenized: true, xstock: "PEPx" },
      { symbol: "XOM", company: "Exxon Mobil", weightBps: 2500, tokenized: true, xstock: "XOMx" },
    ],
  },
  {
    ticker: "icSOL",
    shareMint: "warh49ZKqNfMex3Eza3kpoBQEbvpCn3HfVAagdQJJwL",
    name: "Inverse Cramer Index",
    status: "live",
    accent: "#35D07F",
    accentInk: "#05080F",
    portrait: "/portraits/cramer-bw.jpg",
    portraitAlt: "Jim Cramer",
    subject: "Jim Cramer",
    hook: "He is on television every weeknight. That is the whole thesis.",
    about: [
      "Six of the loudest names on cable, held as tokenized equities. An index built from a running joke and run completely straight: fixed weights, monthly rebalance, every move on chain where you can check it.",
      "For the record, the meme has been measured. Quiver Quantitative backtests an inverse-Cramer strategy from January 2021 at a 42.7% win rate over 3,427 trades, a Sharpe of -0.171 and -13.99% in the last year. The ETF that tried it, SJIM, closed in February 2024. This index is editorial, not a filing.",
    ],
    source: "Editorial. Curated by Copycat from Mad Money coverage.",
    sourceUrl: "https://www.cnbc.com/mad-money/",
    rebalance: "On each new disclosure",
    filingDelay: "None. There is no filing.",
    caveat:
      "Copycat picks these names. No regulator, no filing, no rule you can audit. If you want holdings somebody else is legally on the hook for, this is not it.",
    legs: [
      { symbol: "NVDA", company: "NVIDIA", weightBps: 2500, tokenized: true, xstock: "NVDAx" },
      { symbol: "TSLA", company: "Tesla", weightBps: 2000, tokenized: true, xstock: "TSLAx" },
      { symbol: "MSTR", company: "MicroStrategy", weightBps: 1500, tokenized: true, xstock: "MSTRx" },
      { symbol: "COIN", company: "Coinbase", weightBps: 1500, tokenized: true, xstock: "COINx" },
      { symbol: "HOOD", company: "Robinhood", weightBps: 1500, tokenized: true, xstock: "HOODx" },
      { symbol: "CRCL", company: "Circle", weightBps: 1000, tokenized: true, xstock: "CRCLx" },
    ],
  },
  {
    ticker: "mg7SOL",
    shareMint: "warhSBcb8XpCxz6KGFx9JsFbYxzLPF7BKwUYDJgRzKC",
    name: "Magnificent Seven",
    status: "live",
    accent: "#E8833A",
    accentInk: "#05080F",
    // The clean glyph, not the already-halftoned token image: `Halftone`
    // renders the dots itself, and dotting a dot matrix produces moire.
    portrait: "/avatars/mg7sol.png",
    portraitAlt: "A numeral seven, drawn in ink dots",
    subject: "Big Tech",
    hook: "The seven companies that ate the index. Equal weighted, so one name cannot become the whole thing.",
    about: [
      "Nvidia, Microsoft, Apple, Amazon, Alphabet, Meta and Tesla. Between them, roughly a third of the S&P 500. Most people who think they own a diversified index already own these seven, just without saying so.",
      "Held at equal weight rather than by market cap. Cap weighting would put close to a quarter of the basket in one name and turn the other six into rounding errors. Equal weight is a decision to own the group, not the leader.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.spglobal.com/spdji/en/indices/equity/sp-500/",
    rebalance: "Quarterly, back to equal weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "Copycat picks these names. There is no filing, no index provider, and no rule you can audit. The membership of the \u201cMagnificent Seven\u201d is a press coinage, not a definition. It is also seven correlated US technology companies, so this is a concentrated bet dressed as a basket.",
    legs: [
      { symbol: "NVDA", company: "NVIDIA", weightBps: 1429, tokenized: true, xstock: "NVDAx" },
      { symbol: "MSFT", company: "Microsoft", weightBps: 1429, tokenized: true, xstock: "MSFTx" },
      { symbol: "AAPL", company: "Apple", weightBps: 1429, tokenized: true, xstock: "AAPLx" },
      { symbol: "AMZN", company: "Amazon.com", weightBps: 1429, tokenized: true, xstock: "AMZNx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 1428, tokenized: true, xstock: "GOOGLx" },
      { symbol: "META", company: "Meta", weightBps: 1428, tokenized: true, xstock: "METAx" },
      { symbol: "TSLA", company: "Tesla", weightBps: 1428, tokenized: true, xstock: "TSLAx" },
    ],
  },
];

export const LIVE_TRACKERS = TRACKERS.filter((t) => t.status !== "soon");

export const getTracker = (ticker: string) =>
  TRACKERS.find((t) => t.ticker.toLowerCase() === ticker.toLowerCase());

/**
 * Every image on the site, with the credit its licence requires.
 */
export const IMAGE_CREDITS = [
  {
    subject: "Nancy Pelosi, Warren Buffett, Bill Ackman",
    author: "Wikipedia lead images",
    license: "free licenses via Wikimedia Commons",
    licenseUrl: "https://commons.wikimedia.org",
    sourceUrl: "https://commons.wikimedia.org",
  },
  {
    subject: "Ray Dalio",
    author: "Web Summit",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Web_Summit_2018_-_Forum_-_Day_2,_November_7_HM1_7481_(44858045925).jpg",
  },
  {
    subject: "David Tepper",
    author: "Appaloosa Management",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:David_Tepper_01.jpg",
  },
  {
    subject: "Jim Cramer",
    author: "Tulane Public Relations",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Jimcramerphoto_(cropped).jpg",
  },
  {
    subject: "United States Capitol",
    author: "Martin Falbisoner",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Capitol_at_Dusk_2.jpg",
  },
] as const;

/** The tokenized-equity issuer we would route through on mainnet. */
export const ISSUER = {
  name: "xStocks",
  issuer: "Backed Assets (JE) Limited",
  url: "https://xstocks.com",
  note: "Roughly 130 tokenized US equities and ETFs issued as SPL tokens, backed 1:1 and held by a Jersey SPV.",
} as const;
