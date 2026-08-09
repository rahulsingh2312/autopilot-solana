/**
 * Operator alerting, over the Telegram bot the waitlist already uses.
 *
 * The worker's whole job happens while nobody is looking, so the alerting
 * contract is: a human hears about anything that changed money, anything that
 * needs a decision, and anything that broke. Routine "nothing to do" cycles
 * stay silent, because an alert channel that cries every 15 minutes is one
 * nobody reads on the day it matters.
 *
 * A missing bot token is not an error. It degrades to logging, so the worker
 * runs unattended on a box that was never given credentials.
 */

import { errText, log } from "./log.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() ?? null;
const ADMIN_URL = process.env.ADMIN_URL?.trim() ?? null;

export type AlertLevel = "info" | "action" | "error";

const PREFIX: Record<AlertLevel, string> = {
  info: "✅",
  action: "🟡",
  error: "🔴",
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Sends an operator alert. Never throws: an alerting outage must not abort a
 * rebalance that is otherwise fine.
 */
export async function alert(input: {
  level: AlertLevel;
  title: string;
  tracker?: string;
  lines?: string[];
  /** Appends a deep link to the admin panel when one is configured. */
  linkToAdmin?: boolean;
}): Promise<void> {
  const heading = input.tracker
    ? `${PREFIX[input.level]} <b>${escapeHtml(input.tracker)}</b> — ${escapeHtml(input.title)}`
    : `${PREFIX[input.level]} <b>${escapeHtml(input.title)}</b>`;

  const body = [heading, ...(input.lines ?? []).map(escapeHtml)];

  if (input.linkToAdmin && ADMIN_URL) {
    const url = input.tracker ? `${ADMIN_URL}?tracker=${input.tracker}` : ADMIN_URL;
    body.push(`\n<a href="${escapeHtml(url)}">Open admin panel</a>`);
  }

  const text = body.join("\n");
  log[input.level === "error" ? "error" : "info"](`alert: ${input.title}`, {
    tracker: input.tracker,
  });

  if (!BOT_TOKEN || !CHAT_ID) {
    log.debug("telegram not configured, alert logged only");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      log.warn("telegram send failed", { status: response.status });
    }
  } catch (error) {
    log.warn("telegram send threw", { error: errText(error) });
  }
}

/** Formats a weight change the way a human reads a diff. */
export const formatDelta = (bps: number): string =>
  `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
