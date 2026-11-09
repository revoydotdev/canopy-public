import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveGateSupport,
  declaredLanguages,
  censusLanguages,
  undeclaredLanguages,
  scaffoldLanguagePack,
} from "../lib/language-support.mjs";

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function repo(profile, files = {}) {
  root = mkdtempSync(join(tmpdir(), "langsup-"));
  writeFileSync(join(root, "arbor.profile.jsonc"), JSON.stringify(profile, null, 2));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const TS_ONLY = { schema_version: 1, project_id: "p", languages: [{ id: "typescript", globs: ["**/*.ts"] }], source_roots: ["src"] };

describe("ADR-143 O1 — a gate that cannot measure a language says so", () => {
  it("passes a language-agnostic gate through regardless of the repo's languages", () => {
    const support = resolveGateSupport({ gate: "gate:decision-queue", manifest: { "gate:decision-queue": { support: "language_agnostic" } }, languages: ["rust"] });
    expect(support.verdict).toBe("supported");
  });

  it("reports unsupported — never supported — when no pack covers the repo's language", () => {
    const support = resolveGateSupport({ gate: "gate:anti-stub", manifest: { "gate:anti-stub": { support: "languages", languages: ["typescript"] } }, languages: ["python"] });
    expect(support.verdict).toBe("unsupported");
    expect(support.reason).toMatch(/python/);
  });

  it("supports a gate when ANY declared language has a pack, and names the uncovered rest", () => {
    const support = resolveGateSupport({ gate: "gate:anti-stub", manifest: { "gate:anti-stub": { support: "languages", languages: ["typescript"] } }, languages: ["typescript", "python"] });
    expect(support.verdict).toBe("partial");
    expect(support.uncovered).toEqual(["python"]);
  });

  it("refuses a gate absent from the manifest rather than assuming it is agnostic", () => {
    // Omission must not be a silent pass: that is how a new gate skips the
    // declaration entirely.
    const support = resolveGateSupport({ gate: "gate:brand-new", manifest: {}, languages: ["typescript"] });
    expect(support.verdict).toBe("undeclared");
  });
});

describe("ADR-143 O2 — an undeclared language is surfaced", () => {
  it("reads the declared language set from the profile", () => {
    expect(declaredLanguages(repo(TS_ONLY))).toEqual(["typescript"]);
  });

  it("finds a language an autonomous campaign introduced", () => {
    const dir = repo(TS_ONLY, {
      "src/a.ts": "export const a = 1;\n",
      "src/helper.rs": "fn main() {}\n",
      "src/other.rs": "fn other() {}\n",
      "src/third.rs": "fn third() {}\n",
    });
    const undeclared = undeclaredLanguages(dir, { floor: 2 });
    expect(undeclared.map((u) => u.language)).toContain("rust");
    expect(undeclared.find((u) => u.language === "rust").files).toBe(3);
  });

  it("does not flag a single stray file below the materiality floor", () => {
    // One vendored fixture or example must not propose a language pack.
    const dir = repo(TS_ONLY, { "src/a.ts": "export const a = 1;\n", "src/example.rs": "fn main() {}\n" });
    expect(undeclaredLanguages(dir, { floor: 2 })).toEqual([]);
  });

  it("counts only files under the declared source roots", () => {
    const dir = repo(TS_ONLY, {
      "src/a.ts": "x",
      "vendor/one.py": "x", "vendor/two.py": "x", "vendor/three.py": "x",
    });
    expect(undeclaredLanguages(dir, { floor: 2 })).toEqual([]);
  });

  it("reports the census by language and file count", () => {
    const dir = repo(TS_ONLY, { "src/a.ts": "x", "src/b.ts": "x", "src/c.py": "x" });
    const census = censusLanguages(dir);
    expect(census.typescript).toBe(2);
    expect(census.python).toBe(1);
  });
});

describe("ADR-143 O3 — a scaffolded pack is advisory by construction", () => {
  it("cannot produce a blocking pack", () => {
    const pack = scaffoldLanguagePack({ language: "rust", files: 12 });
    expect(pack.mode).toBe("advisory");
  });

  it("has no parameter that could make it blocking", () => {
    // The harness must not be able to certify its own governance coverage, so
    // there is deliberately no `mode` input to override.
    const pack = scaffoldLanguagePack({ language: "rust", files: 12, mode: "blocking" });
    expect(pack.mode).toBe("advisory");
  });

  it("records why it is advisory, so the operator sees the promotion is theirs", () => {
    expect(scaffoldLanguagePack({ language: "go", files: 3 }).advisory_reason).toMatch(/operator/i);
  });

  it("scaffolds the fields a pack needs to be promotable", () => {
    const pack = scaffoldLanguagePack({ language: "python", files: 40 });
    expect(pack.id).toBe("python");
    expect(pack.lsp_server).toBeTruthy();
    expect(pack.globs.length).toBeGreaterThan(0);
    expect(pack.capabilities).toBeTruthy();
  });
});
