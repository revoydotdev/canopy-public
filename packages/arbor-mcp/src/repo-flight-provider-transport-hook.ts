import { createHash } from "node:crypto";
import type { RepoFlightPhase } from "./repo-flight-contracts.js";
import type { RepoFlightClient, RepoFlightWireResponse } from "./repo-flight-transport.js";
import type { RepoFlightProviderAbortContext, RepoFlightProviderChildContext, RepoFlightProviderErrorContext, RepoFlightProviderHookAdmission, RepoFlightProviderHookLaunchContext, RepoFlightProviderLifecycleHook, RepoFlightProviderTerminalContext } from "./integrations/repo-flight-provider-hook.js";

interface LaunchState {
  readonly repo_run_id: string;
  phase: RepoFlightPhase;
  revision: number;
  instance_id: string | null;
  aborted: boolean;
}

export interface RepoFlightTransportProviderHookOptions {
  readonly client: RepoFlightClient;
  /** Flight-owned launcher callback to an external governance authority. */
  readonly governance_attestation?: (context: RepoFlightProviderHookLaunchContext, plannedRun: unknown) => unknown | Promise<unknown>;
  readonly adapter_version?: string;
  readonly now?: () => Date;
}

/**
 * Turns the provider subprocess seam into authenticated commands against the
 * elected repo-local director. It grants no mutation authority: provider
 * coverage remains cooperative until a separate effect interceptor exists.
 */
export function createRepoFlightTransportProviderHook(options: RepoFlightTransportProviderHookOptions): RepoFlightProviderLifecycleHook {
  const states = new Map<string, LaunchState>();
  let querySequence = 0;
  const now = options.now ?? (() => new Date());
  const command = async (launchId: string, suffix: string, body: unknown): Promise<unknown> => {
    const operation = `flight-provider:${launchId}:${suffix}`;
    const envelope = { schema_version: 1, metadata: { operation_id: operation, idempotency_key: operation, correlation_id: `flight-provider:${launchId}`, actor_id: "provider-host-assertion", requested_at: canonicalNow(now) }, command: body };
    return acceptedProjection(await options.client.command(envelope, operation));
  };
  const transition = async (context: RepoFlightProviderHookLaunchContext, state: LaunchState, to: RepoFlightPhase, bindings?: object): Promise<void> => {
    const projection = asRun(await command(context.launch_id, `transition:${state.revision}:${to}`, { kind: "repo.flight.run.transition", repo_run_id: state.repo_run_id, to, expected_revision: state.revision, ...(bindings === undefined ? {} : { bindings }) }));
    state.phase = projection.phase; state.revision = projection.revision;
  };
  const reconcileCurrent = async (context: RepoFlightProviderHookLaunchContext, state: LaunchState): Promise<void> => {
    querySequence += 1;
    const queryIdentity = `flight-provider:${context.launch_id}:runs:${querySequence}`;
    const response = await options.client.query({ schema_version: 1, query_id: queryIdentity, query: { kind: "repo.flight.runs", limit: 1_000 } }, queryIdentity);
    const result = successfulResult(response);
    if (!result || typeof result !== "object" || !Array.isArray((result as { value?: unknown }).value)) throw new Error("Flight Director returned a malformed run projection");
    const run = (result as { value: unknown[] }).value.find((item) => typeof item === "object" && item !== null && (item as { repo_run_id?: unknown }).repo_run_id === state.repo_run_id);
    if (run === undefined) throw new Error("Flight Director lost the provider repo run");
    const projection = asRun(run); state.phase = projection.phase; state.revision = projection.revision;
  };

  const hook: RepoFlightProviderLifecycleHook = {
    async admit(context: RepoFlightProviderHookLaunchContext): Promise<RepoFlightProviderHookAdmission> {
      if (states.has(context.launch_id)) return { admitted: false, reason: "provider launch identity was reused" };
      if (context.scope === "read_write" && context.governance.command_argv === null) return { admitted: false, reason: "provider command authority is not bound to exact argv" };
      if (options.governance_attestation === undefined) return { admitted: false, reason: "external governance admission authority is not configured" };
      const repoRunId = `repo-run:provider:${context.launch_id}`;
      try {
        const planned = asRun(await command(context.launch_id, "create", { kind: "repo.flight.run.create", repo_run_id: repoRunId }));
        const state: LaunchState = { repo_run_id: repoRunId, phase: planned.phase, revision: planned.revision, instance_id: null, aborted: false };
        states.set(context.launch_id, state);
        const attestation = await options.governance_attestation(context, planned);
        const admitted = asRun(await command(context.launch_id, "governance-authorize", { kind: "repo.flight.run.authorize", repo_run_id: repoRunId, attestation }));
        state.phase = admitted.phase; state.revision = admitted.revision;
        return { admitted: true };
      } catch (error) {
        states.delete(context.launch_id);
        return { admitted: false, reason: bounded(error) };
      }
    },

    async enroll_child(context: RepoFlightProviderChildContext) {
      const state = requiredState(states, context.launch_id);
      const writeIntents = context.governance.write_paths.map((path) => ({ operation: "modify" as const, path, purpose: `declared ${context.provider} provider scope` }));
      const projection = asSession(await command(context.launch_id, "enroll", { kind: "repo.flight.session.enroll", request: { repo_run_id: state.repo_run_id, provider: context.provider, provider_session_id: context.resumed_provider_session_id ?? `${context.provider}:${context.launch_id}`, revoy_session_id: context.governance.campaign_id ?? `revoy:${context.launch_id}`, pid: context.pid, campaign_id: context.governance.campaign_id, node_id: context.governance.node_id, task_id: context.governance.task_id ?? `task:${context.launch_id}`, adapter_version: options.adapter_version ?? "repo-flight-provider-hook-v1", worktree_root: context.cwd, write_intents: writeIntents, gate_intents: [] } }));
      state.instance_id = projection.instance_id;
      const worktreeId = `worktree:v1:${createHash("sha256").update(context.cwd).digest("hex")}`;
      await transition(context, state, "workspace_leased", { session_id: projection.instance_id, worktree_id: worktreeId, worktree_path: context.cwd });
      await transition(context, state, "session_started");
    },

    async abort(context: RepoFlightProviderAbortContext) {
      const state = states.get(context.launch_id);
      if (!state) return;
      state.aborted = true;
      await reconcileCurrent(context, state);
      if (state.phase === "session_started") await transition(context, state, "draining");
    },

    async terminal(context: RepoFlightProviderTerminalContext) {
      const state = states.get(context.launch_id);
      if (!state) return;
      if (state.instance_id !== null) await command(context.launch_id, "reconcile", { kind: "repo.flight.session.reconcile", instance_id: state.instance_id, control_channel: "disconnected" });
      await reconcileCurrent(context, state);
      const successful = context.code === 0 && context.signal === null && !state.aborted;
      if (successful && state.phase === "session_started") await transition(context, state, "candidate_ready");
      else if (state.phase === "session_started" || state.phase === "draining") await transition(context, state, "interrupted");
      else if (["planned", "awaiting_governance", "governance_authorized", "admitted", "workspace_leased"].includes(state.phase)) await transition(context, state, "failed");
      states.delete(context.launch_id);
    },

    async error(context: RepoFlightProviderErrorContext) {
      const state = states.get(context.launch_id);
      if (!state || context.stage === "terminal") return;
      try {
        await reconcileCurrent(context, state);
        if (["planned", "awaiting_governance", "governance_authorized", "admitted", "workspace_leased", "session_started", "draining"].includes(state.phase)) await transition(context, state, "failed");
      } finally { states.delete(context.launch_id); }
    },
  };
  return Object.freeze(hook);
}

function acceptedProjection(response: RepoFlightWireResponse): unknown {
  const result = successfulResult(response);
  if (!result || typeof result !== "object") throw new Error("Flight Director returned a malformed operator result");
  const operator = result as { ok?: unknown; value?: { accepted?: unknown; projection?: unknown; error?: { summary?: unknown } } };
  if (operator.ok !== true || operator.value?.accepted !== true) throw new Error(typeof operator.value?.error?.summary === "string" ? operator.value.error.summary : "Flight Director refused provider admission");
  return operator.value.projection;
}
function successfulResult(response: RepoFlightWireResponse): unknown { if (!response.ok) throw new Error(response.error?.summary ?? "Flight Director transport failed"); return response.result; }
function asRun(value: unknown): { readonly repo_run_id: string; readonly phase: RepoFlightPhase; readonly revision: number } { if (!value || typeof value !== "object" || typeof (value as { repo_run_id?: unknown }).repo_run_id !== "string" || typeof (value as { phase?: unknown }).phase !== "string" || !Number.isSafeInteger((value as { revision?: unknown }).revision)) throw new Error("Flight Director returned a malformed repo-run projection"); return value as { repo_run_id: string; phase: RepoFlightPhase; revision: number }; }
function asSession(value: unknown): { readonly instance_id: string } { if (!value || typeof value !== "object" || typeof (value as { instance_id?: unknown }).instance_id !== "string") throw new Error("Flight Director returned a malformed session projection"); return value as { instance_id: string }; }
function requiredState(states: Map<string, LaunchState>, launchId: string): LaunchState { const state = states.get(launchId); if (!state) throw new Error("provider launch was not admitted by this Flight Director hook"); return state; }
function canonicalNow(now: () => Date): string { const value = now(); if (!Number.isFinite(value.getTime())) throw new Error("provider hook clock is invalid"); return value.toISOString(); }
function bounded(error: unknown): string { return (error instanceof Error ? error.message : "Flight Director provider admission failed").replace(/[\r\n\t]+/g, " ").slice(0, 500); }
