/**
 * arbor-mcp/mutation-probe -- diff∪sibling mutation probe, evidence-only
 * (ADR-069, X-2).
 *
 * A declared acceptance command (the plan's real verification command) is a
 * WEAK ORACLE for the exact lines it was declared against, and an even
 * weaker one at interacting sites the diff never touched -- per the
 * manifest's cited CoHarden (2607.19843) and Ojdanic (2112.14566): most
 * relevant mutants live outside the literal diff. This module generates a
 * small, bounded set of string-level line mutants over the UNION of the
 * current diff's changed lines and the caller's sibling-scan-flagged sites,
 * runs the declared acceptance command against each mutant one at a time,
 * and reports SURVIVORS (the command still exits 0 with the mutant in
 * place) as evidence that the declared tests cannot distinguish that
 * mutation -- never a blocking outcome, never fed into `recordResult`. A
 * killed mutant (non-zero exit, or the command never even reached a real
 * exit) produces no finding either way.
 *
 * Composition mirrors `test-amplifier.ts`'s pattern exactly: env-gated
 * (`ARBOR_MUTATION_PROBE=on`, off by default, zero file writes or command-
 * port calls otherwise), an injectable `MachineVerificationCommandPort`
 * (no raw process spawning here), silent degradation on every failure mode,
 * and one pure exported entry point (`probeMutations`) that a future loop-
 * integration pass wires up -- this module does NOT touch `loop.ts` or
 * `cli.ts` itself (out of this workstream's file scope; see ADR-069's
 * documented contract point).
 *
 * String-level line mutations only -- no AST dependency, matching the
 * manifest's explicit scope. Original file bytes are always captured before
 * a mutant is written and restored in a `finally`, so restoration is
 * guaranteed byte-identical even when the command port itself throws.
 *
 * CoHarden-lite hardening (ADR-071, X, PM-2): for each SURVIVING mutant
 * (bounded by `MUTATION_PROBE_MAX_SURVIVORS`), a caller may optionally
 * supply the same `AmplifierModelPort` shape `test-amplifier.ts` uses to
 * generate ONE killer test asserting the correct behavior the mutant
 * breaks. Per CoHarden's rigor gate, a generated test is trusted only if it
 * passes BOTH legs: it must exit 0 against the real, unmutated code, and
 * non-zero against the mutant re-applied. The real-code leg runs first and
 * needs no extra write at all -- the mutation loop above has already
 * restored the site file to its original bytes by the time hardening
 * begins, so only the mutant leg needs a write, and that write is restored
 * in a `finally` exactly like every other mutant application in this
 * module. Only a test passing both legs upgrades a finding to
 * `{hardened: true, killer_test_source}`; anything else is discarded
 * silently, same posture as an unkilled mutant. Gated by both
 * `ARBOR_MUTATION_PROBE=on` (the whole module's gate) AND
 * `ARBOR_MUTATION_HARDEN=on`; zero model or command-port calls otherwise.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type {
  MachineVerificationCommandPort,
  VerificationNetworkPolicy,
} from "./worktree-machine-verifier.js";
import { extractGeneratedTestSource, type AmplifierModelPort } from "./test-amplifier.js";

/** Set to "on" to opt into mutation-probe evidence. Absent/anything else: disabled, zero file writes or command-port calls. */
export const ARBOR_MUTATION_PROBE_ENV = "ARBOR_MUTATION_PROBE";

/** Set to "on" to opt into CoHarden-lite killer-test hardening of survivors. Requires `ARBOR_MUTATION_PROBE_ENV=on` too; absent/anything else: no model or command-port calls beyond the base probe. */
export const ARBOR_MUTATION_HARDEN_ENV = "ARBOR_MUTATION_HARDEN";

/** Extra wall budget for the hardening phase, tracked separately from and additive to `MUTATION_PROBE_TOTAL_BUDGET_MS`. */
export const MUTATION_HARDEN_BUDGET_MS = 30_000;

/** Hard byte cap on `MutationFinding.killer_test_source`; longer sources are truncated with a trailing marker. */
export const MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES = 4_096;

/** Hard cap on mutants generated+run per invocation, regardless of how many candidate sites the caller passes. */
export const MUTATION_PROBE_MAX_MUTANTS = 8;

/** Probe stops dispatching further mutants once this many survivors have been found. */
export const MUTATION_PROBE_MAX_SURVIVORS = 2;

/** Early-kill timeout for a single mutant's acceptance-command run. */
export const MUTATION_PROBE_PER_MUTANT_TIMEOUT_MS = 20_000;

/** Total wall budget across every mutant in one `probeMutations` call. */
export const MUTATION_PROBE_TOTAL_BUDGET_MS = 60_000;

/** One candidate line: an absolute (or worktree-relative, caller's choice, but consistent) file path and a 1-based line number. */
export interface MutationSite {
  readonly file: string;
  readonly line: number;
}

/** Evidence-only outcome for one mutant the declared acceptance command could not kill. Never accepted by any `recordResult` field. */
export interface MutationFinding {
  readonly site: MutationSite;
  readonly mutant_description: string;
  readonly survived: true;
  /**
   * Additive (ADR-071, X, PM-2): present only when a generated killer test
   * passed the CoHarden rigor gate (exit 0 against real code, non-zero
   * against the mutant re-applied). Absent whenever hardening was not
   * attempted, not enabled, or did not produce a rigorous killer.
   */
  readonly hardened?: true;
  /** The rigorous killer test's source, byte-capped at `MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES` with truncation marked. Present iff `hardened` is `true`. */
  readonly killer_test_source?: string;
}

export interface DeclaredAcceptanceCommand {
  readonly argv: readonly [string, ...string[]];
  readonly network: VerificationNetworkPolicy;
  readonly timeout_ms?: number;
  readonly context_root?: string;
}

export interface ProbeMutationsInput {
  readonly worktree_path: string;
  /** The current diff's changed lines (new-side). */
  readonly diff_changed_lines: readonly MutationSite[];
  /** The sibling-scan's flagged sites (interacting locations outside the diff). */
  readonly sibling_flagged_sites: readonly MutationSite[];
  readonly command_port: MachineVerificationCommandPort;
  /** Builds the declared acceptance command to run against each mutant, given the worktree path. */
  readonly acceptance_command: (worktreePath: string) => DeclaredAcceptanceCommand;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Reads a file's current bytes. Defaults to `node:fs`'s `readFileSync`; injectable so tests never touch the real filesystem. */
  readonly read_file?: (path: string) => string;
  /** Writes a file's bytes. Defaults to `node:fs`'s `writeFileSync`; injectable so tests never touch the real filesystem. */
  readonly write_file?: (path: string, content: string) => void;
  /** Injectable clock for deterministic budget tests. */
  readonly now?: () => number;
  readonly max_output_bytes?: number;
  /**
   * Additive (ADR-071, X, PM-2): a single-call model port (same shape
   * `test-amplifier.ts`'s `AmplifierModelPort` uses) to generate killer
   * tests for survivors. Hardening is skipped entirely (zero model calls)
   * when absent, not `ready`, or `ARBOR_MUTATION_HARDEN` is not `"on"`.
   */
  readonly harden_model_port?: AmplifierModelPort;
  /** Builds the argv used to run one generated killer test file, given its absolute path -- same contract as `test-amplifier.ts`'s `run_generated_test`. Required for hardening to run at all. */
  readonly run_killer_test?: (testFilePath: string) => DeclaredAcceptanceCommand;
  /** Where to write a generated killer test, given the site and its survivor index. Defaults to a bounded, collision-resistant path under the worktree. */
  readonly killer_test_file_path?: (worktreePath: string, site: MutationSite, index: number) => string;
  /** Best-effort deletion of a generated killer test file after both hardening legs run. Defaults to `node:fs`'s `unlinkSync`; injectable so tests never touch the real filesystem. Failures are swallowed -- the killer test file is disposable, not load-bearing. */
  readonly delete_file?: (path: string) => void;
}

interface GeneratedMutant {
  readonly site: MutationSite;
  readonly description: string;
  readonly mutatedContent: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Longest-token-first so `<=`/`>=`/`===`/`!==` are never mistaken for bare `<`/`>`. */
const COMPARISON_FLIPS: readonly (readonly [string, string])[] = [
  ["===", "!=="],
  ["!==", "==="],
  ["<=", "<"],
  [">=", ">"],
  ["<", "<="],
  [">", ">="],
];

const IF_CONDITION_PATTERN = /^(\s*)if\s*\((.*)\)(\s*\{?\s*)$/;
const NUMERIC_CONSTANT_PATTERN = /\b\d+\b/;
const EARLY_RETURN_PATTERN = /^\s*return\b.*;?\s*$/;

/** Comparison-operator flip mutation, or `null` if the line contains none of the known operators. Exported for direct unit testing. */
export function comparisonFlipMutation(line: string): { mutated: string; description: string } | null {
  for (const [from, to] of COMPARISON_FLIPS) {
    const index = line.indexOf(from);
    if (index === -1) continue;
    const mutated = line.slice(0, index) + to + line.slice(index + from.length);
    return { mutated, description: `comparison flip: "${from}" -> "${to}"` };
  }
  return null;
}

/** Negates an `if (...)` line's condition, or `null` if the line is not a single-line `if (...)`. Exported for direct unit testing. */
export function booleanNegationMutation(line: string): { mutated: string; description: string } | null {
  const match = IF_CONDITION_PATTERN.exec(line);
  if (match === null) return null;
  const [, indent, condition, tail] = match;
  return { mutated: `${indent}if (!(${condition}))${tail}`, description: "boolean negation: if (cond) -> if (!(cond))" };
}

/** Increments the first standalone integer literal on the line by one, or `null` if none is present. Exported for direct unit testing. */
export function numericConstantMutation(line: string): { mutated: string; description: string } | null {
  const match = NUMERIC_CONSTANT_PATTERN.exec(line);
  if (match === null) return null;
  const original = match[0];
  const bumped = String(Number(original) + 1);
  const mutated = line.slice(0, match.index) + bumped + line.slice(match.index + original.length);
  return { mutated, description: `numeric constant: ${original} -> ${bumped}` };
}

/** Removes an early-`return` statement's effect (blanked to preserve line numbers), or `null` if the line is not a `return` statement. Exported for direct unit testing. */
export function earlyReturnRemovalMutation(line: string): { mutated: string; description: string } | null {
  if (!EARLY_RETURN_PATTERN.test(line)) return null;
  return { mutated: "", description: "early-return line removed" };
}

/** Tries each operator in a fixed priority order and returns the first that applies to `line`, or `null` if none does. */
function mutateLine(line: string): { mutated: string; description: string } | null {
  return (
    comparisonFlipMutation(line)
    ?? booleanNegationMutation(line)
    ?? numericConstantMutation(line)
    ?? earlyReturnRemovalMutation(line)
  );
}

/**
 * Y-1 (BLINDSPOT-MANIFEST class 5, applicability signal): file extensions
 * this module's string-level mutation operators (`comparisonFlipMutation`,
 * `booleanNegationMutation`, `numericConstantMutation`,
 * `earlyReturnRemovalMutation`) were written against. They match C-family
 * syntax specifically -- `===`/`!==`, a parenthesized `if (...)` condition,
 * a trailing `;` -- none of which is Python/Ruby/Go/Rust syntax, so running
 * them against a non-JS/TS substrate is not "no mutations found," it is
 * "the operators structurally cannot apply here."
 */
const MUTATION_OPERATOR_APPLICABLE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Result shape for an analyzer applicability check: additive alongside `probeMutations`'/`amplifySiblingSites`' existing finding-array return values, never a replacement for them. */
export interface AnalyzerApplicability {
  readonly applicable: boolean;
  /** Present only when `applicable` is `false` -- explains WHY, so a caller can tell "not analyzed" from "analyzed, found nothing." */
  readonly reason?: string;
}

/**
 * Whether the mutation probe's operators can structurally apply to ANY of
 * the given candidate sites, purely by file extension -- cheap, synchronous,
 * makes no filesystem or command-port call, and is independent of
 * `ARBOR_MUTATION_PROBE`'s own on/off gate (a caller may want to know
 * applicability even when the probe itself is disabled). An empty `sites`
 * list is `applicable: false` (nothing to check), distinct from a non-empty
 * list of exclusively non-JS/TS sites (also `false`, with a substrate-naming
 * reason) and from at least one JS/TS-shaped site (`true`).
 */
export function assessMutationProbeApplicability(sites: readonly MutationSite[]): AnalyzerApplicability {
  if (sites.length === 0) return { applicable: false, reason: "no candidate sites (empty diff∪sibling union) to assess" };
  const extensionOf = (file: string): string => {
    const dot = file.lastIndexOf(".");
    return dot === -1 ? "" : file.slice(dot).toLowerCase();
  };
  const hasApplicableSite = sites.some((site) => MUTATION_OPERATOR_APPLICABLE_EXTENSIONS.has(extensionOf(site.file)));
  if (hasApplicableSite) return { applicable: true };
  const observedExtensions = [...new Set(sites.map((site) => extensionOf(site.file) || "(no extension)"))].sort();
  return {
    applicable: false,
    reason: `mutation operators are JS/TS-shaped (comparison operators, parenthesized if-conditions, semicolon-terminated statements) and none of the ${sites.length} candidate site(s) match a JS/TS extension -- observed: ${observedExtensions.join(", ")}`,
  };
}

/** Deduplicates the diff∪sibling site union by `(file, line)`, diff sites first, preserving first-seen order. Exported for direct unit testing. */
export function selectCandidateSites(
  diffChangedLines: readonly MutationSite[],
  siblingFlaggedSites: readonly MutationSite[],
): readonly MutationSite[] {
  const seen = new Set<string>();
  const out: MutationSite[] = [];
  for (const site of [...diffChangedLines, ...siblingFlaggedSites]) {
    const key = `${site.file}:${site.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

function generateMutants(
  sites: readonly MutationSite[],
  readFile: (path: string) => string,
  maxMutants: number,
): readonly GeneratedMutant[] {
  const mutants: GeneratedMutant[] = [];
  const fileLinesCache = new Map<string, string[] | null>();
  for (const site of sites) {
    if (mutants.length >= maxMutants) break;
    let lines = fileLinesCache.get(site.file);
    if (lines === undefined) {
      try {
        lines = readFile(site.file).split("\n");
      } catch {
        lines = null;
      }
      fileLinesCache.set(site.file, lines);
    }
    if (lines === null) continue;
    const lineIndex = site.line - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) continue;
    const original = lines[lineIndex]!;
    const mutation = mutateLine(original);
    if (mutation === null) continue;
    const mutatedLines = [...lines];
    mutatedLines[lineIndex] = mutation.mutated;
    mutants.push({ site, description: mutation.description, mutatedContent: mutatedLines.join("\n") });
  }
  return mutants;
}

/**
 * Generates and evidence-gates up to `MUTATION_PROBE_MAX_MUTANTS` line
 * mutants over the diff∪sibling site union. Returns `[]` immediately, with
 * zero file writes or command-port calls, unless
 * `ARBOR_MUTATION_PROBE=on` is set -- see `ARBOR_MUTATION_PROBE_ENV`.
 */
export async function probeMutations(input: ProbeMutationsInput): Promise<readonly MutationFinding[]> {
  const env = input.env ?? process.env;
  if (env[ARBOR_MUTATION_PROBE_ENV] !== "on") return [];

  const readFile = input.read_file ?? ((path: string) => readFileSync(path, "utf-8"));
  const writeFile = input.write_file ?? ((path: string, content: string) => writeFileSync(path, content, "utf-8"));
  const now = input.now ?? (() => Date.now());

  const sites = selectCandidateSites(input.diff_changed_lines, input.sibling_flagged_sites);
  // Y-3 (BLINDSPOT-MANIFEST class 5): short-circuit before any read/write or
  // command-port call when the candidate sites are structurally outside
  // this module's JS/TS-shaped operators -- `mutateLine` would already
  // return `null` for every one of them (same eventual `[]`), so this
  // changes nothing about the RESULT, only skips wasted file reads for a
  // substrate that could never produce a mutant.
  if (!assessMutationProbeApplicability(sites).applicable) return [];
  const mutants = generateMutants(sites, readFile, MUTATION_PROBE_MAX_MUTANTS);

  const findings: MutationFinding[] = [];
  const survivorMutants: GeneratedMutant[] = [];
  const startedAtMs = now();

  for (const mutant of mutants) {
    if (findings.length >= MUTATION_PROBE_MAX_SURVIVORS) break;
    if (now() - startedAtMs >= MUTATION_PROBE_TOTAL_BUDGET_MS) break;

    let originalContent: string;
    try {
      originalContent = readFile(mutant.site.file);
    } catch {
      continue; // file vanished between site-generation and dispatch -- skip, no finding.
    }

    let wrote = false;
    try {
      writeFile(mutant.site.file, mutant.mutatedContent);
      wrote = true;

      const command = input.acceptance_command(input.worktree_path);
      const remainingBudgetMs = Math.max(0, MUTATION_PROBE_TOTAL_BUDGET_MS - (now() - startedAtMs));
      const timeoutMs = Math.min(
        command.timeout_ms ?? MUTATION_PROBE_PER_MUTANT_TIMEOUT_MS,
        MUTATION_PROBE_PER_MUTANT_TIMEOUT_MS,
        remainingBudgetMs,
      );

      let result: Awaited<ReturnType<MachineVerificationCommandPort["run"]>> | null;
      try {
        result = await input.command_port.run({
          argv: command.argv,
          cwd: input.worktree_path,
          timeout_ms: timeoutMs,
          max_output_bytes: input.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          network: command.network,
          signal: input.signal ?? new AbortController().signal,
          ...(command.context_root === undefined ? {} : { context_root: command.context_root }),
        });
      } catch {
        // The command port itself throwing is indistinguishable from a
        // killed mutant for evidence purposes -- no finding either way.
        // The `finally` below still guarantees restoration.
        result = null;
      }

      // A thrown port call, or anything that never reached a real exit
      // (spawn failure, timeout, cancellation, output cap), killed the run
      // without telling us whether the mutant was caught -- treated as "not
      // a survivor", never a finding either way, mirroring the amplifier's
      // compile-gate posture.
      if (result === null || result.kind !== "exited") continue;
      if (result.exit !== 0) continue; // the mutant was caught -- killed, no finding.

      findings.push({ site: mutant.site, mutant_description: mutant.description, survived: true });
      survivorMutants.push(mutant);
    } finally {
      if (wrote) writeFile(mutant.site.file, originalContent);
    }
  }

  // CoHarden-lite hardening (ADR-071, X, PM-2). Both gates required; zero
  // model or command-port calls beyond the base probe otherwise. Runs after
  // the mutation loop above so every site file is already back to its
  // original bytes -- the real-code leg below needs no extra write.
  if (findings.length > 0 && env[ARBOR_MUTATION_HARDEN_ENV] === "on") {
    await hardenSurvivors(findings, survivorMutants, input, readFile, writeFile, now);
  }

  return findings;
}

const KILLER_SOURCE_TRUNCATION_MARKER = "\n... [truncated]";

/** Truncates `source` to `MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES` (UTF-8), appending a trailing marker when truncated. Exported for direct unit testing. */
export function truncateKillerSource(source: string): string {
  if (Buffer.byteLength(source, "utf-8") <= MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES) return source;
  const markerBytes = Buffer.byteLength(KILLER_SOURCE_TRUNCATION_MARKER, "utf-8");
  const budget = Math.max(0, MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES - markerBytes);
  const truncated = Buffer.from(source, "utf-8").subarray(0, budget).toString("utf-8");
  return `${truncated}${KILLER_SOURCE_TRUNCATION_MARKER}`;
}

/** Prompt guidance only -- the two-leg rigor gate remains the real trust boundary, not this instruction. Exported for direct unit testing. */
export function killerTestPromptFor(site: MutationSite, mutantDescription: string): string {
  return [
    `A mutation-testing probe changed one line, and the declared acceptance command still passed with the mutant in place (the existing tests cannot distinguish this mutation):`,
    `  file: ${site.file}`,
    `  line: ${site.line}`,
    `  mutant: ${mutantDescription}`,
    ``,
    `Write exactly ONE test file that asserts the CORRECT behavior this mutant breaks at this exact line.`,
    `The test must PASS against the real, unmutated code, and FAIL if the mutant described above is applied in its place.`,
    `Return only the test file's source code. No prose, no markdown code fences, no explanation.`,
  ].join("\n");
}

function defaultKillerTestFilePath(worktreePath: string, site: MutationSite, index: number): string {
  const safeName = site.file.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 64);
  return `${worktreePath}/.arbor-mutation-harden-${index}-${safeName}-${site.line}.generated.test.ts`;
}

function defaultDeleteFile(path: string): void {
  unlinkSync(path);
}

async function runHardenCommand(
  input: ProbeMutationsInput,
  command: DeclaredAcceptanceCommand,
  now: () => number,
  hardenDeadlineMs: number,
): Promise<Awaited<ReturnType<MachineVerificationCommandPort["run"]>> | null> {
  const remainingMs = hardenDeadlineMs - now();
  if (remainingMs <= 0) return null;
  const timeoutMs = Math.min(command.timeout_ms ?? MUTATION_PROBE_PER_MUTANT_TIMEOUT_MS, remainingMs);
  try {
    return await input.command_port.run({
      argv: command.argv,
      cwd: input.worktree_path,
      timeout_ms: timeoutMs,
      max_output_bytes: input.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      network: command.network,
      signal: input.signal ?? new AbortController().signal,
      ...(command.context_root === undefined ? {} : { context_root: command.context_root }),
    });
  } catch {
    // Indistinguishable from a run that could not judge the killer test --
    // discarded, never a finding either way, same posture as the base probe.
    return null;
  }
}

/**
 * Attempts to upgrade each survivor in `findings` (parallel to
 * `survivorMutants` by index) to a hardened finding, mutating `findings` in
 * place. Bounded by `MUTATION_HARDEN_BUDGET_MS`, tracked from the moment
 * hardening begins -- additive to, never shared with, the base probe's own
 * `MUTATION_PROBE_TOTAL_BUDGET_MS`.
 */
async function hardenSurvivors(
  findings: MutationFinding[],
  survivorMutants: readonly GeneratedMutant[],
  input: ProbeMutationsInput,
  readFile: (path: string) => string,
  writeFile: (path: string, content: string) => void,
  now: () => number,
): Promise<void> {
  const modelPort = input.harden_model_port;
  const runKillerTest = input.run_killer_test;
  if (modelPort === undefined || !modelPort.ready || runKillerTest === undefined) return;
  const deleteFile = input.delete_file ?? defaultDeleteFile;
  const killerTestFilePath = input.killer_test_file_path ?? defaultKillerTestFilePath;

  const hardenDeadlineMs = now() + MUTATION_HARDEN_BUDGET_MS;

  for (let index = 0; index < findings.length; index++) {
    if (now() >= hardenDeadlineMs) break;
    const mutant = survivorMutants[index]!;

    let generated: { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };
    try {
      generated = await modelPort.call(killerTestPromptFor(mutant.site, mutant.description), input.signal);
    } catch {
      continue; // model port threw -- no hardening for this survivor, no finding change.
    }
    if (!generated.ok) continue;
    const source = extractGeneratedTestSource(generated.text);
    if (source === null) continue;

    const testFilePath = killerTestFilePath(input.worktree_path, mutant.site, index);
    try {
      writeFile(testFilePath, source);
    } catch {
      continue; // could not even be written to disk -- discard, per the compile-gate posture.
    }

    try {
      // Leg 1: real code. The mutation loop above has already restored
      // `mutant.site.file` to its original bytes by now -- no extra write
      // needed for this leg, minimizing total mutant writes overall.
      const realCommand = runKillerTest(testFilePath);
      const realResult = await runHardenCommand(input, realCommand, now, hardenDeadlineMs);
      if (realResult === null || realResult.kind !== "exited" || realResult.exit !== 0) continue;

      // Leg 2: mutant re-applied. Original bytes captured once, mutant
      // written, killer test run, restoration guaranteed in `finally`
      // regardless of outcome -- same byte-identical discipline as the
      // base probe's own mutant application.
      let originalContent: string;
      try {
        originalContent = readFile(mutant.site.file);
      } catch {
        continue; // file vanished -- discard, no finding change.
      }
      let wrote = false;
      try {
        writeFile(mutant.site.file, mutant.mutatedContent);
        wrote = true;
        const mutantCommand = runKillerTest(testFilePath);
        const mutantResult = await runHardenCommand(input, mutantCommand, now, hardenDeadlineMs);
        // A rigorous killer must FAIL (non-zero, real exit) against the
        // mutant -- anything else (clean exit, or never reaching a real
        // exit) means the generated test did not actually catch this
        // mutation, so the finding is left as a plain (unhardened) survivor.
        if (mutantResult === null || mutantResult.kind !== "exited" || mutantResult.exit === 0) continue;
        findings[index] = { ...findings[index]!, hardened: true, killer_test_source: truncateKillerSource(source) };
      } finally {
        if (wrote) writeFile(mutant.site.file, originalContent);
      }
    } finally {
      try { deleteFile(testFilePath); } catch { /* best-effort cleanup -- the killer test file is disposable. */ }
    }
  }
}
