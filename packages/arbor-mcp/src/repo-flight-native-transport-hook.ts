import { createHash } from "node:crypto";
import type { RepoFlightPhase } from "./repo-flight-contracts.js";
import type { RepoFlightClient, RepoFlightWireResponse } from "./repo-flight-transport.js";
import { boundedRepoFlightNativeReason, type RepoFlightNativeErrorContext, type RepoFlightNativeHookAdmission, type RepoFlightNativeLifecycleHook, type RepoFlightNativeSessionContext, type RepoFlightNativeTerminalContext } from "./integrations/repo-flight-native-hook.js";

interface NativeLaunchState {
  readonly repo_run_id: string;
  phase: RepoFlightPhase;
  revision: number;
  aborted: boolean;
}

export interface RepoFlightTransportNativeHookOptions {
  readonly client: RepoFlightClient;
  readonly governance_attestation?: (context: RepoFlightNativeSessionContext, plannedRun: unknown) => unknown | Promise<unknown>;
  readonly now?: () => Date;
}

/**
 * Authenticated lifecycle projection for a direct native harness session.
 *
 * This deliberately does not call `session.enroll`, issue a clearance, or
 * claim a mutation interceptor.  A unique in-process session ID is bound to
 * the repo run for correlation only; process enrollment remains unavailable
 * until the native lane grows a per-worker OS identity.
 */
export function createRepoFlightTransportNativeHook(options: RepoFlightTransportNativeHookOptions): RepoFlightNativeLifecycleHook {
  const states = new Map<string, NativeLaunchState>();
  const now = options.now ?? (() => new Date());
  const command = async (sessionId: string, suffix: string, body: unknown): Promise<unknown> => {
    const operation = `flight-native:${sessionId}:${suffix}`;
    const envelope = {
      schema_version: 1,
      metadata: {
        operation_id: operation,
        idempotency_key: operation,
        correlation_id: `flight-native:${sessionId}`,
        actor_id: "native-host-assertion",
        requested_at: canonicalNow(now),
      },
      command: body,
    };
    return acceptedProjection(await options.client.command(envelope, operation));
  };
  const transition = async (context: RepoFlightNativeSessionContext, state: NativeLaunchState, to: RepoFlightPhase, bindings?: object): Promise<void> => {
    const projection = asRun(await command(context.session_id, `transition:${state.revision}:${to}`, {
      kind: "repo.flight.run.transition", repo_run_id: state.repo_run_id, to, expected_revision: state.revision,
      ...(bindings === undefined ? {} : { bindings }),
    }));
    state.phase = projection.phase;
    state.revision = projection.revision;
  };
  const reconcileCurrent = async (context: RepoFlightNativeSessionContext, state: NativeLaunchState): Promise<void> => {
    const queryId = `flight-native:${context.session_id}:runs:${crypto.randomUUID()}`;
    const response = await options.client.query({ schema_version: 1, query_id: queryId, query: { kind: "repo.flight.runs", limit: 1_000 } }, queryId);
    const result = successfulResult(response);
    if (!result || typeof result !== "object" || !Array.isArray((result as { value?: unknown }).value)) throw new Error("Flight Director returned a malformed native run projection");
    const run = (result as { value: unknown[] }).value.find((item) => typeof item === "object" && item !== null && (item as { repo_run_id?: unknown }).repo_run_id === state.repo_run_id);
    if (run === undefined) throw new Error("Flight Director lost the native repo run");
    const projection = asRun(run);
    state.phase = projection.phase;
    state.revision = projection.revision;
  };

  return Object.freeze({
    async admit(context: RepoFlightNativeSessionContext): Promise<RepoFlightNativeHookAdmission> {
      if (states.has(context.session_id)) return { admitted: false, reason: "native session identity was reused" };
      if (options.governance_attestation === undefined) return { admitted: false, reason: "external governance admission authority is not configured" };
      const repoRunId = `repo-run:native:${context.session_id}`;
      try {
        const planned = asRun(await command(context.session_id, "create", { kind: "repo.flight.run.create", repo_run_id: repoRunId }));
        const state: NativeLaunchState = { repo_run_id: repoRunId, phase: planned.phase, revision: planned.revision, aborted: false };
        states.set(context.session_id, state);
        const attestation = await options.governance_attestation(context, planned);
        const admitted = asRun(await command(context.session_id, "governance-authorize", { kind: "repo.flight.run.authorize", repo_run_id: repoRunId, attestation }));
        state.phase = admitted.phase; state.revision = admitted.revision;
        const worktreeId = `worktree:v1:${createHash("sha256").update(context.workspace_root).digest("hex")}`;
        // `native-session:` is a real harness session correlation ID, not an
        // enrollment instance or an operating-system process identity.
        await transition(context, state, "workspace_leased", {
          session_id: `native-session:${context.session_id}`,
          worktree_id: worktreeId,
          worktree_path: context.workspace_root,
          evidence_ref: `native-in-process:${context.access}`,
        });
        await transition(context, state, "session_started");
        return { admitted: true };
      } catch (error) {
        states.delete(context.session_id);
        return { admitted: false, reason: bounded(error) };
      }
    },

    async abort(context: RepoFlightNativeSessionContext): Promise<void> {
      const state = states.get(context.session_id);
      if (!state) return;
      state.aborted = true;
      await reconcileCurrent(context, state);
      if (state.phase === "session_started") await transition(context, state, "draining");
    },

    async terminal(context: RepoFlightNativeTerminalContext): Promise<void> {
      const state = states.get(context.session_id);
      if (!state) return;
      await reconcileCurrent(context, state);
      if (context.outcome === "completed" && !state.aborted && state.phase === "session_started") await transition(context, state, "candidate_ready");
      else if ((state.phase === "session_started" || state.phase === "draining") && (context.outcome === "interrupted" || state.aborted)) await transition(context, state, "interrupted");
      else if (state.phase === "session_started" || state.phase === "draining") await transition(context, state, "failed");
      states.delete(context.session_id);
    },

    async error(context: RepoFlightNativeErrorContext): Promise<void> {
      const state = states.get(context.session_id);
      if (!state) return;
      try {
        await reconcileCurrent(context, state);
        if (["planned", "awaiting_governance", "governance_authorized", "admitted", "workspace_leased", "session_started", "draining"].includes(state.phase)) await transition(context, state, "failed", { evidence_ref: `native-error:${createHash("sha256").update(boundedRepoFlightNativeReason(context.error)).digest("hex")}` });
      } finally {
        states.delete(context.session_id);
      }
    },
  });
}

function acceptedProjection(response: RepoFlightWireResponse): unknown {
  const result = successfulResult(response);
  if (!result || typeof result !== "object") throw new Error("Flight Director returned a malformed operator result");
  const operator = result as { ok?: unknown; value?: { accepted?: unknown; projection?: unknown; error?: { summary?: unknown } } };
  if (operator.ok !== true || operator.value?.accepted !== true) throw new Error(typeof operator.value?.error?.summary === "string" ? operator.value.error.summary : "Flight Director refused native lifecycle admission");
  return operator.value.projection;
}
function successfulResult(response: RepoFlightWireResponse): unknown { if (!response.ok) throw new Error(response.error?.summary ?? "Flight Director transport failed"); return response.result; }
function asRun(value: unknown): { readonly repo_run_id: string; readonly phase: RepoFlightPhase; readonly revision: number } {
  if (!value || typeof value !== "object" || typeof (value as { repo_run_id?: unknown }).repo_run_id !== "string" || typeof (value as { phase?: unknown }).phase !== "string" || !Number.isSafeInteger((value as { revision?: unknown }).revision)) throw new Error("Flight Director returned a malformed native repo-run projection");
  return value as { repo_run_id: string; phase: RepoFlightPhase; revision: number };
}
function canonicalNow(now: () => Date): string { const value = now(); if (!Number.isFinite(value.getTime())) throw new Error("native lifecycle hook clock is invalid"); return value.toISOString(); }
function bounded(error: unknown): string { return boundedRepoFlightNativeReason(error instanceof Error ? error.message : "Flight Director native lifecycle admission failed"); }
