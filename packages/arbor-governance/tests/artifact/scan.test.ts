import { describe, expect, it } from "vitest";
import { scan } from "../../src/artifact/scan.js";
import { parseSymbolId } from "../../src/artifact/identity.js";

// vitest is invoked from the repo root (`npx vitest run ...`), so process.cwd()
// is the real repo root — scan() is exercised against the actual, current
// repository, not a fixture, per this branch's dispatch brief.
const REPO_ROOT = process.cwd();

describe("scan — determinism", () => {
  it("produces byte-identical output across two calls against the same checkout", () => {
    const first = scan(REPO_ROOT);
    const second = scan(REPO_ROOT);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("scan — basic shape", () => {
  it("emits one file-kind identity and at least one symbol-kind identity for this module's own source", () => {
    const identities = scan(REPO_ROOT);
    const ownFile = identities.find(
      (i) => i.kind === "file" && i.path === "packages/arbor-governance/src/artifact/scan.ts",
    );
    expect(ownFile).toBeDefined();
    const ownSymbol = identities.find(
      (i) => i.kind === "symbol" && i.path === "packages/arbor-governance/src/artifact/scan.ts" && i.symbol_id === "arbor-governance::scan",
    );
    expect(ownSymbol).toBeDefined();
  });

  it("never emits a path containing a backslash", () => {
    const identities = scan(REPO_ROOT);
    expect(identities.every((i) => !i.path.includes("\\"))).toBe(true);
  });
});

describe("scan — a real, currently-live symbol-name collision (PHASE_DURATION_BUCKETS_MS)", () => {
  // Verified against the real repo (grep -rn "PHASE_DURATION_BUCKETS_MS"
  // packages/*/src): defined in BOTH packages/arbor-mcp/src/metrics-projector.ts
  // and packages/arbor-tui/src/telemetry-widgets.ts, with byte-identical
  // literal content in both places. That last fact makes it an even
  // stronger discrimination case than a content-differing collision: a
  // content_hash-only comparison would ALSO wrongly conflate these two,
  // not just a symbol-name-only one — package-qualified symbol_id plus path
  // is what tells them apart.
  it("scans both real declarations as distinct identities, discriminated by package/path despite identical content_hash", () => {
    const identities = scan(REPO_ROOT);
    const matches = identities.filter(
      (i) => i.kind === "symbol" && parseSymbolId(i.symbol_id ?? "")?.exportName === "PHASE_DURATION_BUCKETS_MS",
    );
    expect(matches).toHaveLength(2);

    const [a, b] = matches;
    expect(a.content_hash).toBe(b.content_hash); // identical literal in both files
    expect(a.symbol_id).not.toBe(b.symbol_id); // package differs -> full identity differs
    expect(a.path).not.toBe(b.path);
    expect(new Set(matches.map((m) => m.path))).toEqual(
      new Set(["packages/arbor-mcp/src/metrics-projector.ts", "packages/arbor-tui/src/telemetry-widgets.ts"]),
    );
  });
});
