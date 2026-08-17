/**
 * Verified on-chain bindings for every tokenized leg.
 *
 * Checked in rather than resolved from an API at deploy time. Binding a vault
 * leg to the wrong mint is unrecoverable, and the search endpoints that would
 * resolve these carry impostors: a query for SpaceX returns eight tokens all
 * named "SpaceX - Backpack Securities", one with a fire emoji, ranging from $11
 * to $2,212 of liquidity. A reviewable file beats a live lookup.
 *
 * Every entry below was confirmed against Jupiter\'s `verified` tag with a
 * matching symbol, and every Pyth feed is the `Equity.US.<SYM>/USD` id.
 *
 * `mint`     the SPL Token-2022 mint the vault holds
 * `pythFeed` the price feed for the *underlying equity*, not for the token
 */
export type LegBinding = {
  symbol: string;
  mint: string;
  pythFeed: string;
  issuer: "xStocks";
};

export const LEG_BINDINGS: Record<string, LegBinding> = {
  AAPLx: {
    symbol: "AAPL",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    pythFeed: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    issuer: "xStocks",
  },
  AMZNx: {
    symbol: "AMZN",
    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    pythFeed: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    issuer: "xStocks",
  },
  COINx: {
    symbol: "COIN",
    mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    pythFeed: "fee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245",
    issuer: "xStocks",
  },
  CRCLx: {
    symbol: "CRCL",
    mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
    pythFeed: "92b8527aabe59ea2b12230f7b532769b133ffb118dfbd48ff676f14b273f1365",
    issuer: "xStocks",
  },
  GMEx: {
    symbol: "GME",
    mint: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc",
    pythFeed: "6f9cd89ef1b7fd39f667101a91ad578b6c6ace4579d5f7f285a4b06aa4504be6",
    issuer: "xStocks",
  },
  GOOGLx: {
    symbol: "GOOGL",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    pythFeed: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
    issuer: "xStocks",
  },
  HOODx: {
    symbol: "HOOD",
    mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
    pythFeed: "306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849",
    issuer: "xStocks",
  },
  KOx: {
    symbol: "KO",
    mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ",
    pythFeed: "9aa471dccea36b90703325225ac76189baf7e0cc286b8843de1de4f31f9caa7d",
    issuer: "xStocks",
  },
  MCDx: {
    symbol: "MCD",
    mint: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2",
    pythFeed: "d3178156b7c0f6ce10d6da7d347952a672467b51708baaf1a57ffe1fb005824a",
    issuer: "xStocks",
  },
  METAx: {
    symbol: "META",
    mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    pythFeed: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    issuer: "xStocks",
  },
  MSFTx: {
    symbol: "MSFT",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    pythFeed: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    issuer: "xStocks",
  },
  MSTRx: {
    symbol: "MSTR",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    pythFeed: "e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09",
    issuer: "xStocks",
  },
  NVDAx: {
    symbol: "NVDA",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    pythFeed: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    issuer: "xStocks",
  },
  PEPx: {
    symbol: "PEP",
    mint: "Xsv99frTRUeornyvCfvhnDesQDWuvns1M852Pez91vF",
    pythFeed: "be230eddb16aad5ad273a85e581e74eb615ebf67d378f885768d9b047df0c843",
    issuer: "xStocks",
  },
  STRCx: {
    symbol: "STRC",
    mint: "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH",
    pythFeed: "27c7bbc9755d847f7fc63620c2edcc6a91d2c0c67a28c7999907b59c505b3c17",
    issuer: "xStocks",
  },
  TSLAx: {
    symbol: "TSLA",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    pythFeed: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    issuer: "xStocks",
  },
  XOMx: {
    symbol: "XOM",
    mint: "XsaHND8sHyfMfsWPj6kSdd5VwvCayZvjYgKmmcNL5qh",
    pythFeed: "4a1a12070192e8db9a89ac235bb032342a390dde39389b4ee1ba8e41e7eae5d8",
    issuer: "xStocks",
  },
};

/** Throws rather than returning undefined: an unbound leg must never silently
 * become a zero mint, which would route its weight into the SOL sleeve without
 * anyone deciding to. */
export function legBinding(xstock: string): LegBinding {
  const b = LEG_BINDINGS[xstock];
  if (!b) throw new Error(`no verified binding for ${xstock}`);
  return b;
}
