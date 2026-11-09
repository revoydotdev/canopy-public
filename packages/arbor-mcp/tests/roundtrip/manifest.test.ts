import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_CATALOG, type RuntimeCatalogKind } from "../../src/runtime-catalog.js";
import { ROUNDTRIP_MANIFEST, type RoundtripManifestEntry } from "./manifest.js";

// repo root: packages/arbor-mcp/tests/roundtrip -> up four
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

function capabilitiesOf(entry: RoundtripManifestEntry): readonly RuntimeCatalogKind[] {
  return entry.capabilities;
}

describe("6.3 roundtrip conformance manifest", () => {
  it("covers every supported RUNTIME_CATALOG kind exactly once", () => {
    const supported: RuntimeCatalogKind[] = RUNTIME_CATALOG.filter((e) => e.supported).map((e) => e.kind).sort();
    const manifestKinds = ROUNDTRIP_MANIFEST.flatMap(capabilitiesOf);
    const counts = new Map<string, number>();
    for (const kind of manifestKinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);

    const missing = supported.filter((kind) => !counts.has(kind));
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([kind]) => kind);
    const stale = manifestKinds.filter((kind) => !supported.includes(kind));

    expect(missing, `supported RUNTIME_CATALOG kinds with no manifest entry: ${missing.join(", ")}`).toEqual([]);
    expect(duplicated, `RUNTIME_CATALOG kinds listed in more than one manifest entry: ${duplicated.join(", ")}`).toEqual([]);
    expect(stale, `manifest entries naming a kind RUNTIME_CATALOG no longer declares supported: ${stale.join(", ")}`).toEqual([]);
  });

  it("every landed entry's test file exists and contains the named test", () => {
    for (const entry of ROUNDTRIP_MANIFEST) {
      if (entry.status !== "landed") continue;
      const path = resolve(REPO_ROOT, entry.file);
      expect(existsSync(path), `roundtrip file for [${entry.capabilities.join(", ")}] does not exist: ${entry.file}`).toBe(true);
      const source = readFileSync(path, "utf-8");
      const needle = `it(${JSON.stringify(entry.test)}`;
      expect(
        source.includes(needle),
        `roundtrip test for [${entry.capabilities.join(", ")}] not found in ${entry.file} — expected an it(${JSON.stringify(entry.test)}, ...) block`,
      ).toBe(true);
    }
  });

  it("every gap entry names a real Verified-gap-register id or a dated new-finding id", () => {
    for (const entry of ROUNDTRIP_MANIFEST) {
      if (entry.status !== "gap") continue;
      expect(entry.gap, `gap entry for [${entry.capabilities.join(", ")}] must name a G-xx id or a dated NEW-* finding`).toMatch(/^(G-\d+|NEW-6\.\d+-\d{4}-\d{2}-\d{2})$/);
      expect(entry.note.length, `gap entry for [${entry.capabilities.join(", ")}] must explain why it is deliberately uncovered`).toBeGreaterThan(20);
    }
  });

  it("declares at least as many capabilities as RUNTIME_CATALOG's supported set (sanity floor against an empty manifest)", () => {
    const supportedCount = RUNTIME_CATALOG.filter((e) => e.supported).length;
    const manifestCount = new Set(ROUNDTRIP_MANIFEST.flatMap(capabilitiesOf)).size;
    expect(manifestCount).toBe(supportedCount);
  });
});
