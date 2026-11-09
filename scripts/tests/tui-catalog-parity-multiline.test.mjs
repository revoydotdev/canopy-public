/**
 * scripts/tests/tui-catalog-parity-multiline.test.mjs — governance-walk item
 * 7: prove the structural parser (scripts/lib/tui-catalog-parity/catalog-parser.mjs)
 * fixes the exact bug the old regex-based `parseRuntimeCatalog` had, and that
 * it reports the SAME real-tree verdict the old parser did.
 *
 * The old parser (kept below, inline, as a frozen historical reference — not
 * imported from anywhere, since the real gate no longer has it) required an
 * entire `{ kind: "...", direction: "...", ..., supported: ... }` entry to
 * appear on a single physical source line:
 *
 *   /^\s*\{\s*kind:\s*"([^"]+)",\s*direction:\s*"(command|query)".*\bsupported:\s*(true|false)\b.*\},?\s*$/
 *
 * Every entry in the real `runtime-catalog.ts` happens to fit on one line
 * today, so this was a latent bug: a catalog entry reformatted across
 * multiple lines would silently vanish from the gate's view. This file
 * demonstrates that concretely with a multi-line entry, then confirms the
 * new parser still reports revoy2's real catalog identically to before.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRuntimeCatalog as parseRuntimeCatalogStructural, loadRuntimeCatalog } from "../lib/tui-catalog-parity/catalog-parser.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The manifest, not `arbor-mcp/src/runtime-catalog.ts`. The catalog moved to
// `@arbor/core` and that file is now a re-export alias, so it contains no array
// literal at all: BOTH parsers correctly report zero entries there, which makes
// it useless for a parity comparison. This path is where the entries live, and
// it is also the file the old regex was written against.
const REAL_CATALOG_PATH = resolve(REPO_ROOT, "packages/arbor-core/src/runtime-catalog-manifest.ts");

/** Frozen copy of the OLD one-line-only regex scan this gate used to run. */
function parseRuntimeCatalogOldRegex(source) {
  const entries = [];
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/^\s*\{\s*kind:\s*"([^"]+)",\s*direction:\s*"(command|query)".*\bsupported:\s*(true|false)\b.*\},?\s*$/);
    if (match) entries.push({ kind: match[1], direction: match[2], supported: match[3] === "true", line: index + 1 });
  }
  return entries;
}

/**
 * A catalog entry whose fields are spread across multiple lines — the exact
 * shape the old regex could not see (no single line contains `kind`,
 * `direction`, AND `supported` together).
 */
const MULTILINE_ENTRY = `  {
    kind: "task.inspect",
    direction: "query",
    capability: "task.read",
    idempotency: "not_applicable",
    supported: true,
  },`;

const MULTILINE_SOURCE = `export const RUNTIME_CATALOG = [\n${MULTILINE_ENTRY}\n];\n`;

describe("tui-catalog-parity structural parser vs. the old one-line regex", () => {
  it("the OLD regex parser misses a multi-line catalog entry entirely", () => {
    const entries = parseRuntimeCatalogOldRegex(MULTILINE_SOURCE);
    expect(entries).toEqual([]);
  });

  it("the NEW structural parser extracts the multi-line entry's fields correctly", () => {
    const entries = parseRuntimeCatalogStructural(MULTILINE_SOURCE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "task.inspect", direction: "query", supported: true });
  });

  it("a mix of single-line and multi-line entries: the new parser gets both, the old parser only gets the single-line one", () => {
    const source = [
      "export const RUNTIME_CATALOG = [",
      '  { kind: "task.retry", direction: "command", capability: "task.retry", idempotency: "required", supported: true },',
      MULTILINE_ENTRY,
      "];",
      "",
    ].join("\n");

    const oldEntries = parseRuntimeCatalogOldRegex(source);
    expect(oldEntries.map((e) => e.kind)).toEqual(["task.retry"]);

    const newEntries = parseRuntimeCatalogStructural(source);
    expect(newEntries.map((e) => e.kind).sort()).toEqual(["task.inspect", "task.retry"]);
  });

  it("parity: the new structural parser reports the identical catalog set as the old regex on the REAL manifest", () => {
    const realSource = readFileSync(REAL_CATALOG_PATH, "utf8");
    const oldEntries = parseRuntimeCatalogOldRegex(realSource);
    // Through `loadRuntimeCatalog`, because that is the path the gate uses and
    // the one that resolves `RUNTIME_CATALOG` in arbor-mcp to the manifest's
    // `RUNTIME_CATALOG_MANIFEST`. Handing the bare manifest text to the
    // same-file `parseRuntimeCatalog` would look for a name the manifest does
    // not declare, which is a harness artefact rather than a parity finding.
    const newEntries = loadRuntimeCatalog(resolve(REPO_ROOT, "packages/arbor-mcp/src/runtime-catalog.ts"), REPO_ROOT);

    const normalize = (entries) => entries.map((e) => ({ kind: e.kind, direction: e.direction, supported: e.supported })).sort((a, b) => a.kind.localeCompare(b.kind));

    // Every real entry is single-line, so the old and new parsers must agree
    // exactly — proving the migration changed HOW entries are found, not WHICH
    // ones count as valid/invalid.
    expect(normalize(newEntries)).toEqual(normalize(oldEntries));
    // 195 declared entries, of which 163 are `supported` (the 32 unsupported
    // ones are the `repo.flight.*` family). The gate's parity contract is over
    // the SUPPORTED set -- that is what `supported_catalog_entries` counts and
    // what needs a TUI disposition -- so 163 is asserted against the filtered
    // count, not the total.
    expect(newEntries.length).toBe(195);
    expect(newEntries.filter((e) => e.supported).length).toBe(163);
  });
});
