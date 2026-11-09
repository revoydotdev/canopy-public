import { randomUUID } from "node:crypto";

/**
 * Narrow provider-child lifecycle seam for Repo Flight Control.
 *
 * This module deliberately has no dependency on the flight controller. A
 * provider integration owns its process argv, streams, and cancellation;
 * flight control can only admit a launch, bind the real child PID, and
 * observe its bounded terminal facts. Prompt text, environment values, and
 * provider argv never cross this boundary.
 */

export type RepoFlightChildProvider = "claude" | "codex" | "opencode";
export type RepoFlightProviderMode = "specialist" | "read_only" | "planner" | "critic";
export type RepoFlightProviderScope = "read_write" | "read_only";

/**
 * Bounded task identity and declared authority supplied by the campaign
 * layer. Null command argv means a provider-side command intent has not yet
 * been bound to exact bytes and must not be widened by an admission hook.
 */
export interface RepoFlightProviderGovernanceMetadata {
  readonly campaign_id: string | null;
  readonly node_id: string | null;
  readonly task_id: string | null;
  readonly write_paths: readonly string[];
  readonly command_argv: readonly (readonly string[])[] | null;
}

export interface RepoFlightProviderHookLaunchContext {
  /** Host-generated correlation identity, stable across this child lifecycle. */
  readonly launch_id: string;
  readonly provider: RepoFlightChildProvider;
  readonly mode: RepoFlightProviderMode;
  /** Non-specialist roles are explicitly presented as read-only admission. */
  readonly scope: RepoFlightProviderScope;
  readonly cwd: string;
  readonly model: string;
  readonly resumed_provider_session_id: string | null;
  readonly governance: RepoFlightProviderGovernanceMetadata;
}

export type RepoFlightProviderHookAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

export interface RepoFlightProviderChildContext extends RepoFlightProviderHookLaunchContext {
  /** The OS-assigned PID, obtained from the actual spawned child. */
  readonly pid: number;
}

export interface RepoFlightProviderTerminalContext extends RepoFlightProviderChildContext {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface RepoFlightProviderAbortContext extends RepoFlightProviderChildContext {
  readonly reason: "caller_abort" | "timeout" | "output_limit" | "admission_refused";
}

export interface RepoFlightProviderErrorContext extends RepoFlightProviderHookLaunchContext {
  readonly stage: "pre_launch" | "post_spawn" | "spawn" | "terminal";
  readonly pid: number | null;
  /** Bounded diagnostic only; never provider output, prompt, argv, or env. */
  readonly error: string;
}

/**
 * Optional, fail-closed hooks for a provider child lifecycle. If configured,
 * admission and PID enrollment must resolve before the prompt is written to
 * stdin. A throwing hook or an explicit refusal therefore cannot permit an
 * ungoverned specialist prompt to run.
 */
export interface RepoFlightProviderLifecycleHook {
  readonly admit?: (context: RepoFlightProviderHookLaunchContext) => RepoFlightProviderHookAdmission | void | Promise<RepoFlightProviderHookAdmission | void>;
  readonly enroll_child?: (context: RepoFlightProviderChildContext) => void | Promise<void>;
  readonly terminal?: (context: RepoFlightProviderTerminalContext) => void | Promise<void>;
  readonly abort?: (context: RepoFlightProviderAbortContext) => void | Promise<void>;
  readonly error?: (context: RepoFlightProviderErrorContext) => void | Promise<void>;
}

export class RepoFlightProviderHookRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoFlightProviderHookRefusal";
  }
}

export function repoFlightProviderLaunchContext(
  provider: RepoFlightChildProvider,
  input: {
    readonly mode: RepoFlightProviderMode;
    readonly cwd: string;
    readonly model: string;
    readonly session_id?: string;
    readonly flight_governance?: RepoFlightProviderGovernanceMetadata;
  },
): RepoFlightProviderHookLaunchContext {
  const governance = input.flight_governance ?? { campaign_id: null, node_id: null, task_id: null, write_paths: [], command_argv: [] };
  return Object.freeze({
    launch_id: randomUUID(),
    provider,
    mode: input.mode,
    scope: input.mode === "specialist" ? "read_write" : "read_only",
    cwd: input.cwd,
    model: input.model,
    resumed_provider_session_id: input.session_id ?? null,
    governance: Object.freeze({
      campaign_id: governance.campaign_id,
      node_id: governance.node_id,
      task_id: governance.task_id,
      write_paths: Object.freeze([...governance.write_paths]),
      command_argv: governance.command_argv === null ? null : Object.freeze(governance.command_argv.map((argv) => Object.freeze([...argv]))),
    }),
  });
}

export async function admitRepoFlightProviderLaunch(
  hook: RepoFlightProviderLifecycleHook | undefined,
  context: RepoFlightProviderHookLaunchContext,
): Promise<void> {
  const admission = await hook?.admit?.(context);
  if (admission !== undefined && admission.admitted !== true) {
    throw new RepoFlightProviderHookRefusal(boundedHookReason(admission.reason));
  }
}

export async function reportRepoFlightProviderError(
  hook: RepoFlightProviderLifecycleHook | undefined,
  context: RepoFlightProviderErrorContext,
): Promise<string | null> {
  try {
    await hook?.error?.(context);
    return null;
  } catch (error) {
    return boundedHookReason(error instanceof Error ? error.message : "provider lifecycle error hook rejected notification");
  }
}

export function boundedHookReason(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length === 0 ? "provider lifecycle hook refused the operation" : normalized.slice(0, 500);
}
