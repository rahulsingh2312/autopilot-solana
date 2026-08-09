/**
 * SEC EDGAR 13F-HR ingestion.
 *
 * Free, official, and structured — the only tier-one source in this pipeline.
 * Drives bwSOL (Berkshire) and psqSOL (Pershing Square).
 *
 * Three things about 13F data that a naive reader gets wrong:
 *
 * 1. **Rows are not positions.** A manager files one `infoTable` row per
 *    (issuer, discretion, other-manager) combination, so Berkshire's Q1 2026
 *    filing is 90 rows describing 29 positions. Aggregating by CUSIP is
 *    mandatory, not a tidy-up.
 *
 * 2. **Options are in there.** A row carries `<putCall>` when it describes an
 *    option rather than the underlying share. A long-only vault cannot hold
 *    one. We exclude them and report the excluded weight, because "80% of
 *    Scion's book was puts" is the single most load-bearing disclosure on the
 *    site and it has to come out of the data, not out of hand-written copy.
 *
 * 3. **The `value` unit changed.** Filings before 2023 report thousands of
 *    dollars, later ones whole dollars. It does not matter here — every
 *    consumer uses value as a share of the total — but anyone tempted to print
 *    it as AUM needs to know.
 */

import { createHash } from "node:crypto";

import { log } from "../log.ts";
import type { Filing, RawHolding, SourceAdapter, TrackerBinding } from "../types.ts";
import { getJson, getText } from "./http.ts";
import { rootElement, tagBlocks, tagNumber, tagText } from "./xml.ts";

type SubmissionsResponse = {
  cik: string;
  name: string;
  filings: {
    recent: {
      form: string[];
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
    };
  };
};

type DirectoryResponse = {
  directory: { item: Array<{ name: string; type?: string }> };
};

export type Filing13F = {
  accession: string;
  form: string;
  filedAt: string;
  periodEnd: string;
};

const pad10 = (cik: string) => cik.replace(/\D/g, "").padStart(10, "0");
const unpadded = (cik: string) => String(Number.parseInt(cik.replace(/\D/g, ""), 10));

/**
 * Every 13F this filer has posted, newest first.
 *
 * Amendments (`13F-HR/A`) are included: an amendment restates a period, and
 * the newest document is the one that is currently true.
 */
export async function list13FFilings(cik: string): Promise<Filing13F[]> {
  const data = await getJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${pad10(cik)}.json`,
  );
  const recent = data.filings.recent;

  const filings: Filing13F[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    if (!form?.startsWith("13F-HR")) continue;
    const accession = recent.accessionNumber[i];
    const filedAt = recent.filingDate[i];
    if (!accession || !filedAt) continue;
    filings.push({
      accession,
      form,
      filedAt,
      periodEnd: recent.reportDate[i] ?? filedAt,
    });
  }

  filings.sort((a, b) => (a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : 0));
  return filings;
}

const archiveBase = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${unpadded(cik)}/${accession.replace(/-/g, "")}`;

/**
 * Locates the information table inside a filing.
 *
 * The filename is not stable across filing agents — Berkshire's is `53405.xml`
 * — so candidates are identified by root element rather than by name, with
 * `primary_doc.xml` (the cover page) skipped up front.
 */
async function fetchInformationTable(
  cik: string,
  accession: string,
): Promise<{ xml: string; url: string } | null> {
  const base = archiveBase(cik, accession);
  const directory = await getJson<DirectoryResponse>(`${base}/index.json`);

  const candidates = directory.directory.item
    .map((item) => item.name)
    .filter((name) => name.toLowerCase().endsWith(".xml"))
    .filter((name) => !name.toLowerCase().includes("primary_doc"));

  for (const name of candidates) {
    const url = `${base}/${name}`;
    const xml = await getText(url);
    if (rootElement(xml)?.toLowerCase() === "informationtable") {
      return { xml, url };
    }
  }

  log.warn("no information table in filing", { cik, accession });
  return null;
}

/** Aggregates `infoTable` rows into one entry per CUSIP. */
export function parseInformationTable(xml: string): RawHolding[] {
  const byCusip = new Map<string, RawHolding>();

  for (const block of tagBlocks(xml, "infoTable")) {
    const cusip = tagText(block, "cusip")?.toUpperCase();
    if (!cusip) continue;

    const value = tagNumber(block, "value") ?? 0;
    const shares = tagNumber(block, "sshPrnamt") ?? 0;
    // Present only on option rows. Its absence is what makes a row a share.
    const putCall = tagText(block, "putCall");
    // `PRN` rows are principal amounts of debt, not shares of an equity.
    const amountType = tagText(block, "sshPrnamtType")?.toUpperCase() ?? "SH";
    const isDerivative = Boolean(putCall) || amountType !== "SH";

    // An option and the underlying share of the same issuer are different
    // positions, so they must not merge into one entry.
    const key = `${cusip}:${isDerivative ? putCall ?? amountType : "SH"}`;

    const existing = byCusip.get(key);
    if (existing) {
      existing.valueUsd += value;
      existing.shares = (existing.shares ?? 0) + shares;
      continue;
    }

    byCusip.set(key, {
      issuer: tagText(block, "nameOfIssuer") ?? cusip,
      cusip,
      valueUsd: value,
      shares,
      isDerivative,
    });
  }

  return [...byCusip.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}

export const edgarAdapter: SourceAdapter = {
  kind: "13f",

  async fetchLatest(tracker: TrackerBinding): Promise<Filing | null> {
    if (!tracker.cik) {
      log.warn("13f tracker has no cik", { tracker: tracker.ticker });
      return null;
    }

    const filings = await list13FFilings(tracker.cik);
    const newest = filings[0];
    if (!newest) {
      log.warn("no 13f filings found", { tracker: tracker.ticker, cik: tracker.cik });
      return null;
    }

    const table = await fetchInformationTable(tracker.cik, newest.accession);
    if (!table) return null;

    const holdings = parseInformationTable(table.xml);
    if (holdings.length === 0) {
      log.warn("information table parsed to nothing", {
        tracker: tracker.ticker,
        accession: newest.accession,
      });
      return null;
    }

    log.info("13f fetched", {
      tracker: tracker.ticker,
      accession: newest.accession,
      period: newest.periodEnd,
      positions: holdings.length,
      derivatives: holdings.filter((h) => h.isDerivative).length,
    });

    return {
      id: `edgar:${newest.accession}`,
      trackerTicker: tracker.ticker,
      sourceKind: "13f",
      periodEnd: newest.periodEnd,
      filedAt: newest.filedAt,
      sourceUrl: `${archiveBase(tracker.cik, newest.accession)}/`,
      holdings,
      contentHash: createHash("sha256").update(table.xml).digest("hex").slice(0, 32),
    };
  },
};
