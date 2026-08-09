/**
 * STOCK Act disclosures, straight from the House Clerk.
 *
 * This is the primary source. Every congress-trade product — Quiver at
 * $75/month, Capitol Trades, Tracefour — is reading these same PDFs and
 * reselling the parse. Reading them directly costs nothing, carries no terms
 * of service, and cannot go stale when someone else's free tier changes.
 *
 * The repo previously recorded this path as impractical because "tickers and
 * amounts live in per-filing PDFs, many scanned". That is true of the annual
 * financial disclosures. It is **not** true of Periodic Transaction Reports:
 * PTRs are generated digitally and carry a real text layer, so a PTR parses
 * cleanly. Only the annual reports need OCR, and no tracker here reads them.
 *
 * Two practical wrinkles:
 *
 * - The PDFs are **encrypted** (standard security handler, empty password), so
 *   naive stream inflation yields nothing. `pdftotext` handles it; a pure-JS
 *   parse would have to implement PDF decryption.
 * - Amounts are ranges, never numbers, and the asset code distinguishes shares
 *   `[ST]` from options `[OP]`. Both matter enormously: a long-only vault
 *   cannot hold an option, and most of Pelosi's disclosed activity is options.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { errText, log } from "../log.ts";
import { tagBlocks, tagText } from "./xml.ts";
import { readZip } from "./zip.ts";
import { getText } from "./http.ts";
import { env } from "../env.ts";
import { kvGet, kvSet } from "../store/db.ts";

const execFileAsync = promisify(execFile);

const CLERK_BASE = "https://disclosures-clerk.house.gov/public_disc";

/** Periodic Transaction Report. The only filing type this reads. */
const PTR = "P";

export type ClerkFiling = {
  last: string;
  first: string;
  stateDst: string;
  filingType: string;
  filingDate: string;
  docId: string;
  year: number;
};

export type PtrTransaction = {
  /** SP = spouse, JT = joint, DC = dependent child, blank = the member. */
  owner: string;
  assetName: string;
  ticker: string | null;
  /** House asset-type code: ST = stock, OP = options, and many others. */
  assetCode: string;
  /** P = purchase, S = sale, S (partial), E = exchange. */
  transactionType: string;
  transactionDate: string;
  /** Lower and upper bound of the disclosed range, in dollars. */
  amountLow: number;
  amountHigh: number;
  description: string;
};

/**
 * The year's filing index.
 *
 * Cheap and cacheable: one ZIP holding an XML list of every filing, with the
 * document IDs needed to fetch the PDFs.
 */
export async function loadFilingIndex(year: number): Promise<ClerkFiling[]> {
  const response = await fetch(`${CLERK_BASE}/financial-pdfs/${year}FD.zip`, {
    headers: { "user-agent": env.secUserAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`clerk index ${year} → ${response.status}`);

  const entries = readZip(Buffer.from(await response.arrayBuffer()));
  const xmlEntry = entries.find((entry) => entry.name.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) throw new Error(`clerk index ${year} contained no xml`);

  // The Clerk ships a UTF-8 BOM; leaving it in makes the first tag unmatchable.
  const xml = xmlEntry.data.toString("utf8").replace(/^﻿/, "");

  const filings: ClerkFiling[] = [];
  for (const block of tagBlocks(xml, "Member")) {
    const docId = tagText(block, "DocID");
    if (!docId) continue;
    filings.push({
      last: tagText(block, "Last") ?? "",
      first: tagText(block, "First") ?? "",
      stateDst: tagText(block, "StateDst") ?? "",
      filingType: tagText(block, "FilingType") ?? "",
      filingDate: tagText(block, "FilingDate") ?? "",
      docId,
      year,
    });
  }

  log.debug("clerk index loaded", {
    year,
    filings: filings.length,
    ptrs: filings.filter((f) => f.filingType === PTR).length,
  });

  return filings;
}

let pdftotextChecked = false;

/**
 * PDF → text, via poppler.
 *
 * Shelling out rather than taking a JS PDF dependency: these files are
 * encrypted, so the library that reads them has to implement decryption, and
 * that is a large amount of surface to add to a worker whose only other
 * dependency is the Solana client.
 */
async function pdfToText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-ptr-"));
  const path = join(dir, "filing.pdf");
  try {
    await writeFile(path, pdf);
    // `-layout` preserves the column structure the row parser depends on.
    const { stdout } = await execFileAsync("pdftotext", ["-layout", path, "-"], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch (error) {
    if (!pdftotextChecked && /ENOENT/.test(errText(error))) {
      pdftotextChecked = true;
      throw new Error(
        "pdftotext not found — install poppler (`brew install poppler`, " +
          "`apt-get install poppler-utils`) to parse House Clerk PTR filings",
      );
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Every range the STOCK Act allows, parsed from its printed form.
 *
 * Usually two bounds ("$1,000,001 - $5,000,000"), but not always: a spinoff
 * settling cash in lieu prints one exact figure like "$15.00". A single value
 * is a real disclosure, not a truncated range, so it collapses to low == high.
 */
function parseAmount(text: string): { low: number; high: number } | null {
  const numbers = [...text.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) =>
    Number.parseFloat((m[1] ?? "").replace(/,/g, "")),
  );
  if (numbers.length === 0 || !Number.isFinite(numbers[0]!)) return null;
  const low = numbers[0]!;
  const high = numbers.length > 1 && Number.isFinite(numbers[1]!) ? numbers[1]! : low;
  return { low, high };
}

/**
 * Parses the transaction table out of a PTR's text layer.
 *
 * Records wrap across lines unpredictably — the asset name, its ticker, and
 * the upper bound of the amount are usually on the following line, and the
 * table header repeats mid-document on multi-page filings. So rather than
 * assume a fixed shape, this anchors on the row that carries the transaction
 * type and both dates, then reads forward for the ticker and the range.
 */
export function parsePtr(text: string): PtrTransaction[] {
  // Owner (optional) ‖ asset name ‖ type ‖ txn date ‖ notification date ‖ $low
  //
  // The gap before the transaction type is `\s+`, not `\s{2,}`. When an asset
  // name is long enough to fill the column the type is pushed hard against it
  // — "NVIDIA Corporation - Common Stock P" — and requiring two spaces made
  // those rows fail to register as records at all. They were not mis-parsed,
  // they were silently dropped, which is the worst way to lose a position.
  // Requiring two dates and a dollar figure immediately after keeps a name
  // that merely contains " P " from matching.
  const rowPattern =
    /^\s*(SP|JT|DC)?\s+(.{3,}?)\s+(S \(partial\)|[PSEG])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+)/;

  // The column header repeats on every page, and it contains a literal "$200"
  // in "Cap. Gains > $200?". Left in, that leaks into the next record's amount
  // range and silently understates a position by orders of magnitude.
  const isChrome = (line: string) =>
    /Cap\.|Gains >|\$200\?|^\s*ID\s+Owner|Transaction\s*$|Notification|^\s*Type\s*$|Filing ID #|Clerk of the House|asset type abbreviations/.test(
      line,
    );

  const lines = text.split(/\r?\n/).filter((line) => !isChrome(line));

  // Where each record begins. Records are then whole blocks rather than a
  // line plus guesswork: the ticker, the upper bound of the range, and the
  // description all wrap onto following lines in no fixed order.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (rowPattern.test(lines[i] ?? "")) starts.push(i);
  }

  const transactions: PtrTransaction[] = [];

  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : lines.length;
    const block = lines.slice(from, to);

    const match = rowPattern.exec(block[0] ?? "");
    if (!match) continue;
    const [, owner, namePart, type, txnDate] = match;

    // The amount range lives above the "F S :" / "D :" detail lines, and the
    // description below them — and descriptions are full of dollar figures
    // ("a strike price of $50"). Splitting here keeps those out of the range.
    const detailAt = block.findIndex((line) => /^\s*(F\s|D\s*:)/.test(line));
    const head = (detailAt === -1 ? block : block.slice(0, detailAt)).join("\n");
    const detail = detailAt === -1 ? "" : block.slice(detailAt).join(" ");

    // Ticker and asset code are matched independently. They are usually
    // adjacent — "(NVDA) [OP]" — but wrap apart when the name is long:
    // "Apple Inc. - Common Stock (AAPL)" on one line, "[ST]" on the next.
    // Insisting they touch lost every Apple row in the filing.
    const ticker = /\(([A-Z][A-Z0-9.]{0,6})\)/.exec(head)?.[1] ?? null;
    const assetCode = /\[([A-Z]{2})\]/.exec(head)?.[1] ?? "";

    const amount = parseAmount(head);
    if (!amount) continue;

    transactions.push({
      owner: (owner ?? "").trim(),
      // Rebuild the wrapped asset name minus the ticker/code marker.
      assetName: head
        .replace(rowPattern, "$2")
        .replace(/\([A-Z][A-Z0-9.]{0,6}\)/, "")
        .replace(/\[[A-Z]{2}\]/, "")
        .replace(/\$[\d,]+/g, "")
        .replace(/\d{2}\/\d{2}\/\d{4}/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      ticker,
      assetCode,
      transactionType: (type ?? "").trim(),
      transactionDate: txnDate ?? "",
      amountLow: amount.low,
      amountHigh: amount.high,
      description: /D\s*:\s*(.+)/.exec(detail)?.[1]?.replace(/\s+/g, " ").trim() ?? "",
    });
  }

  return transactions;
}

/** Canonical URL for a filing, for the audit trail and the UI. */
export const ptrUrl = (filing: ClerkFiling) =>
  `${CLERK_BASE}/ptr-pdfs/${filing.year}/${filing.docId}.pdf`;

/**
 * Downloads and parses one PTR, cached permanently by document ID.
 *
 * A filed PTR never changes — an amendment is a new document with a new ID —
 * so the parse is cached forever rather than for a TTL. That matters most for
 * the aggregate tracker, which reads hundreds of filings: without this, every
 * cycle would re-download and re-run poppler over the entire chamber.
 */
export async function loadPtr(filing: ClerkFiling): Promise<PtrTransaction[]> {
  const cacheKey = `ptr:${filing.year}:${filing.docId}`;
  const cached = kvGet<PtrTransaction[]>(cacheKey);
  if (cached) return cached;

  const response = await fetch(ptrUrl(filing), {
    headers: { "user-agent": env.secUserAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ptr ${filing.docId} → ${response.status}`);

  const text = await pdfToText(Buffer.from(await response.arrayBuffer()));
  const transactions = parsePtr(text);
  kvSet(cacheKey, transactions);
  return transactions;
}

export { getText };
