import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME_CATALOG_MANIFEST } from "@arbor/core";
import { describe, expect, it } from "vitest";

/**
 * Ground-truth coverage check for the a2a/bus/compaction families: every
 * `supported: true` kind the backend catalog registers in these three
 * families must be reachable from the TUI's own view of the catalog
 * (`runtime-port.ts`'s `RuntimeCommandKind`/`RuntimeQueryKind` unions).
 *
 * `arbor-tui` never imports `@arbor/mcp` (see runtime-port.ts's module doc),
 * but the catalog itself is not `@arbor/mcp`'s to define: `@arbor/mcp`
 * re-exports `RUNTIME_CATALOG_MANIFEST` from `@arbor/core` verbatim
 * (`runtime-catalog.ts`'s `export const RUNTIME_CATALOG = RUNTIME_CATALOG_MANIFEST`),
 * and `@arbor/core` is a declared dependency. So the backend ground truth is
 * imported as data — the real, typed catalog — rather than scraped out of one
 * package's source text by regex. Hardcoding a list would only prove the TUI
 * matches itself; scraping `@arbor/mcp` proved nothing at all once the
 * literals moved to `@arbor/core`, and failed silently by matching zero.
 */
const TUI_PORT_PATH = fileURLToPath(new URL("../src/runtime-port.ts", import.meta.url));

interface CatalogEntry {
  readonly kind: string;
  readonly direction: "command" | "query";
}

/** Extract the quoted string literals inside `export type <Name> = ... ;`. */
function parseUnion(source: string, typeName: string): readonly string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`could not find union ${typeName} in ${TUI_PORT_PATH}`);
  const end = source.indexOf(";", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  return Array.from(body.matchAll(/"([a-zA-Z0-9_.]+)"/g), (m) => m[1]);
}

/**
 * Kinds that are deliberately NOT operator-invokable from the TUI, with the
 * recorded reason. Empty on purpose: every `a2a.*`/`bus.*`/`compaction.*`
 * kind the backend supports is a legitimate operator concern (the A2A
 * subsystem in particular was built and gated as a first-class operator
 * concern), so this test is conservative — prefer wiring a kind over
 * excluding it. Add an entry here only with a specific, reviewed reason.
 */
const DELIBERATELY_EXCLUDED: ReadonlySet<string> = new Set([]);

describe("a2a/bus/compaction: backend catalog vs TUI runtime-port coverage", () => {
  const tuiSource = readFileSync(TUI_PORT_PATH, "utf8");
  const backendEntries: readonly CatalogEntry[] = RUNTIME_CATALOG_MANIFEST
    .filter((entry) => entry.supported && /^(a2a|bus|compaction)\./.test(entry.kind))
    .map((entry) => ({ kind: entry.kind, direction: entry.direction }));

  it("finds backend entries to check (sanity: the parser is not silently matching nothing)", () => {
    expect(backendEntries.length).toBeGreaterThanOrEqual(11);
  });

  const tuiCommandKinds = new Set(parseUnion(tuiSource, "RuntimeCommandKind"));
  const tuiQueryKinds = new Set(parseUnion(tuiSource, "RuntimeQueryKind"));

  it("every supported a2a/bus/compaction backend kind is present in the TUI's matching union", () => {
    const missing: string[] = [];
    for (const entry of backendEntries) {
      if (DELIBERATELY_EXCLUDED.has(entry.kind)) continue;
      const present = entry.direction === "command" ? tuiCommandKinds.has(entry.kind) : tuiQueryKinds.has(entry.kind);
      if (!present) missing.push(`${entry.kind} (${entry.direction})`);
    }
    expect(missing).toEqual([]);
  });

  it("never claims a kind the backend does not actually register (no orphan a2a/bus/compaction kinds in the TUI union)", () => {
    const backendCommandKinds = new Set(backendEntries.filter((e) => e.direction === "command").map((e) => e.kind));
    const backendQueryKinds = new Set(backendEntries.filter((e) => e.direction === "query").map((e) => e.kind));
    const orphanCommands = [...tuiCommandKinds].filter((k) => /^(a2a|bus|compaction)\./.test(k) && !backendCommandKinds.has(k));
    const orphanQueries = [...tuiQueryKinds].filter((k) => /^(a2a|bus|compaction)\./.test(k) && !backendQueryKinds.has(k));
    expect([...orphanCommands, ...orphanQueries]).toEqual([]);
  });
});
