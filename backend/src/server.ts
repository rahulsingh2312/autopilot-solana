/**
 * The worker's HTTP surface.
 *
 * Two audiences, one server. Read routes are public and are what the site
 * renders — holdings, drift, the filing behind a basket, the transaction that
 * changed it. Write routes are the admin panel and require a bearer token.
 *
 * Plain `node:http` rather than a framework: the surface is a dozen routes,
 * and a dependency that has to be audited before it touches an authority key
 * is a poor trade for a router.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { env } from "./env.ts";
import { errText, log } from "./log.ts";
import {
  approvePending,
  rejectPending,
  runAllCycles,
  runCycle,
} from "./pipeline.ts";
import { readAllTrackerStates, readTrackerState } from "./chain/state.ts";
import { getSigner } from "./chain/rpc.ts";
import { setPaused } from "./execute/publish.ts";
import { setEditorialBasket, getEditorialBasket } from "./sources/editorial.ts";
import { TRACKER_BINDINGS, getBinding } from "./trackers.ts";
import {
  executionHistory,
  filingHistory,
  latestFiling,
  latestPortfolio,
  pendingPlan,
  planHistory,
} from "./store/db.ts";
import { allSettings, getSettings, updateSettings } from "./store/settings.ts";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; admin: boolean };

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, admin = false) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}/?$`,
  );
  routes.push({ method, pattern, keys, handler, admin });
}

/** JSON-safe: bigints appear all over the chain state and would throw. */
const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

function send(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload, replacer);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // The site and the admin panel both call this from a server runtime, but
    // a browser-side read of public data should not be blocked either.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A basket is a few hundred bytes; anything larger is not a basket.
    if (size > 256 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Constant-time bearer check.
 *
 * A worker with no ADMIN_TOKEN refuses every write rather than allowing them:
 * an unset secret must never be the same as an absent lock.
 */
function isAuthorized(request: IncomingMessage): boolean {
  if (!env.adminToken) return false;
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length !== env.adminToken.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ env.adminToken.charCodeAt(i);
  }
  return diff === 0;
}

// ── Read routes ───────────────────────────────────────────────────────

route("GET", "/health", async () => {
  const signer = await getSigner();
  return {
    ok: true,
    cluster: env.cluster,
    programId: env.programId,
    signer: signer?.address ?? null,
    readOnly: !signer,
    trackers: TRACKER_BINDINGS.length,
  };
});

/** Everything the admin panel's index needs, in one request. */
route("GET", "/api/trackers", async () => {
  const states = await readAllTrackerStates(TRACKER_BINDINGS.map((t) => t.ticker));
  const settings = new Map(allSettings().map((s) => [s.ticker, s]));

  return {
    cluster: env.cluster,
    trackers: TRACKER_BINDINGS.map((binding) => {
      const state = states.get(binding.ticker);
      const pending = pendingPlan(binding.ticker);
      const filing = latestFiling(binding.ticker);

      return {
        ticker: binding.ticker,
        name: binding.name,
        sourceKind: binding.sourceKind,
        frozen: binding.frozen,
        deployed: Boolean(state),
        settings: settings.get(binding.ticker) ?? getSettings(binding.ticker),
        onChain: state
          ? {
              legs: state.account.legs,
              paused: state.account.paused,
              rebalanceCount: state.account.rebalanceCount,
              lastRebalanceTs: Number(state.account.lastRebalanceTs),
              vaultLamports: state.vaultLamports.toString(),
              netLamports: state.netLamports.toString(),
              shareSupply: state.shareSupply.toString(),
              navPerShare: state.navPerShare,
              tokenized: state.tokenized,
              holdings: state.holdings.map((holding) => ({
                symbol: holding.symbol,
                mint: holding.mint,
                weightBps: holding.weightBps,
                amount: holding.amount.toString(),
              })),
            }
          : null,
        latestFiling: filing
          ? {
              id: filing.id,
              periodEnd: filing.periodEnd,
              filedAt: filing.filedAt,
              sourceUrl: filing.sourceUrl,
              positions: filing.holdings.length,
            }
          : null,
        pendingPlan: pending
          ? {
              id: pending.id,
              driftBps: pending.plan.driftBps,
              trades: pending.plan.trades.length,
              blockers: pending.plan.blockers,
              targetLegs: pending.plan.targetLegs,
              previousLegs: pending.plan.previousLegs,
              builtAt: pending.plan.builtAt,
            }
          : null,
      };
    }),
  };
});

route("GET", "/api/trackers/:ticker", async (_request, _response, params) => {
  const binding = getBinding(params.ticker!);
  if (!binding) throw Object.assign(new Error("unknown tracker"), { status: 404 });

  const state = await readTrackerState(binding.ticker);
  const pending = pendingPlan(binding.ticker);

  return {
    ticker: binding.ticker,
    name: binding.name,
    binding,
    settings: getSettings(binding.ticker),
    onChain: state,
    latestFiling: latestFiling(binding.ticker),
    portfolio: latestPortfolio(binding.ticker),
    editorialBasket:
      binding.sourceKind === "editorial" ? getEditorialBasket(binding.ticker) : null,
    pendingPlan: pending,
  };
});

route("GET", "/api/trackers/:ticker/history", async (_request, _response, params) => {
  const ticker = params.ticker!;
  return {
    filings: filingHistory(ticker),
    plans: planHistory(ticker),
    executions: executionHistory(ticker),
  };
});

// ── Admin routes ──────────────────────────────────────────────────────

route(
  "POST",
  "/api/trackers/:ticker/ingest",
  async (_request, _response, params, body) => {
    const input = (body ?? {}) as { force?: boolean; dryRun?: boolean };
    return await runCycle(params.ticker!, {
      force: input.force ?? true,
      dryRun: input.dryRun,
    });
  },
  true,
);

route(
  "POST",
  "/api/trackers/:ticker/approve",
  async (_request, _response, params, body) => {
    const input = (body ?? {}) as { dryRun?: boolean };
    return await approvePending(params.ticker!, { dryRun: input.dryRun });
  },
  true,
);

route(
  "POST",
  "/api/trackers/:ticker/reject",
  async (_request, _response, params, body) => {
    const input = (body ?? {}) as { reason?: string };
    const rejected = rejectPending(params.ticker!, input.reason ?? "rejected in admin panel");
    if (!rejected) throw Object.assign(new Error("no pending plan"), { status: 404 });
    return { ok: true };
  },
  true,
);

route(
  "PATCH",
  "/api/trackers/:ticker/settings",
  async (_request, _response, params, body) => {
    const input = (body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateSettings>[1] = {};
    if (input.mode === "auto" || input.mode === "manual") patch.mode = input.mode;
    if (typeof input.minDriftBps === "number") patch.minDriftBps = input.minDriftBps;
    if (typeof input.autoSwap === "boolean") patch.autoSwap = input.autoSwap;
    if (typeof input.hidden === "boolean") patch.hidden = input.hidden;
    return updateSettings(params.ticker!, patch);
  },
  true,
);

/** The daily edit for editorial trackers, e.g. icSOL. */
route(
  "PUT",
  "/api/trackers/:ticker/basket",
  async (_request, _response, params, body) => {
    const binding = getBinding(params.ticker!);
    if (!binding) throw Object.assign(new Error("unknown tracker"), { status: 404 });
    if (binding.sourceKind !== "editorial") {
      throw Object.assign(
        new Error(
          `${binding.ticker} is driven by ${binding.sourceKind}; editing its basket by hand would overwrite what the filing says`,
        ),
        { status: 400 },
      );
    }

    const input = (body ?? {}) as {
      positions?: Array<{ ticker: string; company?: string; weight: number }>;
      note?: string;
      author?: string;
    };
    if (!Array.isArray(input.positions)) {
      throw Object.assign(new Error("positions[] required"), { status: 400 });
    }

    const basket = setEditorialBasket(binding.ticker, {
      positions: input.positions,
      note: input.note ?? "",
      author: input.author ?? "admin",
    });

    // Plan immediately so the panel can show the diff the edit produced.
    const outcome = await runCycle(binding.ticker, { force: true });
    return { basket, outcome };
  },
  true,
);

route(
  "POST",
  "/api/trackers/:ticker/pause",
  async (_request, _response, params, body) => {
    const input = (body ?? {}) as { paused?: boolean };
    const state = await readTrackerState(params.ticker!);
    if (!state) throw Object.assign(new Error("tracker not deployed"), { status: 404 });
    const result = await setPaused(state, input.paused ?? true);
    return { ok: true, signature: result.signature };
  },
  true,
);

route(
  "POST",
  "/api/cycle",
  async (_request, _response, _params, body) => {
    const input = (body ?? {}) as { force?: boolean };
    return { outcomes: await runAllCycles({ force: input.force }) };
  },
  true,
);

// ── Server ────────────────────────────────────────────────────────────

export function startServer(): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  server.listen(env.port, () => {
    log.info("http listening", {
      port: env.port,
      cluster: env.cluster,
      adminAuth: env.adminToken ? "enabled" : "DISABLED (writes refused)",
    });
  });

  return server;
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://localhost:${env.port}`);

  if (method === "OPTIONS") return send(response, 204, {});

  const match = routes
    .map((candidate) => ({
      candidate,
      result: candidate.method === method ? candidate.pattern.exec(url.pathname) : null,
    }))
    .find((entry) => entry.result);

  if (!match?.result) return send(response, 404, { error: "not found" });

  const { candidate, result } = match;
  if (candidate.admin && !isAuthorized(request)) {
    return send(response, 401, {
      error: env.adminToken
        ? "invalid admin token"
        : "ADMIN_TOKEN is not set on this worker, so writes are refused",
    });
  }

  const params: Record<string, string> = {};
  candidate.keys.forEach((key, index) => {
    params[key] = decodeURIComponent(result[index + 1] ?? "");
  });

  try {
    const body = method === "GET" ? undefined : await readBody(request);
    const payload = await candidate.handler(request, response, params, body);
    if (!response.writableEnded) send(response, 200, payload);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    const message = errText(error);
    if (status >= 500) {
      log.error("request failed", { path: url.pathname, method, error: message });
    }
    send(response, status, { error: message });
  }
}
