/**
 * Rewrites each tracker's `legs` in config.ts from what the chain actually
 * publishes.
 *
 * The worker is the authority on weights: it reads the filing, filters, and
 * publishes. But `config.ts` is what the site renders and what the backtest is
 * computed from, so the moment the worker rebalances, the two disagree — the
 * card shows holdings the vault no longer claims and the return is measured
 * against a basket that no longer exists.
 *
 * Rather than ask anyone to hand-copy sixteen weights after every cycle, this
 * reads the vaults and rewrites the arrays. Company names come from Backed's
 * directory so a new leg arrives with a real name rather than its ticker.
 *
 *   node --experimental-strip-types scripts/sync-config-legs.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

const directory = await fetch(
  "https://api.xstocks.fi/api/v2/public/assets?network=Solana&page=0",
).then(() => null).catch(() => null);

/** symbol (NVDAx) -> { ticker: NVDA, company: NVIDIA } */
async function loadNames() {
  const out = new Map();
  for (let page = 0; page < 20; page++) {
    const r = await fetch(
      `https://api.xstocks.fi/api/v2/public/assets?network=Solana&page=${page}`,
      { headers: { accept: "application/json" } },
    );
    if (!r.ok) break;
    const body = await r.json();
    for (const n of body.nodes ?? []) {
      if (typeof n.symbol !== "string" || typeof n.underlyingSymbol !== "string") continue;
      out.set(n.symbol, {
        ticker: n.underlyingSymbol,
        // "NVIDIA xStock" -> "NVIDIA". The suffix is Backed's wrapper, not
        // part of the company's name.
        company: String(n.name ?? n.symbol).replace(/\s*xStock$/i, "").trim(),
      });
    }
    if (!body.page?.hasNextPage) break;
  }
  return out;
}

const names = await loadNames();
const { trackers } = await fetch(`${BACKEND}/api/trackers`).then((r) => r.json());

const path = join(ROOT, "src", "lib", "config.ts");
let source = await readFile(path, "utf8");
let changed = 0;

for (const t of trackers) {
  if (!t.onChain?.legs?.length) continue;

  const legs = t.onChain.legs.map((leg) => {
    const hit = names.get(leg.symbol);
    const ticker = hit?.ticker ?? leg.symbol.replace(/x$/, "");
    const company = hit?.company ?? ticker;
    const tokenized = Boolean(hit);
    return (
      `      { symbol: ${JSON.stringify(ticker)}, company: ${JSON.stringify(company)}, ` +
      `weightBps: ${leg.weightBps}, tokenized: ${tokenized}` +
      (tokenized ? `, xstock: ${JSON.stringify(leg.symbol)}` : "") +
      ` },`
    );
  });

  // Anchor on the ticker so the right block is replaced even as order changes.
  const block = new RegExp(
    `(ticker: "${t.ticker}"[\\s\\S]*?legs: \\[\\n)([\\s\\S]*?)(\\n    \\],)`,
  );
  const match = block.exec(source);
  if (!match) {
    console.log(`  ${t.ticker.padEnd(8)} not found in config.ts, skipped`);
    continue;
  }

  const next = `${match[1]}${legs.join("\n")}${match[3]}`;
  if (match[0] === next) {
    console.log(`  ${t.ticker.padEnd(8)} already in sync (${legs.length} legs)`);
    continue;
  }
  source = source.replace(match[0], next);
  changed++;
  console.log(`  ${t.ticker.padEnd(8)} ${legs.length} legs synced from chain`);
}

if (changed) await writeFile(path, source);
console.log(`\n${changed} tracker(s) rewritten from on-chain state`);
