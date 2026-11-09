/**
 * Arboretum M2: the stop-tier battery is scheduled by the inputs each gate
 * DECLARES, against the paths this session changed, and a red that was red
 * before the session began is attributed to an OWNED baseline-debt record
 * instead of to the session.
 *
 * ============================================================================
 * WHY THE HARNESS DECIDES, NOT `gate-all.mjs`. ADR-177 decision 4 puts "when a
 * gate runs" in the harness. `gate-all.mjs` keeps sole ownership of the roster
 * (which gates are in the stop tier at all); this module only names gates to
 * schedule OUT, and passes them as `--skip`. A gate this module has never heard
 * of therefore still runs: the failure direction of a stale or partial view is
 * "ran something unnecessary", never "skipped something it should have run".
 *
 * ============================================================================
 * AN UNDECLARED GATE ALWAYS RUNS. A gate with no `inputs` in
 * `scripts/execution-profile.json` has an unknown read-set, and an unknown set
 * is treated as everything. Declaring inputs is an opt-in a reviewer can check
 * against the gate's source; inferring them is not offered.
 *
 * DECLARED INPUTS ARE WIDENED, NEVER NARROWED. Every declared gate also reads:
 * the battery's own roster and profile files (`STOP_SCOPE_UNIVERSAL_INPUTS`),
 * its own entry script, and that script's static import closure — relative
 * imports followed transitively, `@arbor/<pkg>` imports widened to the whole
 * workspace package. Editing a gate's implementation therefore re-runs it even
 * when the gate's declaration names only its data.
 *
 * ============================================================================
 * THE CHANGED SET IS A SUPERSET, AND SAYS WHEN IT IS NOT COMPLETE. It is the
 * union of: uncommitted and untracked paths (`git status`), paths committed
 * since the session's base revision (`git diff base HEAD`), and
 * `.visual-intelligence/.dirty`, which the native `observe.vi-dirty-tracker`
 * writes for every path a file tool attempted. Any git failure marks the set
 * incomplete, and an incomplete set schedules nothing out.
 *
 * The honest ceiling: a gate whose verdict depends on something that is not a
 * repository path — wall-clock expiry, the git common dir, another process's
 * evidence transaction — must stay undeclared, and does. A path written by a
 * shell command and committed before the session's FIRST turn boundary is
 * outside the base this module records. Neither weakens a push: prepush and CI
 * select gates from the profile and never consult this schedule.
 *
 * ============================================================================
 * BASELINE DEBT IS OWNED AND WITNESSED, NOT ASSERTED. `scripts/stop-guard/
 * debt.json` is written only by `scripts/stop-guard-debt.mjs open`, which
 * refuses a dirty tree and refuses a gate it cannot observe red at HEAD, and
 * requires an owning decision record that exists. The battery only READS it.
 * An entry that does not validate is dropped with a problem line, so a broken
 * record can only make a red block, never hide one.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import type { GitAdapter } from "../git-workspace-projection.js";

/** Files every declared gate reads by construction: the roster, the profile, the battery and its shared libraries. */
export const STOP_SCOPE_UNIVERSAL_INPUTS: readonly string[] = Object.freeze([
  "package.json",
  "bun.lock",
  "scripts/execution-profile.json",
  "scripts/gate-all.mjs",
  "scripts/gate-manifest.json",
  "scripts/lib/**",
]);

/** Repository-relative location of the owned baseline-debt record. */
export const STOP_DEBT_PATH = "scripts/stop-guard/debt.json";
export const STOP_DEBT_KIND = "revoy2.stop_baseline_debt";

const VI_DIRTY = ".visual-intelligence/.dirty";

// --- globs ------------------------------------------------------------------

/**
 * A repository-relative POSIX glob as a RegExp. `**` crosses directories, `*`
 * and `?` do not, and a pattern with no wildcard matches exactly that path or
 * anything beneath it when it names a directory.
 */
export function inputGlobToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slashAfter = pattern[index + 2] === "/";
        source += slashAfter ? "(?:.*/)?" : ".*";
        index += slashAfter ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const literal = !/[*?]/.test(pattern);
  return new RegExp(literal ? `^${source}(?:/.*)?$` : `^${source}$`);
}

export function matchesAnyInput(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => inputGlobToRegExp(pattern).test(path));
}

// --- the changed set ----------------------------------------------------------

export interface ChangedPathSet {
  readonly paths: readonly string[];
  /** False when any source could not be read; an incomplete set schedules nothing out. */
  readonly complete: boolean;
  readonly problems: readonly string[];
}

/** Paths from `git status --porcelain=v1 -z`, both sides of a rename or copy. */
export function parsePorcelainZ(output: string): readonly string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    paths.push(record.slice(3));
    if (xy.includes("R") || xy.includes("C")) {
      const original = records[index + 1];
      if (original !== undefined && original !== "") paths.push(original);
      index += 1;
    }
  }
  return paths;
}

/**
 * The union described in the header. `porcelain` lets the caller reuse the
 * status output it already spawned for its cache key.
 */
export function changedPathsSince(git: GitAdapter, root: string, base: string | null, head: string, porcelain?: string): ChangedPathSet {
  const problems: string[] = [];
  const paths = new Set<string>();
  let statusOutput = porcelain;
  if (statusOutput === undefined) {
    const status = git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.ok) statusOutput = status.stdout;
    else problems.push(`git status failed (exit ${String(status.exit_code)})`);
  }
  for (const path of parsePorcelainZ(statusOutput ?? "")) paths.add(path);
  if (base !== null && base !== head) {
    const diff = git.run(["diff", "--name-only", "-z", base, head]);
    if (diff.ok) for (const path of diff.stdout.split("\0")) { if (path !== "") paths.add(path); }
    else problems.push(`git diff ${base.slice(0, 12)}..${head.slice(0, 12)} failed (exit ${String(diff.exit_code)})`);
  }
  try {
    for (const line of readFileSync(join(root, VI_DIRTY), "utf8").split("\n")) { if (line.trim() !== "") paths.add(line.trim()); }
  } catch { /* absent .dirty is an empty contribution: the tracker writes it on the first tool write */ }
  return Object.freeze({ paths: Object.freeze([...paths].sort()), complete: problems.length === 0, problems: Object.freeze(problems) });
}

// --- per-gate inputs ------------------------------------------------------------

interface ProfileGateEntry {
  readonly cost_class?: unknown;
  readonly contexts?: { readonly stop?: unknown };
  readonly inputs?: unknown;
}

export interface StopScopeProfile {
  readonly gates: Readonly<Record<string, ProfileGateEntry>>;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Workspace package name -> repository-relative directory, from the root manifest's `workspaces`. */
export function workspacePackageDirs(root: string, packageJson: { readonly workspaces?: unknown }): ReadonlyMap<string, string> {
  const dirs = new Map<string, string>();
  const workspaces = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [];
  for (const dir of workspaces) {
    if (typeof dir !== "string") continue;
    try {
      const name = (JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { name?: unknown }).name;
      if (typeof name === "string") dirs.set(name, dir);
    } catch { /* an unreadable workspace manifest contributes no mapping; its imports widen nothing */ }
  }
  return dirs;
}

const toRepoPath = (root: string, absolute: string): string | null => {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
};

/**
 * The gate's entry script and its static import closure, as patterns. Entry
 * scripts are the `scripts/` or `packages/` source paths named in its
 * package.json command.
 */
export function gateImplicitInputs(root: string, command: string, packageDirs: ReadonlyMap<string, string>): readonly string[] {
  const found = new Set<string>(STOP_SCOPE_UNIVERSAL_INPUTS);
  const queue: string[] = [];
  for (const token of command.split(/\s+/)) {
    if (/^(?:scripts|packages)\/\S+\.(?:mjs|cjs|js|ts|mts)$/.test(token)) queue.push(normalize(token).split(sep).join("/"));
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    found.add(file);
    let text: string;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] as string;
      if (specifier.startsWith(".")) {
        let target = toRepoPath(root, join(root, dirname(file), specifier));
        if (target === null) continue;
        if (!existsSync(join(root, target)) && target.endsWith(".js") && existsSync(join(root, `${target.slice(0, -3)}.ts`))) target = `${target.slice(0, -3)}.ts`;
        queue.push(target);
        continue;
      }
      const workspace = [...packageDirs.entries()].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
      if (workspace !== undefined) found.add(`${workspace[1]}/**`);
    }
  }
  return Object.freeze([...found].sort());
}

export interface ScheduledOut {
  readonly gate: string;
  readonly reason: string;
}

export interface StopSchedule {
  /** Gates to pass as `--skip`. */
  readonly skip: readonly ScheduledOut[];
  /** Stop-context gates with no `inputs` declaration, which therefore always run. */
  readonly undeclared: readonly string[];
  /** Why nothing was scheduled out, when nothing was. */
  readonly ran_everything_because: string | null;
}

/**
 * Which stop-context gates the changed set leaves untouched. Only gates whose
 * profile entry declares `inputs` are ever candidates.
 */
export function scheduleStopGates(args: {
  readonly root: string;
  readonly profile: StopScopeProfile;
  readonly packageJson: { readonly scripts?: Readonly<Record<string, string>>; readonly workspaces?: unknown };
  readonly changed: ChangedPathSet;
}): StopSchedule {
  const stopGates = Object.entries(args.profile.gates).filter(([, entry]) => entry.contexts?.stop === true).sort(([a], [b]) => a.localeCompare(b));
  const undeclared = stopGates.filter(([, entry]) => !Array.isArray(entry.inputs)).map(([name]) => name);
  if (!args.changed.complete) {
    return Object.freeze({ skip: Object.freeze([]), undeclared: Object.freeze(undeclared), ran_everything_because: `the changed-path set is incomplete: ${args.changed.problems.join("; ")}` });
  }
  const packageDirs = workspacePackageDirs(args.root, args.packageJson);
  const skip: ScheduledOut[] = [];
  for (const [name, entry] of stopGates) {
    if (!Array.isArray(entry.inputs)) continue;
    const declared = entry.inputs.filter((value): value is string => typeof value === "string" && value !== "");
    const command = args.packageJson.scripts?.[name];
    if (command === undefined) continue;
    const patterns = [...declared, ...gateImplicitInputs(args.root, command, packageDirs)];
    if (!args.changed.paths.some((path) => matchesAnyInput(patterns, path))) {
      skip.push(Object.freeze({ gate: name, reason: `none of its ${declared.length} declared input(s) or its implementation changed` }));
    }
  }
  return Object.freeze({ skip: Object.freeze(skip), undeclared: Object.freeze(undeclared), ran_everything_because: null });
}

/** A stable digest of what the schedule was computed from, for the verdict's cache key. */
export function changedSetDigest(changed: ChangedPathSet): string {
  return createHash("sha256").update(JSON.stringify([changed.complete, changed.paths])).digest("hex").slice(0, 16);
}

// --- owned baseline debt --------------------------------------------------------

export interface DebtEntry {
  readonly gate: string;
  readonly owner: string;
  readonly reason: string;
  readonly opened_at: string;
  readonly opened_at_revision: string;
  readonly observed_exit_code: number;
}

export interface BaselineDebt {
  readonly entries: readonly DebtEntry[];
  readonly problems: readonly string[];
}

const OWNER_RE = /^ADR-(?:\d{3,}|PENDING-[a-z0-9][a-z0-9-]*)$/;

/** Whether an owner names a decision record that exists in `decisions/`. */
export function debtOwnerExists(root: string, owner: string): boolean {
  if (!OWNER_RE.test(owner)) return false;
  try {
    return readdirSync(join(root, "decisions")).some((name) => owner.startsWith("ADR-PENDING-") ? name === `${owner}.md` : name.startsWith(`${owner}-`) && name.endsWith(".md"));
  } catch { return false; }
}

/**
 * The debt record, validated entry by entry. An absent file is no debt; a
 * malformed file or entry is a problem line and contributes nothing, so a
 * broken record makes reds block rather than hiding them.
 */
export function loadBaselineDebt(root: string): BaselineDebt {
  let raw: string;
  try { raw = readFileSync(join(root, STOP_DEBT_PATH), "utf8"); }
  catch { return Object.freeze({ entries: Object.freeze([]), problems: Object.freeze([]) }); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return Object.freeze({ entries: Object.freeze([]), problems: Object.freeze([`${STOP_DEBT_PATH} is not valid JSON`]) }); }
  const record = parsed as { schema_version?: unknown; kind?: unknown; entries?: unknown };
  if (record === null || typeof record !== "object" || record.schema_version !== 1 || record.kind !== STOP_DEBT_KIND || !Array.isArray(record.entries)) {
    return Object.freeze({ entries: Object.freeze([]), problems: Object.freeze([`${STOP_DEBT_PATH} must be {schema_version: 1, kind: "${STOP_DEBT_KIND}", entries: [...]}`]) });
  }
  const problems: string[] = [];
  const entries: DebtEntry[] = [];
  const seen = new Set<string>();
  for (const value of record.entries as unknown[]) {
    const entry = value as Partial<DebtEntry> | null;
    const label = typeof entry?.gate === "string" ? entry.gate : "(unnamed)";
    if (entry === null || typeof entry !== "object" || typeof entry.gate !== "string" || !entry.gate.startsWith("gate:")) { problems.push(`debt entry ${label}: gate must be a gate:* name`); continue; }
    if (typeof entry.owner !== "string" || !debtOwnerExists(root, entry.owner)) { problems.push(`debt entry ${label}: owner ${String(entry.owner)} does not name an existing decisions/ record`); continue; }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") { problems.push(`debt entry ${label}: reason is empty`); continue; }
    if (typeof entry.opened_at_revision !== "string" || !/^[0-9a-f]{40}$/.test(entry.opened_at_revision)) { problems.push(`debt entry ${label}: opened_at_revision must be a full commit oid`); continue; }
    if (typeof entry.opened_at !== "string" || typeof entry.observed_exit_code !== "number" || entry.observed_exit_code === 0) { problems.push(`debt entry ${label}: opened_at and a non-zero observed_exit_code are required`); continue; }
    if (seen.has(entry.gate)) { problems.push(`debt entry ${label}: duplicate; only the first is honoured`); continue; }
    seen.add(entry.gate);
    entries.push(Object.freeze({ gate: entry.gate, owner: entry.owner, reason: entry.reason, opened_at: entry.opened_at, opened_at_revision: entry.opened_at_revision, observed_exit_code: entry.observed_exit_code }));
  }
  return Object.freeze({ entries: Object.freeze(entries), problems: Object.freeze(problems) });
}

export interface RedGateRef {
  readonly gate: string;
  readonly exit_code: string;
}

export interface OwnedRed {
  readonly gate: string;
  readonly exit_code: string;
  readonly owner: string;
  readonly reason: string;
  readonly opened_at_revision: string;
}

/** Splits blocking reds into those an owned debt entry covers and those that are the session's. */
export function attributeBaselineDebt(blocking: readonly RedGateRef[], debt: readonly DebtEntry[]): { readonly unowned: readonly RedGateRef[]; readonly owned: readonly OwnedRed[] } {
  const byGate = new Map(debt.map((entry) => [entry.gate, entry]));
  const unowned: RedGateRef[] = [];
  const owned: OwnedRed[] = [];
  for (const red of blocking) {
    const entry = byGate.get(red.gate);
    if (entry === undefined) unowned.push(red);
    else owned.push(Object.freeze({ gate: red.gate, exit_code: red.exit_code, owner: entry.owner, reason: entry.reason, opened_at_revision: entry.opened_at_revision }));
  }
  return Object.freeze({ unowned: Object.freeze(unowned), owned: Object.freeze(owned) });
}

/** One line per owned red: the rendering §7.3 asks for. */
export function renderOwnedDebt(owned: readonly OwnedRed[]): string {
  if (owned.length === 0) return "";
  return [
    `Baseline debt — ${owned.length} red gate(s) were red before this session and are owned elsewhere; they do not block:`,
    ...owned.map((red) => `  - ${red.gate} (exit ${red.exit_code}) owned by ${red.owner} since ${red.opened_at_revision.slice(0, 8)}: ${red.reason}`),
  ].join("\n");
}

/** Read the profile and root manifest the schedule needs. `null` when either is unreadable. */
export function readScheduleInputs(root: string): { readonly profile: StopScopeProfile; readonly packageJson: { readonly scripts?: Readonly<Record<string, string>>; readonly workspaces?: unknown } } | null {
  try {
    const profile = JSON.parse(readFileSync(join(root, "scripts", "execution-profile.json"), "utf8")) as StopScopeProfile;
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string>; workspaces?: unknown };
    if (profile === null || typeof profile !== "object" || typeof profile.gates !== "object" || profile.gates === null) return null;
    return Object.freeze({ profile, packageJson });
  } catch { return null; }
}
