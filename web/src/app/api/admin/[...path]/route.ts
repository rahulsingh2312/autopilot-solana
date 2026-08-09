import { NextResponse } from "next/server";

/**
 * Server-side proxy to the tracking worker.
 *
 * The worker's write routes are guarded by a bearer token that can publish
 * baskets and move a vault's assets. That token must never reach a browser, so
 * the admin panel calls this route instead and the secret is attached here, on
 * the server, where it is already required to be.
 *
 * The panel itself is gated by `ADMIN_PANEL_PASSWORD`: the cookie proves a
 * human got past the login, this route turns that into worker authority.
 * Splitting them means leaking the panel's password does not leak the key that
 * signs transactions.
 */

import { cookies } from "next/headers";

import { ADMIN_SESSION_COOKIE, verifySession } from "@/lib/admin/session";

const WORKER_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";
const WORKER_TOKEN = process.env.BACKEND_ADMIN_TOKEN ?? "";

/** Nothing here may be cached: it is live chain state and mutations. */
export const dynamic = "force-dynamic";

async function proxy(request: Request, path: string[]): Promise<Response> {
  const session = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!(await verifySession(session))) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  if (!WORKER_TOKEN) {
    return NextResponse.json(
      { error: "BACKEND_ADMIN_TOKEN is not configured on the web app" },
      { status: 500 },
    );
  }

  const target = new URL(`/api/${path.join("/")}`, WORKER_URL);
  target.search = new URL(request.url).search;

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.text();

  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${WORKER_TOKEN}`,
        "content-type": "application/json",
      },
      body,
      cache: "no-store",
      // Publishing a basket and confirming it can take a while on a busy
      // cluster; the default would abort a transaction that is still landing.
      signal: AbortSignal.timeout(120_000),
    });

    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // A worker that is down is an operational fact the panel should render,
    // not a 500 page with no explanation.
    return NextResponse.json(
      {
        error: `worker unreachable at ${WORKER_URL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 502 },
    );
  }
}

export const GET = (request: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  ctx.params.then(({ path }) => proxy(request, path));
export const POST = (request: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  ctx.params.then(({ path }) => proxy(request, path));
export const PATCH = (request: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  ctx.params.then(({ path }) => proxy(request, path));
export const PUT = (request: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  ctx.params.then(({ path }) => proxy(request, path));
