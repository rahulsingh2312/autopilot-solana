/**
 * Persistence, on Node's built-in SQLite so the worker has no database to
 * provision and no connection pool to misconfigure.
 *
 * What is stored is an audit trail, not a cache: every filing we acted on,
 * every plan we built, and every transaction we sent. The product's claim is
 * "every move on chain, from a source you can check", and that claim is only
 * as good as the record behind it. Rows are append-only; nothing is updated in
 * place except a plan's status.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { env } from "../env.ts";
import type { Filing, RebalancePlan, TargetPortfolio } from "../types.ts";

mkdirSync(dirname(env.databasePath), { recursive: true });

export const db = new DatabaseSync(env.databasePath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS filings (
    id            TEXT PRIMARY KEY,
    tracker       TEXT NOT NULL,
    source_kind   TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    filed_at      TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    holdings_json TEXT NOT NULL,
    seen_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS filings_tracker_filed
    ON filings (tracker, filed_at DESC);

  CREATE TABLE IF NOT EXISTS portfolios (
    tracker     TEXT NOT NULL,
    filing_id   TEXT NOT NULL,
    legs_json   TEXT NOT NULL,
    excluded_json TEXT NOT NULL,
    built_at    TEXT NOT NULL,
    PRIMARY KEY (tracker, filing_id),
    FOREIGN KEY (filing_id) REFERENCES filings (id)
  );

  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker     TEXT NOT NULL,
    filing_id   TEXT NOT NULL,
    drift_bps   INTEGER NOT NULL,
    plan_json   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    built_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plans_tracker_built
    ON plans (tracker, built_at DESC);

  CREATE TABLE IF NOT EXISTS executions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL,
    tracker     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    signature   TEXT,
    detail      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES plans (id)
  );
  CREATE INDEX IF NOT EXISTS executions_tracker
    ON executions (tracker, created_at DESC);

  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

// ── filings ───────────────────────────────────────────────────────────

const insertFiling = db.prepare(`
  INSERT OR IGNORE INTO filings
    (id, tracker, source_kind, period_end, filed_at, source_url,
     content_hash, holdings_json, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Returns true when this observation was new. */
export function saveFiling(filing: Filing): boolean {
  const result = insertFiling.run(
    filing.id,
    filing.trackerTicker,
    filing.sourceKind,
    filing.periodEnd,
    filing.filedAt,
    filing.sourceUrl,
    filing.contentHash,
    JSON.stringify(filing.holdings),
    now(),
  );
  return result.changes > 0;
}

const selectLatestFiling = db.prepare(`
  SELECT * FROM filings WHERE tracker = ? ORDER BY filed_at DESC, seen_at DESC LIMIT 1
`);

type FilingRow = {
  id: string;
  tracker: string;
  source_kind: string;
  period_end: string;
  filed_at: string;
  source_url: string;
  content_hash: string;
  holdings_json: string;
};

const toFiling = (row: FilingRow): Filing => ({
  id: row.id,
  trackerTicker: row.tracker,
  sourceKind: row.source_kind as Filing["sourceKind"],
  periodEnd: row.period_end,
  filedAt: row.filed_at,
  sourceUrl: row.source_url,
  contentHash: row.content_hash,
  holdings: JSON.parse(row.holdings_json) as Filing["holdings"],
});

export function latestFiling(tracker: string): Filing | null {
  const row = selectLatestFiling.get(tracker) as FilingRow | undefined;
  return row ? toFiling(row) : null;
}

const selectFiling = db.prepare(`SELECT * FROM filings WHERE id = ?`);

export function getFiling(id: string): Filing | null {
  const row = selectFiling.get(id) as FilingRow | undefined;
  return row ? toFiling(row) : null;
}

const selectFilingHistory = db.prepare(`
  SELECT id, tracker, source_kind, period_end, filed_at, source_url, seen_at
  FROM filings WHERE tracker = ? ORDER BY filed_at DESC LIMIT ?
`);

export const filingHistory = (tracker: string, limit = 20) =>
  selectFilingHistory.all(tracker, limit);

// ── portfolios ────────────────────────────────────────────────────────

const insertPortfolio = db.prepare(`
  INSERT OR REPLACE INTO portfolios
    (tracker, filing_id, legs_json, excluded_json, built_at)
  VALUES (?, ?, ?, ?, ?)
`);

export function savePortfolio(portfolio: TargetPortfolio): void {
  insertPortfolio.run(
    portfolio.trackerTicker,
    portfolio.filingId,
    JSON.stringify(portfolio.legs),
    JSON.stringify(portfolio.excluded),
    portfolio.builtAt,
  );
}

const selectPortfolio = db.prepare(`
  SELECT * FROM portfolios WHERE tracker = ? ORDER BY built_at DESC LIMIT 1
`);

export function latestPortfolio(tracker: string): TargetPortfolio | null {
  const row = selectPortfolio.get(tracker) as
    | {
        tracker: string;
        filing_id: string;
        legs_json: string;
        excluded_json: string;
        built_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    trackerTicker: row.tracker,
    filingId: row.filing_id,
    legs: JSON.parse(row.legs_json) as TargetPortfolio["legs"],
    excluded: JSON.parse(row.excluded_json) as TargetPortfolio["excluded"],
    builtAt: row.built_at,
  };
}

// ── plans ─────────────────────────────────────────────────────────────

const insertPlan = db.prepare(`
  INSERT INTO plans (tracker, filing_id, drift_bps, plan_json, status, built_at)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);

export function savePlan(plan: RebalancePlan): number {
  const result = insertPlan.run(
    plan.trackerTicker,
    plan.filingId,
    plan.driftBps,
    JSON.stringify(plan),
    plan.builtAt,
  );
  return Number(result.lastInsertRowid);
}

const updatePlanStatus = db.prepare(`UPDATE plans SET status = ? WHERE id = ?`);

export const setPlanStatus = (
  id: number,
  status: "pending" | "published" | "executed" | "failed" | "skipped",
) => updatePlanStatus.run(status, id);

const selectPendingPlan = db.prepare(`
  SELECT id, plan_json FROM plans
  WHERE tracker = ? AND status = 'pending'
  ORDER BY built_at DESC LIMIT 1
`);

export function pendingPlan(
  tracker: string,
): { id: number; plan: RebalancePlan } | null {
  const row = selectPendingPlan.get(tracker) as
    | { id: number; plan_json: string }
    | undefined;
  return row
    ? { id: row.id, plan: JSON.parse(row.plan_json) as RebalancePlan }
    : null;
}

const selectPlans = db.prepare(`
  SELECT id, tracker, filing_id, drift_bps, status, built_at
  FROM plans WHERE tracker = ? ORDER BY built_at DESC LIMIT ?
`);

export const planHistory = (tracker: string, limit = 20) =>
  selectPlans.all(tracker, limit);

// ── executions ────────────────────────────────────────────────────────

const insertExecution = db.prepare(`
  INSERT INTO executions (plan_id, tracker, kind, signature, detail, error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function recordExecution(input: {
  planId: number;
  tracker: string;
  kind: "rebalance" | "swap" | "multiplier";
  signature?: string;
  detail?: unknown;
  error?: string;
}): void {
  insertExecution.run(
    input.planId,
    input.tracker,
    input.kind,
    input.signature ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    input.error ?? null,
    now(),
  );
}

const selectExecutions = db.prepare(`
  SELECT id, plan_id, tracker, kind, signature, detail, error, created_at
  FROM executions WHERE tracker = ? ORDER BY created_at DESC LIMIT ?
`);

export const executionHistory = (tracker: string, limit = 50) =>
  selectExecutions.all(tracker, limit);

// ── kv ────────────────────────────────────────────────────────────────

const upsertKv = db.prepare(`
  INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const selectKv = db.prepare(`SELECT value FROM kv WHERE key = ?`);

export const kvSet = (key: string, value: unknown) =>
  upsertKv.run(key, JSON.stringify(value), now());

export function kvGet<T>(key: string): T | null {
  const row = selectKv.get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}
