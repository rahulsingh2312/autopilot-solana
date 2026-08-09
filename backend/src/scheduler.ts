/**
 * The clock.
 *
 * Two loops, both self-rescheduling rather than on a fixed interval, so a slow
 * cycle can never overlap the next one. Overlapping cycles would plan against
 * chain state that a still-running cycle is in the middle of changing, which is
 * how a tracker rebalances twice for one filing.
 */

import { env } from "./env.ts";
import { errText, log } from "./log.ts";
import { alert } from "./notify.ts";
import { runAllCycles } from "./pipeline.ts";
import { loadDirectory } from "./mapping/xstocks.ts";

type Loop = { stop: () => void };

function everyN(seconds: number, name: string, task: () => Promise<void>): Loop {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    const started = Date.now();
    try {
      await task();
    } catch (error) {
      log.error("scheduled task threw", { task: name, error: errText(error) });
    } finally {
      if (!stopped) {
        const elapsed = Date.now() - started;
        // Wait the full interval *after* finishing, never from the start.
        timer = setTimeout(() => void tick(), Math.max(1_000, seconds * 1_000));
        log.debug("task rescheduled", { task: name, elapsedMs: elapsed });
      }
    }
  };

  timer = setTimeout(() => void tick(), 1_000);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startScheduler(): Loop[] {
  log.info("scheduler starting", {
    ingestIntervalSec: env.ingestIntervalSec,
    cluster: env.cluster,
    autoPublishDefault: env.autoPublish,
  });

  const loops: Loop[] = [];

  // The full pipeline. Each tracker's own mode decides whether the result is
  // an alert or a transaction.
  loops.push(
    everyN(env.ingestIntervalSec, "cycle", async () => {
      await runAllCycles();
    }),
  );

  // The tokenized universe, refreshed daily. Held separately so a Backed
  // outage shows up as its own alert rather than as seven tracker failures.
  loops.push(
    everyN(6 * 60 * 60, "xstocks-directory", async () => {
      if (env.cluster !== "mainnet-beta") return;
      try {
        await loadDirectory(true);
      } catch (error) {
        await alert({
          level: "error",
          title: "xStocks directory refresh failed",
          lines: [
            errText(error),
            "Serving the last good crawl; mint resolution may be stale.",
          ],
        });
      }
    }),
  );

  return loops;
}
