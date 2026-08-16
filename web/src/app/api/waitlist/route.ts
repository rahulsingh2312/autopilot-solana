import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";

/**
 * Waitlist signups go to Telegram.
 *
 * The previous sink was a file next to the app, which works on a laptop and
 * silently does not on Vercel: the serverless filesystem is read-only outside
 * /tmp, so every signup on the deployed site failed. A bot message lands
 * somewhere a person actually looks, and needs no database to stand up.
 *
 * Telegram bots cannot open a conversation, and `chat_id` only accepts an
 * @name for channels, never for a person. So the recipient has to message the
 * bot once, and we store the numeric id that produces. See TELEGRAM_SETUP.md.
 */

const STORE = join(process.cwd(), ".data", "waitlist.ndjson");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

type Signup = { email: string; wallet: string; at: string };

/** Plain text on purpose: no parse_mode means no escaping an address wrong. */
async function notifyTelegram(signup: Signup): Promise<boolean> {
  if (!TOKEN || !CHAT_ID) return false;

  const lines = [
    "New Copycat waitlist signup",
    "",
    `Email:  ${signup.email}`,
    `Wallet: ${signup.wallet || "not connected"}`,
    `Time:   ${signup.at}`,
  ];

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: lines.join("\n"),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) {
      // The body carries Telegram's reason, and the usual one is worth seeing:
      // "chat not found" means the recipient never messaged the bot.
      console.error("[waitlist] telegram rejected:", await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("[waitlist] telegram unreachable:", error);
    return false;
  }
}

/** Local convenience only. Never counts as delivery in production. */
async function appendLocally(signup: Signup): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false;
  try {
    await mkdir(dirname(STORE), { recursive: true });
    await appendFile(STORE, `${JSON.stringify(signup)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let payload: { email?: unknown; wallet?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const wallet =
    typeof payload.wallet === "string" ? payload.wallet.trim() : "";

  if (!EMAIL.test(email)) {
    return NextResponse.json(
      { error: "That does not look like an email address." },
      { status: 400 },
    );
  }
  if (email.length > 254 || wallet.length > 64) {
    return NextResponse.json({ error: "That is too long." }, { status: 400 });
  }

  const signup: Signup = { email, wallet, at: new Date().toISOString() };

  // Both are attempted: a dev machine gets a file it can read back, and the
  // deployed site gets the message. Success means at least one sink took it,
  // because telling someone they are on a list we did not record is the one
  // outcome worth failing loudly for.
  const [delivered, saved] = await Promise.all([
    notifyTelegram(signup),
    appendLocally(signup),
  ]);

  if (!delivered && !saved) {
    console.error("[waitlist] dropped signup, no sink accepted it:", email);
    return NextResponse.json(
      { error: "We could not save that. Try again in a minute." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
