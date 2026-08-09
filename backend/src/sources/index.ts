/**
 * Source registry: tracker kind → the adapter that feeds it.
 *
 * Adding a tracker is picking one of these, never writing new pipeline code.
 * Everything downstream — portfolio building, diffing, publishing, swapping —
 * consumes `Filing` and does not know or care which adapter produced it.
 */

import { congressAdapter } from "./congress.ts";
import { edgarAdapter } from "./edgar.ts";
import { editorialAdapter } from "./editorial.ts";
import type { SourceAdapter, SourceKind } from "../types.ts";

const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  "13f": edgarAdapter,
  congress: congressAdapter,
  editorial: editorialAdapter,
};

export const adapterFor = (kind: SourceKind): SourceAdapter => ADAPTERS[kind];

export { congressAdapter, edgarAdapter, editorialAdapter };
