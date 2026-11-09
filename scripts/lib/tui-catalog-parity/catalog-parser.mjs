/**
 * scripts/lib/tui-catalog-parity/catalog-parser.mjs — the runtime catalog
 * reader as the TUI parity gate consumes it.
 *
 * This file used to BE the reader. It does not any more. It was one of three
 * independent parsers for the same array literal, and they disagreed: this one
 * followed the `RUNTIME_CATALOG` alias, `packages/arbor-governance/src/counts/
 * derive.ts` followed it by regex-scanning every source file, and
 * `scripts/registration-integrity.mjs` followed it not at all and reported
 * `gate:registration-integrity` red. Three readers means three numbers that can
 * drift apart with nothing able to notice, which is what
 * `scripts/guard-canaries.mjs`'s census exists to make visible.
 *
 * The single reader is `readRuntimeCatalog` in
 * `packages/arbor-governance/src/counts/catalog.ts`. It lives in a package
 * rather than here because `scripts/*.mjs` already import `@arbor/governance`
 * and packages must not import `scripts/lib` (see the boundary note in
 * `packages/arbor-mcp/src/project-registry.ts`) — the only home that avoids
 * both a build-graph cycle and a second copy.
 *
 * WHAT STAYS HERE, deliberately. The two functions below keep the shapes their
 * callers and tests depend on, including the difference between "the catalog
 * file could not be read" (throws, so the gate records a read error and the
 * "no entries" finding is NOT the thing that fires) and "the file was read but
 * held no array literal" (`[]`, which the gate's own
 * "runtime catalog parser found no entries" finding covers). Collapsing those
 * two into one would make a broken reader look like an empty catalog.
 *
 * The one count-shaped difference from the other two consumers is preserved as
 * a named predicate rather than dropped: this gate counts only entries whose
 * `direction` is `command` or `query`, because dispositions describe
 * dispatchable surface. `isDispatchableDirection` is shared, not re-derived.
 *
 * WHY A STRUCTURAL PARSER, NOT A REGEX. The gate used to scan the catalog
 * source line-by-line with a regex requiring `kind`, `direction` and
 * `supported` on the SAME line. Every entry happened to fit on one line, so the
 * bug was latent — but any entry reformatted across multiple lines silently
 * disappears from the gate's view, and "missing from an OBSERVED list" and
 * "missing from the WORLD" produce identical output to a scanner that found
 * nothing. The shared reader parses TypeScript syntax (`ts.createSourceFile`,
 * no type-checker `Program`), so an entry's field layout across lines is
 * irrelevant.
 *
 * NOTE ON PRIOR ART. `scripts/lib/hollow-parity/catalog.mjs`'s own
 * `parseRuntimeCatalog`/`loadRuntimeCatalog` are a fourth, still-regex-based
 * copy of the scan this replaced. It is outside this gate's scope and remains
 * a known duplicate; collapsing it is the same change applied to a different
 * consumer.
 */

import { isDispatchableDirection, readCatalogFromSource, readRuntimeCatalog } from "@arbor/governance";

/**
 * Parse a `RUNTIME_CATALOG` array literal already held in memory, following
 * same-file alias hops. Returns `[]` for a source it cannot make sense of,
 * matching this function's long-standing contract.
 */
export function parseRuntimeCatalog(source, fileName = "runtime-catalog.ts") {
  const read = readCatalogFromSource(source, fileName);
  return read.measured ? read.entries.filter((entry) => isDispatchableDirection(entry.direction)) : [];
}

/**
 * Read the catalog from disk, following the alias out of `runtime-catalog.ts`
 * and through its `@arbor/core` import into the manifest that holds the
 * literal.
 *
 * @throws when the entry file itself cannot be read — a gate that reads nothing
 * and reports no findings is indistinguishable from a gate that found no drift.
 */
export function loadRuntimeCatalog(catalogPath, workspaceRoot) {
  const read = readRuntimeCatalog({ repoRoot: workspaceRoot, catalogPath });
  if (!read.measured) {
    if (read.code === "unreadable") throw new Error(read.reason);
    return [];
  }
  return read.entries.filter((entry) => isDispatchableDirection(entry.direction));
}
