/**
 * Outbound HTTP with the manners each upstream demands.
 *
 * SEC publishes an access policy rather than an API key: a descriptive
 * User-Agent carrying a contact address, and no more than ~10 requests a
 * second. Ignoring either gets the worker's IP blocked, so the rate limiter
 * lives here where it cannot be forgotten at a call site.
 */

import { env } from "../env.ts";
import { errText, log } from "../log.ts";

/**
 * Serialises requests per host with a minimum gap between them.
 *
 * Written without parameter properties or class fields beyond a plain private
 * field: this worker runs under Node's strip-only TypeScript mode, which has
 * no transform step and rejects any syntax that would need one.
 */
class HostThrottle {
  #next = new Map<string, Promise<void>>();
  #minGapMs: number;

  constructor(minGapMs: number) {
    this.#minGapMs = minGapMs;
  }

  run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#next.get(host) ?? Promise.resolve();
    const gated = previous.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, this.#minGapMs)),
    );
    this.#next.set(host, gated);
    return gated.then(task);
  }
}

/** 8 requests/second, comfortably inside SEC's published ceiling of 10. */
const throttle = new HostThrottle(125);

export type FetchOptions = {
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries on 429/5xx/network error, with exponential backoff. */
  retries?: number;
};

async function request(url: string, options: FetchOptions): Promise<Response> {
  const { hostname } = new URL(url);
  const headers: Record<string, string> = {
    accept: "application/json, text/xml;q=0.9, */*;q=0.8",
    "accept-encoding": "gzip, deflate",
    ...options.headers,
  };

  // Every sec.gov host, including data.sec.gov and www.sec.gov.
  if (hostname.endsWith("sec.gov")) headers["user-agent"] = env.secUserAgent;

  const retries = options.retries ?? 3;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    try {
      const response = await throttle.run(hostname, () =>
        fetch(url, {
          headers,
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        }),
      );
      // 4xx other than 429 will not become successful by asking again.
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
      log.debug("upstream retryable", { url, status: response.status, attempt });
    } catch (error) {
      lastError = error;
      log.debug("upstream error", { url, attempt, error: errText(error) });
    }
  }

  throw new Error(`${url} failed after ${retries + 1} attempts: ${errText(lastError)}`);
}

export async function getJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await request(url, options);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

export async function getText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await request(url, options);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return await response.text();
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options: FetchOptions = {},
): Promise<T> {
  const { hostname } = new URL(url);
  const response = await throttle.run(hostname, () =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    }),
  );
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}
