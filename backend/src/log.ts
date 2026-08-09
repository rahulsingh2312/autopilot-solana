/**
 * Structured, one-line-per-event logging.
 *
 * This worker moves other people's money on a schedule nobody is watching, so
 * every log line is machine-greppable and carries the tracker it concerns.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < THRESHOLD) return;

  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

/** Turns an unknown thrown value into something safe to put in a log field. */
export const errText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
