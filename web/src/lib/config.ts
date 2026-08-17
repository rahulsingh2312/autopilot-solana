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
    portrait: null,
    portraitAlt: "A snake eating its own tail, drawn in ink dots",
    subject: "Crypto, listed",
    hook: "Companies whose earnings are a bet on crypto, bought with crypto.",
    about: [
      "Six listed companies that are, underneath the filings, leveraged positions on the same thing you are paying with. Circle issues USDC and earns the interest on its reserves. Strategy is a bitcoin holding company with a software segment attached, and STRC is the preferred stock it issues to buy more. Coinbase and Robinhood are the toll booths. GameStop is what happens when a retailer discovers the balance sheet is more interesting than the stores.",
      "The name is the argument. You spend SOL to mint a token that holds equities whose value depends on the price of crypto \u2014 a position that eats its own tail. Every leg is priced by Pyth against the underlying listed share, so the vault knows what it holds even when the reflexivity does not.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.sec.gov/edgar/search/",
    rebalance: "Quarterly, back to target weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "This is not diversification, it is the same trade six times. When crypto falls these do not fall independently \u2014 they fall together, and usually harder than the asset they track, because most of them carry leverage or hold the asset outright. Buying it with SOL means a drawdown hits the vault and your denominator at once.",
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
    portrait: null,
    portraitAlt: "A paper cup, a bottle and a fuel nozzle, drawn in ink dots",
    subject: "Things people do not stop buying",
    hook: "Fast food, sugar, caffeine and fuel. Four businesses nobody decides about.",
    about: [
      "McDonald's, Coca-Cola, PepsiCo and Exxon Mobil, equally weighted. The usual name for this basket is defensive, which is a portfolio manager's word for the same observation stated less clearly: none of these are decisions. People do not evaluate whether to buy a Coke, and they do not stop commuting because the market fell.",
      "That is the whole thesis, and it is why the basket is boring on purpose. It will lag badly in a year when everything works. It is here to be the part of the lineup that is not a bet on technology, on crypto, or on somebody's disclosed trades.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.sec.gov/edgar/search/",
    rebalance: "Quarterly, back to equal weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "Boring is not safe. Three of these four sell things a growing share of buyers are actively trying to consume less of, and the fourth sells the thing the energy transition is aimed at. Equal weight also means a quarter of this basket is a single oil major, so an oil price shock moves it more than the word defensive suggests.",
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
    portrait: "/portraits/cramer.jpg",
    portraitAlt: "Jim Cramer",
    subject: "Jim Cramer",
    hook: "He is still on television every weeknight. That is the whole thesis.",
    about: [
      "Six of the most-shouted-about names on cable, held as tokenized equities. An index built from a running joke, and we run it seriously: fixed weights, monthly rebalance, every move on chain.",
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
    ticker: "pltSOL",
    // Still the derived mint this tracker was created with. It has shares
    // outstanding, so `close_tracker` refuses and the mint cannot be
    // swapped. The ground vanity address warhA5YS2Hix…
    // is reserved for it; redeem, re-run init-trackers.mjs, then update.
    //
    // This has to match what the tracker records or the site derives a share
    // account that does not exist, and a holder cannot see — let alone
    // redeem — what they own.
    shareMint: "A5AqDr5kxWvingmybQASTgHnQgjWVWyj2mLDPYQR9D6R",
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
      "Most of this book is call options, and a long-only vault cannot hold one \u2014 they are excluded, which removes the majority of the disclosed activity and the card states how much. What remains is the share sleeve, including names with no tokenized counterpart whose weight sits in SOL. Same direction, none of the leverage, so this will not track her returns.",
    legs: [
      { symbol: "INTC", company: "Intel", weightBps: 4800, tokenized: true, xstock: "INTCx" },
      { symbol: "UBER", company: "Uber", weightBps: 1200, tokenized: true, xstock: "UBERx" },
      { symbol: "AMZN", company: "Amazon.com", weightBps: 1200, tokenized: true, xstock: "AMZNx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 1200, tokenized: true, xstock: "GOOGLx" },
      { symbol: "NVDA", company: "NVIDIA", weightBps: 600, tokenized: true, xstock: "NVDAx" },
      { symbol: "AAPL", company: "Apple", weightBps: 600, tokenized: true, xstock: "AAPLx" },
      { symbol: "VST", company: "VST", weightBps: 280, tokenized: false },
      { symbol: "TEM", company: "TEM", weightBps: 120, tokenized: false },
    ],
  },
  {
    ticker: "cgSOL",
    shareMint: "warhL13YoBGLxkbJuQGvB1snMvjwrzXEaBYyuRmYmFZ",
    name: "Congress Tracker",
    status: "live",
    accent: "#7B8CFF",
    accentInk: "#FFFFFF",
    portrait: "/portraits/capitol.jpg",
    portraitAlt: "The United States Capitol",
    subject: "Congress",
    hook: "535 people who legally must tell you what they bought. Eventually.",
    about: [
      "The sixteen names bought by the most distinct members across congressional disclosures, weighted by how many members hold each. Members have 45 days to report a trade under the STOCK Act, so cgSOL is always looking slightly into the past.",
      "Individual conviction washes out in an aggregate; what survives is the chamber's collective lean, which has been mega-cap tech for years.",
    ],
    source: "STOCK Act disclosures, aggregated across members",
    sourceUrl: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    rebalance: "On each new disclosure",
    filingDelay: "Up to 45 days by law",
    caveat:
      "Weighted by how many members hold a name, not by how much they hold: disclosure ranges make true sizing impossible. It tracks what Congress holds most widely, not what it holds most of. Names with no tokenized counterpart keep their weight in the SOL sleeve, and the card names them next to the holdings.",
    legs: [
      { symbol: "AAPL", company: "Apple", weightBps: 909, tokenized: true, xstock: "AAPLx" },
      { symbol: "AMZN", company: "Amazon.com", weightBps: 842, tokenized: true, xstock: "AMZNx" },
      { symbol: "MSFT", company: "Microsoft", weightBps: 808, tokenized: true, xstock: "MSFTx" },
      { symbol: "NVDA", company: "NVIDIA", weightBps: 808, tokenized: true, xstock: "NVDAx" },
      { symbol: "AVGO", company: "Broadcom", weightBps: 606, tokenized: true, xstock: "AVGOx" },
      { symbol: "JNJ", company: "Johnson & Johnson", weightBps: 606, tokenized: true, xstock: "JNJx" },
      { symbol: "UNH", company: "UnitedHealth", weightBps: 606, tokenized: true, xstock: "UNHx" },
      { symbol: "JPM", company: "JPMorgan Chase", weightBps: 606, tokenized: true, xstock: "JPMx" },
      { symbol: "HD", company: "Home Depot", weightBps: 573, tokenized: false },
      { symbol: "META", company: "Meta", weightBps: 573, tokenized: true, xstock: "METAx" },
      { symbol: "V", company: "Visa", weightBps: 572, tokenized: true, xstock: "Vx" },
      { symbol: "COST", company: "COST", weightBps: 505, tokenized: false },
      { symbol: "PG", company: "Procter & Gamble", weightBps: 505, tokenized: true, xstock: "PGx" },
      { symbol: "MRK", company: "Merck", weightBps: 505, tokenized: false },
      { symbol: "PEP", company: "PepsiCo", weightBps: 505, tokenized: true, xstock: "PEPx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 471, tokenized: true, xstock: "GOOGLx" },
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
    hook: "The seven companies that ate the index. Equal weighted, so the biggest one does not become the whole thing.",
    about: [
      "Nvidia, Microsoft, Apple, Amazon, Alphabet, Meta and Tesla. Between them they are roughly a third of the S&P 500, which means most people who think they own a diversified index mostly own these seven.",
      "Held at equal weight rather than by market cap. A cap-weighted version would put close to a quarter of the basket in one name and turn the other six into rounding errors; equal weight is a decision to hold the group rather than the leader.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.spglobal.com/spdji/en/indices/equity/sp-500/",
    rebalance: "Quarterly, back to equal weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "Copycat picks these names. There is no filing, no index provider, and no rule you can audit — the membership of the \u201cMagnificent Seven\u201d is a press coinage, not a definition. It is also seven correlated US technology companies, so this is a concentrated bet dressed as a basket.",
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
  {
    ticker: "aiSOL",
    // Still the derived mint this tracker was created with. It has shares
    // outstanding, so `close_tracker` refuses and the mint cannot be
    // swapped. The ground vanity address warhdDBRacMw…
    // is reserved for it; redeem, re-run init-trackers.mjs, then update.
    //
    // This has to match what the tracker records or the site derives a share
    // account that does not exist, and a holder cannot see — let alone
    // redeem — what they own.
    shareMint: "59SgAUGMAQUYCHJFrQve9vnDLeqcNDL5ToM3Xb41eApX",
    name: "AI Infrastructure",
    status: "live",
    accent: "#A855F7",
    accentInk: "#FFFFFF",
    portrait: "/avatars/aisol.png",
    portraitAlt: "A processor die with pins, drawn in ink dots",
    subject: "AI buildout",
    hook: "Not the models. The whole stack underneath them \u2014 lithography, foundry, memory, silicon, networking and the clouds renting it out.",
    about: [
      "Sixteen companies, equal weighted, covering the AI supply chain end to end. ASML makes the machines that print the chips; TSMC prints them; Nvidia, AMD, Broadcom, Marvell and Intel design them; Micron, SK Hynix and SanDisk supply the memory and storage they starve without; Microsoft, Alphabet, Amazon, Meta and Oracle buy the result and rent it out; Palantir sells the deployment layer on top.",
      "Equal weight is the point. A cap-weighted version of this is just Nvidia with a long tail, and the interesting claim is that the buildout pays the whole chain \u2014 including the unglamorous parts \u2014 not only the company everyone already owns.",
    ],
    source: "Editorial. Curated by Copycat.",
    sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA&type=10-K",
    rebalance: "Quarterly, back to equal weight",
    filingDelay: "None. There is no filing.",
    caveat:
      "Copycat picks these names, and picked them knowing how they had already done. Sixteen holdings in one theme is not diversification, it is a single trade on capital expenditure continuing. Liquidity across the stack is also wildly uneven \u2014 Nvidia trades in millions on chain, several of the memory and equipment names in hundreds \u2014 so the weights are real but most of this basket could not be rebalanced at size today. The holdings list names which ones.",
    legs: [
      { symbol: "NVDA", company: "NVIDIA", weightBps: 625, tokenized: true, xstock: "NVDAx" },
      { symbol: "GOOGL", company: "Alphabet", weightBps: 625, tokenized: true, xstock: "GOOGLx" },
      { symbol: "MSFT", company: "Microsoft", weightBps: 625, tokenized: true, xstock: "MSFTx" },
      { symbol: "AMZN", company: "Amazon.com", weightBps: 625, tokenized: true, xstock: "AMZNx" },
      { symbol: "META", company: "Meta", weightBps: 625, tokenized: true, xstock: "METAx" },
      { symbol: "ORCL", company: "Oracle", weightBps: 625, tokenized: true, xstock: "ORCLx" },
      { symbol: "AVGO", company: "Broadcom", weightBps: 625, tokenized: true, xstock: "AVGOx" },
      { symbol: "AMD", company: "AMD", weightBps: 625, tokenized: true, xstock: "AMDx" },
      { symbol: "MRVL", company: "Marvell", weightBps: 625, tokenized: true, xstock: "MRVLx" },
      { symbol: "INTC", company: "Intel", weightBps: 625, tokenized: true, xstock: "INTCx" },
      { symbol: "TSM", company: "TSMC", weightBps: 625, tokenized: true, xstock: "TSMx" },
      { symbol: "ASML", company: "ASML", weightBps: 625, tokenized: true, xstock: "ASMLx" },
      { symbol: "MU", company: "Micron Technology", weightBps: 625, tokenized: true, xstock: "MUx" },
      { symbol: "SKHY", company: "SK hynix", weightBps: 625, tokenized: false },
      { symbol: "SNDK", company: "Sandisk Corporation", weightBps: 625, tokenized: true, xstock: "SNDKx" },
      { symbol: "PLTR", company: "Palantir", weightBps: 625, tokenized: true, xstock: "PLTRx" },
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
