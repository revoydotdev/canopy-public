import { describe, expect, it } from "vitest";
import {
  assertPosixRelativePath,
  contentHashOfFile,
  contentHashOfString,
  createArtifactIdentity,
  duplicateSymbolIds,
  InvalidArtifactPathError,
  parseSymbolId,
  symbolId,
} from "../../src/artifact/identity.js";

describe("assertPosixRelativePath", () => {
  it("rejects a path containing a backslash rather than silently converting it", () => {
    expect(() => assertPosixRelativePath("packages\\arbor-mcp\\src\\demo.ts")).toThrow(InvalidArtifactPathError);
  });

  it("rejects an absolute path", () => {
    expect(() => assertPosixRelativePath("/etc/passwd")).toThrow(InvalidArtifactPathError);
  });

  it("rejects an empty path", () => {
    expect(() => assertPosixRelativePath("")).toThrow(InvalidArtifactPathError);
  });

  it("accepts a normal POSIX repo-relative path", () => {
    expect(() => assertPosixRelativePath("packages/arbor-mcp/src/demo.ts")).not.toThrow();
  });
});

describe("createArtifactIdentity", () => {
  it("rejects a backslash path at construction time, not at first use", () => {
    expect(() =>
      createArtifactIdentity({
        kind: "file",
        path: "packages\\arbor-mcp\\src\\demo.ts",
        symbol_id: null,
        content_hash: "sha256:deadbeef",
      }),
    ).toThrow(InvalidArtifactPathError);
  });

  it("stamps schema_version and omits `generated` when not supplied", () => {
    const identity = createArtifactIdentity({
      kind: "file",
      path: "packages/arbor-mcp/src/demo.ts",
      symbol_id: null,
      content_hash: "sha256:deadbeef",
    });
    expect(identity.schema_version).toBe(1);
    expect(identity).not.toHaveProperty("generated");
  });
});

describe("contentHashOfString / contentHashOfFile", () => {
  it("is deterministic for identical content", () => {
    expect(contentHashOfString("hello")).toBe(contentHashOfString("hello"));
  });

  it("differs for different content", () => {
    expect(contentHashOfString("hello")).not.toBe(contentHashOfString("hello!"));
  });

  it("hashes this module's own real source file (contentHashOfFile against the real repo)", () => {
    const hash = contentHashOfFile("packages/arbor-governance/src/artifact/identity.ts");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects contentHashOfFile on a backslash path rather than converting it", () => {
    expect(() => contentHashOfFile("packages\\arbor-mcp\\src\\demo.ts")).toThrow(InvalidArtifactPathError);
  });
});

describe("symbolId / parseSymbolId round trip", () => {
  it("round-trips package + export name", () => {
    const id = symbolId("arbor-mcp", "stepToAction");
    expect(parseSymbolId(id)).toEqual({ packageName: "arbor-mcp", exportName: "stepToAction" });
  });

  it("returns null for a malformed id", () => {
    expect(parseSymbolId("not-a-symbol-id")).toBeNull();
    expect(parseSymbolId("a::b::c")).toBeNull();
  });
});

describe("the stepToAction collision — symbol-name-only identity would wrongly conflate two artifacts", () => {
  // Verified fact (git log --all --follow -- '*planning-markdown*'): a
  // second `stepToAction`, in packages/arbor-opencode/src/planning-markdown.ts,
  // existed at the time this branch's dispatch brief was written but was
  // deleted from the repository in commit c028333 ("refactor(arbor-opencode):
  // delete the dead planning/planning-markdown pipeline") before this task
  // started — `git log --all -- '**/planning-markdown.ts'` confirms it no
  // longer exists at HEAD. The only `stepToAction` live in the repo today is
  // packages/arbor-mcp/src/demo.ts's. This test therefore uses the two
  // ArtifactIdentity fixtures the historical collision would have produced
  // (both real packages, both a real exported function name, differing only
  // in which package/file declared it) rather than re-scanning a file that
  // is gone — see tests/artifact/scan.test.ts for a discrimination test
  // against a collision that IS still live in the current repo
  // (PHASE_DURATION_BUCKETS_MS).
  const inMcp = createArtifactIdentity({
    kind: "symbol",
    path: "packages/arbor-mcp/src/demo.ts",
    symbol_id: symbolId("arbor-mcp", "stepToAction"),
    content_hash: contentHashOfString("function stepToAction(step) { /* demo.ts's shape */ }"),
  });
  const inOpencode = createArtifactIdentity({
    kind: "symbol",
    path: "packages/arbor-opencode/src/planning-markdown.ts",
    symbol_id: symbolId("arbor-opencode", "stepToAction"),
    content_hash: contentHashOfString("function stepToAction(step) { /* planning-markdown.ts's different shape */ }"),
  });

  it("WOULD be wrongly conflated by a symbol-name-only (last-segment) comparison — demonstrating why symbol_id alone is not enough", () => {
    const bareName = (id: string) => parseSymbolId(id)?.exportName;
    expect(bareName(inMcp.symbol_id!)).toBe(bareName(inOpencode.symbol_id!));
    expect(bareName(inMcp.symbol_id!)).toBe("stepToAction");
  });

  it("are correctly discriminated by symbol_id (package::export) alone, since the two are in different packages", () => {
    expect(inMcp.symbol_id).not.toBe(inOpencode.symbol_id);
  });
});

describe("duplicateSymbolIds", () => {
  it("flags two identities sharing a (kind, symbol_id) key at different paths", () => {
    const a = createArtifactIdentity({
      kind: "symbol",
      path: "packages/arbor-mcp/src/a.ts",
      symbol_id: symbolId("arbor-mcp", "helper"),
      content_hash: contentHashOfString("export function helper() { return 1; }"),
    });
    const b = createArtifactIdentity({
      kind: "symbol",
      path: "packages/arbor-mcp/src/b.ts",
      symbol_id: symbolId("arbor-mcp", "helper"),
      content_hash: contentHashOfString("export function helper() { return 2; }"),
    });
    const duplicates = duplicateSymbolIds([a, b]);
    expect(duplicates.size).toBe(1);
    const [group] = [...duplicates.values()];
    expect(group).toHaveLength(2);
  });

  it("does not flag a single identity, or two identities at the same path (that is just one artifact seen twice)", () => {
    const a = createArtifactIdentity({
      kind: "symbol",
      path: "packages/arbor-mcp/src/a.ts",
      symbol_id: symbolId("arbor-mcp", "helper"),
      content_hash: contentHashOfString("export function helper() { return 1; }"),
    });
    expect(duplicateSymbolIds([a]).size).toBe(0);
    expect(duplicateSymbolIds([a, a]).size).toBe(0);
  });

  it("ignores file-kind identities (symbol_id null) entirely", () => {
    const f1 = createArtifactIdentity({ kind: "file", path: "a.ts", symbol_id: null, content_hash: "sha256:1" });
    const f2 = createArtifactIdentity({ kind: "file", path: "b.ts", symbol_id: null, content_hash: "sha256:1" });
    expect(duplicateSymbolIds([f1, f2]).size).toBe(0);
  });
});
