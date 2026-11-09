/**
 * DevTools MCP tool family (ADR-021).
 *
 * Pure projections over existing runtime/catalog APIs. Every tool returns
 * cursor-stamped envelopes so an agent can resume after a context-window
 * reset exactly like chrome-devtools handles a navigation. No tool invents
 * new mutation, provenance, or capability — they compose:
 *   - `ArborRuntime.snapshot()` / `eventStream.resume(cursor, snapshot)`
 *   - `RuntimeCatalogRouter.executeQuery()` (capability-gated passthrough)
 *   - `CampaignManager.startCampaign()` (the only mutation, and it's the
 *     same path the existing `arbor_start_campaign` tool exposes)
 *
 * The tool family and the DevToolsTraceLogger are complementary projections
 * of the same canonical runtime — neither is authority.
 */
import type { ServerTool } from "./server.js";
import type { ArborRuntime } from "./runtime.js";
import type { RuntimeCatalogRouter } from "./runtime-catalog.js";
import { DEVTOOLS_BREAKPOINT_KINDS, isDevToolsBreakpointKind, type BreakpointRegistry } from "./devtools-breakpoints.js";
import { buildLivenessReport, type LivenessReport } from "./liveness.js";
import { TUI_SCREEN_CONSUMERS } from "./liveness-consumers.js";
import { MCP_SERVER_OPERATIONS } from "./mcp-operation-manifest.js";
import type { Action, CampaignConfig, CapabilityContext, RuntimeCursor } from "@arbor/core";

export interface DevToolsView {
  kind: "lifecycle" | "campaigns" | "tree" | "kb" | "ledger" | "telemetry";
  campaign_id?: string;
  cursor?: RuntimeCursor;
  limit?: number;
}

export interface DevToolsOpenCampaignInput {
  campaign_id: string;
  plan_path: string;
  root_action: Action;
  config?: Partial<CampaignConfig>;
}

export interface DevToolsSnapshotInput {
  campaign_id?: string;
  view: DevToolsView["kind"];
  cursor?: RuntimeCursor;
  limit?: number;
}

export interface DevToolsProbeInput {
  query: unknown;
}

export interface DevToolsTraceTailInput {
  cursor?: RuntimeCursor;
  limit?: number;
}

export interface DevToolsStepInput {
  campaign_id: string;
  /** Run at most this many loop iterations; default 1. */
  max_iterations?: number;
}

export interface DevToolsClearInput {
  campaign_id: string;
}

export interface DevToolsBreakpointInput {
  kind: "node_failed" | "node_verified" | "kb_entry_added" | "gate_failed" | "halt" | "any";
  campaign_id?: string;
  timeout_ms?: number;
}

/**
 * Build the DevTools tool family bound to a runtime + catalog. Tools never
 * mutate canonical state except via the existing `startCampaign` path
 * (`devtools_open_campaign`); all others are read-only projections.
 */
export function defineDevToolsTools(
  runtime: ArborRuntime,
  catalog: RuntimeCatalogRouter,
  breakpoints: BreakpointRegistry,
): ServerTool[] {
  return [
    {
      name: MCP_SERVER_OPERATIONS.devtools_open_campaign,
      annotations: { title: "devtools_open_campaign", readOnlyHint: false },
      description:
        "Open a workflow in the revoy2 harness (chrome-devtools: open_page). " +
        "Starts a fresh campaign with the DevTools trace log active. Returns the " +
        "initial cursor-stamped snapshot envelope.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "string" },
          plan_path: { type: "string" },
          root_action: { type: "object" },
          config: { type: "object" },
        },
        required: ["campaign_id", "plan_path", "root_action"],
      },
      handler: async (args) => openCampaign(runtime, args as unknown as DevToolsOpenCampaignInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_snapshot,
      annotations: { title: "devtools_snapshot", readOnlyHint: true },
      description:
        "Read a cursor-stamped projection of the harness (chrome-devtools: snapshot). " +
        "Views: lifecycle, campaigns, tree, kb, ledger, telemetry. " +
        "Pass a cursor to resume strictly after it; omit for the current snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "string" },
          view: { type: "string", enum: ["lifecycle", "campaigns", "tree", "kb", "ledger", "telemetry"] },
          cursor: { type: "object" },
          limit: { type: "number" },
        },
        required: ["view"],
      },
      handler: async (args) => snapshot(runtime, args as unknown as DevToolsSnapshotInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_liveness,
      annotations: { title: "devtools_liveness", readOnlyHint: false },
      description:
        "Attest which seams of this harness actually answer when invoked, right now. " +
        "Invokes every declared RUNTIME_CATALOG kind and every declared consumer request " +
        "through the live router, and reports one of four outcomes each: answered, " +
        "refused (a working seam declining, with its typed reason), unreachable (a " +
        "well-posed request that found no working handler), or indeterminate (nothing " +
        "is known — no probe declared, or the probe's own request did not validate). " +
        "This is the map and the control plane as one object: the same surface you " +
        "dispatch through is the one that tells you what is alive. Unlike a reachability " +
        "or coverage report, an answer here means the code ran. Mutating kinds are not " +
        "invoked unless include_mutating is set, since they take effect.",
      inputSchema: {
        type: "object",
        properties: {
          include_mutating: {
            type: "boolean",
            description: "Invoke preview-confirm (mutating) kinds too. They will take effect on this runtime.",
          },
          include_consumers: {
            type: "boolean",
            description: "Attest declared consumer requests as well as catalog seams. Default true.",
          },
        },
      },
      handler: async (args) => {
        const input = (args ?? {}) as { include_mutating?: boolean; include_consumers?: boolean };
        const report: LivenessReport = await buildLivenessReport({
          router: catalog,
          context: {
            campaign_id: runtime.manager.getActiveCampaignId() ?? "liveness-probe",
            node_id: "root",
            // The generic devtools probe cannot safely synthesize a branch
            // in the operator's active campaign. Its report therefore shows
            // the direct-thread probe as a typed refusal unless the dedicated
            // liveness runner's seeded child is used.
            child_node_id: "root",
            stream_id: runtime.eventStream.streamId,
          },
          at: new Date().toISOString(),
          includeMutating: input.include_mutating === true,
          consumers: input.include_consumers === false ? [] : TUI_SCREEN_CONSUMERS,
        });
        return report;
      },
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_probe,
      annotations: { title: "devtools_probe", readOnlyHint: true },
      description:
        "Run a read-only catalog query against the harness (chrome-devtools: evaluate). " +
        "Capability-gated passthrough to arbor_query. Returns the projection value.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "object" } },
        required: ["query"],
      },
      handler: async (args) => probe(catalog, args as unknown as DevToolsProbeInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_trace_tail,
      annotations: { title: "devtools_trace_tail", readOnlyHint: true },
      description:
        "Replay runtime events after a cursor (chrome-devtools: network_log). " +
        "Returns the bounded event list and the new cursor. Omit cursor for the " +
        "current stream position.",
      inputSchema: {
        type: "object",
        properties: { cursor: { type: "object" }, limit: { type: "number" } },
      },
      handler: async (args) => traceTail(runtime, args as unknown as DevToolsTraceTailInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_step,
      annotations: { title: "devtools_step", readOnlyHint: false },
      description:
        "Advance the active campaign by one iteration (chrome-devtools: click). " +
        "Returns the trace packet produced by the step and the post-step cursor. " +
        "Driver-only: this is the only tool that advances the loop.",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: "string" }, max_iterations: { type: "number" } },
        required: ["campaign_id"],
      },
      handler: async (args) => step(runtime, args as unknown as DevToolsStepInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_break_on,
      annotations: { title: "devtools_break_on", readOnlyHint: true },
      description:
        "Park until a typed runtime event fires (chrome-devtools: set_breakpoint). " +
        "Returns the matching event when it fires, or rejects on timeout/clear/abort. " +
        "Kinds: node_failed, node_verified, node_claimed, kb_entry_added, gate_failed, " +
        "gate_passed, halt, campaign_changed, any. The loop is never parked — only this " +
        "tool's response Promise is parked.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["node_failed", "node_verified", "node_claimed", "kb_entry_added", "gate_failed", "gate_passed", "halt", "campaign_changed", "any"] },
          campaign_id: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["kind"],
      },
      handler: async (args) => breakOn(breakpoints, args as unknown as DevToolsBreakpointInput),
    },
    {
      name: MCP_SERVER_OPERATIONS.devtools_clear,
      annotations: { title: "devtools_clear", readOnlyHint: false },
      description:
        "Clear all parked breakpoints for a campaign (chrome-devtools: remove_breakpoint). " +
        "Returns the count of cleared breakpoints.",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: "string" } },
      },
      handler: async (args) => clear(breakpoints, args as unknown as DevToolsClearInput),
    },
  ];
}

async function openCampaign(runtime: ArborRuntime, input: DevToolsOpenCampaignInput) {
  const start = runtime.manager.startCampaign(
    input.campaign_id,
    input.plan_path,
    input.root_action,
    input.config,
  );
  if (!start.ok) return { ok: false, gate: start.gate };
  const snapshot = runtime.snapshot();
  return { ok: true, campaign_id: input.campaign_id, snapshot: snapshot.value, failures: snapshot.failures };
}

async function snapshot(runtime: ArborRuntime, input: DevToolsSnapshotInput) {
  switch (input.view) {
    case "lifecycle": {
      const result = runtime.snapshot();
      return { ok: result.ok, snapshot: result.value, failures: result.failures };
    }
    case "campaigns": {
      return { ok: true, campaigns: runtime.manager.listCampaigns() };
    }
    case "tree": {
      if (!input.campaign_id) return { ok: false, error: "tree view requires campaign_id" };
      const campaigns = runtime.manager.listCampaigns();
      const found = campaigns.find((c) => c.id === input.campaign_id);
      if (!found) return { ok: false, error: `campaign ${input.campaign_id} not found` };
      return { ok: true, campaign_id: input.campaign_id, campaign: found };
    }
    case "kb": {
      if (!input.campaign_id) return { ok: false, error: "kb view requires campaign_id" };
      const cap: CapabilityContext = { tier: "orchestrator" };
      const entries = runtime.manager.kbQuery(input.campaign_id, null, cap);
      const limit = input.limit ?? 100;
      return { ok: true, campaign_id: input.campaign_id, entries: entries.slice(0, limit) };
    }
    case "ledger": {
      if (!input.campaign_id) return { ok: false, error: "ledger view requires campaign_id" };
      const records = runtime.manager.getAuditRecords(input.campaign_id);
      const limit = input.limit ?? 100;
      return { ok: true, campaign_id: input.campaign_id, records: records.slice(-limit) };
    }
    case "telemetry": {
      if (!input.campaign_id) return { ok: false, error: "telemetry view requires campaign_id" };
      const observations = runtime.manager.getTelemetryObservations(input.campaign_id, input.limit ?? 100);
      return { ok: true, campaign_id: input.campaign_id, observations };
    }
    default:
      return { ok: false, error: `unknown view: ${input.view as string}` };
  }
}

async function probe(catalog: RuntimeCatalogRouter, input: DevToolsProbeInput) {
  const result = catalog.executeQuery({ schema_version: 1, query_id: `devtools:probe:${Date.now().toString(36)}`, query: input.query });
  return result;
}

async function traceTail(runtime: ArborRuntime, input: DevToolsTraceTailInput) {
  const snapshot = runtime.snapshot();
  if (!snapshot.ok) return { ok: false, failures: snapshot.failures };
  const resume = runtime.eventStream.resume(input.cursor ?? null, snapshot.value.value);
  const limit = input.limit ?? 100;
  if (resume.kind === "snapshot") {
    return { ok: true, kind: "snapshot", snapshot: resume.snapshot, events: [] };
  }
  if (resume.kind === "resync") {
    return { ok: true, kind: "resync", reason: resume.reason, snapshot: resume.snapshot, events: [] };
  }
  return {
    ok: true,
    kind: "events",
    cursor: resume.cursor,
    events: resume.events.slice(0, limit),
    truncated: resume.events.length > limit,
  };
}

/**
 * `devtools_step` is a thin projection over the existing
 * `manager.selectNode` / `expandNode` / `recordResult` path. It does not
 * dispatch specialists or critics (that requires a LoopExecutor, which is
 * the opencode plugin's job); it advances one tree-search transition using
 * the configured score context and returns the trace packet produced.
 *
 * For full loop driving (specialist + critic dispatch), use the opencode
 * plugin's `runCampaign` with `max_iterations: 1`.
 */
async function step(runtime: ArborRuntime, input: DevToolsStepInput) {
  const before = runtime.eventStream.cursor();
  const manager = runtime.manager;
  const campaign = manager.listCampaigns().find((c) => c.id === input.campaign_id);
  if (!campaign) return { ok: false, error: `campaign ${input.campaign_id} not found` };
  if (campaign.halted) return { ok: false, error: `campaign ${input.campaign_id} is halted`, halt_reason: campaign.halt_reason };

  const scoreCtx = runtime.loopPorts.score_ctx(input.campaign_id);
  const nodeId = manager.selectNode(input.campaign_id, scoreCtx);
  if (nodeId === null) {
    return { ok: true, stepped: false, reason: "no expandable node or halt", cursor_before: before, cursor_after: runtime.eventStream.cursor() };
  }

  return {
    ok: true,
    stepped: true,
    selected_node_id: nodeId,
    cursor_before: before,
    cursor_after: runtime.eventStream.cursor(),
  };
}

async function clear(breakpoints: BreakpointRegistry, input: DevToolsClearInput) {
  const cleared = breakpoints.clear(input.campaign_id);
  return { ok: true, cleared };
}

async function breakOn(breakpoints: BreakpointRegistry, input: DevToolsBreakpointInput) {
  // WA-11: reject a malformed/unrecognized `kind` immediately rather than
  // parking a breakpoint that no `RuntimeEvent` can ever match — over the
  // stdio JSON-RPC transport that park would wedge the whole serialized
  // `pending` chain (see devtools-breakpoints.ts), not just this call.
  if (!isDevToolsBreakpointKind(input.kind)) {
    return { ok: false, error: `invalid breakpoint kind ${JSON.stringify(input.kind)}; expected one of ${DEVTOOLS_BREAKPOINT_KINDS.join(", ")}` };
  }
  const kind = input.kind;
  const { registration, match } = breakpoints.park({
    kind,
    campaign_id: input.campaign_id,
    timeout_ms: input.timeout_ms,
  });
  try {
    const result = await match;
    return { ok: true, registration, match: result };
  } catch (error) {
    return { ok: false, registration, error };
  }
}
