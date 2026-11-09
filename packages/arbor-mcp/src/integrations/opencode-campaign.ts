import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsageResult } from "@arbor/core";
import type { ConnectorDescriptor, SessionEvent } from "@arbor/harness";
import type { CampaignHarnessIntegration } from "../campaign-harness-integration.js";
import type { HookBus } from "../hooks/bus.js";
import { createNativeLoopExecutor } from "../native-loop-executor.js";
import { createOpenCodeDecomposer } from "../opencode-decomposer.js";
import { normalizeProviderPlan } from "../native-task-plan-contract.js";
import { buildRepositoryContextCapsule } from "../native-agent-executor.js";
import { buildOpenCodeArgs, createOpenCodeLoopExecutor, createOpenCodePanelReviewer, resolveConfiguredModel, runOpenCode, type OpenCodeLoopExecutorOptions } from "../opencode-executor.js";
import type { NativeCriticPort } from "../native-critic-transport.js";
import type { RepositoryGraphIndex } from "../repository-graph.js";
import type { TaskComposerPlannerPort } from "../task-composer.js";
import type { SpecialistWorktreeVerificationPort } from "../worktree-machine-verifier.js";
import { postConnectorBusThreadReport, resolveConnectorBusThreadEdge } from "../native-bus-thread-contracts.js";
import { repoFlightProviderLaunchContext, type RepoFlightProviderLifecycleHook } from "./repo-flight-provider-hook.js";

export const OPENCODE_HARNESS_CONNECTOR_ID = "opencode-plugin";
export const DEFAULT_OPENCODE_PLANNER_MODEL = "openrouter/~openai/gpt-mini-latest";

export function createOpenCodeHarnessConnectorDescriptor(observedAt = new Date().toISOString()): ConnectorDescriptor {
  const support = (capability: "interruption" | "tool_policy" | "workspace_isolation" | "usage_reporting", grade: "governed" | "observed", detail: string) => ({
    capability,
    grade,
    evidence: { implementation_id: "revoy2-opencode-integration", observed_at: observedAt, detail },
  });
  return {
    connector_id: OPENCODE_HARNESS_CONNECTOR_ID,
    implementation_version: "1",
    supported_upstream_range: "opencode-cli",
    health: "healthy",
    capabilities: [
      support("interruption", "governed", "Revoy forwards campaign cancellation to the isolated connector subprocess"),
      support("tool_policy", "governed", "Revoy composes role and permission policy before connector dispatch"),
      support("workspace_isolation", "governed", "Every specialist dispatch is scoped to a Revoy-owned git worktree lease"),
      support("usage_reporting", "observed", "Connector-reported usage is retained without manufacturing missing totals"),
    ],
  };
}

export interface OpenCodeCampaignIntegrationObservers {
  readonly on_session_event?: (sessionId: string, event: SessionEvent) => void;
  readonly on_session_end?: (input: { readonly session_id: string; readonly campaign_id: string; readonly node_id: string }) => void;
  readonly specialist_verification?: SpecialistWorktreeVerificationPort;
  readonly executor_options?: OpenCodeLoopExecutorOptions;
  /**
   * PERF: single-call native transport for panel-review dispatch, mirroring
   * claude-code-campaign.ts's `native_critic` wiring (see
   * `native-critic-transport.ts`). Used only when `ARBOR_CRITIC_TRANSPORT=native`
   * AND this port reports itself ready; absent, not ready, or an erroring
   * call all fall back to the unchanged `opencode run` critic path.
   */
  readonly native_critic?: NativeCriticPort;
  /** Optional fail-closed Repo Flight Control lifecycle seam for every OpenCode child. */
  readonly repo_flight_hook?: RepoFlightProviderLifecycleHook;
  /**
   * The governed hook bus, carried into the supervised worker so the devolved
   * hooks whose seams this lane CAN reach run here as they do on the native
   * lane. See `native-loop-executor.ts` for exactly which those are.
   */
  readonly hook_bus?: HookBus;
}

export interface OpenCodeTaskPlannerOptions {
  readonly cwd: string;
  readonly planning_prompt: (input: Parameters<TaskComposerPlannerPort["plan"]>[0]) => string;
  readonly repository_graph?: RepositoryGraphIndex;
  readonly model?: string;
  readonly opencode_bin?: string;
  readonly timeout_ms?: number;
  /** Optional fail-closed Repo Flight Control lifecycle seam for the planner child. */
  readonly repo_flight_hook?: RepoFlightProviderLifecycleHook;
}

export function renderOpenCodePlanningPrompt(options: OpenCodeTaskPlannerOptions, input: Parameters<TaskComposerPlannerPort["plan"]>[0]): string {
  const capsule = options.repository_graph === undefined ? null : buildRepositoryContextCapsule(options.repository_graph, options.cwd, input.task);
  return [
    options.planning_prompt(input),
    ...(capsule === null ? [] : [capsule.text]),
    capsule === null
      ? "Planning context contract: no repository capsule is available. Propose bounded executable actions from the operator request; do not invent paths or admit discovery-only terminal work."
      : "Planning context contract: the bounded repository capsule above is the grounded repository signal for this pre-campaign step. Treat it as a retrieval seed, not proof.",
    "Planning authority contract: this is a read-only pre-campaign step. Do not modify files, execute repository commands, or request human input. Return only the requested JSON object; the admitted specialist owns execution.",
  ].join("\n\n");
}

function normalizeOpenCodePlanText(raw: string, task: string): string {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastObject: unknown = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; continue; }
    if (char !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        const candidate = JSON.parse(raw.slice(start, index + 1));
        if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) lastObject = candidate;
      } catch { /* A malformed diagnostic fragment is not the final proposal. */ }
      start = -1;
    }
  }
  if (lastObject === null) return raw;
  const normalized = normalizeProviderPlan(lastObject);
  if (/\b(?:one atomic|single atomic|single action|do not split)\b/i.test(task)
    && typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
    const proposal = normalized as Record<string, unknown>;
    if (typeof proposal.root_action === "object" && proposal.root_action !== null) {
      proposal.actions = [proposal.root_action];
      // Collapsing the executable frontier also changes the only legal
      // acceptance-mapping target. Keep OpenCode at parity with the Claude
      // connector: every criterion now maps to the retained root description,
      // never to action descriptions this normalization just removed.
      const rootDescription = (proposal.root_action as Record<string, unknown>).description;
      if (typeof rootDescription === "string" && Array.isArray(proposal.acceptance_checks)
        && proposal.acceptance_checks.every((criterion) => typeof criterion === "string")) {
        proposal.acceptance_mapping = proposal.acceptance_checks.map((criterion) => ({ criterion, action_descriptions: [rootDescription] }));
      }
    }
  }
  return JSON.stringify(normalized);
}

export function parseOpenCodeJsonEvents(raw: string): { readonly text: string; readonly session_id: string | null; readonly usage: TokenUsageResult } {
  const text: string[] = [];
  let sessionId: string | null = null;
  let usage: TokenUsageResult = { kind: "unavailable", reason: "opencode JSON events did not include provider token counters" };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    const part = typeof event.part === "object" && event.part !== null ? event.part as Record<string, unknown> : null;
    if (event.type === "text" && part !== null && typeof part.text === "string") text.push(part.text);
    if (event.type === "step_finish" && part !== null && typeof part.tokens === "object" && part.tokens !== null) {
      const tokens = part.tokens as Record<string, unknown>;
      const cache = typeof tokens.cache === "object" && tokens.cache !== null ? tokens.cache as Record<string, unknown> : {};
      if ([tokens.input, tokens.output, cache.read, cache.write].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) {
        usage = {
          input_tokens: tokens.input as number,
          output_tokens: tokens.output as number,
          cached_input_tokens: cache.read as number,
          cache_write_input_tokens: cache.write as number,
          counter_source: "provider_counter",
        };
      }
    }
  }
  return { text: text.join(""), session_id: sessionId, usage };
}

/** Read-only task-composer planning through OpenCode's authenticated provider boundary. */
export function createOpenCodeTaskPlanner(options: OpenCodeTaskPlannerOptions): TaskComposerPlannerPort {
  const opencodeBin = options.opencode_bin ?? "opencode";
  const timeoutMs = options.timeout_ms ?? 180_000;
  return {
    async plan(input) {
      if (input.signal?.aborted) throw new Error("OpenCode task planning aborted before dispatch");
      if ((input.attachments?.length ?? 0) > 0) throw new Error("OpenCode task planning cannot prove governed image consumption; select a direct native image-capable provider");
      const model = options.model ?? resolveConfiguredModel("taproot", options.cwd, DEFAULT_OPENCODE_PLANNER_MODEL);
      const dir = mkdtempSync(join(tmpdir(), "arbor-opencode-planner-"));
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, renderOpenCodePlanningPrompt(options, input), "utf8");
      try {
        const args = buildOpenCodeArgs({
          model,
          worktree: undefined,
          promptFile,
          instruction: "Produce the bounded task-composer proposal from the attached instructions. Return only raw JSON, without markdown fences or prose.",
          opencodeBin,
          pure: true,
          format: "json",
        });
        const result = await runOpenCode({
          opencodeBin,
          args,
          signal: input.signal,
          timeoutMs,
          cwd: options.cwd,
          flight: options.repo_flight_hook === undefined ? undefined : {
            hook: options.repo_flight_hook,
            context: repoFlightProviderLaunchContext("opencode", {
              mode: "planner",
              cwd: options.cwd,
              model,
              flight_governance: {
                campaign_id: input.parent_campaign_id,
                node_id: input.draft_id,
                task_id: input.draft_id,
                write_paths: [],
                command_argv: [],
              },
            }),
          },
        });
        if (!result.ok) throw new Error(result.error);
        const events = parseOpenCodeJsonEvents(result.stdout);
        if (!events.text.trim()) throw new Error("opencode task planning returned no text event");
        return {
          raw_proposal: normalizeOpenCodePlanText(events.text, input.task),
          session_id: events.session_id ?? `opencode-task-plan:${input.draft_id}`,
          model_identity: `opencode/${model}`,
          usage: events.usage,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Transitional built-in adapter; intended to move to an installable plugin package. */
export function createOpenCodeCampaignIntegration(
  observers: OpenCodeCampaignIntegrationObservers = {},
): CampaignHarnessIntegration {
  return {
    createExecutor: ({ runtime, adapter, campaign_id, cwd }) => {
      const raw = createOpenCodeLoopExecutor(adapter, () => {}, campaign_id, {
        configDir: cwd,
        ...observers.executor_options,
        ...(observers.repo_flight_hook === undefined ? {} : { repo_flight_hook: observers.repo_flight_hook }),
      });
      // Cross-lane bus relay (ADR-083, extended across lanes -- see
      // native-bus-thread-contracts.ts): the same host-driven, best-effort
      // relay claude-code-campaign.ts wires for its connector, applied at
      // this connector's own dispatch boundary. Never reads a target edge
      // from the connector subprocess's output; a relay failure is logged
      // and never fails the specialist call it is reporting on.
      const busWrapped: typeof raw = {
        ...raw,
        async specialize(params) {
          const result = await raw.specialize(params);
          const edge = resolveConnectorBusThreadEdge(runtime, { campaign_id, node_id: params.node_id }, "opencode");
          if (edge !== null) {
            const content = result.error !== undefined
              ? `[opencode] specialist failed: ${result.error.kind}: ${result.error.message}`
              : `[opencode] specialist completed:\n${result.output}`;
            const posted = await postConnectorBusThreadReport(runtime, edge, {
              message_kind: "report", content, correlation_id: `opencode:${campaign_id}:${params.node_id}`,
            });
            if (!posted.ok) {
              adapter.pushDevtoolsLine({
                seq: 0, ts: new Date().toISOString(), event_kind: "loop.bus_thread_report_failed",
                campaign_id, node_id: params.node_id, synthetic: false,
                loop_event: { type: "bus_thread_report_failed", reason: posted.reason } as never,
              });
            }
          }
          return result;
        },
      };
      return createNativeLoopExecutor({
        downstream: busWrapped,
        workspace_root: cwd,
        ...(observers.hook_bus === undefined ? {} : { hook_bus: observers.hook_bus }),
        live_sessions: runtime.nativeSessionRegistry,
        specialist_verification: observers.specialist_verification,
        on_specialist_verification(record) {
          if (record.outcome !== "verified") adapter.pushDevtoolsLine({
            seq: 0,
            ts: new Date().toISOString(),
            event_kind: "loop.machine_verification",
            campaign_id: record.campaign_id,
            node_id: record.node_id,
            synthetic: false,
            loop_event: {
              type: "machine_verification",
              outcome: record.outcome,
              session_id: record.session_id,
              ...(record.code === undefined ? {} : { code: record.code }),
              ...(record.exit === undefined ? {} : { exit: record.exit }),
              ...(record.error === undefined ? {} : { error: record.error }),
            } as never,
          });
        },
        on_session_started(record) {
          const journal = runtime.harnessSessions;
          if (journal !== null && !journal.recordStarted({
            session_id: record.inspection.session_id,
            campaign_id: record.campaign_id,
            node_id: record.node_id,
            operation: record.operation,
            connector_id: record.connector_id,
            execution_kind: record.execution_kind,
            profile_id: record.profile_id,
            state: record.inspection.state,
            latest_sequence: record.inspection.latest_sequence,
            lineage: record.inspection.lineage,
          })) throw new Error("fallback session admission could not be durably recorded");
        },
        on_session_event(record) {
          observers.on_session_event?.(record.inspection.session_id, record.event);
          const journal = runtime.harnessSessions;
          if (journal !== null && !journal.recordEvent(record.event)) {
            throw new Error("fallback session event could not be durably recorded");
          }
        },
        on_session(record) {
          observers.on_session_end?.({
            session_id: record.inspection.session_id,
            campaign_id: record.campaign_id,
            node_id: record.node_id,
          });
          const journal = runtime.harnessSessions;
          if (journal !== null && !journal.record(record)) {
            throw new Error("fallback session completion could not be durably recorded");
          }
          runtime.recordSessionCompletionUx({
            session_id: record.inspection.session_id,
            campaign_id: record.campaign_id,
            node_id: record.node_id,
          });
        },
      });
    },
    createReviewer: ({ adapter, campaign_id, cwd }) => createOpenCodePanelReviewer(adapter, campaign_id, {
      configDir: cwd,
      ...(observers.executor_options?.criticModel === undefined ? {} : { criticModel: observers.executor_options.criticModel }),
      ...(observers.executor_options?.opencodeBin === undefined ? {} : { opencodeBin: observers.executor_options.opencodeBin }),
      ...(observers.executor_options?.timeoutMs === undefined ? {} : { timeoutMs: observers.executor_options.timeoutMs }),
      ...(observers.native_critic === undefined ? {} : { native_critic: observers.native_critic }),
      ...(observers.repo_flight_hook === undefined ? {} : { repo_flight_hook: observers.repo_flight_hook }),
    }),
    createDecomposer: ({ cwd }) => createOpenCodeDecomposer({ configDir: cwd }),
  };
}
