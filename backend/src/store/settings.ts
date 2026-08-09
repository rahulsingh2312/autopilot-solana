/**
 * Per-tracker operating policy, editable from the admin panel.
 *
 * The important field is `mode`:
 *
 *   auto   — the worker publishes and (if enabled) swaps on its own, then
 *            reports what it did. The default.
 *   manual — a detected change becomes a pending plan and an alert, and waits
 *            for a human. Kept as a per-tracker brake, not as the norm.
 *
 * The whole point of the product is that holdings follow the filing without
 * anyone in the loop, so waiting on a click was the wrong default: it meant a
 * tracker was only as current as someone's attention. `AUTO_PUBLISH=false`
 * still flips the entire fleet back to manual in one place if that is ever
 * needed in a hurry.
 */

import { db } from "./db.ts";
import { TRACKER_BINDINGS } from "../trackers.ts";
import { env } from "../env.ts";

export type TrackerMode = "manual" | "auto";

export type TrackerSettings = {
  ticker: string;
  mode: TrackerMode;
  /** Below this summed absolute drift, a change is not worth a transaction. */
  minDriftBps: number;
  /** Whether auto mode may also move real assets, not just publish weights. */
  autoSwap: boolean;
  /** Hidden trackers stay on chain but disappear from the site. */
  hidden: boolean;
  updatedAt: string;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS tracker_settings (
    ticker        TEXT PRIMARY KEY,
    mode          TEXT NOT NULL DEFAULT 'manual',
    min_drift_bps INTEGER NOT NULL,
    auto_swap     INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
  );
`);

const upsert = db.prepare(`
  INSERT INTO tracker_settings (ticker, mode, min_drift_bps, auto_swap, hidden, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (ticker) DO UPDATE SET
    mode = excluded.mode,
    min_drift_bps = excluded.min_drift_bps,
    auto_swap = excluded.auto_swap,
    hidden = excluded.hidden,
    updated_at = excluded.updated_at
`);

const select = db.prepare(`SELECT * FROM tracker_settings WHERE ticker = ?`);
const selectAll = db.prepare(`SELECT * FROM tracker_settings`);

type Row = {
  ticker: string;
  mode: string;
  min_drift_bps: number;
  auto_swap: number;
  hidden: number;
  updated_at: string;
};

const toSettings = (row: Row): TrackerSettings => ({
  ticker: row.ticker,
  mode: row.mode === "auto" ? "auto" : "manual",
  minDriftBps: row.min_drift_bps,
  autoSwap: row.auto_swap === 1,
  hidden: row.hidden === 1,
  updatedAt: row.updated_at,
});

function defaults(ticker: string): TrackerSettings {
  const binding = TRACKER_BINDINGS.find((t) => t.ticker === ticker);
  return {
    ticker,
    // AUTO_PUBLISH is the fleet-wide kill switch; per-tracker mode refines it.
    mode: env.autoPublish ? "auto" : "manual",
    minDriftBps: binding?.minDriftBps ?? env.minDriftBps,
    autoSwap: env.autoSwap,
    hidden: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export function getSettings(ticker: string): TrackerSettings {
  const row = select.get(ticker) as Row | undefined;
  return row ? toSettings(row) : defaults(ticker);
}

export function allSettings(): TrackerSettings[] {
  const stored = new Map(
    (selectAll.all() as Row[]).map((row) => [row.ticker, toSettings(row)]),
  );
  return TRACKER_BINDINGS.map(
    (binding) => stored.get(binding.ticker) ?? defaults(binding.ticker),
  );
}

export function updateSettings(
  ticker: string,
  patch: Partial<Omit<TrackerSettings, "ticker" | "updatedAt">>,
): TrackerSettings {
  const current = getSettings(ticker);
  const next: TrackerSettings = {
    ...current,
    ...patch,
    ticker,
    updatedAt: new Date().toISOString(),
  };

  if (next.minDriftBps < 0 || next.minDriftBps > 10_000) {
    throw new Error("minDriftBps must be between 0 and 10000");
  }
  // Swapping without publishing would move assets to match weights the chain
  // has not been told about, leaving holdings and disclosure disagreeing.
  if (next.autoSwap && next.mode !== "auto") {
    throw new Error("autoSwap requires mode=auto");
  }

  upsert.run(
    next.ticker,
    next.mode,
    next.minDriftBps,
    next.autoSwap ? 1 : 0,
    next.hidden ? 1 : 0,
    next.updatedAt,
  );
  return next;
}
