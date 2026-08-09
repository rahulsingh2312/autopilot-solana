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
 * How often a tracker's source is re-read for changes, in minutes.
 *
 * Stated on the fund card and again in every token's on-chain metadata. Those
 * two disagreeing would be a card and a wallet describing the same asset
 * differently, so the number lives here and both read it.
 */
export const WATCH_MINUTES = 30;

export const BRAND = {
  name: "Autopilot",
  wordmark: "AUTOPILOT",
  byline: "by Autopilot",
  domain: "autopilot-solana.vercel.app",
  tagline: "Famous portfolios, one token each.",
  contactEmail: "hello@autopilot.fund",
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

/** Matches MAX_FEE_BPS in the program. The UI cannot show a fee the chain would reject. */
export const MAX_FEE_BPS = 300;

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
    ticker: "mbtSOL",
    name: "Michael Burry Tracker",
    status: "frozen",
    accent: "#FF6A55",
    accentInk: "#05080F",
    portrait: "/portraits/burry.jpg",
    portraitAlt: "Michael Burry",
    subject: "Michael Burry",
    hook: "Michael Burry's final disclosed book, frozen at the moment he walked away.",
    about: [
      "Scion Asset Management filed its final 13F on November 3, 2025 and deregistered with the SEC seven days later. Burry told investors he would liquidate and return capital by year end. There is no next filing coming.",
      "This basket holds the last disclosed common-stock book: four names, $68.1M, exactly as reported. It will never rebalance, because there is nothing left to rebalance against. A closing snapshot of a famous career, held as a token.",
    ],
    source: "SEC Form 13F-HR, Scion Asset Management, Q3 2025 (final)",
    sourceUrl:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001649339&type=13F",
    rebalance: "Never. The source is gone.",
    filingDelay: "Permanently stale since Nov 3, 2025",
    caveat:
      "About 80% of Scion's final reported book was put options on Palantir and Nvidia. A long-only vault cannot hold a put, so none of that is here. This tracks the common-stock sleeve only, renormalized to 100%.",
    legs: [
      {
        symbol: "MOH",
        company: "Molina Healthcare",
        weightBps: 3511,
        tokenized: false,
      },
      {
        symbol: "LULU",
        company: "Lululemon Athletica",
        weightBps: 2611,
        tokenized: false,
      },
      { symbol: "SLM", company: "SLM Corp", weightBps: 1950, tokenized: false },
      {
        symbol: "BRKR",
        company: "Bruker Corp",
        weightBps: 1928,
        tokenized: false,
      },
    ],
  },
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
      "For the record: the ETF that tried this, SJIM, closed in February 2024 after a year of losing money. The meme has a track record and it is not good. This index is editorial, not a filing.",
    ],
    source: "Editorial. Curated by Autopilot from Mad Money coverage.",
    sourceUrl: "https://www.cnbc.com/mad-money/",
    rebalance: "Monthly, on the first trading day",
    filingDelay: "None. There is no filing.",
    caveat:
      "Autopilot picks these names. No regulator, no filing, no rule you can audit. If you want a basket somebody else is legally on the hook for, this is not it.",
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
      "Built from the periodic transaction reports her household files under the STOCK Act: Broadcom and Nvidia call exercises, Palo Alto, Tempus AI, and the long-standing mega-cap core. The January 2026 filings exercised calls into 5,000 more NVDA and 5,000 TEM shares.",
      "Disclosures state ranges, not amounts, and options, not just shares. So the weights here are our estimate of the household book, not a number anyone filed.",
    ],
    source: "STOCK Act periodic transaction reports, Speaker Emerita Pelosi",
    sourceUrl: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days by law",
    caveat:
      "Filings disclose ranges like $1M to $5M, not exact sizes, and much of the book is call options a long-only vault cannot hold. These weights are editorial estimates of the disclosed positions, held as shares.",
    legs: [
      { symbol: "AVGO", company: "Broadcom", weightBps: 2500, tokenized: true, xstock: "AVGOx" },
      { symbol: "NVDA", company: "NVIDIA", weightBps: 2500, tokenized: true, xstock: "NVDAx" },
      { symbol: "PANW", company: "Palo Alto Networks", weightBps: 1500, tokenized: true, xstock: "PANWx" },
      { symbol: "AAPL", company: "Apple", weightBps: 1250, tokenized: true, xstock: "AAPLx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 1250, tokenized: true, xstock: "GOOGLx" },
      { symbol: "TEM", company: "Tempus AI", weightBps: 1000, tokenized: false },
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
      "The five names most widely held across congressional disclosures, equal weighted. Members have 45 days to report a trade under the STOCK Act, so this basket is always looking slightly into the past.",
      "Individual conviction washes out in an aggregate; what survives is the chamber's collective lean, which has been mega-cap tech for years.",
    ],
    source: "STOCK Act disclosures, aggregated across members",
    sourceUrl: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    rebalance: "Quarterly",
    filingDelay: "Up to 45 days by law",
    caveat:
      "An equal-weight basket of the most commonly disclosed names, not a size-weighted aggregate: disclosure ranges make true sizing impossible. It tracks what Congress holds most widely, not what it holds most of.",
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
    rebalance: "Quarterly, on each 13F",
    filingDelay: "Up to 45 days after quarter end",
    caveat:
      "Top six positions only, out of 29, renormalized to 100%. Berkshire's biggest asset is a mountain of T-bills no equity basket can represent, so this is the equity sleeve, concentrated further.",
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
    ticker: "jstSOL",
    name: "Jim Simons Tracker",
    status: "live",
    accent: "#8E5CE7",
    accentInk: "#FFFFFF",
    portrait: "/portraits/simons.jpg",
    portraitAlt: "Jim Simons",
    subject: "Jim Simons",
    hook: "The man died in 2024. The machine he built keeps filing.",
    about: [
      "Renaissance Technologies still reports a 13F every quarter: $64B across thousands of algorithmically chosen positions. This basket holds the five largest from Q1 2026, renormalized.",
      "Be clear about what this is not: Medallion, the fund that made Simons a legend, is closed to outsiders and discloses nothing. This tracks the public tip of a very private iceberg.",
    ],
    source: "SEC Form 13F-HR, Renaissance Technologies, Q1 2026",
    sourceUrl:
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001037389&type=13F",
    rebalance: "Quarterly, on each 13F",
    filingDelay: "Up to 45 days after quarter end",
    caveat:
      "RenTec's top position is 1.66% of a portfolio with thousands of names. Five holdings cannot track a strategy built on breadth; this is a sample of the machine's output, not the machine.",
    legs: [
      { symbol: "UTHR", company: "United Therapeutics", weightBps: 2400, tokenized: true, xstock: "UTHRx" },
      { symbol: "PLTR", company: "Palantir", weightBps: 2300, tokenized: true, xstock: "PLTRx" },
      { symbol: "AAPL", company: "Apple", weightBps: 1800, tokenized: true, xstock: "AAPLx" },
      { symbol: "KGC", company: "Kinross Gold", weightBps: 1800, tokenized: false },
      { symbol: "MU", company: "Micron", weightBps: 1700, tokenized: true, xstock: "MUx" },
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
    rebalance: "Quarterly, on each 13F",
    filingDelay: "Up to 45 days after quarter end",
    caveat:
      "Top five of eleven positions, renormalized. 13Fs omit swaps and hedges, and Ackman uses both, so the fund's true exposure can differ from its filing in ways this basket cannot see.",
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
 * Every image on the site, with the credit its licence requires. There is no
 * entry for Michael Burry because no freely licensed photograph of him
 * exists, which is why his card carries a redacted plate.
 */
export const IMAGE_CREDITS = [
  {
    subject: "Nancy Pelosi, Warren Buffett, Jim Simons, Bill Ackman",
    author: "Wikipedia lead images",
    license: "free licenses via Wikimedia Commons",
    licenseUrl: "https://commons.wikimedia.org",
    sourceUrl: "https://commons.wikimedia.org",
  },
  {
    subject: "Michael Burry",
    author: "press photo, The Big Short premiere (2015)",
    license: "MVP placeholder, replace before launch",
    licenseUrl: "https://en.wikipedia.org/wiki/Michael_Burry",
    sourceUrl: "https://en.wikipedia.org/wiki/Michael_Burry",
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
