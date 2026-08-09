/**
 * A deliberately tiny XML reader for SEC information tables.
 *
 * A real parser is not warranted here: the 13F information table is a flat,
 * machine-generated list of `infoTable` records with no attributes, no mixed
 * content, and no nesting deeper than two levels. What it *does* have is
 * inconsistent namespace prefixes between filing agents — the same field is
 * `<cusip>`, `<ns1:cusip>`, or `<n1:cusip>` depending on who filed it — so
 * every lookup here is prefix-insensitive.
 */

/** Matches an element by local name, ignoring any namespace prefix. */
const elementRegex = (localName: string) =>
  new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`, "i");

const allElementsRegex = (localName: string) =>
  new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`, "gi");

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const decode = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity)
    .trim();

/** First child element with this local name, or null. */
export function tagText(xml: string, localName: string): string | null {
  const match = elementRegex(localName).exec(xml);
  return match?.[1] === undefined ? null : decode(match[1]);
}

/** Every element with this local name, as raw inner XML. */
export function tagBlocks(xml: string, localName: string): string[] {
  return [...xml.matchAll(allElementsRegex(localName))].map((m) => m[1] ?? "");
}

/** `tagText` parsed as a number, with commas and currency noise stripped. */
export function tagNumber(xml: string, localName: string): number | null {
  const raw = tagText(xml, localName);
  if (raw === null) return null;
  const value = Number.parseFloat(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Local name of the document's root element, used to identify a file. */
export function rootElement(xml: string): string | null {
  const match = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)[\s>]/.exec(
    xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, ""),
  );
  return match?.[1] ?? null;
}
