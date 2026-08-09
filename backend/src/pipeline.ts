/**
 * One tracker, end to end: read the source, decide, and act within policy.
 *
 * The cycle is the same whether it was triggered by the scheduler at 4am or by
 * a button in the admin panel, and whether the tracker is in manual or auto
 * mode. Only the last step differs: manual leaves a pending plan and asks a
 * human, auto sends it. Everything before that — fetch, build, diff, threshold
 * — is shared, so the approval a human gives is an approval of exactly what
 * automation would have done.
 */

import { errText, log } from "./log.ts";
import { alert, formatDelta } from "./notify.ts";
import { adapterFor } from "./sources/index.ts";
import { getBinding } from "./trackers.ts";
import {
  getFiling,
  latestFiling,
  latestPortfolio,
  pendingPlan,
  recordExecution,
  savePlan,
  savePortfolio,
  saveFiling,
  setPlanStatus,
} from "./store/db.ts";
import { getSettings } from "./store/settings.ts";
import { readTrackerState } from "./chain/state.ts";
import { buildPlan, toEncodableLegs, underlyingSymbol } from "./plan/diff.ts";
import { buildTargetPortfolio } from "./plan/portfolio.ts";
import { executeSwaps, publishWeights } from "./execute/publish.ts";
import { env } from "./env.ts";
import type { RebalancePlan, TrackerBinding } from "./types.ts";

export type CycleOutcome = {
  tracker: string;
  status:
    | "no-source-data"
    | "frozen"
    | "not-deployed"
    | "unchanged"
    | "below-threshold"
    | "awaiting-approval"
    | "published"
    | "executed"
    | "failed";
  driftBps?: number;
  planId?: number;
  signature?: string;
  detail?: string;
};

/**
 * Runs one full cycle for a tracker.
 *
 * `force` re-plans even when the source has published nothing new, which is
 * what the admin panel's "re-check" button needs: the on-chain basket can
 * drift from an unchanged filing if a previous publish half-failed.
 */
export async function runCycle(
  ticker: string,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<CycleOutcome> {
  const binding = getBinding(ticker);
  if (!binding) return { tracker: ticker, status: "failed", detail: "unknown tracker" };

  try {
    return await runCycleInner(binding, options);
  } catch (error) {
    const detail = errText(error);
    log.error("cycle failed", { tracker: ticker, error: detail });
    await alert({
      level: "error",
      title: "Rebalance cycle failed",
      tracker: ticker,
      lines: [detail],
      linkToAdmin: true,
    });
    return { tracker: ticker, status: "failed", detail };
  }
}

async function runCycleInner(
  binding: TrackerBinding,
  options: { force?: boolean; dryRun?: boolean },
): Promise<CycleOutcome> {
  const ticker = binding.ticker;
  const settings = getSettings(ticker);

  // 1. Source.
  const previous = latestFiling(ticker);
  const filing = await adapterFor(binding.sourceKind).fetchLatest(binding);
  if (!filing) {
    return { tracker: ticker, status: "no-source-data" };
  }

  const isNew = saveFiling(filing);
  const changed = previous?.contentHash !== filing.contentHash;

  if (isNew && changed && previous) {
    await alert({
      level: "info",
      title: "New filing detected",
      tracker: ticker,
      lines: [
        `${filing.sourceKind.toUpperCase()} period ${filing.periodEnd}, filed ${filing.filedAt}`,
        `${filing.holdings.length} disclosed positions`,
        filing.sourceUrl,
      ],
    });
  }

  // A frozen tracker is still ingested so the record stays complete, but its
  // basket is never touched: its filer has stopped reporting, so there is
  // nothing to rebalance against.
  if (binding.frozen) {
    return { tracker: ticker, status: "frozen" };
  }

  // An unchanged source is NOT a reason to stop.
  //
  // The chain is the thing that has to be right, and it can disagree with an
  // unchanged filing — a publish that half-failed, a transaction that never
  // landed, a basket written from a partial read. Returning early here meant
  // any bad publish became permanent the moment the filer went quiet, because
  // the drift check below never ran again. The threshold is what suppresses
  // noise; skipping the comparison entirely just hid the disagreement.
  if (!changed && !options.force) {
    log.debug("source unchanged, still checking chain drift", { tracker: ticker });
  }

  // 2. Target basket.
  const portfolio = await buildTargetPortfolio(filing, binding);
  savePortfolio(portfolio);

  // 3. Chain state and diff.
  const state = await readTrackerState(ticker);
  if (!state) {
    return { tracker: ticker, status: "not-deployed" };
  }

  const plan = await buildPlan(portfolio, state);

  if (plan.driftBps < settings.minDriftBps) {
    log.info("drift below threshold", {
      tracker: ticker,
      driftBps: plan.driftBps,
      threshold: settings.minDriftBps,
    });
    return { tracker: ticker, status: "below-threshold", driftBps: plan.driftBps };
  }

  const planId = savePlan(plan);

  // 4. Act, within policy.
  if (settings.mode === "manual") {
    await alert({
      level: "action",
      title: "Rebalance needs approval",
      tracker: ticker,
      lines: [
        `Drift ${formatDelta(plan.driftBps)} against the published basket`,
        ...describeChanges(plan),
        plan.trades.length > 0
          ? `${plan.trades.length} swaps planned`
          : "Weights only, no swaps",
        ...(plan.blockers.length > 0 ? [`Blocked: ${plan.blockers.join("; ")}`] : []),
      ],
      linkToAdmin: true,
    });
    return {
      tracker: ticker,
      status: "awaiting-approval",
      driftBps: plan.driftBps,
      planId,
    };
  }

  return await applyPlan({ planId, plan, dryRun: options.dryRun });
}

/**
 * Publishes a plan, and swaps if policy allows it.
 *
 * Shared by auto mode and by the admin panel's approve button, so an approved
 * plan takes exactly the path an automatic one would.
 */
export async function applyPlan(input: {
  planId: number;
  plan: RebalancePlan;
  dryRun?: boolean;
}): Promise<CycleOutcome> {
  const { plan, planId } = input;
  const ticker = plan.trackerTicker;
  const settings = getSettings(ticker);

  const state = await readTrackerState(ticker);
  if (!state) {
    setPlanStatus(planId, "failed");
    return { tracker: ticker, status: "not-deployed" };
  }

  const portfolio = latestPortfolio(ticker);
  if (!portfolio || portfolio.filingId !== plan.filingId) {
    setPlanStatus(planId, "skipped");
    return {
      tracker: ticker,
      status: "failed",
      detail: "plan is stale: a newer filing has superseded it",
    };
  }

  // 1. Publish weights.
  const published = await publishWeights({
    planId,
    plan,
    state,
    legs: toEncodableLegs(portfolio),
    dryRun: input.dryRun,
  });
  setPlanStatus(planId, "published");

  // 2. Swap, when the tracker is allowed to and nothing blocks it.
  const canSwap =
    settings.autoSwap && plan.trades.length > 0 && plan.blockers.length === 0;

  if (!canSwap) {
    await alert({
      level: "info",
      title: input.dryRun ? "Weights published (dry run)" : "Weights published",
      tracker: ticker,
      lines: [
        `Drift ${formatDelta(plan.driftBps)}`,
        ...describeChanges(plan),
        published.signature ? `tx ${published.signature}` : "simulated only",
        ...(plan.blockers.length > 0
          ? [`Holdings unchanged — ${plan.blockers.join("; ")}`]
          : plan.trades.length > 0
            ? ["Holdings unchanged — autoSwap is off for this tracker"]
            : []),
      ],
    });
    return {
      tracker: ticker,
      status: "published",
      driftBps: plan.driftBps,
      planId,
      signature: published.signature ?? undefined,
    };
  }

  const outcomes = await executeSwaps({ planId, plan, state, dryRun: input.dryRun });
  const failed = outcomes.filter((outcome) => outcome.error);
  setPlanStatus(planId, failed.length > 0 ? "failed" : "executed");

  await alert({
    level: failed.length > 0 ? "error" : "info",
    title:
      failed.length > 0
        ? "Rebalance partially executed"
        : input.dryRun
          ? "Rebalance simulated"
          : "Rebalance executed",
    tracker: ticker,
    lines: [
      `Drift ${formatDelta(plan.driftBps)}`,
      ...outcomes.map(
        (outcome) =>
          `${outcome.trade.side} ${outcome.trade.ticker} — ${
            outcome.error ?? outcome.signature ?? "simulated"
          }`,
      ),
    ],
    linkToAdmin: failed.length > 0,
  });

  return {
    tracker: ticker,
    status: failed.length > 0 ? "failed" : "executed",
    driftBps: plan.driftBps,
    planId,
    signature: published.signature ?? undefined,
  };
}

/** Approves whatever is pending for a tracker. Used by the admin panel. */
export async function approvePending(
  ticker: string,
  options: { dryRun?: boolean } = {},
): Promise<CycleOutcome> {
  const pending = pendingPlan(ticker);
  if (!pending) {
    return { tracker: ticker, status: "failed", detail: "no pending plan" };
  }
  return await applyPlan({
    planId: pending.id,
    plan: pending.plan,
    dryRun: options.dryRun,
  });
}

export function rejectPending(ticker: string, reason: string): boolean {
  const pending = pendingPlan(ticker);
  if (!pending) return false;
  setPlanStatus(pending.id, "skipped");
  recordExecution({
    planId: pending.id,
    tracker: ticker,
    kind: "rebalance",
    detail: { rejected: true, reason },
  });
  return true;
}

/** The three or four lines a human needs to judge a plan at a glance. */
export function describeChanges(plan: RebalancePlan): string[] {
  // Compared on the underlying, so NVDAx and NVDA are one position.
  const before = new Map(
    plan.previousLegs.map((leg) => [underlyingSymbol(leg.symbol), leg.weightBps]),
  );
  const after = new Map(
    plan.targetLegs.map((leg) => [underlyingSymbol(leg.ticker), leg.weightBps]),
  );

  const rows: Array<{ symbol: string; delta: number; text: string }> = [];
  for (const symbol of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(symbol) ?? 0;
    const to = after.get(symbol) ?? 0;
    if (from === to) continue;
    rows.push({
      symbol,
      delta: Math.abs(to - from),
      text:
        from === 0
          ? `+ ${symbol} ${(to / 100).toFixed(2)}% (new)`
          : to === 0
            ? `− ${symbol} was ${(from / 100).toFixed(2)}% (exited)`
            : `  ${symbol} ${(from / 100).toFixed(2)}% → ${(to / 100).toFixed(2)}%`,
    });
  }

  rows.sort((a, b) => b.delta - a.delta);
  const shown = rows.slice(0, 6).map((row) => row.text);
  if (rows.length > shown.length) {
    shown.push(`  …and ${rows.length - shown.length} more`);
  }
  return shown;
}

/** Runs every non-frozen tracker. The scheduler's unit of work. */
export async function runAllCycles(options: { force?: boolean } = {}): Promise<CycleOutcome[]> {
  const { activeBindings } = await import("./trackers.ts");
  const outcomes: CycleOutcome[] = [];

  // Sequential on purpose: SEC throttling, OpenFIGI's per-minute ceiling, and
  // Jupiter quotes all share this process, and seven trackers in parallel is
  // how a worker earns an IP ban.
  for (const binding of activeBindings()) {
    outcomes.push(await runCycle(binding.ticker, options));
  }

  log.info("cycle sweep complete", {
    cluster: env.cluster,
    ...Object.fromEntries(
      Object.entries(
        outcomes.reduce<Record<string, number>>((counts, outcome) => {
          counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
          return counts;
        }, {}),
      ),
    ),
  });

  return outcomes;
}

export { getFiling };
