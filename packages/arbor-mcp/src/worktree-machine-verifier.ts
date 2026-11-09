/**
 * Independent machine verification for specialist worktrees.
 *
 * A Specialist's final message is deliberately not an input to the decision:
 * this boundary executes one immutable, argv-only command in the admitted
 * worktree and can produce `!verified` only from its observed zero exit.
 * Network denial is accepted only when the execution port can enforce it;
 * the local port is deliberately honest that it cannot do so.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { Provenance, VerificationCheck, VerificationStrength } from "@arbor/core";
import type { NativeConversationEntry } from "@arbor/harness";
import { SandboxedVerificationCommandPort } from "./sandbox/confined-command.js";
import { hasVacuousPackageScript, resolvedPackageScriptIdentity, vacuousInlineCheckReason } from "./verification-script-vacuity.js";

export type VerificationNetworkPolicy = "unrestricted" | "enforced_denied";

/** An operator's recorded reason for letting one verification command use host network. */
export interface VerificationNetworkEgress {
  readonly reason: string;
}

/** Evidence that a stage ran with an explicit network grant: its bounded label and the declared reason. */
export interface VerificationNetworkEgressRecord {
  readonly display: string;
  readonly reason: string;
}

/**
 * Y-1 (least-privilege #1, graduated scope enforcement): `"block"` is
 * G-SCOPE's original behavior — an out-of-scope tracked change fails
 * verification outright. `"audit"` is the new middle tier for MINED
 * (non-authored) scopes: verification proceeds normally and the mismatch is
 * carried on the outcome instead (`ScopeMismatchObservation`), so the
 * composition can journal it without letting a merely-guessed scope block
 * correct work.
 */
export type ScopeEnforcement = "block" | "audit";

/** A node's declared write scope, plus how strictly it binds the worktree diff. */
export interface DeclaredWriteScope {
  readonly paths: readonly string[];
  readonly enforcement: ScopeEnforcement;
}

/**
 * An out-of-scope-write mismatch observed against the worktree diff. Carried
 * on the verification outcome (never blocking by itself when `enforcement`
 * is `"audit"`) so a composition root can journal it as an
 * `arbor-audit` `scope_observation` record. `enforcement` here always
 * mirrors the `DeclaredWriteScope` that produced it — "blocked" for
 * `"block"`, "audit" for `"audit"` — and is derived structurally by the
 * caller (see `cli.ts`'s `scopeIsAuthored`), never read from any
 * model-produced field.
 */
export interface ScopeMismatchObservation {
  readonly declared: readonly string[];
  readonly observed_out_of_scope: readonly string[];
  readonly enforcement: "audit" | "blocked";
}

export interface WorktreeVerificationCommand {
  /** A single executable and its arguments. Shell strings are never accepted. */
  readonly argv: readonly [string, ...string[]];
  readonly timeout_ms?: number;
  /** The composition must state honestly whether this command can use a network. */
  readonly network: VerificationNetworkPolicy;
  /**
   * Present iff an operator explicitly granted this exact argv host network
   * (`verification.network_egress`); requires `network: "unrestricted"`. The
   * reason is recorded in the evidence label (and so in the verified
   * provenance `cmd`) and on the outcome's `network_egress`, so a reader can
   * see which command ran with network and why.
   */
  readonly network_egress?: VerificationNetworkEgress;
  /**
   * A bounded audit label recorded as the verified provenance `cmd`, in place
   * of the raw argv. Set it when the argv carries content that must not leak
   * into the durable session projection — e.g. a declared-outputs check whose
   * argv lists repository file paths. When omitted, the argv display is used.
   */
  readonly display?: string;
  /** Machine-readable scope only; paths and prose remain excluded. */
  readonly check?: VerificationCheck;
  /**
   * E-4 (arXiv 2605.17029/2501.01054, cascades 2607.13918): declares WHAT
   * this command actually establishes. `"command_executed"` (the default
   * when omitted, preserving pre-E-4 behavior) is the plan's real
   * acceptance command. A composition that derives a declared-outputs
   * existence check (no acceptance command available) must say so
   * explicitly with `"outputs_check"` -- the verifier has no way to infer
   * this from the argv alone, and must not silently claim the stronger
   * evidence class.
   */
  readonly strength?: VerificationStrength;
  /**
   * Optional root mounted read-only alongside the writable worktree (see
   * `SandboxedCommandRequest.readonly_context_root`): a linked worktree's
   * dependencies live in the enclosing checkout, and a declared acceptance
   * command cannot resolve them from the worktree mount alone.
   */
  readonly context_root?: string;
  /** Explicit read-only dependency cache backing links beneath context_root. */
  readonly dependency_root?: string;
  /** Additional exact dependency/workspace-package roots backing links beneath context_root. */
  readonly dependency_roots?: readonly string[];
}

/**
 * Ordered, sequential, fail-fast staged verification: a compound acceptance
 * lane (e.g. revoy2's own `bun run build && bun run test:all && bun run
 * gate:all`) plausibly exceeds any single stage's timeout budget, and an
 * opaque one-argv `WorktreeVerificationCommand` has no way to give its build
 * step and its test step independent budgets. A caller that only ever had
 * one command is unaffected: `command`/`command_for_node` may still return a
 * bare `WorktreeVerificationCommand` (unchanged behavior, no stage evidence
 * attached); wrapping the same stages in `{ stages: [...] }` opts into this
 * behavior instead.
 */
export interface StagedWorktreeVerificationCommand {
  readonly stages: readonly WorktreeVerificationCommand[];
}

export type WorktreeVerificationSpec = WorktreeVerificationCommand | StagedWorktreeVerificationCommand;

/** Per-stage machine evidence for a staged verification run. Never carries raw stdout/stderr -- see `verificationFailureDiagnostic` for the bounded failure text attached at the outcome level instead. */
export interface VerificationStageResult {
  readonly display: string;
  readonly argv: readonly string[];
  readonly exit: number | null;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly outcome: "passed" | "failed";
  /**
   * S01: present only when `argv` is a bare package-manager `run <name>`
   * invocation whose script text was resolved from `package.json` at the
   * moment this stage ran. Binds the acceptance evidence to the exact
   * SCRIPT BODY that executed, not merely the script's name -- a later edit
   * to `package.json` changes this hash on the next run, so a stale record
   * cannot be mistaken for evidence about the current script, and a
   * different node's differently-scripted `package.json` cannot inherit
   * this record's acceptance. Absent for non-package-script argv, which
   * already carries its own identity via `argv` itself.
   */
  readonly script_identity?: { readonly script_name: string; readonly sha256: string };
}

export interface MachineVerificationCommandRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly network: VerificationNetworkPolicy;
  readonly signal: AbortSignal;
  /** See `WorktreeVerificationCommand.context_root`. */
  readonly context_root?: string;
  readonly dependency_root?: string;
  readonly dependency_roots?: readonly string[];
}

export type MachineVerificationCommandResult =
  | { readonly kind: "exited"; readonly exit: number; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "cancelled"; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "timed_out"; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "output_limited"; readonly stdout: Buffer; readonly stderr: Buffer }
  | { readonly kind: "network_isolation_unavailable" }
  | { readonly kind: "spawn_failed" };

/** Process authority owned by composition, so tests can prove decisions without a shell. */
export interface MachineVerificationCommandPort {
  run(request: MachineVerificationCommandRequest): Promise<MachineVerificationCommandResult>;
}

export interface SpecialistWorktreeVerificationInput {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly specialist_agent: string;
  readonly session_id: string;
  readonly worktree_path: string;
  /** Present for correlation only; it is never parsed or trusted as evidence. */
  readonly final_message: string;
  /** Present for correlation only; it is never parsed or trusted as evidence. */
  readonly history: readonly NativeConversationEntry[];
}

/** The three things a verification attempt can resolve to; see `SpecialistWorktreeVerificationPort.verifyOutcome`. */
export type SpecialistWorktreeVerificationOutcome =
  | {
      readonly outcome: "verified";
      readonly message: string;
      readonly provenance: Extract<Provenance, { readonly tag: "verified" }>;
      /** Exact argv observed by the trusted command port, retained separately from the bounded audit label. */
      readonly command_argv: readonly string[];
      /** Y-1: present only when a declared write scope mismatched the observed diff (audit tier -- never present for a blocked mismatch, since that fails the outcome instead). */
      readonly out_of_scope_observation?: ScopeMismatchObservation;
      /** Present only when the composition opted into staged verification (`{ stages: [...] }`); absent for a bare single `WorktreeVerificationCommand`, preserving its exact pre-staging shape. */
      readonly stage_results?: readonly VerificationStageResult[];
      /** Sanitized, bounded tail of the final stage's output, for the critic's review evidence. Never an input to provenance. */
      readonly output_tail?: string;
      /** Every stage that ran under an explicit network grant, with its reason. Absent when every stage ran network-denied. */
      readonly network_egress?: readonly VerificationNetworkEgressRecord[];
    }
  /** E-2 (arXiv 2607.13034): a command WAS derived and actually run, but did not exit cleanly. */
  | {
      readonly outcome: "failed";
      /** Bounded machine reason; raw command output is never promoted into this control-plane result. */
      readonly code?: "command_exit_nonzero" | "command_cancelled" | "command_timed_out" | "command_output_limited" | "network_isolation_unavailable" | "command_spawn_failed" | "protected_inherited_path_invalid" | "protected_inherited_path_changed" | "write_scope_violation" | "verification_vacuous";
      readonly exit?: number;
      /** Sanitized tail of machine output, bounded for governed retry context. */
      readonly diagnostic?: string;
      readonly out_of_scope_observation?: ScopeMismatchObservation;
      /** Present only for staged verification (see the `"verified"` variant); includes every stage attempted up to and including the failing one. */
      readonly stage_results?: readonly VerificationStageResult[];
      /**
       * ADR-185 graded signal: how much of the declared plan passed before it
       * failed. A STAGE is one entry of the declared plan -- each declared
       * acceptance/verification command, in order (a bare command is a plan of
       * exactly one stage). The plan is fail-fast, so stages after the failing
       * one never ran and count as not passed: `passed` is the failing stage's
       * zero-based index and `total` is the declared plan length. Reported for
       * every failure that happened while running the plan (non-zero exit,
       * cancel, timeout, output limit, spawn/isolation failure, vacuous check),
       * independent of the `stage_results` evidence opt-in. Absent when the
       * plan never started (write-scope or protected-path refusal), where no
       * stage measurement exists.
       */
      readonly stages?: { readonly passed: number; readonly total: number };
      /** See the `"verified"` variant: stages attempted under an explicit network grant, including the failing one. */
      readonly network_egress?: readonly VerificationNetworkEgressRecord[];
    }
  /** Aborted signal, non-admitted worktree, or no command declared for this node -- nothing to check, stays `claimed`. */
  | { readonly outcome: "not_attempted" };

export interface SpecialistWorktreeVerificationPort {
  /** `null` iff the outcome was not `"verified"` -- unchanged pre-E-2 contract, kept exactly as-is so this port stays structurally compatible with any other consumer expecting only this method. */
  verify(input: SpecialistWorktreeVerificationInput, signal: AbortSignal): Promise<{
    readonly message: string;
    readonly provenance: Extract<Provenance, { readonly tag: "verified" }>;
    readonly command_argv: readonly string[];
  } | null>;
  /**
   * E-2: the same verification attempt as `verify()`, but distinguishing a
   * real attempted-and-failed verification from "nothing was attempted" --
   * `verify()` alone collapses both into `null`. Optional: existing
   * `SpecialistWorktreeVerificationPort` implementations (and any narrower
   * consumer expecting only `verify`) remain valid without it; only
   * `WorktreeMachineVerifier` implements it today. Callers use this
   * distinction to gate turn-budget expansion on a critic-block retry —
   * only a genuine failure justifies more turns, never mere absence of
   * verification.
   */
  verifyOutcome?(input: SpecialistWorktreeVerificationInput, signal: AbortSignal): Promise<SpecialistWorktreeVerificationOutcome>;
}

export interface WorktreeMachineVerifierOptions {
  /**
   * A single static verification command, or omit it and supply
   * `command_for_node` to derive one per node. A hardcoded whole-repo build is
   * a poor generalist default: it cannot even run in a fresh worktree (no
   * dependencies) and is irrelevant to, say, a documentation task, so every
   * node was capped at `claimed`. A per-node command tied to the plan's
   * declared outputs is both runnable and task-appropriate.
   */
  readonly command?: WorktreeVerificationSpec;
  /** Derive the verification command (or staged plan) from the node; null means "nothing to verify" (stays claimed). */
  readonly command_for_node?: (input: SpecialistWorktreeVerificationInput) => WorktreeVerificationSpec | null;
  /**
   * Upgrade-only attempt tried BEFORE the primary command: a clean exit is
   * the verification (typically the stronger command_executed evidence); a
   * failure silently falls through to the primary. For heuristically mined
   * acceptance commands, which must never block correct work.
   */
  readonly opportunistic_command_for_node?: (input: SpecialistWorktreeVerificationInput) => WorktreeVerificationSpec | null;
  /**
   * G-SCOPE (ab3 bench), widened by Y-1: the node's declared write scope,
   * when one exists. A non-empty return arms an out-of-scope-write check:
   * `git status --porcelain` runs in the worktree BEFORE the verification
   * command, and any changed path outside the declared list is a mismatch.
   * `enforcement: "block"` fails verification outright (G-SCOPE's original
   * behavior) -- without this the declaration was decorative on the
   * connector path, a bench specialist wrote package.json under a scope
   * declaring only test/decorator.test.js and still verified.
   * `enforcement: "audit"` is the Y-1 middle tier for MINED (non-authored)
   * scopes: the mismatch never blocks -- verification proceeds and the
   * mismatch is carried on the outcome's `out_of_scope_observation` instead,
   * for composition to journal. Null/empty means no scope was declared and
   * no enforcement applies.
   */
  readonly write_scope_for_node?: (input: SpecialistWorktreeVerificationInput) => DeclaredWriteScope | null;
  /**
   * Y-1 (ADR-066, lineage-scoped diff union): a write-scope mismatch is
   * checked per-node only, so a specialist can split an out-of-scope change
   * across a critic-block retry lineage — each individual node's diff stays
   * inside ITS OWN declared scope while the sum, across the lineage, does
   * not. This seam widens the check's comparison set without touching
   * `DeclaredWriteScope` itself (which stays a pure "what this node
   * declares" value, back-compat for every existing caller that doesn't
   * supply this option): when present, returns the union of tracked-write
   * paths already recorded for the node's ancestor lineage (see
   * `manager.ts`'s `deriveScopeLineagePaths`, the composition-side source of
   * this data). `verifyOutcome` unions these paths with the CURRENT diff
   * before filtering against the declared scope — so an ancestor's
   * already-written path that this node's own declared scope never covers
   * is flagged even though this node never touched it itself. Absent or
   * empty changes nothing: the check degrades to exactly pre-Y-1 behavior.
   */
  readonly lineage_paths_for_node?: (input: SpecialistWorktreeVerificationInput) => readonly string[];
  /**
   * Inherited paths materialized before dispatch that this node did not
   * receive authority to edit. Any content drift fails before verification,
   * preventing a downstream verifier from laundering changes to its inputs.
   */
  readonly protected_inherited_paths_for_node?: (input: SpecialistWorktreeVerificationInput) => readonly { readonly path: string; readonly sha256: string | null }[];
  /**
   * Test seam for the scope check's status query. Returns `git status
   * --porcelain` stdout for the worktree, or null when no status can be
   * taken (not a git checkout / git unavailable) — null skips enforcement.
   * Defaults to a direct spawn of the fixed harness-owned git command.
   */
  readonly git_status_for_scope?: (worktreePath: string) => string | null;
  readonly command_port?: MachineVerificationCommandPort;
  /**
   * Per-command timeout ceiling (see `WorktreeVerificationCommand.timeout_ms`,
   * bounded by this). Was declared but never wired to anything -- every
   * caller was silently capped at the hardcoded 900_000ms default regardless
   * of this option, exactly the "documented but not wired" antipattern this
   * repo's own conventions call out. Now load-bearing: defaults to 900_000ms
   * unchanged, but a composition whose own acceptance lane (e.g. revoy2's
   * `bun run build && bun run test:all && bun run gate:all`) genuinely needs
   * more can raise it, up to `ABSOLUTE_MAX_TIMEOUT_MS`.
   */
  readonly max_timeout_ms?: number;
  readonly max_output_bytes?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
/** Hard backstop no `max_timeout_ms` configuration can exceed -- "configurable" must not mean "unbounded". */
const ABSOLUTE_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Composition-owned verifier. There is intentionally no callback through
 * which a Specialist or model can assert verified provenance.
 */
export class WorktreeMachineVerifier implements SpecialistWorktreeVerificationPort {
  private readonly maxOutputBytes: number;
  private readonly maxTimeoutMs: number;
  private readonly port: MachineVerificationCommandPort;

  constructor(private readonly options: WorktreeMachineVerifierOptions) {
    if (options.command === undefined && options.command_for_node === undefined) {
      throw new Error("WorktreeMachineVerifier requires either a static command or command_for_node");
    }
    if (options.command !== undefined) normalizeSpec(options.command);
    this.maxOutputBytes = bounded(options.max_output_bytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, "verification max_output_bytes");
    this.maxTimeoutMs = bounded(options.max_timeout_ms, MAX_TIMEOUT_MS, ABSOLUTE_MAX_TIMEOUT_MS, "verification max_timeout_ms");
    this.port = options.command_port ?? new SandboxedVerificationCommandPort();
  }

  async verify(input: SpecialistWorktreeVerificationInput, signal: AbortSignal): Promise<{ readonly message: string; readonly provenance: Extract<Provenance, { readonly tag: "verified" }>; readonly command_argv: readonly string[] } | null> {
    const outcome = await this.verifyOutcome(input, signal);
    return outcome.outcome === "verified" ? { message: outcome.message, provenance: outcome.provenance, command_argv: outcome.command_argv } : null;
  }

  async verifyOutcome(input: SpecialistWorktreeVerificationInput, signal: AbortSignal): Promise<SpecialistWorktreeVerificationOutcome> {
    if (signal.aborted || !admittedWorktree(input.worktree_path)) return { outcome: "not_attempted" };
    const spec = this.options.command_for_node ? this.options.command_for_node(input) : this.options.command!;
    if (spec === null) return { outcome: "not_attempted" }; // nothing to verify for this node; it stays claimed, honestly
    const { stages, staged } = normalizeSpec(spec);
    for (const inherited of this.options.protected_inherited_paths_for_node?.(input) ?? []) {
      if (!safeRelativePath(inherited.path) || (inherited.sha256 !== null && !/^[0-9a-f]{64}$/.test(inherited.sha256))) return { outcome: "failed", code: "protected_inherited_path_invalid" };
      const path = join(realpathSync(input.worktree_path), inherited.path);
      let actual: string | null = null;
      try { actual = existsSync(path) ? rawSha256(readFileSync(path)) : null; } catch { return { outcome: "failed", code: "protected_inherited_path_changed" }; }
      if (actual !== inherited.sha256) return { outcome: "failed", code: "protected_inherited_path_changed" };
    }
    // G-SCOPE: declared write scope binds the worktree diff. Checked before
    // the (possibly expensive) verification command so an out-of-scope write
    // fails fast and never earns verified provenance. The status query is a
    // fixed, harness-owned read-only git command (no model input reaches its
    // argv), and it deliberately does NOT go through the sandboxed command
    // port: a linked git worktree's `.git` file points outside the sandbox
    // mount, so a confined `git status` cannot resolve the repository at
    // all. Enforcement is best-effort by construction — when the status
    // query itself cannot run (not a git checkout, git absent), there is no
    // diff to bind and verification proceeds without the check.
    const scope = this.options.write_scope_for_node?.(input) ?? null;
    let outOfScopeObservation: ScopeMismatchObservation | undefined;
    if (scope !== null && scope.paths.length > 0) {
      const status = (this.options.git_status_for_scope ?? defaultGitStatusForScope)(realpathSync(input.worktree_path));
      if (status !== null) {
        const declared = new Set(scope.paths);
        // Enforce tracked changes and untracked additions alike. A blanket
        // untracked-file exemption is a write-scope bypass: a specialist can
        // put arbitrary product code in a new undeclared file, pass machine
        // verification, and only be rejected later at adoption. Exclude only
        // the explicit harness-owned runtime namespaces below.
        // Y-1: union the current diff with the ancestor lineage's already-
        // recorded tracked-write paths before filtering against this node's
        // declared scope -- see `lineage_paths_for_node`'s doc for why.
        const lineagePaths = this.options.lineage_paths_for_node?.(input) ?? [];
        const unionPaths = new Set([...parsePorcelainPaths(status), ...lineagePaths]);
        const observedOutOfScope = Array.from(unionPaths).filter((changed) => !declared.has(changed));
        if (observedOutOfScope.length > 0) {
          // Y-1: "block" fails fast exactly as G-SCOPE always did. "audit"
          // never blocks -- the mismatch is carried on whatever outcome
          // verification below produces, so composition can journal it.
          if (scope.enforcement === "block") {
            return { outcome: "failed", code: "write_scope_violation", out_of_scope_observation: { declared: scope.paths, observed_out_of_scope: observedOutOfScope, enforcement: "blocked" } };
          }
          outOfScopeObservation = { declared: scope.paths, observed_out_of_scope: observedOutOfScope, enforcement: "audit" };
        }
      }
    }
    // S8 follow-up: an OPPORTUNISTIC command is upgrade-only evidence. It
    // exists for heuristically MINED acceptance commands (reviewed tier):
    // a clean exit earns the stronger command_executed provenance, but any
    // failure falls through to the primary command instead of failing the
    // node — a mined guess must never be able to block correct work, only
    // strengthen its evidence.
    // S13: this node's declared write scope (when known) is also the input
    // to the semantic-relationship guard below -- an inline `-e`/`-c`/
    // `--eval` check earns evidence only if it (or its trailing argv) names
    // one of these paths; see `vacuousInlineCheckReason`.
    const declaredPaths = scope?.paths ?? [];
    const opportunistic = this.options.opportunistic_command_for_node?.(input) ?? null;
    if (opportunistic !== null) {
      const plan = normalizeSpec(opportunistic);
      const attempt = await this.runPlan(plan.stages, input, signal, plan.staged, declaredPaths);
      if (attempt.outcome === "verified") return outOfScopeObservation ? { ...attempt, out_of_scope_observation: outOfScopeObservation } : attempt;
      // A demonstrated vacuous check is not an ordinary failed mined guess.
      // Falling back would let file existence launder it into verified work.
      if (attempt.code === "verification_vacuous") return outOfScopeObservation ? { ...attempt, out_of_scope_observation: outOfScopeObservation } : attempt;
    }
    const result = await this.runPlan(stages, input, signal, staged, declaredPaths);
    // E-2: a command was derived and actually run but did not exit cleanly --
    // a real verification FAILURE, distinguishable from "nothing to check"
    // (the `command === null` branch above, which returns `not_attempted`).
    return outOfScopeObservation ? { ...result, out_of_scope_observation: outOfScopeObservation } : result;
  }

  /** Runs one verification command's port dispatch, timing it for staged evidence. */
  private async executeCommand(
    command: WorktreeVerificationCommand,
    input: SpecialistWorktreeVerificationInput,
    signal: AbortSignal,
  ): Promise<{ result: MachineVerificationCommandResult; duration_ms: number }> {
    const startedAt = Date.now();
    const result = await this.port.run({
      argv: command.argv,
      cwd: realpathSync(input.worktree_path),
      timeout_ms: bounded(command.timeout_ms, DEFAULT_TIMEOUT_MS, this.maxTimeoutMs, "verification timeout_ms"),
      max_output_bytes: this.maxOutputBytes,
      network: command.network,
      signal,
      ...(command.context_root === undefined ? {} : { context_root: command.context_root }),
      ...(command.dependency_root === undefined ? {} : { dependency_root: command.dependency_root }),
      ...(command.dependency_roots === undefined ? {} : { dependency_roots: command.dependency_roots }),
    });
    return { result, duration_ms: Date.now() - startedAt };
  }

  /**
   * Runs an ordered stage sequence, fail-fast: the first non-zero/cancelled/
   * timed-out/limited stage stops the plan and is returned as `"failed""`,
   * carrying every stage attempted so far when `includeStageResults` is set.
   * A bare single-command caller (`includeStageResults: false`, the pre-
   * staging call shape) gets byte-for-byte the same `"verified"`/`"failed"`
   * shape this method replaced -- `stage_results` is only ever attached when
   * the composition opted into `{ stages: [...] }`.
   */
  private async runPlan(
    stages: readonly WorktreeVerificationCommand[],
    input: SpecialistWorktreeVerificationInput,
    signal: AbortSignal,
    includeStageResults: boolean,
    declaredPaths: readonly string[],
  ): Promise<Extract<SpecialistWorktreeVerificationOutcome, { outcome: "verified" | "failed" }>> {
    const stageResults: VerificationStageResult[] = [];
    const boundDisplays: string[] = [];
    const egress: VerificationNetworkEgressRecord[] = [];
    const egressEvidence = (): { network_egress?: readonly VerificationNetworkEgressRecord[] } => egress.length === 0 ? {} : { network_egress: [...egress] };
    for (let i = 0; i < stages.length; i++) {
      // ADR-185: fail-fast, so a failure at index i means exactly i stages passed.
      const stageProgress = { passed: i, total: stages.length };
      const stage = stages[i];
      const display = stage.display ?? commandDisplay(stage.argv);
      // S01: resolved once per stage, at the moment this stage is about to
      // run (or be rejected as vacuous) -- not recomputed later -- so the
      // identity reflects exactly the script content this attempt observed.
      const scriptIdentity = resolvedPackageScriptIdentity(stage.argv, input.worktree_path) ?? undefined;
      const scriptBoundDisplay = scriptIdentity ? `${display} [script_sha256:${scriptIdentity.sha256.slice(0, 16)}]` : display;
      // An explicit network grant is part of what this evidence attests: the
      // label (and so the verified provenance `cmd`) names it and its reason.
      const boundDisplay = stage.network_egress === undefined ? scriptBoundDisplay : `${scriptBoundDisplay} [network:egress reason=${JSON.stringify(stage.network_egress.reason)}]`;
      boundDisplays.push(boundDisplay);
      // S13 (manifest S01 residual): the literal-noop guard above catches a
      // closed grammar of trivially-inert shell text. It does NOT catch
      // `node -e "process.exit(0)"` -- genuinely dispatchable, genuinely
      // exiting zero, proving nothing. `vacuousInlineCheckReason` extends
      // the guard to inline interpreter invocations (`-e`/`-c`/`--eval`),
      // requiring a defensible relationship to the repository -- a
      // reference to this node's declared write scope when one is known,
      // or at minimum a filesystem/module touch otherwise. It never fires
      // on a real test runner, build tool, or script file (those are not
      // `-e`/`-c`/`--eval` invocations), so it cannot over-refuse them.
      const packageScriptVacuous = hasVacuousPackageScript(stage.argv, input.worktree_path);
      const inlineVacuousReason = packageScriptVacuous ? null : vacuousInlineCheckReason(stage.argv, input.worktree_path, declaredPaths);
      if (packageScriptVacuous || inlineVacuousReason !== null) {
        if (includeStageResults) stageResults.push({ display: boundDisplay, argv: [...stage.argv], exit: null, duration_ms: 0, timed_out: false, outcome: "failed", ...(scriptIdentity ? { script_identity: scriptIdentity } : {}) });
        return { outcome: "failed", code: "verification_vacuous",
          diagnostic: packageScriptVacuous
            ? "Package script contains only literal messages, version queries, or no-ops; no acceptance check was executed."
            : inlineVacuousReason!,
          ...(includeStageResults ? { stage_results: stageResults } : {}), stages: stageProgress };
      }
      if (stage.network_egress !== undefined) egress.push({ display: boundDisplay, reason: stage.network_egress.reason });
      const { result, duration_ms } = await this.executeCommand(stage, input, signal);
      const exit = result.kind === "exited" ? result.exit : null;
      // Vitest can be configured with passWithNoTests, making an absent or
      // misspelled target exit zero. That proves only that the runner started,
      // not that the declared test executed. Keep this semantic check scoped
      // to an explicit Vitest argv so arbitrary commands remain generic.
      const vacuous = result.kind === "exited" && result.exit === 0
        && declaredVitestCommand(stage.argv) && vitestReportedNoTests(result);
      const passed = result.kind === "exited" && result.exit === 0 && !vacuous;
      if (includeStageResults) {
        stageResults.push({ display: boundDisplay, argv: [...stage.argv], exit, duration_ms, timed_out: result.kind === "timed_out", outcome: passed ? "passed" : "failed", ...(scriptIdentity ? { script_identity: scriptIdentity } : {}) });
      }
      if (!passed) {
        const diagnostic = verificationFailureDiagnostic(result, input.worktree_path);
        if (vacuous) {
          return { outcome: "failed", code: "verification_vacuous", exit: 0, ...(diagnostic === undefined ? {} : { diagnostic }), ...(includeStageResults ? { stage_results: stageResults } : {}), stages: stageProgress, ...egressEvidence() };
        }
        if (result.kind === "exited") {
          return { outcome: "failed", code: "command_exit_nonzero", exit: result.exit, ...(diagnostic === undefined ? {} : { diagnostic }), ...(includeStageResults ? { stage_results: stageResults } : {}), stages: stageProgress, ...egressEvidence() };
        }
        const code = {
          cancelled: "command_cancelled",
          timed_out: "command_timed_out",
          output_limited: "command_output_limited",
          network_isolation_unavailable: "network_isolation_unavailable",
          spawn_failed: "command_spawn_failed",
        }[result.kind] as Extract<SpecialistWorktreeVerificationOutcome, { outcome: "failed" }>["code"];
        return { outcome: "failed", code, ...(diagnostic === undefined ? {} : { diagnostic }), ...(includeStageResults ? { stage_results: stageResults } : {}), stages: stageProgress, ...egressEvidence() };
      }
      if (i === stages.length - 1) {
        // Prefer a bounded audit label over the raw argv so an argv carrying
        // repository paths cannot leak into the durable session projection.
        // S01: each stage's label already carries its resolved package-script
        // content hash (see `boundDisplays` above) when one applies, so the
        // persisted `provenance.cmd` -- the exact evidence critic, memory and
        // UI surfaces read -- is bound to the script that actually ran.
        const combinedDisplay = boundDisplays.join(" && ");
        const outputTail = verificationFailureDiagnostic(result, input.worktree_path);
        return {
          outcome: "verified",
          message: `machine verification passed: ${combinedDisplay}`,
          command_argv: stages.flatMap((s) => [...s.argv]),
          ...(outputTail === undefined ? {} : { output_tail: outputTail }),
          ...(includeStageResults ? { stage_results: stageResults } : {}),
          ...egressEvidence(),
          provenance: {
            tag: "verified", cmd: combinedDisplay, exit: result.exit, stdout_hash: sha256(result.stdout),
            check: stage.check ?? { kind: "shell_command", breadth: "single" },
            strength: stage.strength ?? "command_executed",
          },
        };
      }
    }
    /* istanbul ignore next -- unreachable: normalizeSpec/callers never hand this an empty stage list */
    throw new Error("verification stage plan was empty");
  }
}

function declaredVitestCommand(argv: readonly string[]): boolean {
  const names = argv.map((part) => basename(part).toLowerCase());
  if (/^vitest(?:\.m?js|\.cjs|\.exe)?$/.test(names[0] ?? "")) return true;
  if (["bunx", "npx"].includes(names[0] ?? "")) return /^vitest(?:\.m?js|\.cjs|\.exe)?$/.test(names[1] ?? "");
  if (names[0] === "bun" && names[1] === "x") return /^vitest(?:\.m?js|\.cjs|\.exe)?$/.test(names[2] ?? "");
  return names[0] === "node" && /^vitest(?:\.m?js|\.cjs)?$/.test(names[1] ?? "");
}

function vitestReportedNoTests(result: Extract<MachineVerificationCommandResult, { kind: "exited" }>): boolean {
  const output = Buffer.concat([result.stdout, Buffer.from("\n"), result.stderr]).toString("utf8").replace(ANSI_ESCAPE, "");
  return /^\s*No test files found(?:, exiting with code \d+)?\s*$/im.test(output);
}

/** Validate a spec (bare command or `{ stages }`) and normalize it into an ordered, non-empty stage list. `staged` is true only when the composition explicitly opted into `{ stages: [...] }` -- it gates whether `stage_results` evidence is attached, keeping a bare single-command caller's outcome shape byte-for-byte unchanged. */
function normalizeSpec(spec: WorktreeVerificationSpec): { stages: readonly WorktreeVerificationCommand[]; staged: boolean } {
  if ("stages" in spec) {
    if (!Array.isArray(spec.stages) || spec.stages.length === 0) {
      throw new Error("verification stages must be a non-empty array");
    }
    for (const stage of spec.stages) validateCommand(stage);
    return { stages: spec.stages, staged: true };
  }
  validateCommand(spec);
  return { stages: [spec], staged: false };
}

const FAILURE_DIAGNOSTIC_CHARS = 2_048;
const ANSI_ESCAPE = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

/** Converts bounded command buffers into retry-safe evidence, never raw output: the failure diagnostic, and the verified outcome's output tail. */
function verificationFailureDiagnostic(result: MachineVerificationCommandResult, worktreePath: string): string | undefined {
  if (!("stdout" in result)) return undefined;
  const value = sanitizeHarnessEvidenceText(Buffer.concat([result.stdout, Buffer.from("\n"), result.stderr]).toString("utf8"), worktreePath);
  if (!value) return undefined;
  const characters = Array.from(value);
  return characters.length <= FAILURE_DIAGNOSTIC_CHARS ? value : characters.slice(-FAILURE_DIAGNOSTIC_CHARS).join("");
}

/**
 * The structural redaction every harness-captured evidence text crosses
 * before it may reach a model or a durable record: terminal control is
 * stripped, the worktree and home roots are de-identified, and credential
 * and e-mail shapes are replaced. Shared by the verifier's diagnostics and
 * the native critic's candidate diff so both cross the same boundary.
 */
export function sanitizeHarnessEvidenceText(text: string, worktreePath: string): string {
  let value = text
    .replace(ANSI_ESCAPE, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!value) return "";
  const roots = [worktreePath, process.env.HOME].filter((root): root is string => typeof root === "string" && root.length > 0);
  for (const root of roots) value = value.split(root).join(root === worktreePath ? "<worktree>" : "~");
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|password|secret|credential)\s*[=:]\s*[^\s\"']+/gi, (match) => `${match.split(/[=:]/, 1)[0]}=[REDACTED]`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
}

function admittedWorktree(path: string): boolean {
  try { return isAbsolute(path) && existsSync(path) && statSync(realpathSync(path)).isDirectory(); } catch { return false; }
}

function validateCommand(command: WorktreeVerificationCommand): void {
  if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
    throw new Error("verification command argv must contain non-empty NUL-free strings");
  }
  if (command.network !== "unrestricted" && command.network !== "enforced_denied") throw new Error("verification command network policy is invalid");
  if (command.network_egress !== undefined) {
    if (command.network !== "unrestricted") throw new Error("verification network_egress requires network \"unrestricted\"");
    if (typeof command.network_egress.reason !== "string" || command.network_egress.reason.trim() === "") throw new Error("verification network_egress requires a non-empty reason");
  }
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !isAbsolute(path) && !path.includes("\0") && !path.split(/[\\/]/).includes("..");
}

function bounded(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0 || actual > maximum) throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  return actual;
}

/**
 * Repo-relative changed paths from `git status --porcelain` v1 output. A
 * rename line ("R  old -> new") contributes both sides; quoted paths are
 * unquoted per git's C-style escaping only far enough for exact-match
 * comparison (a scope never declares paths needing escapes).
 */
function defaultGitStatusForScope(worktreePath: string): string | null {
  const result = spawnSync("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8", timeout: 30_000 });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
}

function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const body = line.slice(3);
    for (const side of body.split(" -> ")) {
      const cleaned = side.startsWith("\"") && side.endsWith("\"") ? side.slice(1, -1) : side;
      if (cleaned.length > 0 && !isHarnessOwnedRuntimePath(cleaned)) paths.push(cleaned);
    }
  }
  return paths;
}

function isHarnessOwnedRuntimePath(path: string): boolean {
  return [".arbor/", ".arbor-evidence/", ".arbor-session/"].some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

function commandDisplay(argv: readonly string[]): string { return argv.map((part) => /^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)).join(" "); }
function rawSha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sha256(value: Buffer): string { return `sha256:${rawSha256(value)}`; }
