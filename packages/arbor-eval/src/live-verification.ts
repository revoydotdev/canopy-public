/**
 * arbor-eval/live-verification — runs a task's real verification command and
 * produces the ONLY provenance shape that may retire a tree node as
 * `verified` (see `packages/arbor-core/src/tree.ts`'s `verifyNode` and
 * `packages/arbor-gate/src/gate.ts`'s `checkEvidence`, which requires
 * `exit === 0` and a non-empty `stdout_hash` for the `verified` tag).
 *
 * This module never fabricates a hash or an exit code: `stdout_hash` is
 * always `sha256:` + the actual digest of the bytes the child process wrote
 * to stdout, and `exit` is always the real process exit code (or `null` if
 * the process was killed by a signal, which counts as "did not run to
 * completion" and can never become `verified`).
 */
import { createHash } from "node:crypto";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import type { Provenance, VerificationCheckBreadth } from "@arbor/core";

/** A real, executable verification command — never a description of one. */
export interface VerificationCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeout_ms?: number;
}

/** The raw, unfiltered outcome of actually running a verification command. */
export interface VerificationRunResult {
  readonly cmd_label: string;
  /** False only when the process could not be spawned at all (e.g. ENOENT). */
  readonly ran: boolean;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_hash: string | null;
  readonly spawn_error: string | null;
  /**
   * ADR-133 §1: real wall-clock milliseconds spent in the `spawnSync` call
   * above (measured even on a spawn failure, since that is still real time
   * spent attempting the command). Additive — no existing field's meaning
   * changes; nothing downstream is required to read it yet.
   */
  readonly duration_ms: number;
}

/**
 * Actually spawn the verification command and content-hash its stdout. This
 * is the one place in the live lane that touches a real process — every
 * caller must go through this function rather than constructing a
 * `VerificationRunResult` by hand.
 */
export function runVerificationCommand(command: VerificationCommand): VerificationRunResult {
  const cmdLabel = [command.cmd, ...command.args].join(" ");
  const startedAt = Date.now();
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSync(command.cmd, [...command.args], {
      cwd: command.cwd,
      timeout: command.timeout_ms ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return Object.freeze({
      cmd_label: cmdLabel, ran: false, exit_code: null, stdout: "", stderr: "", stdout_hash: null,
      spawn_error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    });
  }
  if (result.error) {
    return Object.freeze({
      cmd_label: cmdLabel, ran: false, exit_code: null, stdout: "", stderr: "", stdout_hash: null,
      spawn_error: result.error.message,
      duration_ms: Date.now() - startedAt,
    });
  }
  const stdout = result.stdout?.toString("utf8") ?? "";
  const stderr = result.stderr?.toString("utf8") ?? "";
  return Object.freeze({
    cmd_label: cmdLabel,
    ran: true,
    exit_code: result.status,
    stdout,
    stderr,
    stdout_hash: `sha256:${createHash("sha256").update(stdout).digest("hex")}`,
    spawn_error: null,
    duration_ms: Date.now() - startedAt,
  });
}

/**
 * Derive a `Provenance` from a real run. Returns `null` — never a fabricated
 * `verified` tag — when the command did not actually run to completion or
 * exited non-zero: `checkEvidence` requires `exit === 0` for `verified`, and
 * a task whose command never ran has produced no evidence at all, so the
 * caller must treat this as a failed node (see `manager.recordResult`'s
 * `critic_approved: false` path), never a claimed success.
 *
 * ADR-134 §2: `breadth` is no longer hardcoded here — it does not derive
 * what scope the command actually had, only the caller running it knows
 * that. A caller that declares nothing gets `check: undefined`, an honest
 * "scope unknown," never a guessed value.
 */
export function verifiedProvenanceFromRun(result: VerificationRunResult, breadth?: VerificationCheckBreadth): Provenance | null {
  if (!result.ran || result.exit_code !== 0 || result.stdout_hash === null) return null;
  return Object.freeze({
    tag: "verified" as const,
    cmd: result.cmd_label,
    exit: result.exit_code,
    stdout_hash: result.stdout_hash,
    ...(breadth === undefined ? {} : { check: Object.freeze({ kind: "shell_command" as const, breadth }) }),
  });
}
