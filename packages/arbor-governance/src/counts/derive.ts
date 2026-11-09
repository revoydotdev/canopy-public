/**
 * derive.ts — derive the counted facts that keep drifting into stale prose.
 *
 * The audit (this branch's dispatch brief) found the SAME defect five times:
 * a derived fact was counted once, by hand, then copied into prose, and the
 * two drifted apart the moment the repository changed underneath the prose.
 * Every quantity here is computed FROM THE REPOSITORY on every call — never
 * cached, never hand-maintained — so a document claiming a number can be
 * checked against a live measurement (see check.ts) instead of another
 * person's memory of a measurement.
 *
 * Purity: every function in this module is a pure function of `repoRoot`'s
 * on-disk content. No `Date`, no `process.env`, no network. Calling
 * `deriveRepositoryCounts` twice against the same checkout returns a
 * deep-equal result (tests/counts/derive.test.ts asserts this).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { catalogKinds, readRuntimeCatalog } from "./catalog.ts";

/**
 * Quantities whose source could not be read, so the number beside them is not a
 * measurement.
 *
 * Every probe below used to `return 0` when its source file was missing or
 * unparseable. That is the absence-as-zero defect this repository's governing
 * principle forbids — "a missing measurement is a typed `unavailable`, never a
 * zero" — and it sat in the module that enforces documentation honesty.
 *
 * The consequence was not cosmetic. `checkCounts` compares prose against these
 * numbers: if `runtime-catalog.ts` were ever moved or renamed, `catalog_kinds`
 * would silently become 0, SUR-05 would flag every document stating a kind count
 * as drifted, and its remediation string would instruct the reader to **write
 * 0**. A gate that tells you to replace a true number with a false one is worse
 * than no gate.
 *
 * Found by the port of `baseline.mjs`, whose own probes had this right:
 * they reported UNMEASURED rather than a number they could not stand behind.
 * Delegating to this module would have made the ported code *less* honest than
 * the script it replaced.
 */
export type UnmeasuredQuantity = keyof Omit<RepositoryCounts, "unmeasured">;

export interface RepositoryCounts {
  /**
   * Names of the fields below whose source was unreadable. Empty is the normal
   * case. A field listed here carries `0`, and that `0` means "not known",
   * never "none" — consumers must treat it as absent rather than compare it.
   */
  unmeasured: readonly UnmeasuredQuantity[];
  /** Durable allocations in decisions/registry.json; pending drafts are excluded. */
  adr_total: number;
  /** Distinct `kind: "..."` string literals inside RUNTIME_CATALOG's array literal. */
  catalog_kinds: number;
  /** packages/*\/src/**\/*.{ts,tsx}, excluding .d.ts. */
  src_files: number;
  /** Top-level directories under packages/. */
  packages: number;
  /** packages/*\/tests/**\/*.test.ts plus scripts/tests/**\/*.test.mjs — vitest.config.ts's own `include` globs. */
  test_files: number;
  /** scripts/reachability/allowlist.json's `.entries` array length. */
  allowlist_entries: number;
}

function listDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(dir: string, matches: (name: string) => boolean, out: string[]): void {
  for (const entry of listDirEntries(dir).sort()) {
    const full = join(dir, entry);
    if (isDirectory(full)) {
      walkFiles(full, matches, out);
    } else if (matches(entry)) {
      out.push(full);
    }
  }
}

function countAdrTotal(repoRoot: string, decisionsDir: string, unmeasured: UnmeasuredQuantity[]): number {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, decisionsDir, "registry.json"), "utf8")) as { allocations?: unknown[] };
    if (!Array.isArray(parsed.allocations)) throw new Error("missing allocations");
    return parsed.allocations.length;
  } catch {
    unmeasured.push("adr_total");
    return 0;
  }
}

/**
 * Count the catalog's distinct `kind` values through the ONE reader
 * (`./catalog.ts`), and report `unmeasured` rather than a zero whenever the
 * catalog cannot be resolved to an array literal.
 *
 * The distinct-kind count — not the entry count — is deliberate and is this
 * consumer's own historical semantics: `derive.ts` has always counted a SET of
 * `kind` literals, and the other two consumers count entries. On today's corpus
 * the two agree (no kind repeats), which is exactly why the divergence was
 * invisible; `catalogKinds` keeps the difference named instead of flattened.
 *
 * The alias hop lives in the reader. It has to: this function once followed
 * `RUNTIME_CATALOG` with a regex scan over every `<sourceRoot>/*\/src` tree and
 * a one-step hop of its own, which is a THIRD resolution algorithm that agreed
 * with the others only by coincidence.
 */
function countCatalogKinds(
  repoRoot: string,
  catalogRelPath: string,
  unmeasured: UnmeasuredQuantity[],
  sourceRoots: readonly string[],
): number {
  const read = readRuntimeCatalog({ repoRoot, catalogPath: catalogRelPath, sourceRoots });
  if (!read.measured) {
    unmeasured.push("catalog_kinds");
    return 0;
  }
  return catalogKinds(read).length;
}

function countSrcFiles(repoRoot: string, sourceRoots: readonly string[]): number {
  let total = 0;
  for (const root of sourceRoots) {
    const rootDir = join(repoRoot, root);
    for (const pkg of listDirEntries(rootDir).sort()) {
      const srcDir = join(rootDir, pkg, "src");
      if (!isDirectory(srcDir)) continue;
      const files: string[] = [];
      walkFiles(srcDir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"), files);
      total += files.length;
    }
  }
  return total;
}

function countPackages(repoRoot: string, sourceRoots: readonly string[]): number {
  let total = 0;
  for (const root of sourceRoots) {
    const rootDir = join(repoRoot, root);
    total += listDirEntries(rootDir).filter((entry) => isDirectory(join(rootDir, entry))).length;
  }
  return total;
}

function countTestFiles(repoRoot: string, sourceRoots: readonly string[], scriptsTestsRelDir: string): number {
  const files: string[] = [];
  for (const root of sourceRoots) {
    const rootDir = join(repoRoot, root);
    for (const pkg of listDirEntries(rootDir).sort()) {
      const testsDir = join(rootDir, pkg, "tests");
      if (isDirectory(testsDir)) walkFiles(testsDir, (name) => name.endsWith(".test.ts"), files);
    }
  }
  const scriptsTestsDir = join(repoRoot, scriptsTestsRelDir);
  if (isDirectory(scriptsTestsDir)) walkFiles(scriptsTestsDir, (name) => name.endsWith(".test.mjs"), files);
  return files.length;
}

function countAllowlistEntries(repoRoot: string, allowlistRelPath: string, unmeasured: UnmeasuredQuantity[]): number {
  const allowlistPath = join(repoRoot, allowlistRelPath);
  try {
    const parsed = JSON.parse(readFileSync(allowlistPath, "utf8")) as { entries?: unknown[] };
    if (!Array.isArray(parsed.entries)) {
      // A file that parsed but has no `entries` array is a shape we do not
      // understand, not an allowlist with nothing in it.
      unmeasured.push("allowlist_entries");
      return 0;
    }
    return parsed.entries.length;
  } catch {
    unmeasured.push("allowlist_entries");
    return 0;
  }
}

/** Options controlling where `deriveRepositoryCounts` looks for the waiver allowlist. */
export interface DeriveRepositoryCountsOptions {
  /**
   * Repo-relative path to the waiver allowlist —
   * `arbor.profile.jsonc`'s `governance.allowlist_path`. Defaults to
   * `"scripts/reachability/allowlist.json"`, revoy2's own convention, so an
   * omitted option behaves exactly as before this option existed.
   */
  readonly allowlistPath?: string;
  /**
   * Repo-relative decisions directory, from `arbor.profile.jsonc`'s
   * `governance.decisions_dir`. Defaults to `"decisions"`, revoy2's own
   * convention, so an omitted option behaves exactly as before. Without it a
   * project naming the directory differently could not have its ADRs counted
   * at all: `countAdrTotal` would fail to read the registry and — correctly,
   * not silently — report `adr_total` as `unmeasured` rather than as a real
   * zero. So this closes an inability to measure, not a false measurement.
   */
  readonly decisionsDir?: string;
  /**
   * Repo-relative directories the migrated gates treat as source roots —
   * `arbor.profile.jsonc`'s `source_roots` (ADR-073). Defaults to
   * `["packages"]`, revoy2's own convention, so an omitted option behaves
   * exactly as before. `countSrcFiles`, `countPackages`, and `countTestFiles`
   * all walk `<root>/*\/src` and `<root>/*\/tests` under EVERY listed root —
   * a foreign project whose sources live in `src/` rather than `packages/`
   * (`source_roots: ["src"]`) previously had its symbols silently missed:
   * `countSrcFiles`/`countPackages` would find no `packages/` directory and
   * return a real, indistinguishable-from-honest `0`, not `unmeasured`. That
   * was the false-zero defect Roadmap 23 §5 names as the whole risk of this
   * migration — it looked exactly like a correct measurement of an empty
   * project. Threading `sourceRoots` fixes the false zero at its source
   * (the fixture now IS found) rather than merely relabeling it `unmeasured`.
   */
  readonly sourceRoots?: readonly string[];
  /**
   * Repo-relative directory of non-package-scoped test files, counted
   * alongside `<sourceRoot>/*\/tests/**\/*.test.ts`. Defaults to
   * `"scripts/tests"`, revoy2's own convention. Deliberately NOT part of
   * `source_roots`: it is not a source tree at all — no package lives under
   * it — so folding it into `sourceRoots` would assert a fact about a
   * "scripts" source root that does not exist. A foreign project may have no
   * such directory (or a differently-named one); this option lets it say so
   * without contorting `source_roots` to cover a directory it does not mean.
   */
  readonly scriptsTestsDir?: string;
  /**
   * Repo-relative path to the file `countCatalogKinds` parses for
   * `RUNTIME_CATALOG`'s `kind: "..."` literals. Defaults to
   * `"packages/arbor-mcp/src/runtime-catalog.ts"` — this repo's specific
   * runtime-catalog module. Unlike `sourceRoots`, this is not a `source_roots`
   * consumer: it names one particular file inside one particular package
   * (`arbor-mcp`), not a directory convention every ADR-073-conformant
   * project shares. A foreign project has no `arbor-mcp` and no
   * `RUNTIME_CATALOG` to count; there is no generalizable fact to assert in
   * the profile schema for it. Following the precedent set for
   * `ROADMAP.md`/`audit/` (commit 169f6699): removing the hardcoding without
   * inventing a schema fact that doesn't generalize is the honest middle —
   * so this becomes an option, defaulting to today's literal, rather than a
   * profile field.
   */
  readonly catalogPath?: string;
}

/** Derive every counted quantity fresh from `repoRoot`. Pure: no clock, no env, deterministic. */
export function deriveRepositoryCounts(repoRoot: string, options: DeriveRepositoryCountsOptions = {}): RepositoryCounts {
  const allowlistPath = options.allowlistPath ?? "scripts/reachability/allowlist.json";
  const decisionsDir = options.decisionsDir ?? "decisions";
  const sourceRoots = options.sourceRoots ?? ["packages"];
  const scriptsTestsDir = options.scriptsTestsDir ?? "scripts/tests";
  const catalogPath = options.catalogPath ?? "packages/arbor-mcp/src/runtime-catalog.ts";
  const unmeasured: UnmeasuredQuantity[] = [];
  const adrTotal = countAdrTotal(repoRoot, decisionsDir, unmeasured);
  const packages = countPackages(repoRoot, sourceRoots);
  if (packages === 0 && !sourceRoots.some((root) => isDirectory(join(repoRoot, root)))) unmeasured.push("packages");

  return {
    adr_total: adrTotal,
    catalog_kinds: countCatalogKinds(repoRoot, catalogPath, unmeasured, sourceRoots),
    src_files: countSrcFiles(repoRoot, sourceRoots),
    packages,
    test_files: countTestFiles(repoRoot, sourceRoots, scriptsTestsDir),
    allowlist_entries: countAllowlistEntries(repoRoot, allowlistPath, unmeasured),
    unmeasured,
  };
}
