/**
 * scripts/lib/hollow-parity/catalog.mjs — source-text parsers shared by the
 * hollow-parity gate (T5.2, 2026-08-23 remediation). These deliberately do
 * NOT import `@arbor/mcp` TypeScript at runtime (this is a plain `.mjs`
 * script run under `bun`/`node`, not compiled) — the same constraint
 * `scripts/tui-catalog-parity.mjs`'s `parseRuntimeCatalog` already works
 * under, and this module reuses that exact pattern rather than re-deriving
 * it, so a change to `RUNTIME_CATALOG`'s one-line-per-entry shape only has
 * to be re-learned once.
 */

import { readFileSync } from "node:fs";
import {
  parseRuntimeCatalog as parseRuntimeCatalogStructural,
  loadRuntimeCatalog as loadRuntimeCatalogStructural,
} from "../tui-catalog-parity/catalog-parser.mjs";

/**
 * Catalog parsing is SHARED with the structural parser, not re-implemented.
 *
 * This used to be a second copy of the one-line regex, kept that way to avoid
 * "a load-bearing cross-gate dependency on its internals". Importing the
 * `lib/` module satisfies that concern — it is a shared utility, not another
 * gate's internals — and keeping the copy is what made this gate blind: the
 * manifest moved to `@arbor/core` behind a re-export alias, so the regex
 * matched nothing here exactly as it did there, and a scanner that observes
 * nothing cannot report drift.
 */
export function parseRuntimeCatalog(source, fileName = "runtime-catalog.ts") {
  return parseRuntimeCatalogStructural(source, fileName);
}

export function loadRuntimeCatalog(catalogPath, workspaceRoot) {
  return loadRuntimeCatalogStructural(catalogPath, workspaceRoot);
}

/**
 * Extract the quoted-string keys of the `probePayloads()` object literal in
 * `packages/arbor-mcp/src/liveness.ts` — the set of query kinds the liveness
 * gate actually dispatches a real payload for (as opposed to reporting
 * `indeterminate`). Sliced to the function body text so keys used elsewhere
 * in the file (e.g. inside `RUNTIME_CATALOG` itself) are never picked up.
 */
export function parseLivenessProbedQueryKinds(source) {
  const start = source.indexOf("export function probePayloads(");
  if (start < 0) throw new Error("probePayloads() not found in liveness.ts source");
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = bodyStart;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") { depth--; if (depth === 0) break; }
  }
  const body = source.slice(bodyStart, end + 1);
  const keys = new Set();
  const keyPattern = /"([a-z][a-z0-9_.]*)"\s*:\s*\{/g;
  for (const match of body.matchAll(keyPattern)) keys.add(match[1]);
  return keys;
}

/**
 * Load the TUI catalog-parity disposition register
 * (`scripts/tui-catalog-parity/dispositions.json`) — the existing,
 * already-audited per-kind "does the TUI actually surface this" register
 * (`gate:tui-catalog-parity` proves every `supported` catalog kind has an
 * entry here). Only `disposition: "live_query"` / `"live_control"` mean the
 * TUI actually dispatches the kind TODAY (each requires a real operator
 * `trigger` and, for `live_control`, a passing e2e test — see
 * `scripts/tui-catalog-parity.mjs`'s `validateParity`). `authoring_required`
 * / `detail_required` are `operator_visible: true` but explicitly NOT wired
 * yet (a `reason` explains what's missing, the same shape `excluded` uses)
 * — counting those as a live TUI surface would silently un-find real WA-35
 * gaps like `foreground.derive`/`nodecard.resolve`, whose dispositions are
 * `detail_required`.
 */
export function loadTuiDispositionSurfaceKinds(dispositionsPath) {
  const document = JSON.parse(readFileSync(dispositionsPath, "utf8"));
  const kinds = new Set();
  for (const entry of document.entries ?? []) {
    if (entry.disposition === "live_query" || entry.disposition === "live_control") kinds.add(entry.kind);
  }
  return kinds;
}

/**
 * Find every catalog kind string literal quoted in a source file (used for
 * the CLI and Web surface signals: does this kind's literal name appear
 * anywhere in `cli.ts` / `webui.ts`). Deliberately coarse — a literal
 * occurrence is evidence of a real, named code path for that kind, which is
 * the same bar `boundary-parity.test.ts`'s webui command-literal check uses
 * for item 1(d).
 */
export function findLiteralKindReferences(source, kinds) {
  const found = new Set();
  for (const kind of kinds) {
    if (source.includes(`"${kind}"`) || source.includes(`'${kind}'`)) found.add(kind);
  }
  return found;
}
