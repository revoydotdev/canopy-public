import { describe, expect, it } from "vitest";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSymbolAcrossRepo,
  hashContent,
  isCollectedByVitest,
  readVitestIncludeGlobs,
  resolveProofComment,
  resolveRepoRoot,
  symbolAppearsInFile,
} from "../../src/obligation/proof.js";
import type { ObligationProofComment } from "../../src/obligation/parse.js";

const FIXTURES_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "fixtures");
const AMBIGUOUS_REPO = resolvePath(FIXTURES_DIR, "ambiguous-repo");
const REEXPORT_REPO = resolvePath(FIXTURES_DIR, "reexport-repo");
const AT = "2026-08-04T00:00:00.000Z";

describe("resolveRepoRoot", () => {
  it("resolves to the real repository root (contains decisions/ and vitest.config.ts)", () => {
    const root = resolveRepoRoot();
    expect(() => readVitestIncludeGlobs(root)).not.toThrow();
    expect(readVitestIncludeGlobs(root).length).toBeGreaterThan(0);
  });
});

describe("readVitestIncludeGlobs + isCollectedByVitest: reads the real vitest.config.ts", () => {
  const root = resolveRepoRoot();
  const globs = readVitestIncludeGlobs(root);

  it("finds both known include patterns", () => {
    expect(globs).toContain("packages/**/tests/**/*.test.ts");
    expect(globs).toContain("scripts/tests/**/*.test.mjs");
  });

  it("matches a real, nested test file under packages/**/tests/**", () => {
    expect(isCollectedByVitest("packages/arbor-audit/tests/hash-chain-integrity.test.ts", globs)).toBe(true);
    expect(isCollectedByVitest("packages/arbor-governance/tests/obligation/proof.test.ts", globs)).toBe(true);
  });

  it("does NOT match a real src file that is not under any tests/ directory", () => {
    expect(isCollectedByVitest("packages/arbor-audit/src/audit.ts", globs)).toBe(false);
  });

  it("matches scripts/tests/**/*.test.mjs but not an arbitrary scripts/ file", () => {
    expect(isCollectedByVitest("scripts/tests/whatever.test.mjs", globs)).toBe(true);
    expect(isCollectedByVitest("scripts/docs-truth.mjs", globs)).toBe(false);
  });
});

describe("symbolAppearsInFile: textual/AST-lite declaration check", () => {
  it("finds a directly declared, exported symbol", () => {
    const root = resolveRepoRoot();
    expect(symbolAppearsInFile("EvidenceLedger", resolvePath(root, "packages/arbor-audit/src/audit.ts"))).toBe("declared");
  });

  it("finds a symbol exported only via an export list (re-export shape)", () => {
    const file = resolvePath(REEXPORT_REPO, "packages/gamma/src/impl.ts");
    expect(symbolAppearsInFile("reexportedThing", file)).toBe("reexported");
    expect(symbolAppearsInFile("directlyDeclared", file)).toBe("declared");
  });

  it("reports absent for a name that never appears", () => {
    const file = resolvePath(REEXPORT_REPO, "packages/gamma/src/impl.ts");
    expect(symbolAppearsInFile("NoSuchThing", file)).toBe("absent");
  });
});

describe("findSymbolAcrossRepo: ambiguity is surfaced, never silently resolved", () => {
  it("returns both files when the same name is declared in two different packages", () => {
    const matches = findSymbolAcrossRepo("sharedName", AMBIGUOUS_REPO);
    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.includes("alpha"))).toBe(true);
    expect(matches.some((m) => m.includes("beta"))).toBe(true);
  });

  it("returns zero matches for a name that appears nowhere", () => {
    expect(findSymbolAcrossRepo("DefinitelyNotARealSymbolName42", AMBIGUOUS_REPO)).toEqual([]);
  });
});

describe("resolveProofComment: unverifiable must never collapse into resolved", () => {
  it("an ambiguous symbol (no file= given, 2 real matches) resolves to unverifiable, not resolved", () => {
    const proof: ObligationProofComment = { raw: "symbol=sharedName roundtrip=nonexistent.test.ts", symbol: "sharedName" };
    const result = resolveProofComment(proof, { repoRoot: AMBIGUOUS_REPO, at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol.state).toBe("unverifiable");
    expect(result.value.symbol.state).not.toBe("resolved");
    expect(result.value.fully_resolved).toBe(false);
  });

  it("a file= that does not exist makes the dependent symbol= unverifiable, not resolved and not silently missing-as-if-checked", () => {
    const proof: ObligationProofComment = {
      raw: "symbol=Whatever file=packages/nope/src/nope.ts roundtrip=nonexistent.test.ts",
      symbol: "Whatever",
      file: "packages/nope/src/nope.ts",
    };
    const result = resolveProofComment(proof, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.file?.state).toBe("missing");
    expect(result.value.symbol.state).toBe("unverifiable");
    expect(result.value.symbol.state).not.toBe("resolved");
  });
});

describe("resolveProofComment: never throws, always returns a GovernanceResult", () => {
  it("a proof comment with no fields at all resolves every field to missing", () => {
    const proof: ObligationProofComment = { raw: "" };
    const result = resolveProofComment(proof, { at: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol.state).toBe("missing");
    expect(result.value.roundtrip.state).toBe("missing");
    expect(result.value.file).toBeNull();
    expect(result.value.fully_resolved).toBe(false);
  });
});

describe("hashContent: deterministic", () => {
  it("same content hashes identically; different content hashes differently", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});
