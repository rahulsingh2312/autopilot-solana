"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";

/**
 * The operations console.
 *
 * One screen, because the job is one question repeated seven times: has the
 * source moved, does the chain agree, and do I approve the difference. Every
 * mutation goes through the same worker endpoints the scheduler uses, so a
 * button here and a 4am automatic run take identical code paths — the panel
 * cannot drift from the automation it is supervising.
 */

type Leg = { mint: string; symbol: string; weightBps: number };
type TargetLeg = { ticker: string; weightBps: number; mint: string | null };

type Tracker = {
  ticker: string;
  name: string;
  sourceKind: "13f" | "congress" | "editorial";
  frozen: boolean;
  deployed: boolean;
  settings: {
    mode: "manual" | "auto";
    minDriftBps: number;
    autoSwap: boolean;
    hidden: boolean;
  };
  onChain: {
    legs: Leg[];
    paused: boolean;
    rebalanceCount: number;
    netLamports: string;
    shareSupply: string;
    navPerShare: number;
    tokenized: boolean;
    holdings: Array<{ symbol: string; mint: string; amount: string }>;
  } | null;
  latestFiling: {
    id: string;
    periodEnd: string;
    filedAt: string;
    sourceUrl: string;
    positions: number;
  } | null;
  pendingPlan: {
    id: number;
    driftBps: number;
    trades: number;
    blockers: string[];
    targetLegs: TargetLeg[];
    previousLegs: Leg[];
    builtAt: string;
  } | null;
};

const fetcher = async (url: string) => {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? response.status));
  return body;
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const sol = (lamports: string) => (Number(lamports) / 1e9).toFixed(4);

/** Strips Backed's lowercase `x` so NVDAx and NVDA compare as one position. */
const underlying = (symbol: string) =>
  (symbol.endsWith("x") ? symbol.slice(0, -1) : symbol).toUpperCase();

export function AdminConsole({ initialTracker }: { initialTracker?: string }) {
  const { data, error, isLoading, mutate } = useSWR<{ trackers: Tracker[]; cluster: string }>(
    "/api/admin/trackers",
    fetcher as never,
    { refreshInterval: 30_000, keepPreviousData: true },
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(initialTracker ?? null);

  /**
   * Every mutation funnels through here so the panel can never leave a button
   * spinning after a failure, and so the tracker list always re-reads from the
   * chain afterwards rather than trusting an optimistic guess about what a
   * transaction did.
   */
  const act = useCallback(
    async (key: string, path: string, init?: RequestInit) => {
      setBusy(key);
      setNotice(null);
      try {
        const response = await fetch(`/api/admin/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...init,
        });
        const body = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new Error(String(body.error ?? response.status));
        setNotice({ kind: "ok", text: describe(body) });
        await mutate();
      } catch (caught) {
        setNotice({
          kind: "err",
          text: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        setBusy(null);
      }
    },
    [mutate],
  );

  const trackers = data?.trackers ?? [];
  const needingApproval = useMemo(
    () => trackers.filter((t) => t.pendingPlan).length,
    [trackers],
  );

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div>
          <h1 className="display text-3xl text-ink">Operations</h1>
          <p className="meta">
            {data ? `${data.cluster} · ${trackers.length} trackers` : "connecting…"}
            {needingApproval > 0 ? ` · ${needingApproval} awaiting approval` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void act("cycle", "cycle", { body: JSON.stringify({ force: true }) })}
            disabled={busy !== null}
            className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink disabled:opacity-50"
          >
            {busy === "cycle" ? "Checking…" : "Check all sources"}
          </button>
          <form action="/admin/login" method="post">
            <input type="hidden" name="logout" value="1" />
            <button className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {notice ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "ok"
              ? "border-rule bg-paper text-muted"
              : "border-neg/30 bg-neg/5 text-neg"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-neg/30 bg-neg/5 px-3 py-2 text-sm text-neg">
          {String(error.message ?? error)}
        </p>
      ) : null}

      {isLoading && !data ? <p className="text-sm text-muted">Loading…</p> : null}

      <div className="flex flex-col gap-3">
        {trackers.map((tracker) => (
          <TrackerCard
            key={tracker.ticker}
            tracker={tracker}
            busy={busy}
            expanded={open === tracker.ticker}
            onToggle={() => setOpen(open === tracker.ticker ? null : tracker.ticker)}
            act={act}
          />
        ))}
      </div>
    </main>
  );
}

function TrackerCard({
  tracker,
  busy,
  expanded,
  onToggle,
  act,
}: {
  tracker: Tracker;
  busy: string | null;
  expanded: boolean;
  onToggle: () => void;
  act: (key: string, path: string, init?: RequestInit) => Promise<void>;
}) {
  const plan = tracker.pendingPlan;
  const disabled = busy !== null;

  return (
    <section className="rounded-lg border border-rule bg-paper">
      <button
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-3">
          <span className="font-mono text-sm text-ink">{tracker.ticker}</span>
          <span className="text-sm text-muted">{tracker.name}</span>
          {tracker.frozen ? <Tag tone="muted">frozen</Tag> : null}
          {!tracker.deployed ? <Tag tone="warn">not deployed</Tag> : null}
          {tracker.onChain?.paused ? <Tag tone="warn">paused</Tag> : null}
        </span>

        <span className="flex items-center gap-2">
          <Tag tone={tracker.settings.mode === "auto" ? "ok" : "muted"}>
            {tracker.settings.mode}
            {tracker.settings.autoSwap ? " + swap" : ""}
          </Tag>
          {plan ? <Tag tone="warn">drift {pct(plan.driftBps)}</Tag> : null}
          <span className="font-mono text-xs text-faint">
            {tracker.onChain ? `${sol(tracker.onChain.netLamports)} SOL` : "—"}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="flex flex-col gap-5 border-t border-rule px-4 py-4">
          {plan ? <PlanDiff plan={plan} /> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source">
              {tracker.latestFiling ? (
                <a
                  href={tracker.latestFiling.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-rule-strong underline-offset-2"
                >
                  {tracker.sourceKind} · period {tracker.latestFiling.periodEnd} ·{" "}
                  {tracker.latestFiling.positions} positions
                </a>
              ) : (
                <span className="text-faint">nothing ingested yet</span>
              )}
            </Field>

            <Field label="On chain">
              {tracker.onChain ? (
                <>
                  {tracker.onChain.rebalanceCount} rebalances · supply{" "}
                  {sol(tracker.onChain.shareSupply)} · NAV{" "}
                  {tracker.onChain.navPerShare.toFixed(6)}
                </>
              ) : (
                <span className="text-faint">—</span>
              )}
            </Field>
          </div>

          {tracker.onChain ? <CurrentBasket legs={tracker.onChain.legs} /> : null}

          {tracker.sourceKind === "editorial" ? (
            <EditorialEditor
              tracker={tracker}
              disabled={disabled}
              onSave={(positions, note) =>
                act(`basket-${tracker.ticker}`, `trackers/${tracker.ticker}/basket`, {
                  method: "PUT",
                  body: JSON.stringify({ positions, note, author: "admin panel" }),
                })
              }
            />
          ) : null}

          <Controls tracker={tracker} disabled={disabled} busy={busy} act={act} />
        </div>
      ) : null}
    </section>
  );
}

/** The change itself, which is the only thing an approval is really about. */
function PlanDiff({ plan }: { plan: NonNullable<Tracker["pendingPlan"]> }) {
  const before = new Map(plan.previousLegs.map((leg) => [underlying(leg.symbol), leg.weightBps]));
  const after = new Map(plan.targetLegs.map((leg) => [underlying(leg.ticker), leg.weightBps]));

  const rows = [...new Set([...before.keys(), ...after.keys()])]
    .map((symbol) => ({
      symbol,
      from: before.get(symbol) ?? 0,
      to: after.get(symbol) ?? 0,
    }))
    .filter((row) => row.from !== row.to)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule-strong bg-bg p-3">
      <p className="meta">
        Pending plan #{plan.id} · drift {pct(plan.driftBps)} ·{" "}
        {plan.trades > 0 ? `${plan.trades} swaps` : "weights only"}
      </p>

      <table className="w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbol} className="border-t border-rule/60">
              <td className="py-1 font-mono text-xs text-ink">{row.symbol}</td>
              <td className="py-1 text-right font-mono text-xs text-faint">
                {row.from === 0 ? "—" : pct(row.from)}
              </td>
              <td className="w-6 py-1 text-center text-faint">→</td>
              <td
                className={`py-1 text-right font-mono text-xs ${
                  row.to === 0 ? "text-neg" : row.to > row.from ? "text-pos" : "text-ink"
                }`}
              >
                {row.to === 0 ? "exit" : pct(row.to)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {plan.blockers.length > 0 ? (
        <ul className="flex flex-col gap-0.5 border-t border-rule pt-2">
          {plan.blockers.map((blocker) => (
            <li key={blocker} className="text-xs text-muted">
              · {blocker}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CurrentBasket({ legs }: { legs: Leg[] }) {
  return (
    <Field label="Published basket">
      <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
        {legs.map((leg) => (
          <span key={leg.symbol} className="text-muted">
            {leg.symbol} {pct(leg.weightBps)}
          </span>
        ))}
      </span>
    </Field>
  );
}

/**
 * Daily basket editing for editorial trackers.
 *
 * Weights are entered as relative numbers rather than basis points that must
 * sum to 10000. The worker normalizes with a largest-remainder allocation, so
 * "25 20 15 15 15 10" is a valid basket and the operator never has to make
 * the arithmetic come out exactly.
 */
function EditorialEditor({
  tracker,
  disabled,
  onSave,
}: {
  tracker: Tracker;
  disabled: boolean;
  onSave: (
    positions: Array<{ ticker: string; weight: number }>,
    note: string,
  ) => Promise<void>;
}) {
  const [text, setText] = useState(() =>
    (tracker.onChain?.legs ?? [])
      .map((leg) => `${underlying(leg.symbol)} ${(leg.weightBps / 100).toFixed(2)}`)
      .join("\n"),
  );
  const [note, setNote] = useState("");

  const parsed = useMemo(() => {
    const rows: Array<{ ticker: string; weight: number }> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ticker, weight] = trimmed.split(/[\s,]+/);
      const value = Number.parseFloat(weight ?? "");
      if (!ticker || !Number.isFinite(value) || value <= 0) return null;
      rows.push({ ticker: ticker.toUpperCase(), weight: value });
    }
    return rows.length > 0 ? rows : null;
  }, [text]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-bg p-3">
      <p className="meta">Edit basket — one position per line: TICKER WEIGHT</p>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={Math.max(4, text.split("\n").length)}
        spellCheck={false}
        className="rounded border border-rule bg-paper px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-rule-strong"
      />

      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Why this changed — required, becomes the audit trail"
        className="rounded border border-rule bg-paper px-2 py-1.5 text-xs text-ink outline-none focus:border-rule-strong"
      />

      <div className="flex items-center gap-2">
        <button
          disabled={disabled || !parsed || !note.trim()}
          onClick={() => parsed && void onSave(parsed, note)}
          className="rounded-md bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40"
        >
          Save and plan
        </button>
        <span className="text-xs text-faint">
          {parsed
            ? `${parsed.length} positions, normalized to 100%`
            : "each line needs a ticker and a positive weight"}
        </span>
      </div>
    </div>
  );
}

function Controls({
  tracker,
  disabled,
  busy,
  act,
}: {
  tracker: Tracker;
  disabled: boolean;
  busy: string | null;
  act: (key: string, path: string, init?: RequestInit) => Promise<void>;
}) {
  const t = tracker.ticker;
  const settings = tracker.settings;

  const patch = (body: Record<string, unknown>) =>
    act(`settings-${t}`, `trackers/${t}/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {tracker.pendingPlan ? (
          <>
            <button
              disabled={disabled}
              onClick={() => void act(`approve-${t}`, `trackers/${t}/approve`)}
              className="rounded-md bg-ink px-3 py-1.5 text-sm text-bg disabled:opacity-40"
            >
              {busy === `approve-${t}` ? "Publishing…" : "Approve and publish"}
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void act(`dry-${t}`, `trackers/${t}/approve`, {
                  body: JSON.stringify({ dryRun: true }),
                })
              }
              className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink disabled:opacity-40"
            >
              Simulate
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void act(`reject-${t}`, `trackers/${t}/reject`, {
                  body: JSON.stringify({ reason: "rejected in admin panel" }),
                })
              }
              className="rounded-md border border-rule px-3 py-1.5 text-sm text-muted disabled:opacity-40"
            >
              Reject
            </button>
          </>
        ) : (
          <button
            disabled={disabled}
            onClick={() =>
              void act(`ingest-${t}`, `trackers/${t}/ingest`, {
                body: JSON.stringify({ force: true }),
              })
            }
            className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink disabled:opacity-40"
          >
            {busy === `ingest-${t}` ? "Checking…" : "Re-check source"}
          </button>
        )}

        {tracker.deployed ? (
          <button
            disabled={disabled}
            onClick={() =>
              void act(`pause-${t}`, `trackers/${t}/pause`, {
                body: JSON.stringify({ paused: !tracker.onChain?.paused }),
              })
            }
            className="ml-auto rounded-md border border-rule px-3 py-1.5 text-sm text-muted disabled:opacity-40"
          >
            {tracker.onChain?.paused ? "Resume deposits" : "Pause deposits"}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={settings.mode === "auto"}
            disabled={disabled || tracker.frozen}
            onChange={(event) =>
              void patch({
                mode: event.target.checked ? "auto" : "manual",
                // Auto-swap cannot outlive auto mode; the worker rejects the
                // combination, so drop it here rather than surface that error.
                ...(event.target.checked ? {} : { autoSwap: false }),
              })
            }
          />
          Automatic — publish without asking
        </label>

        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={settings.autoSwap}
            disabled={disabled || settings.mode !== "auto"}
            onChange={(event) => void patch({ autoSwap: event.target.checked })}
          />
          …and execute swaps
        </label>

        <label className="flex items-center gap-2 text-muted">
          Alert above
          <input
            type="number"
            defaultValue={settings.minDriftBps}
            min={0}
            max={10000}
            disabled={disabled}
            onBlur={(event) => {
              const value = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(value) && value !== settings.minDriftBps) {
                void patch({ minDriftBps: value });
              }
            }}
            className="w-20 rounded border border-rule bg-paper px-2 py-1 font-mono text-xs text-ink"
          />
          bps drift
        </label>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="meta">{label}</span>
      <span className="text-sm text-muted">{children}</span>
    </div>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    ok: "border-pos/30 text-pos",
    warn: "border-neg/30 text-neg",
    muted: "border-rule text-faint",
  } as const;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[0.6875rem] ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Turns a worker response into one sentence an operator can act on. */
function describe(body: Record<string, unknown>): string {
  if (Array.isArray(body.outcomes)) {
    const outcomes = body.outcomes as Array<{ tracker: string; status: string }>;
    const interesting = outcomes.filter(
      (outcome) => !["unchanged", "frozen", "below-threshold"].includes(outcome.status),
    );
    return interesting.length === 0
      ? `Checked ${outcomes.length} trackers — nothing changed.`
      : interesting.map((o) => `${o.tracker}: ${o.status}`).join(" · ");
  }
  if (typeof body.status === "string") {
    const signature = typeof body.signature === "string" ? ` (${body.signature.slice(0, 12)}…)` : "";
    return `${String(body.tracker ?? "")}: ${body.status}${signature}`;
  }
  return "Done.";
}
