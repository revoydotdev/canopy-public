/**
 * Lifecycle seam for Revoy's in-process native provider lane.
 *
 * A native harness turn has a durable harness session ID, but it does not
 * create a provider child process.  In particular, `process.pid` belongs to
 * the long-lived Arbor host and must never be presented as a unique worker
 * identity.  This contract therefore carries only the real in-process
 * session identity and bounded lifecycle facts.  It intentionally has no
 * clearance token or mutation-interception surface.
 */

export type RepoFlightNativeOperation = "specialize" | "review";
export type RepoFlightNativeAccess = "read_only" | "tool_hosted";

export interface RepoFlightNativeSessionContext {
  /** NativeHarnessWorker's unique, host-assigned session identity. */
  readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: RepoFlightNativeOperation;
  readonly workspace_root: string;
  /** Tool-hosted is observation/admission only, not an effect interceptor. */
  readonly access: RepoFlightNativeAccess;
}

export type RepoFlightNativeHookAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

export interface RepoFlightNativeTerminalContext extends RepoFlightNativeSessionContext {
  readonly outcome: "completed" | "failed" | "interrupted";
}

export interface RepoFlightNativeErrorContext extends RepoFlightNativeSessionContext {
  readonly stage: "admission" | "execution";
  /** A bounded local diagnostic, never prompt, model output, argv, or secret. */
  readonly error: string;
}

/**
 * Optional fail-closed lifecycle observer for a direct native session.  The
 * executor calls `admit` before it can lease a model credential or invoke a
 * model transport.  There is deliberately no `enroll_child`: no child exists.
 */
export interface RepoFlightNativeLifecycleHook {
  readonly admit?: (context: RepoFlightNativeSessionContext) => RepoFlightNativeHookAdmission | void | Promise<RepoFlightNativeHookAdmission | void>;
  readonly abort?: (context: RepoFlightNativeSessionContext) => void | Promise<void>;
  readonly terminal?: (context: RepoFlightNativeTerminalContext) => void | Promise<void>;
  readonly error?: (context: RepoFlightNativeErrorContext) => void | Promise<void>;
}

export function boundedRepoFlightNativeReason(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length === 0 ? "native Flight Director lifecycle hook refused the operation" : normalized.slice(0, 500);
}
