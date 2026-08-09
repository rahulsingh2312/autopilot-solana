/**
 * Regenerates public/tokens/<ticker>.json from src/lib/config.ts.
 *
 * These files are what a wallet reads to name and describe the token someone
 * is holding, so they are the one surface where drifting from the site is not
 * a cosmetic problem: a card that says the basket rebalances monthly and a
 * wallet that says quarterly disagree about the asset itself. Generating them
 * from the same config the site renders removes the chance to disagree.
 *
 *   node --experimental-strip-types scripts/gen-token-metadata.mjs
 *
 * Re-run after editing TRACKERS, and re-upload if the mint's URI is already
 * pointed at these files (see scripts/set-metadata.mjs).
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { TRACKERS, BRAND, CLUSTER, WATCH_MINUTES } = await import(
  "../src/lib/config.ts"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://autopilot-solana.vercel.app";

const network = CLUSTER === "devnet" ? "Solana devnet" : "Solana mainnet";

/**
 * The description a wallet shows. Built from the same hook the card leads
 * with, then the mechanics in the site's own words: what you do, what you
 * get, and how the basket keeps up.
 */
function describe(tracker) {
  const watch =
    tracker.status === "frozen"
      ? "The source is final, so the basket never changes."
      : `The source is re-read every ${WATCH_MINUTES} minutes and the basket updates when it changes.`;

  return [
    `${tracker.hook} Deposit SOL to mint ${tracker.ticker}, burn it back for SOL at NAV any time.`,
    watch,
    `Holdings: ${tracker.legs.map((l) => l.symbol).join(", ")}.`,
    `${network} deployment by ${BRAND.name}. Not an ETF, not a registered fund, not investment advice.`,
  ].join(" ");
}

let written = 0;

for (const tracker of TRACKERS) {
  const slug = tracker.ticker.toLowerCase();

  const metadata = {
    name: tracker.name,
    symbol: tracker.ticker,
    description: describe(tracker),
    image: `${SITE}/tokens/${slug}.png`,
    external_url: SITE,
    attributes: [
      { trait_type: "Tracks", value: tracker.subject },
      { trait_type: "Source", value: tracker.source },
      { trait_type: "Rebalance", value: tracker.rebalance },
      { trait_type: "Filing delay", value: tracker.filingDelay },
      { trait_type: "Holdings", value: String(tracker.legs.length) },
      { trait_type: "Network", value: network },
    ],
  };

  await writeFile(
    join(ROOT, "public", "tokens", `${slug}.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  written++;
  console.log(`  ${tracker.ticker.padEnd(7)} ${tracker.name}`);
}

console.log(`\n${written} token metadata files written from config.ts`);
