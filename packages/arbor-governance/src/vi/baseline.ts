/**
 * vi/baseline.ts — port of the revoy2-visual-intelligence skill's
 * `baseline.mjs` into `@arbor/governance`.
 *
 * WHY THIS EXISTS. `baseline.mjs`'s own header explains it best: a SKILL.md
 * used to state repository measurements inline, and every one was wrong
 * within a day, because the repository moves and a markdown file cannot.
 * The rule: describe SHAPES in prose, derive COUNTS on demand.
 *
 * SECOND RULE, learned the hard way (also from `baseline.mjs`'s header): the
 * first version of a probe there used a git pathspec that matched nothing
 * and silently printed 0 — a plausible-looking, entirely wrong number. A
 * deriver that silently emits a wrong zero is strictly worse than the
 * hardcoded number it replaced, because it carries the authority of having
 * been measured. So every probe here that CAN produce a false zero returns
 * `Probe<T>` — `{status: "measured", value}` or `{status: "unmeasured",
 * reason}` — never a bare number it cannot stand behind. This is the same
 * discipline the original script's `UNMEASURED` sentinel enforced, now
 * typed as a discriminated union instead of a magic value.
 *
 * DEDUPLICATION. `baseline.mjs` re-derived several quantities `@arbor/
 * governance`'s `deriveRepositoryCounts` (counts/derive.ts) already owns:
 * waiver count, ADR count, and RUNTIME_CATALOG kind count. This module
 * consumes `deriveRepositoryCounts` for those three fields instead of
 * re-walking the filesystem a second time — two counts derivers in one
 * repository was the duplication this port exists to remove. Every OTHER
 * probe below has no equivalent in derive.ts and is kept, ported as-is.
 *
 * ONE HONESTY GAP CARRIED OVER FROM CONSUMING derive.ts, reported here
 * rather than silently absorbed: `deriveRepositoryCounts`'s `adr_total`,
 * `catalog_kinds`, and `allowlist_entries` all fall back to a bare `0` on a
 * missing/unreadable source file (see derive.ts's own try/catch blocks),
 * whereas this module's remaining probes report `UNMEASURED` for the
 * equivalent failure. Consuming derive.ts for those three fields therefore
 * makes `waivers_total`, `adrs_total`, and `runtime_catalog_kinds`
 * genuinely LESS honest than the script they replace, which explicitly
 * detected "RUNTIME_CATALOG literal not found" as its own UNMEASURED case.
 * In today's repository this is not observable (all three sources exist and
 * measure non-zero), but the discrepancy is real and belongs to derive.ts,
 * not to this module — flagged in this port's final report rather than
 * fixed here, since derive.ts is outside this file's ownership.
 */

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { deriveRepositoryCounts } from "../counts/derive.js";
import type { AllowlistEntry } from "./exceptions.js";

/** A measurement this module can stand behind, or an honest refusal with why not. Never a magic -1/null. */
export type Probe<T> =
  | { readonly status: "measured"; readonly value: T }
  | { readonly status: "unmeasured"; readonly reason: string };

function measured<T>(value: T): Probe<T> {
  return { status: "measured", value };
}

function unmeasured<T>(reason: string): Probe<T> {
  return { status: "unmeasured", reason };
}

const ALLOWLIST_PATH = "scripts/reachability/allowlist.json";
const DECISIONS_DIR = "decisions";
/**
 * Default gap-register path, overridable via `DeriveBaselineOptions.gapRegisterPath`.
 *
 * Deliberately NOT threaded from `arbor.profile.jsonc`, unlike `allowlistPath`
 * and `decisionsDir`. Those name a structural fact every ADR-073-conformant
 * project has (a waiver store, a decisions directory); `audit/10-gap-register.md`
 * is not that — it is a revoy2-specific document (this repo's own numbered
 * audit convention), and there is no reason to believe a sibling project has
 * an equivalent artifact at all, let alone one that should be POINTED AT
 * rather than simply absent. The option exists so a caller with a
 * differently-located register can still supply it, but the honesty
 * discipline this module already enforces — `probeWaiverAuthority` reports
 * `unmeasured` rather than a false zero when the register can't be read (see
 * `knownGapIdsFromRegister`, which distinguishes "missing" from "empty") — is
 * what makes leaving it un-schematized safe: a foreign project with no gap
 * register degrades to an honest "can't measure this," not a wrong number.
 */
const GAP_REGISTER_PATH = "audit/10-gap-register.md";
/**
 * Default ROADMAP.md path, overridable via `DeriveBaselineOptions.roadmapPath`.
 * Same reasoning as `GAP_REGISTER_PATH` above and `vi/exceptions.ts`'s
 * `ROADMAP_PATH`: a roadmap is not a fact every governed project has, so this
 * stays an option with a default rather than a profile field.
 * `probeRoadmapProofComments` already reports `unmeasured` (not `0`) when
 * this path is unreadable.
 */
const ROADMAP_PATH = "ROADMAP.md";
const ENTRY_POINTS_PATH = "scripts/reachability/entry-points.json";
const SRC_PATHSPEC = "packages/*/src/**";

export interface RepositoryBaseline {
  /** == deriveRepositoryCounts(repoRoot).allowlist_entries. */
  readonly waivers_total: number;
  readonly waivers_unowned: Probe<number>;
  readonly waivers_expired: Probe<number>;
  /** == deriveRepositoryCounts(repoRoot).adr_total. */
  readonly adrs_total: number;
  readonly waivers_authority_unresolved: Probe<number>;
  /** Each entry "G-NN(xM)" — a G-id cited by M waivers but absent from the gap register. */
  readonly waiver_gaps_dangling: Probe<readonly string[]>;
  readonly adrs_uncited_from_src: Probe<number>;
  readonly adr_citations_dangling: Probe<readonly string[]>;
  readonly roadmap_proof_comments: Probe<number>;
  readonly persist_ts_files: Probe<number>;
  /** == deriveRepositoryCounts(repoRoot).catalog_kinds. See module header re: the honesty gap this inherits. */
  readonly runtime_catalog_kinds: number;
  readonly entry_points: Probe<number>;
  readonly type_only_whole_clause: Probe<number>;
  readonly type_only_inline_files: number;
}

export interface DeriveBaselineOptions {
  /** "YYYY-MM-DD". Expiry comparisons are relative to this — this module reads no clock of its own. */
  readonly today: string;
  /**
   * Repo-relative path to the waiver allowlist —
   * `arbor.profile.jsonc`'s `governance.allowlist_path`. Defaults to
   * `ALLOWLIST_PATH`, matching this module's prior hardcoded behavior.
   */
  readonly allowlistPath?: string;
  /**
   * Repo-relative directory holding this project's ADR/decision records —
   * `arbor.profile.jsonc`'s `governance.decisions_dir`. Defaults to
   * `DECISIONS_DIR` (`"decisions"`), matching this module's prior hardcoded
   * behavior.
   */
  readonly decisionsDir?: string;
  /**
   * Repo-relative path to the gap register `knownGapIdsFromRegister` mines
   * for `G-\d+` ids. Defaults to `GAP_REGISTER_PATH`
   * (`"audit/10-gap-register.md"`), so an omitted option behaves exactly as
   * before this option existed. Deliberately NOT a profile field — see
   * `GAP_REGISTER_PATH`'s doc comment for why.
   */
  readonly gapRegisterPath?: string;
  /**
   * Repo-relative path to the roadmap document `probeRoadmapProofComments`
   * reads. Defaults to `ROADMAP_PATH` (`"ROADMAP.md"`), so an omitted option
   * behaves exactly as before this option existed. Deliberately NOT a
   * profile field — see `ROADMAP_PATH`'s doc comment for why.
   */
  readonly roadmapPath?: string;
}

function readAllowlistEntries(repoRoot: string, allowlistPath: string): readonly AllowlistEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, allowlistPath), "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as AllowlistEntry[]) : null;
  } catch {
    return null;
  }
}

/** ADR ids known from decisions/ — any digit width, matching baseline.mjs's own (looser) pattern, deliberately NOT exceptions.ts's 3-digit-only pattern. See exceptions.ts's knownAuthorityIds doc for why the two are kept distinct. */
function knownAdrIds(repoRoot: string, decisionsDir: string): ReadonlySet<string> {
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(repoRoot, decisionsDir))) {
      const m = /^(ADR-\d+)/.exec(name);
      if (m) ids.add(m[1]);
    }
  } catch {
    // no decisions/ — nothing to add
  }
  return ids;
}

/** G-ids known from the gap register. `null` (not empty-set) when the register is missing or names none — that distinction matters to the caller. */
function knownGapIdsFromRegister(repoRoot: string, gapRegisterPath: string): ReadonlySet<string> | null {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, gapRegisterPath), "utf8");
  } catch {
    return null;
  }
  const ids = new Set([...text.matchAll(/\bG-\d+\b/g)].map((m) => m[0]));
  return ids.size > 0 ? ids : null;
}

/** git grep respects .gitignore and never walks node_modules. Empty result is a finding, not an error — callers decide whether empty is plausible. */
function gitGrepLines(repoRoot: string, args: readonly string[]): string[] {
  try {
    return execFileSync("git", ["grep", ...args], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function probeWaiverOwnership(entries: readonly AllowlistEntry[] | null, allowlistPath: string): Probe<number> {
  if (entries === null) return unmeasured(`${allowlistPath} unreadable`);
  return measured(entries.filter((e) => !e.owner).length);
}

function probeWaiverExpiry(entries: readonly AllowlistEntry[] | null, today: string, allowlistPath: string): Probe<number> {
  if (entries === null) return unmeasured(`${allowlistPath} unreadable`);
  return measured(entries.filter((e) => !!e.expires && e.expires < today).length);
}

/**
 * Authority resolves only if the gap tag names a record this repo can
 * produce: an ADR file, or a row in the gap register. A bare dated tag
 * resolves to nothing, and a G-id above the register's high-water mark
 * resolves to nothing either — that second case is the one worth catching,
 * because it LOOKS valid.
 *
 * NOTE (ported faithfully from baseline.mjs): this checks `e.gap` only, NOT
 * `e.gap ?? e.adr` the way exceptions.ts's authority resolution does. That
 * asymmetry existed in the original two scripts and is preserved here
 * rather than silently unified — see this port's final report.
 */
function probeWaiverAuthority(
  repoRoot: string,
  entries: readonly AllowlistEntry[] | null,
  allowlistPath: string,
  decisionsDir: string,
  gapRegisterPath: string,
): { authorityUnresolved: Probe<number>; gapsDangling: Probe<readonly string[]> } {
  if (entries === null) {
    const reason = `${allowlistPath} unreadable`;
    return { authorityUnresolved: unmeasured(reason), gapsDangling: unmeasured(reason) };
  }

  const adrIds = knownAdrIds(repoRoot, decisionsDir);
  const gapIds = knownGapIdsFromRegister(repoRoot, gapRegisterPath);
  if (!gapIds) {
    return {
      authorityUnresolved: unmeasured(`${gapRegisterPath} missing or contains no G-ids`),
      gapsDangling: unmeasured("gap register unreadable"),
    };
  }

  const resolves = (g: string | undefined): boolean => !!g && (adrIds.has(g) || gapIds.has(g));
  const unresolved = entries.filter((e) => !resolves(e.gap)).length;

  const dangling = new Map<string, number>();
  for (const e of entries) {
    if (e.gap && /^G-\d+$/.test(e.gap) && !gapIds.has(e.gap)) {
      dangling.set(e.gap, (dangling.get(e.gap) ?? 0) + 1);
    }
  }
  const danglingList = [...dangling.entries()].map(([g, n]) => `${g}(x${n})`).sort();

  return { authorityUnresolved: measured(unresolved), gapsDangling: measured(danglingList) };
}

function probeAdrCitations(
  repoRoot: string,
  adrIds: ReadonlySet<string>,
): { uncited: Probe<number>; dangling: Probe<readonly string[]> } {
  const cited = new Set(gitGrepLines(repoRoot, ["-ohE", "ADR-[0-9]{3}", "--", SRC_PATHSPEC]).map((s) => s.trim()));
  if (cited.size === 0) {
    return {
      uncited: unmeasured("zero ADR citations found in src — probe likely broken"),
      dangling: unmeasured("same probe"),
    };
  }
  const uncited = [...adrIds].filter((id) => !cited.has(id)).length;
  const dangling = [...cited].filter((id) => !adrIds.has(id)).sort();
  return { uncited: measured(uncited), dangling: measured(dangling) };
}

function probeRoadmapProofComments(repoRoot: string, roadmapPath: string): Probe<number> {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, roadmapPath), "utf8");
  } catch {
    return unmeasured(`${roadmapPath} unreadable`);
  }
  return measured((text.match(/<!--\s*proof:/g) ?? []).length);
}

function probePersistTsFiles(repoRoot: string): Probe<number> {
  const files = gitGrepLines(repoRoot, ["-l", "", "--", "packages/*/src/persist.ts"]);
  return files.length > 0 ? measured(files.length) : unmeasured("no persist.ts matched — pathspec suspect");
}

function probeEntryPoints(repoRoot: string): Probe<number> {
  let parsed: { entryPoints?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, ENTRY_POINTS_PATH), "utf8")) as { entryPoints?: unknown };
  } catch {
    return unmeasured(`${ENTRY_POINTS_PATH} unreadable`);
  }
  return Array.isArray(parsed.entryPoints)
    ? measured(parsed.entryPoints.length)
    : unmeasured("entry-points.json has no entryPoints array");
}

function probeTypeOnlyWholeClause(repoRoot: string): Probe<number> {
  const lines = gitGrepLines(repoRoot, ["-c", "^import type ", "--", SRC_PATHSPEC]);
  const total = lines.reduce((n, l) => n + Number(l.split(":").pop() || 0), 0);
  return total > 0 ? measured(total) : unmeasured("zero whole-clause type imports — pathspec suspect");
}

/** Note a mixed `import { type A, b }` is NOT erasing — b is a real value. Not zero-guarded like its whole-clause sibling: an inline-only repo genuinely can have zero such files. */
function countTypeOnlyInlineFiles(repoRoot: string): number {
  return gitGrepLines(repoRoot, ["-lE", "^import \\{[^}]*\\btype ", "--", SRC_PATHSPEC]).length;
}

/**
 * Derive the current revoy2 baseline measurements. Pure function of
 * `repoRoot`'s on-disk content plus the supplied `today` — no clock, no
 * write, no `process.cwd()`. Every probe that can produce a false zero
 * reports `Probe<T>`'s `unmeasured` branch instead of guessing.
 */
export function deriveRepositoryBaseline(repoRoot: string, options: DeriveBaselineOptions): RepositoryBaseline {
  const allowlistPath = options.allowlistPath ?? ALLOWLIST_PATH;
  const decisionsDir = options.decisionsDir ?? DECISIONS_DIR;
  const gapRegisterPath = options.gapRegisterPath ?? GAP_REGISTER_PATH;
  const roadmapPath = options.roadmapPath ?? ROADMAP_PATH;
  const counts = deriveRepositoryCounts(repoRoot, { allowlistPath, decisionsDir });
  const entries = readAllowlistEntries(repoRoot, allowlistPath);
  const adrIds = knownAdrIds(repoRoot, decisionsDir);
  const authority = probeWaiverAuthority(repoRoot, entries, allowlistPath, decisionsDir, gapRegisterPath);
  const citations = probeAdrCitations(repoRoot, adrIds);

  return {
    waivers_total: counts.allowlist_entries,
    waivers_unowned: probeWaiverOwnership(entries, allowlistPath),
    waivers_expired: probeWaiverExpiry(entries, options.today, allowlistPath),
    adrs_total: counts.adr_total,
    waivers_authority_unresolved: authority.authorityUnresolved,
    waiver_gaps_dangling: authority.gapsDangling,
    adrs_uncited_from_src: citations.uncited,
    adr_citations_dangling: citations.dangling,
    roadmap_proof_comments: probeRoadmapProofComments(repoRoot, roadmapPath),
    persist_ts_files: probePersistTsFiles(repoRoot),
    runtime_catalog_kinds: counts.catalog_kinds,
    entry_points: probeEntryPoints(repoRoot),
    type_only_whole_clause: probeTypeOnlyWholeClause(repoRoot),
    type_only_inline_files: countTypeOnlyInlineFiles(repoRoot),
  };
}
