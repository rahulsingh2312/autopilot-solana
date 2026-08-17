"use client";

import { useState } from "react";

import type { TrackerConfig } from "@/lib/config";
import { formatWeight } from "@/lib/format";
import { formatReturn, useTrackerReturns } from "@/lib/returns";

/**
 * What the basket would have done, with the index beside it.
 *
 * Deliberately not called "performance" anywhere a reader can see. These
 * vaults are days old; there is no track record to show, and a number that
 * looks like one would be the single most misleading thing on the page. The
 * heading says backtest, the basis line says backtest, and the number never
 * appears without both.
 */
export function Performance({ tracker }: { tracker: TrackerConfig }) {
  const [open, setOpen] = useState(false);
  const {
    windows,
    oneYear,
    threeYear,
    coverageBps,
    benchmark,
    basis,
    isLoading,
    error,
  } = useTrackerReturns(tracker);

  // Nothing priced means nothing to say. A basket with no tokenized leg —
  // A basket whose names have no xStock between them lands here, and
  // an empty block is the honest render of it.
  if (error || (!isLoading && threeYear === null && oneYear === null)) return null;

  const benchWindow = (label: string) =>
    benchmark?.windows.find((w) => w.label === label)?.value ?? null;

  /**
   * The headline is the three-year number, annualised.
   *
   * It is a longer window than a single year and therefore says more about a
   * basket than the last twelve months do. It is **not** comparable with the
   * 1Y figure below it, which is a total rather than a rate, so the label has
   * to carry "a yr" and the benchmark beside it has to be the 3Y benchmark —
   * comparing an annualised basket against a one-year index would flatter or
   * damn it by the difference in horizon alone.
   */
  const headline = threeYear;
  const headlineBench = benchWindow("3Y");
  const headlineExcess =
    headline !== null && headlineBench !== null ? headline - headlineBench : null;

  return (
    <div className="glass-inset flex flex-col gap-2.5 p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="meta">Backtested return</span>
        {coverageBps < 10_000 ? (
          <span className="num text-[0.625rem] text-faint">
            covers {formatWeight(coverageBps)} of the basket
          </span>
        ) : null}
      </div>

      {isLoading && headline === null ? (
        <p className="text-[0.8125rem] text-faint">Reading price history…</p>
      ) : (
        <>
          {/* The headline pair: the basket's trailing year, and by how much
              it cleared the index. One without the other is a half-truth in
              a year when the index itself did +23%. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={`num text-2xl font-semibold tabular-nums ${
                (headline ?? 0) >= 0 ? "text-pos" : "text-neg"
              }`}
            >
              {headline !== null ? formatReturn(headline) : "—"}
            </span>
            <span className="num text-[0.6875rem] uppercase tracking-wider text-faint">
              3Y a yr
            </span>
            {headlineBench !== null && headlineExcess !== null ? (
              <span className="text-[0.8125rem] text-muted">
                S&amp;P {formatReturn(headlineBench)} ·{" "}
                <span className={headlineExcess >= 0 ? "text-pos" : "text-neg"}>
                  {headlineExcess >= 0 ? "beat by" : "behind by"}{" "}
                  {formatReturn(Math.abs(headlineExcess)).replace(/^[+−]/, "")}
                </span>
              </span>
            ) : null}
          </div>

          {/* 3Y and 5Y are annualized, YTD and 1Y are not. Mixing the two
              without saying so is how a 5-year 200% becomes a claim of 200%
              a year, so the annualized ones carry the label. */}
          <dl className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-rule bg-rule">
            {windows.map((w) => {
              const bench = benchWindow(w.label);
              return (
                <div key={w.label} className="flex flex-col gap-0.5 bg-bg px-2 py-1.5">
                  <dt className="num text-[0.625rem] uppercase tracking-wider text-faint">
                    {w.label}
                    {w.annualized ? (
                      <span className="normal-case tracking-normal"> a yr</span>
                    ) : null}
                  </dt>
                  <dd
                    className={`num text-[0.8125rem] font-semibold tabular-nums ${
                      w.value === null
                        ? "text-faint"
                        : w.value >= 0
                          ? "text-pos"
                          : "text-neg"
                    }`}
                  >
                    {w.value !== null ? formatReturn(w.value) : "—"}
                  </dd>
                  <dd className="num text-[0.625rem] tabular-nums text-faint">
                    {bench !== null ? `SPY ${formatReturn(bench)}` : " "}
                  </dd>
                </div>
              );
            })}
          </dl>

          <button
            onClick={() => setOpen((v) => !v)}
            className="num self-start text-[0.625rem] uppercase tracking-wider text-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-ink"
          >
            {open ? "Hide how this is measured" : "How this is measured"}
          </button>
          {open ? (
            <p className="text-[0.6875rem] leading-relaxed text-faint">
              {basis}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
