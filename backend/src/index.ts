/**
 * Worker entry point: HTTP surface plus the scheduler, in one process.
 *
 * They share a process deliberately. The admin panel's "approve" button and
 * the 4am automatic run must go through the same code and the same SQLite
 * file, and splitting them would mean two deployments that can disagree about
 * whether a plan is still pending.
 */

import { env } from "./env.ts";
import { log } from "./log.ts";
import { alert } from "./notify.ts";
import { startScheduler } from "./scheduler.ts";
import { startServer } from "./server.ts";
import { getSigner } from "./chain/rpc.ts";

const signer = await getSigner();

log.info("autopilot worker starting", {
  cluster: env.cluster,
  rpc: env.rpcUrl,
  programId: env.programId,
  signer: signer?.address ?? "none (read-only)",
  database: env.databasePath,
});

if (!signer) {
  log.warn("no signer configured: the worker will plan and serve, but never send");
}
if (!env.adminToken) {
  log.warn("ADMIN_TOKEN unset: every write route will refuse");
}
if (env.congressProvider === "none") {
  log.warn("congress source disabled: pltSOL and cgSOL will not ingest");
}

const server = startServer();
const loops = startScheduler();

/**
 * Shut down cleanly so a cycle mid-transaction is never killed between sending
 * and recording. The in-flight cycle finishes; nothing new starts.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info("shutting down", { signal });
    for (const loop of loops) loop.stop();
    server.close(() => process.exit(0));
    // A hung connection must not hold the process open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
  void alert({
    level: "error",
    title: "Worker unhandled rejection",
    lines: [String(reason)],
  });
});
