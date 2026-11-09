/**
 * packages/arbor-mcp/src/project-manage.ts — Roadmap 23 W6: the multi-project
 * management surface.
 *
 * ADR-076 gave the registry a checkable meaning: an entry is a claim, and
 * "manage N projects" is "a fold over discharged entries" (ADR-076
 * Consequences). This module IS that fold. For every registered entry it:
 *
 *   1. Re-establishes discharge (reusing `verifyRegistryEntry` — the single
 *      evaluation path ADR-076 already designates; this module does not
 *      re-derive expiry/path/hash/conformance logic).
 *   2. If discharge fails, reports the entry as failed and does NOT run any
 *      further gates against it — Roadmap 23 W6's requirement 4: "you cannot
 *      make claims about a project whose registration claim is already
 *      void." Its gates are reported `not_run_discharge_failed`, never pass.
 *   3. If discharge holds, runs the gate battery: every gate script that can
 *      actually be pointed at another project's root gets invoked for real
 *      against `entry.path`; every gate that cannot is reported
 *      `not_applicable` — never silently skipped, never counted as a pass
 *      (requirement 3, the single most important one. Roadmap 23 §5 names
 *      the failure this prevents: "a harness that reports green about files
 *      it never read.").
 *
 * DISCOVERING RETARGETABLE GATES, HONESTLY (requirement 1). The catalog is
 * enumerated from `package.json`'s `gate:*` scripts at run time — the same
 * anti-drift technique `scripts/gate-all.mjs` (ADR-074) uses, so a new gate
 * cannot silently go unclassified here either. Retargetability itself is
 * NOT a hardcoded list: a gate script is classified retargetable iff its
 * (comment-stripped) source contains real argv-driven parsing of its OWN
 * `--root` flag — the same `resolveRootArg(process.argv...)` /
 * `argumentValue(args, "--root")` pattern `project-conform.mjs`,
 * `anti-stub.mjs`, `lockfile-check.mjs`, and `tui-catalog-parity.mjs` each
 * define or call. This is a real static signal, not a guess: it is exactly
 * the code path that would break if a gate's `--root` support were removed,
 * and grepping for it independently reproduces the four gates Roadmap 23
 * §W6 names by hand. Two categories still require a one-line documented
 * carve-out rather than pure discovery (see `EXCLUDED_GATE_IDS` and
 * `GATE_EXTRA_ARGS` below); both are declared in this one place, each with
 * its reason, per the task's own allowance ("if you must hardcode, declare
 * it in one place and say why").
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectRegistry, verifyRegistryEntry, type ProjectRegistryEntry, type RegistryEntryVerification } from "./project-registry.js";

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/arbor-mcp/src -> repo root
  return resolve(here, "..", "..", "..");
}

/**
 * Gates deliberately excluded from the battery even though they would
 * otherwise be discovered as retargetable, with the reason stated inline.
 * This is the ONE place such a carve-out is allowed to live (requirement 1).
 */
const EXCLUDED_GATE_IDS: ReadonlyMap<string, string> = new Map([
  [
    "project-registry",
    "excluded — this gate IS the ADR-076 discharge mechanism this module already runs " +
      "per-entry via verifyRegistryEntry. Including it in the battery would check a " +
      "different, unrelated fact (whether the TARGET project has its own nested " +
      "project-registry.json) under a name that reads as circular. Reported here as " +
      "not_applicable so the exclusion is visible, not silent.",
  ],
]);

/** Same contract as `scripts/project-conform.mjs`'s comment-stripping needs:
 * remove `/* ... *\/` block comments and `// ...` line comments before
 * pattern-matching so a match can only occur in real, executable code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The real signal: does this script's own argv parsing resolve a `--root`
 * flag to determine ITS OWN operating root? Matches the two idioms in use
 * today (`resolveRootArg(process.argv...)`, and `argumentValue(args,
 * "--root")`). Deliberately does NOT match a bare `"--root"` string
 * appearing only because the script hardcodes `--root` as an argument to a
 * CHILD process it spawns (e.g. `scripts/vi-refresh.mjs` passes `"--root",
 * "."` to its own extractor subprocess but never reads `--root` from its
 * own argv) — that is not retargetability of the gate itself. */
const RETARGETABLE_PATTERN = /resolveRootArg\(\s*process\.argv|argumentValue\(\s*args\s*,\s*["'`]--root["'`]\s*\)/;

export interface GateCatalogEntry {
  readonly gate_id: string;
  readonly npm_script: string;
  readonly script_path: string;
  /** Extra CLI flags carried over from the chosen npm script's own command
   * (e.g. `["--check"]` for `gate:vi-reproducible`'s `bun scripts/vi-refresh.mjs
   * --check`), replayed verbatim when this gate is invoked against another
   * project's root. Without this, retargeting `vi-refresh.mjs` without
   * `--check` would run it in its WRITE mode against a project this module
   * has no business mutating. */
  readonly extra_args: readonly string[];
}

export interface GateClassification extends GateCatalogEntry {
  readonly retargetable: boolean;
  readonly reason: string;
}

/**
 * Enumerates every `gate:*` script from `package.json` (excluding `gate:all`
 * itself), keeping only the ones shaped as a single direct `bun
 * scripts/<file>.(mjs|ts) [flags]` invocation — the shape a `--root` flag
 * can even apply to. `gate:coverage` (`vitest run ...`) and `gate:ledger-audit`
 * (`bun packages/arbor-mcp/bin/arbor-mcp.mjs ledger audit --all --dir
 * .arbor` — a different tool entirely, addressed by `--dir` not `--root`)
 * fall out of scope by this same structural test, with no separate
 * hardcoded list naming them.
 *
 * When two npm scripts point at the same underlying file (today only
 * `gate:anti-stub` / `gate:anti-stub:blocking`, both `scripts/anti-stub.mjs`),
 * the variant with MORE extra flags is kept as canonical, not fewer. This is
 * a real, generalizable rule, not a name-specific carve-out: `anti-stub.mjs`
 * documents itself as REPORT-ONLY without `--blocking` — its own
 * `process.exitCode` stays 0 regardless of findings — so the bare variant is
 * structurally incapable of failing this battery; it would report every
 * project's real stubs as a silent, permanent pass, exactly the failure
 * requirement 3 exists to prevent. Preferring the more-qualified invocation
 * whenever one exists is the general fix, and it is why `extra_args` is
 * captured and replayed rather than discarded after dedup.
 */
export function enumerateGateCatalog(root: string = repoRoot()): GateCatalogEntry[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const byScriptPath = new Map<string, { gateId: string; npmScript: string; extraArgs: string[] }>();
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith("gate:") || name === "gate:all") continue;
    const match = /^bun\s+(scripts\/[\w.\-/]+\.(?:mjs|ts))(?:\s+(.*))?$/.exec(command);
    if (!match) continue;
    const scriptPath = resolve(root, match[1]);
    const extraArgs = (match[2] ?? "").trim().length === 0 ? [] : match[2]!.trim().split(/\s+/);
    const gateId = name.slice("gate:".length);
    const existing = byScriptPath.get(scriptPath);
    if (!existing || extraArgs.length > existing.extraArgs.length) {
      byScriptPath.set(scriptPath, { gateId, npmScript: name, extraArgs });
    }
  }
  return [...byScriptPath.entries()]
    .map(([scriptPath, entry]) => ({ gate_id: entry.gateId, npm_script: entry.npmScript, script_path: scriptPath, extra_args: entry.extraArgs }))
    .sort((a, b) => a.gate_id.localeCompare(b.gate_id));
}

/** Classifies every catalog entry as retargetable or not, with a reason for
 * each — never a bare boolean, per requirement 3's "reported, never
 * silently skipped." */
export function classifyGateCatalog(root: string = repoRoot()): GateClassification[] {
  return enumerateGateCatalog(root).map((entry) => {
    const excludedReason = EXCLUDED_GATE_IDS.get(entry.gate_id);
    if (excludedReason) return { ...entry, retargetable: false, reason: excludedReason };
    let source: string;
    try {
      source = readFileSync(entry.script_path, "utf8");
    } catch (error) {
      return { ...entry, retargetable: false, reason: `not_applicable — could not read ${entry.script_path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const retargetable = RETARGETABLE_PATTERN.test(stripComments(source));
    return {
      ...entry,
      retargetable,
      reason: retargetable
        ? `retargetable — ${entry.script_path} parses --root from its own argv`
        : `not_applicable — ${entry.script_path} does not parse a --root flag for its own operating root; it always evaluates the host repository`,
    };
  });
}

export type ProjectGateStatus = "pass" | "fail" | "not_applicable" | "not_run_discharge_failed";

export interface ProjectGateResult {
  readonly gate_id: string;
  readonly status: ProjectGateStatus;
  readonly detail: string;
}

const TAIL_LINES = 15;

function tail(text: string, lines: number): string {
  const trimmed = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return trimmed.slice(-lines).join("\n");
}

/** Runs one retargetable gate against `root`, real subprocess, real exit
 * code — the only honest way to know whether it passed (requirement 1/3).
 * Classification is exit-code based (0 => pass), not per-gate JSON-shape
 * parsing, because the four gates' JSON payloads are not uniform (some
 * carry `ok`, `tui-catalog-parity` and `anti-stub` do not) while every one
 * of them already treats `process.exitCode` as the pass/fail contract other
 * callers (`gate-all.mjs`, `project-registry.ts`'s own `runConformanceCheck`)
 * rely on. */
function runGateAgainstRoot(entry: GateCatalogEntry, root: string): ProjectGateResult {
  const args = [entry.script_path, ...entry.extra_args, "--root", root, "--json"];
  try {
    execFileSync("bun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { gate_id: entry.gate_id, status: "pass", detail: `PASS — ${entry.npm_script} --root ${root}` };
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown; stderr?: unknown };
    const combined = `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}`;
    const detail = tail(combined, TAIL_LINES) || `${entry.npm_script} exited non-zero against --root ${root}`;
    return { gate_id: entry.gate_id, status: "fail", detail };
  }
}

export interface ProjectManageEntryReport {
  readonly project_id: string;
  readonly path: string;
  readonly discharge_ok: boolean;
  readonly discharge_failures: RegistryEntryVerification["failures"];
  readonly gates: readonly ProjectGateResult[];
  readonly ok: boolean;
}

export interface ProjectManageReport {
  readonly ok: boolean;
  readonly entry_count: number;
  readonly retargetable_gate_ids: readonly string[];
  readonly not_applicable_gates: readonly { readonly gate_id: string; readonly reason: string }[];
  readonly entries: readonly ProjectManageEntryReport[];
}

/**
 * The management fold itself (Roadmap 23 W6). Empty registry => `ok: true`,
 * `entries: []` — requirement 6: governing zero projects is a valid state.
 */
export function manageProjects(persistenceDir: string, root: string = repoRoot(), options: { readonly now?: string } = {}): ProjectManageReport {
  const registry = loadProjectRegistry(persistenceDir);
  const classification = classifyGateCatalog(root);
  const retargetable = classification.filter((c) => c.retargetable);
  const notApplicable = classification.filter((c) => !c.retargetable).map((c) => ({ gate_id: c.gate_id, reason: c.reason }));

  const entries: ProjectManageEntryReport[] = registry.entries.map((entry: ProjectRegistryEntry) => {
    const verification = verifyRegistryEntry(entry, options);
    if (!verification.ok) {
      const gates: ProjectGateResult[] = classification.map((c) => ({
        gate_id: c.gate_id,
        status: "not_run_discharge_failed" as const,
        detail: "registration discharge failed for this entry — its claim is void, so no gate verdict can be honestly attributed to the project it names",
      }));
      return {
        project_id: entry.project_id,
        path: entry.path,
        discharge_ok: false,
        discharge_failures: verification.failures,
        gates,
        ok: false,
      };
    }
    const gates: ProjectGateResult[] = [
      ...retargetable.map((c) => runGateAgainstRoot(c, entry.path)),
      ...notApplicable.map((c) => ({ gate_id: c.gate_id, status: "not_applicable" as const, detail: c.reason })),
    ].sort((a, b) => a.gate_id.localeCompare(b.gate_id));
    const ok = gates.every((g) => g.status !== "fail");
    return { project_id: entry.project_id, path: entry.path, discharge_ok: true, discharge_failures: [], gates, ok };
  });

  return {
    ok: entries.every((e) => e.ok),
    entry_count: registry.entries.length,
    retargetable_gate_ids: retargetable.map((c) => c.gate_id).sort(),
    not_applicable_gates: notApplicable.sort((a, b) => a.gate_id.localeCompare(b.gate_id)),
    entries,
  };
}

export function formatProjectManageReport(report: ProjectManageReport): string {
  const lines = [`Project management — ${report.entry_count} entr${report.entry_count === 1 ? "y" : "ies"} governed`];
  lines.push(`  retargetable gates run per project: ${report.retargetable_gate_ids.join(", ") || "(none discovered)"}`);
  lines.push(`  not-applicable gates (structurally cannot target another project): ${report.not_applicable_gates.map((g) => g.gate_id).join(", ") || "(none)"}`);
  if (report.entry_count === 0) {
    lines.push("");
    lines.push("(governing no projects — a valid state, not a failure)");
    return lines.join("\n");
  }
  for (const e of report.entries) {
    lines.push("");
    lines.push(`  ${e.ok ? "OK  " : "FAIL"}  ${e.project_id}  ${e.path}`);
    if (!e.discharge_ok) {
      lines.push(`      registration discharge FAILED — no gate verdicts are attributable to this project:`);
      for (const f of e.discharge_failures) lines.push(`        [${f.code}] ${f.detail}`);
      continue;
    }
    for (const g of e.gates) {
      const marker = g.status === "pass" ? "pass" : g.status === "fail" ? "FAIL" : g.status === "not_applicable" ? "n/a " : "skip";
      lines.push(`      [${marker}] ${g.gate_id}`);
      if (g.status === "fail") for (const l of g.detail.split("\n")) lines.push(`            ${l}`);
    }
  }
  return lines.join("\n");
}
