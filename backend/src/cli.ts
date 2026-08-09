/**
 * Operator CLI for the things you want to do by hand before trusting a
 * schedule with them.
 *
 *   node src/cli.ts ingest [ticker]     fetch + build + plan (never sends)
 *   node src/cli.ts plan   <ticker>     show the pending plan in full
 *   node src/cli.ts publish <ticker>    apply the pending plan
 *   node src/cli.ts holdings [ticker]   what the chain says right now
 *
 * `publish` sends real transactions. Everything else is read-only, and
 * `--dry-run` makes publish simulate instead.
 */

import { env } from "./env.ts";
import { errText } from "./log.ts";
import { approvePending, describeChanges, runCycle } from "./pipeline.ts";
import { readTrackerState } from "./chain/state.ts";
import { TRACKER_BINDINGS, getBinding } from "./trackers.ts";
import { pendingPlan } from "./store/db.ts";
import { getSettings } from "./store/settings.ts";

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const args = rest.filter((arg) => !arg.startsWith("--"));
const dryRun = flags.has("--dry-run");

const targets = (): string[] =>
  args.length > 0 ? args : TRACKER_BINDINGS.map((binding) => binding.ticker);

const bps = (value: number) => `${(value / 100).toFixed(2)}%`;
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);

async function cmdIngest() {
  for (const ticker of targets()) {
    const outcome = await runCycle(ticker, { force: flags.has("--force") });
    const drift = outcome.driftBps === undefined ? "" : ` drift=${bps(outcome.driftBps)}`;
    const detail = outcome.detail ? ` — ${outcome.detail}` : "";
    console.log(`${ticker.padEnd(8)} ${outcome.status}${drift}${detail}`);
  }
}

async function cmdPlan() {
  for (const ticker of targets()) {
    const pending = pendingPlan(ticker);
    console.log(`\n── ${ticker} ${"─".repeat(Math.max(0, 60 - ticker.length))}`);
    if (!pending) {
      console.log("  no pending plan");
      continue;
    }

    const { plan } = pending;
    console.log(`  plan #${pending.id}  drift ${bps(plan.driftBps)}  from ${plan.filingId}`);
    for (const line of describeChanges(plan)) console.log(`  ${line}`);

    if (plan.trades.length > 0) {
      console.log(`\n  trades (${plan.trades.length}):`);
      for (const trade of plan.trades) {
        const size =
          trade.side === "buy"
            ? `${(Number(trade.amount) / 1e9).toFixed(4)} SOL`
            : `${trade.amount} base units`;
        console.log(`    ${trade.side.padEnd(4)} ${trade.ticker.padEnd(6)} ${size}`);
      }
    } else {
      console.log("\n  trades: none (weights only)");
    }

    if (plan.blockers.length > 0) {
      console.log("\n  blockers:");
      for (const blocker of plan.blockers) console.log(`    · ${blocker}`);
    }
  }
}

async function cmdPublish() {
  const ticker = args[0];
  if (!ticker) throw new Error("usage: cli.ts publish <ticker> [--dry-run]");
  if (!getBinding(ticker)) throw new Error(`unknown tracker ${ticker}`);

  const outcome = await approvePending(ticker, { dryRun });
  console.log(JSON.stringify(outcome, null, 2));
}

async function cmdHoldings() {
  console.log(`cluster ${env.cluster}  program ${env.programId}\n`);

  for (const ticker of targets()) {
    const state = await readTrackerState(ticker);
    if (!state) {
      console.log(`${ticker.padEnd(8)} not deployed`);
      continue;
    }

    const settings = getSettings(ticker);
    console.log(
      `${ticker.padEnd(8)} ${sol(state.netLamports)} SOL net  ` +
        `supply ${sol(state.shareSupply)}  nav ${state.navPerShare.toFixed(6)}  ` +
        `rebalances ${state.account.rebalanceCount}  ` +
        `[${settings.mode}${settings.autoSwap ? "+swap" : ""}]` +
        `${state.account.paused ? "  PAUSED" : ""}`,
    );
    for (const leg of state.account.legs) {
      const holding = state.holdings.find((h) => h.mint === leg.mint);
      const held = holding ? `  held ${holding.amount}` : "";
      const tokenized = holding ? "" : "  (SOL sleeve)";
      console.log(`         ${leg.symbol.padEnd(8)} ${bps(leg.weightBps).padStart(7)}${held}${tokenized}`);
    }
  }
}

const COMMANDS: Record<string, () => Promise<void>> = {
  ingest: cmdIngest,
  plan: cmdPlan,
  publish: cmdPublish,
  holdings: cmdHoldings,
};

const run = COMMANDS[command ?? ""];
if (!run) {
  console.error(`usage: cli.ts <${Object.keys(COMMANDS).join("|")}> [ticker...] [--force] [--dry-run]`);
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (error) {
  console.error(`error: ${errText(error)}`);
  process.exit(1);
}
