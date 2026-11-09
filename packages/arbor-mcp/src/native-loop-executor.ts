import {
  NativeHarnessWorker,
  NativeSessionEngine,
  type CapabilitySupport,
  type ExecutionPolicy,
  type NativeExecutionProfile,
  type NativeGovernedCompletionPort,
  type NativeModelPort,
  type NativeSessionSteeringMessage,
  type SessionEvent,
  type SessionInspection,
} from "@arbor/harness";
import type { LoopExecutor, SpecialistResult, CriticResult } from "@arbor/opencode";
import { tropismPromptBlock } from "@arbor/prompts";
import { OPENCODE_FALLBACK_SESSION_EXECUTION } from "./harness-session-execution.js";
import type { HarnessSessionConnectorId, HarnessSessionExecutionKind } from "./harness-session-execution.js";
import type { HookBus } from "./hooks/bus.js";
import type { SpecialistWorktreeVerificationOutcome, SpecialistWorktreeVerificationPort } from "./worktree-machine-verifier.js";

export interface NativeSpecialistVerificationRecord {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly session_id: string;
  readonly outcome: SpecialistWorktreeVerificationOutcome["outcome"] | "error";
  readonly code?: Extract<SpecialistWorktreeVerificationOutcome, { readonly outcome: "failed" }>["code"];
  readonly exit?: number;
  readonly error?: string;
}

export interface NativeLoopSessionRecord {
  readonly operation: "specialize" | "review";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly connector_id: HarnessSessionConnectorId;
  readonly execution_kind: HarnessSessionExecutionKind;
  /** The actual role profile applied to the supervised connector session. */
  readonly profile_id: string;
  readonly inspection: SessionInspection;
  readonly events: readonly SessionEvent[];
  readonly specialist_verification?: NativeSpecialistVerificationRecord;
}

/** Structural seam owned by the executor so it never depends on its MCP host. */
export interface NativeLiveSessionPort {
  register(session: {
    readonly session_id: string;
  readonly campaign_id: string;
  readonly node_id: string;
  readonly operation: "specialize" | "review";
  readonly connector_id: HarnessSessionConnectorId;
  readonly execution_kind: HarnessSessionExecutionKind;
  readonly profile_id: string;
    readonly controller: AbortController;
    readonly inspect: () => SessionInspection;
    readonly events: (after_sequence?: number) => readonly SessionEvent[];
  }): void;
  settle(session_id: string): void;
  drain(session_id: string): readonly NativeSessionSteeringMessage[];
}

export interface NativeLoopExecutorOptions {
  readonly downstream: LoopExecutor;
  /** Composition-root workspace used for read-only operations without a worktree (for example critic review). */
  readonly workspace_root?: string;
  readonly on_session?: (record: NativeLoopSessionRecord) => void;
  /** Synchronous canonical event observer for durable write-ahead journals. */
  readonly on_session_event?: (record: Omit<NativeLoopSessionRecord, "events"> & { readonly event: SessionEvent }) => void;
  /** Emitted after admission and before connector dispatch for durable live observation. */
  readonly on_session_started?: (record: Omit<NativeLoopSessionRecord, "events">) => void;
  /** Host-owned live control plane; retains no session after it settles. */
  readonly live_sessions?: NativeLiveSessionPort;
  /** Independent verification runs inside the supervised specialist session, bound to its real session id. */
  readonly specialist_verification?: SpecialistWorktreeVerificationPort;
  /** Diagnostic-only observation; never changes provenance or gate outcomes. */
  readonly on_specialist_verification?: (record: NativeSpecialistVerificationRecord) => void;
  readonly clock?: { now(): number };
  /** Test seam for the same wall-clock boundary carried into the native policy. */
  readonly max_wall_clock_ms?: number;
  /**
   * The governed hook bus for this lane. Optional, and deliberately not a
   * blanket: this composition reaches `injectForSession` and `observeTurnEnd`
   * but has no tool port to veto and no second turn to refuse or advise, and
   * `devolution-lane-coverage.test.ts` records which devolved row each of those
   * facts costs. Read that file before adding a seam here.
   */
  readonly hook_bus?: HookBus;
}

const nativeCapabilities = (observedAt: string): readonly CapabilitySupport[] => [
  "streaming", "interruption", "ephemeral_sessions", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "revoy2-native-loop-adapter", observed_at: observedAt, detail: "enforced by the native session worker" },
})) as readonly CapabilitySupport[];

/**
 * The interactive harness is operator-interruptible and does not impose a
 * short provider deadline. Keep only the largest timer-safe supervisory
 * backstop here; ordinary termination comes from completion or an explicit
 * AbortSignal, not a hidden fifteen-minute cutoff.
 */
// Node timers accept at most a signed 32-bit delay. Reserve one millisecond
// for the native session engine's strict `elapsed > policy` boundary.
const MAX_TIMER_WALL_CLOCK_MS = 0x7fff_fffe;
export const NATIVE_LOOP_DEFAULT_MAX_WALL_CLOCK_MS = MAX_TIMER_WALL_CLOCK_MS;

const policy = (workspaceRoots: readonly string[], maxWallClockMs: number): ExecutionPolicy => ({
  filesystem: "read_only",
  approvals: "never",
  tool_allow: [],
  tool_deny: [],
  workspace_roots: [...workspaceRoots],
  max_wall_clock_ms: maxWallClockMs,
  max_events: 16,
  network_allowed: false,
  ambient_plugins_allowed: false,
  user_configuration_allowed: false,
  inherited_credentials_allowed: false,
});

const profile = (roleId: string): NativeExecutionProfile => ({
  role_id: roleId,
  allowed_tools: [],
  allowed_capabilities: ["streaming", "interruption"],
  required_capabilities: [
    { capability: "streaming", minimum_grade: "native" },
    { capability: "interruption", minimum_grade: "native" },
  ],
});

function sessionId(operation: "specialize" | "review", campaignId: string, nodeId: string): string {
  return `${campaignId}:${nodeId}:${operation}:${crypto.randomUUID()}`;
}

function boundedWallClock(value: number | undefined): number {
  const resolved = value ?? NATIVE_LOOP_DEFAULT_MAX_WALL_CLOCK_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_WALL_CLOCK_MS) throw new Error(`max_wall_clock_ms must be 1..${MAX_TIMER_WALL_CLOCK_MS}`);
  return resolved;
}

function timeoutError(elapsedMs: number) {
  return {
    kind: "timeout" as const,
    provenance: { tag: "claimed" as const, claimant: "native-loop-executor" },
    message: "native connector exceeded the supervised wall-clock limit",
    elapsed_ms: elapsedMs,
    partial_output: null,
    usage: { kind: "unavailable" as const, reason: "native connector exceeded the supervised wall-clock limit" },
  };
}

function specialistTimeout(elapsedMs: number): SpecialistResult {
  return {
    output: "",
    provenance: { tag: "claimed", claimant: "native-loop-executor" },
    token_usage: { kind: "unavailable", reason: "native connector exceeded the supervised wall-clock limit" },
    error: timeoutError(elapsedMs),
  };
}

function criticTimeout(elapsedMs: number): CriticResult {
  return {
    approved: false,
    rationale: "native critic connector exceeded the supervised wall-clock limit",
    token_usage: { kind: "unavailable", reason: "native connector exceeded the supervised wall-clock limit" },
    error: timeoutError(elapsedMs),
  };
}

/**
 * Places connector dispatch behind the revoy-owned session lifecycle without
 * pretending the outer worker controls tools hidden inside the subordinate
 * connector. The native policy therefore exposes no tools; connector-specific
 * execution stays isolated in `downstream` and its original result/provenance
 * is returned unchanged to the campaign loop.
 */
export function createNativeLoopExecutor(options: NativeLoopExecutorOptions): LoopExecutor {
  const clock = options.clock ?? { now: () => Date.now() };
  const maxWallClockMs = boundedWallClock(options.max_wall_clock_ms);

  async function supervise<T extends SpecialistResult | CriticResult>(input: {
    operation: "specialize" | "review";
    campaign_id: string;
    node_id: string;
    role_id: string;
    prompt: string;
    workspace_roots: readonly string[];
    specialist_agent?: string;
    worktree_path?: string;
    signal?: AbortSignal;
    dispatch(signal: AbortSignal, prompt: string): Promise<T>;
    timeout_result(elapsed_ms: number): T;
  }): Promise<T> {
    const id = sessionId(input.operation, input.campaign_id, input.node_id);
    // Resolved once per supervised session, and carried on the CONNECTOR's prompt:
    // on this lane the connector is the model, and the model port ignores the
    // worker's own prompt. `tropismPromptBlock` is the renderer's single
    // definition, shared with the native role-prompt path.
    const scope = options.hook_bus === undefined
      ? undefined
      : await options.hook_bus.injectForSession("session_start", {
        session_id: id, campaign_id: input.campaign_id, node_id: input.node_id, role: input.role_id, turn: 0,
      });
    const prompt = scope === undefined || scope.content === "" ? input.prompt : `${input.prompt}${tropismPromptBlock(scope)}`;
    const controller = new AbortController();
    let startedAt: number | null = null;
    let wallClockExceeded = false;
    let wallClockAbort: ReturnType<typeof setTimeout> | undefined;
    let resolveWallClock: (() => void) | undefined;
    const wallClockDeadline = new Promise<void>((resolve) => { resolveWallClock = resolve; });
    const armWallClock = (): void => {
      if (wallClockAbort !== undefined) return;
      startedAt = Date.now();
      const enforceDeadline = (): void => {
        // NativeSessionEngine terminalizes only once elapsed time is strictly
        // greater than its policy ceiling. Timer delivery can occasionally be
        // rounded into the final ceiling millisecond, so recheck instead of
        // aborting early and misclassifying the session as interrupted.
        try {
          const inspection = engine.inspect(id);
          if (inspection.terminal === null) {
            wallClockAbort = setTimeout(enforceDeadline, 1);
            return;
          }
          wallClockExceeded = inspection.terminal.cause === "wall_clock_limit";
          if (wallClockExceeded && !controller.signal.aborted) controller.abort(new Error("native session wall-clock limit exceeded"));
        } finally {
          if (wallClockExceeded || engine.inspect(id).terminal !== null) resolveWallClock?.();
        }
      };
      wallClockAbort = setTimeout(enforceDeadline, maxWallClockMs + 1);
    };
    const forwardInputAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) forwardInputAbort();
    else input.signal?.addEventListener("abort", forwardInputAbort, { once: true });
    let result: T | undefined;
    let specialistVerification: NativeSpecialistVerificationRecord | undefined;
    let publishedStart = false;
    let finalized = false;
    let finalInspection: SessionInspection | undefined;
    const engine = new NativeSessionEngine({
      capabilities: nativeCapabilities(new Date(clock.now()).toISOString()),
      clock,
      on_event: (event, inspection) => {
        const base = {
          operation: input.operation, campaign_id: input.campaign_id, node_id: input.node_id,
          connector_id: OPENCODE_FALLBACK_SESSION_EXECUTION.connector_id,
          execution_kind: OPENCODE_FALLBACK_SESSION_EXECUTION.execution_kind,
          profile_id: input.role_id, inspection,
        } as const;
        if (event.kind === "lifecycle" && !publishedStart) {
          armWallClock();
          publishedStart = true;
          options.live_sessions?.register({
            session_id: id, campaign_id: input.campaign_id, node_id: input.node_id,
            operation: input.operation, connector_id: OPENCODE_FALLBACK_SESSION_EXECUTION.connector_id,
            execution_kind: OPENCODE_FALLBACK_SESSION_EXECUTION.execution_kind,
            profile_id: input.role_id, controller,
            inspect: () => engine.inspect(id),
            events: (after_sequence = 0) => engine.observe(id, after_sequence),
          });
          options.on_session_started?.(base);
        }
        options.on_session_event?.({ ...base, event });
      },
    });
    const model: NativeModelPort = {
      async run(_request, _secret, signal) {
        const downstream = input.dispatch(signal, prompt);
        // Always observe a connector that settles after the deadline. The
        // race below returns promptly; this handler prevents an unhandled
        // late rejection without publishing its output.
        void downstream.catch(() => undefined);
        const settled = await Promise.race([
          downstream.then(
            (value) => ({ kind: "result" as const, value }),
            (error: unknown) => ({ kind: "error" as const, error }),
          ),
          wallClockDeadline.then(() => ({ kind: "timeout" as const })),
        ]);
        // A connector can resolve after the ownership timer has expired. Its
        // output is not evidence for this timed-out session and must not reach
        // verification, candidate capture, or adoption.
        if (settled.kind === "timeout" || wallClockExceeded) return { text: [], tool_calls: [], final_message: `${input.operation} connector output discarded after wall-clock limit` };
        if (settled.kind === "error") throw settled.error;
        result = settled.value;
        if (input.operation === "specialize" && options.specialist_verification !== undefined && input.specialist_agent !== undefined && input.worktree_path) {
          const specialist = result as SpecialistResult;
          if (!("error" in specialist)) {
            try {
              const verificationInput = {
                campaign_id: input.campaign_id,
                node_id: input.node_id,
                specialist_agent: input.specialist_agent,
                session_id: id,
                worktree_path: input.worktree_path,
                final_message: specialist.output,
                history: [],
              } as const;
              const outcome = options.specialist_verification.verifyOutcome === undefined
                ? await options.specialist_verification.verify(verificationInput, signal).then((verified) => verified === null ? { outcome: "not_attempted" as const } : { outcome: "verified" as const, ...verified })
                : await options.specialist_verification.verifyOutcome(verificationInput, signal);
              specialistVerification = {
                campaign_id: input.campaign_id,
                node_id: input.node_id,
                session_id: id,
                outcome: outcome.outcome,
                ...(outcome.outcome !== "failed" || outcome.code === undefined ? {} : { code: outcome.code }),
                ...(outcome.outcome !== "failed" || outcome.exit === undefined ? {} : { exit: outcome.exit }),
              };
              options.on_specialist_verification?.(specialistVerification);
              if (outcome.outcome === "verified") {
                result = { ...specialist, provenance: outcome.provenance, verification_evidence: outcome.message } as T;
              }
            } catch (error) {
              specialistVerification = { campaign_id: input.campaign_id, node_id: input.node_id, session_id: id, outcome: "error", error: error instanceof Error ? error.message : String(error) };
              options.on_specialist_verification?.(specialistVerification);
            }
          }
        }
        const finalMessage = input.operation === "specialize"
          ? (result as SpecialistResult).output
          : (result as CriticResult).rationale;
        return {
          // The subordinate connector's bounded deliverable is the operator's
          // answer. Preserve it as a canonical final model event instead of
          // reducing a whole turn to lifecycle started/completed markers.
          text: [{ text: finalMessage, phase: "final" as const }],
          tool_calls: [],
          final_message: finalMessage,
        };
      },
    };
    const governedCompletion: NativeGovernedCompletionPort | undefined = input.operation === "specialize"
      ? {
          async verify() {
            const specialist = result as SpecialistResult | undefined;
            return specialist?.provenance.tag === "verified"
              ? { message: "specialist connector dispatch verified", provenance: specialist.provenance }
              : null;
          },
        }
      : undefined;
    const worker = new NativeHarnessWorker({
      session_engine: engine, model, governed_completion: governedCompletion,
      ...(options.live_sessions === undefined ? {} : { steering: options.live_sessions }),
      // The per-turn observe seam, beside the worker that owns the boundary: a
      // declared `turn_end` handler with no producer is an inert handler, and
      // `observeTurnEnd` is a no-op when no descriptor is declared.
      ...(options.hook_bus === undefined ? {} : { on_turn_end: (boundary: { readonly session_id: string; readonly turn: number }) => { options.hook_bus?.observeTurnEnd(boundary.session_id, boundary.turn); } }),
    });
    let workerError: unknown;
    const finalizeSession = (): void => {
      if (finalized) return;
      finalized = true;
      try {
        finalInspection = engine.inspect(id);
      } catch {
        return;
      }
      options.on_session?.({
        operation: input.operation,
        campaign_id: input.campaign_id,
        node_id: input.node_id,
        connector_id: OPENCODE_FALLBACK_SESSION_EXECUTION.connector_id,
        execution_kind: OPENCODE_FALLBACK_SESSION_EXECUTION.execution_kind,
        profile_id: input.role_id,
        inspection: finalInspection,
        events: engine.observe(id),
        ...(specialistVerification === undefined ? {} : { specialist_verification: specialistVerification }),
      });
    };
    try {
      await worker.run({
        start: {
          session_id: id,
          policy: policy(input.workspace_roots.length > 0 ? input.workspace_roots : [options.workspace_root ?? process.cwd()], maxWallClockMs),
          required_capabilities: [],
          lineage: { kind: "new" },
          ephemeral: true,
        },
        prompt,
        max_turns: 1,
        profile: profile(input.role_id),
        signal: controller.signal,
      });
    } catch (error) {
      workerError = error;
    } finally {
      if (wallClockAbort !== undefined) clearTimeout(wallClockAbort);
      input.signal?.removeEventListener("abort", forwardInputAbort);
      finalizeSession();
      options.live_sessions?.settle(id);
    }
    const timedOut = wallClockExceeded || finalInspection?.terminal?.cause === "wall_clock_limit";
    if (timedOut) return input.timeout_result(Math.max(0, Date.now() - (startedAt ?? Date.now())));
    if (workerError !== undefined) throw workerError;
    if (result === undefined) throw new Error(`native ${input.operation} session ended before connector returned a result`);
    return result;
  }

  return {
    log: options.downstream.log,
    specialize(params) {
      return supervise({
        operation: "specialize",
        campaign_id: params.campaign_id,
        node_id: params.node_id,
        role_id: params.specialist_agent,
        prompt: params.prompt,
        workspace_roots: params.worktree_path ? [params.worktree_path] : [],
        specialist_agent: params.specialist_agent,
        worktree_path: params.worktree_path,
        signal: params.signal,
        dispatch: (signal, prompt) => options.downstream.specialize({ ...params, prompt, signal }),
        timeout_result: specialistTimeout,
      });
    },
    review(params) {
      return supervise({
        operation: "review",
        campaign_id: params.campaign_id,
        node_id: params.node_id,
        role_id: params.critic_agent,
        prompt: params.prompt,
        workspace_roots: [],
        signal: params.signal,
        dispatch: (signal, prompt) => options.downstream.review({ ...params, prompt, signal }),
        timeout_result: criticTimeout,
      });
    },
  };
}
