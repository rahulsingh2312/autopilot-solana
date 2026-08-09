/**
 * Every address, ticker, fee, link, and piece of tracker copy lives here.
 * Launch day is a one-line edit, not a search-and-replace across components.
 */

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet") as
  | "devnet"
  | "mainnet-beta";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (CLUSTER === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com");

export const RPC_WS_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_WS_URL ?? RPC_URL.replace(/^http/, "ws");

export const CHAIN = `solana:${CLUSTER}` as const;

export const PROGRAM_ID = "8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK";

/**
 * How often a tracker's source is re-read for changes, in seconds.
 *
 * Stated on the fund card and again in every token's on-chain metadata. Those
 * two disagreeing would be a card and a wallet describing the same asset
 * differently, so the number lives here and both read it.
 */
export const WATCH_SECONDS = 30;

export const BRAND = {
  name: "Autopilot",
  wordmark: "AUTOPILOT",
  byline: "by Autopilot",
  domain: "autopilot-solana.vercel.app",
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
  /** Shown verbatim on the card. The uncomfortable fact, stated first. */
  caveat: string;
};

export const TRACKERS: TrackerConfig[] = [
  {
    ticker: "icSOL",
    name: "Inverse Cramer Index",
    status: "live",
    accent: "#35D07F",
    accentInk: "#05080F",
    portrait: "/portraits/cramer.jpg",
    portraitAlt: "Jim Cramer",
    subject: "Jim Cramer",
    hook: "He is still on television every weeknight. That is the whole thesis.",
    about: [
      "Six of the most-shouted-about names on cable, held as tokenized equities. An index built from a running joke, and we run it seriously: fixed weights, monthly rebalance, every move on chain.",
      "For the record, the meme has been measured. Quiver Quantitative backtests an inverse-Cramer strategy from January 2021 at a 42.7% win rate over 3,427 trades, a Sharpe of -0.171 and -13.99% in the last year. The ETF that tried it, SJIM, closed in February 2024. This index is editorial, not a filing.",
    ],
    source: "Editorial. Curated by Autopilot from Mad Money coverage.",
    sourceUrl: "https://www.cnbc.com/mad-money/",
    rebalance: "On each new disclosure",
    filingDelay: "None. There is no filing.",
    caveat:
      "Autopilot picks these names. No regulator, no filing, no rule you can audit. If you want holdings somebody else is legally on the hook for, this is not it.",
    legs: [
      {
        symbol: "NVDA",
        company: "NVIDIA",
        weightBps: 2500,
        tokenized: true,
        xstock: "NVDAx",
      },
      {
        symbol: "TSLA",
        company: "Tesla",
        weightBps: 2000,
        tokenized: true,
        xstock: "TSLAx",
      },
      {
        symbol: "MSTR",
        company: "Strategy",
        weightBps: 1500,
        tokenized: true,
        xstock: "MSTRx",
      },
      {
        symbol: "COIN",
        company: "Coinbase",
        weightBps: 1500,
        tokenized: true,
        xstock: "COINx",
      },
      {
        symbol: "HOOD",
        company: "Robinhood",
        weightBps: 1500,
        tokenized: true,
        xstock: "HOODx",
      },
      {
        symbol: "CRCL",
        company: "Circle",
        weightBps: 1000,
        tokenized: true,
        xstock: "CRCLx",
      },
    ],
  },
  {
    ticker: "pltSOL",
    name: "Pelosi Tracker",
    status: "live",
    accent: "#2F6FED",
    accentInk: "#FFFFFF",
    portrait: "/portraits/pelosi.jpg",
    portraitAlt: "Nancy Pelosi",
    subject: "Nancy Pelosi",
    hook: "The most-watched brokerage account in America, filed under oath.",
    about: [
      "Built from the periodic transaction reports her household files under the STOCK Act, weighted by the midpoint of each disclosed dollar range. The newest entries are 200 Intel calls and 200 Uber calls traded May 29, 2026 and filed June 23. Before those, January 2026 exercised fifty calls each into Amazon, Alphabet, Nvidia, Vistra and Tempus AI.",
      "Disclosures state ranges like $1,000,001 to $5,000,000, never an exact size, so every weight here is a midpoint estimate rather than a number anyone filed.",
    ],
    source: "STOCK Act periodic transaction reports, via Quiver Quantitative",
    sourceUrl:
      "https://www.quiverquant.com/congresstrading/politician/Nancy%20Pelosi-P000197",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days by law",
    caveat:
      "Much of this book is call options, and a long-only vault holds shares instead. Same direction, none of the leverage, so this will not track her returns. Intel alone is 48% because one disclosed range ran to $5M; that is what the filing implies, not a conviction we added.",
    legs: [
      { symbol: "INTC", company: "Intel", weightBps: 4800, tokenized: true, xstock: "INTCx" },
      { symbol: "UBER", company: "Uber", weightBps: 1200, tokenized: true, xstock: "UBERx" },
      { symbol: "AMZN", company: "Amazon", weightBps: 1200, tokenized: true, xstock: "AMZNx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 1200, tokenized: true, xstock: "GOOGLx" },
      { symbol: "NVDA", company: "NVIDIA", weightBps: 600, tokenized: true, xstock: "NVDAx" },
      { symbol: "AAPL", company: "Apple", weightBps: 600, tokenized: true, xstock: "AAPLx" },
      { symbol: "VST", company: "Vistra", weightBps: 280, tokenized: false },
      { symbol: "TEM", company: "Tempus AI", weightBps: 120, tokenized: false },
    ],
  },
  {
    ticker: "cgSOL",
    name: "Congress Tracker",
    status: "live",
    accent: "#7B8CFF",
    accentInk: "#FFFFFF",
    portrait: "/portraits/capitol.jpg",
    portraitAlt: "The United States Capitol",
    subject: "Congress",
    hook: "535 people who legally must tell you what they bought. Eventually.",
    about: [
      "The five names most widely held across congressional disclosures, equal weighted. Members have 45 days to report a trade under the STOCK Act, so cgSOL is always looking slightly into the past.",
      "Individual conviction washes out in an aggregate; what survives is the chamber's collective lean, which has been mega-cap tech for years.",
    ],
    source: "STOCK Act disclosures, aggregated across members",
    sourceUrl: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days by law",
    caveat:
      "An equal-weight set of the most commonly disclosed names, not a size-weighted aggregate: disclosure ranges make true sizing impossible. It tracks what Congress holds most widely, not what it holds most of.",
    legs: [
      { symbol: "NVDA", company: "NVIDIA", weightBps: 2000, tokenized: true, xstock: "NVDAx" },
      { symbol: "MSFT", company: "Microsoft", weightBps: 2000, tokenized: true, xstock: "MSFTx" },
      { symbol: "AAPL", company: "Apple", weightBps: 2000, tokenized: true, xstock: "AAPLx" },
      { symbol: "AMZN", company: "Amazon", weightBps: 2000, tokenized: true, xstock: "AMZNx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 2000, tokenized: true, xstock: "GOOGLx" },
    ],
  },
  {
    ticker: "bwSOL",
    name: "Buffett Tracker",
    status: "live",
    accent: "#C98A1B",
    accentInk: "#FFFFFF",
    portrait: "/portraits/buffett.jpg",
    portraitAlt: "Warren Buffett",
    subject: "Warren Buffett",
    hook: "He handed Greg Abel the keys. The 13F still prints every quarter.",
    about: [
      "Berkshire Hathaway's six largest disclosed equity positions from the Q1 2026 13F, renormalized to 100%. Apple, American Express, Coca-Cola, Bank of America, Chevron, and the newly tripled Alphabet stake.",
      "Buffett stepped back as CEO at the end of 2025, so this increasingly tracks Berkshire the institution rather than Buffett the person. The filing does not care who signs it.",
    ],
    source: "SEC Form 13F-HR, Berkshire Hathaway, Q1 2026",
    sourceUrl:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001067983&type=13F",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days after quarter end",
    caveat:
      "Top six positions only, out of 29, renormalized to 100%. Berkshire's biggest asset is a mountain of T-bills no equity tracker can represent, so this is the equity sleeve, concentrated further.",
    legs: [
      { symbol: "AAPL", company: "Apple", weightBps: 2680, tokenized: true, xstock: "AAPLx" },
      { symbol: "AXP", company: "American Express", weightBps: 2120, tokenized: false },
      { symbol: "KO", company: "Coca-Cola", weightBps: 1410, tokenized: true, xstock: "KOx" },
      { symbol: "BAC", company: "Bank of America", weightBps: 1290, tokenized: true, xstock: "BACx" },
      { symbol: "CVX", company: "Chevron", weightBps: 1250, tokenized: true, xstock: "CVXx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 1250, tokenized: true, xstock: "GOOGLx" },
    ],
  },
  {
    ticker: "psqSOL",
    name: "Ackman Tracker",
    status: "live",
    accent: "#0FA3A3",
    accentInk: "#FFFFFF",
    portrait: "/portraits/ackman.jpg",
    portraitAlt: "Bill Ackman",
    subject: "Bill Ackman",
    hook: "Eleven positions, $13.7B, and a post about every one of them.",
    about: [
      "Pershing Square's five largest positions from the Q1 2026 13F: Brookfield, Amazon, Uber, the new Microsoft stake, and Restaurant Brands, renormalized to 100%.",
      "Ackman runs one of the most concentrated big books in the business, which makes it unusually trackable: five names are most of the fund, and he narrates his own trades in public.",
    ],
    source: "SEC Form 13F-HR, Pershing Square Capital, Q1 2026",
    sourceUrl:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001336528&type=13F",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days after quarter end",
    caveat:
      "Top five of eleven positions, renormalized. 13Fs omit swaps and hedges, and Ackman uses both, so the fund's true exposure can differ from its filing in ways psqSOL cannot see.",
    legs: [
      { symbol: "BN", company: "Brookfield", weightBps: 2200, tokenized: false },
      { symbol: "AMZN", company: "Amazon", weightBps: 2150, tokenized: true, xstock: "AMZNx" },
      { symbol: "UBER", company: "Uber", weightBps: 1950, tokenized: true, xstock: "UBERx" },
      { symbol: "MSFT", company: "Microsoft", weightBps: 1900, tokenized: true, xstock: "MSFTx" },
      { symbol: "QSR", company: "Restaurant Brands", weightBps: 1800, tokenized: true, xstock: "QSRx" },
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
