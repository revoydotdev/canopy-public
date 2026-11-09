import { a2aBridgeOption } from "./a2a-bridge.js";
import { CampaignManager } from "./manager.js";
import { ArborRuntime, type RuntimeResult, type RuntimeHealth } from "./runtime.js";
import { defineTools } from "./tools.js";
import { defineResources } from "./resources.js";
import { defineFrameResource } from "./frame-resource.js";
import { defineDevToolsTools } from "./devtools.js";
import { BreakpointRegistry } from "./devtools-breakpoints.js";
import { RuntimeCatalogRouter, type RuntimeRouterResult } from "./runtime-catalog.js";
import { NATIVE_MODEL_TOOL_IDS, type CapabilityTier } from "@arbor/core";
import { MCP_MAX_TOOLS_PER_SERVER } from "./mcp-client/contracts.js";
import { CAPABILITY_INDEX, compareCapabilitySurfaces } from "./capability-index.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "./native-capability-manifest.js";
import { NATIVE_ROLE_PROFILES } from "@arbor/prompts";
import { NATIVE_BUS_THREAD_MODEL_TOOLS, NATIVE_PLANNING_MODEL_TOOLS, NATIVE_REPOSITORY_MODEL_TOOLS } from "./native-model-tool-catalog.js";
import { NATIVE_SKILL_CAPABILITY_MANIFEST } from "./skills/capabilities.js";
import { RUNTIME_CATALOG } from "./runtime-catalog.js";

export interface ServerTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: ServerToolAnnotations;
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/** Advisory MCP behavior hints. These never authorize or gate a tool call. */
export interface ServerToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ArborMCPServerOptions {
  /**
   * ADR-028 tier for this server's `RuntimeCatalogRouter`. Omit to keep the
   * trusted in-process default (`senior`) — every existing composition root
   * (tests, `liveness-runner.ts`, ...) relies on that default and stays
   * unaffected. WA-10: a transport that hands this server to a party it does
   * not fully control (e.g. an `arbor serve` stdio client) should pass
   * `"junior"` explicitly so mutating catalog kinds are refused until an
   * operator grants trust.
   */
  caller_tier?: CapabilityTier;
}

export interface McpOperatorElicitationRequest {
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
}

export type McpOperatorElicitationResult =
  | { readonly action: "accept"; readonly content: Readonly<Record<string, unknown>> }
  | { readonly action: "decline" | "cancel" }
  | { readonly action: "unavailable"; readonly reason: string };

/** Typed port used by server tools when an operator answer is required mid-call. */
export interface McpOperatorElicitationPort {
  elicit(request: McpOperatorElicitationRequest, signal: AbortSignal): Promise<McpOperatorElicitationResult>;
}

export interface ResourceDefinition {
  uri_template: string;
  description: string;
  handler: (campaignId: string) => unknown;
}

export class ArborMCPServer {
  readonly runtime: ArborRuntime;
  readonly manager: CampaignManager;
  readonly runtimeCatalog: RuntimeCatalogRouter;
  readonly tools: ServerTool[];
  readonly resources: ResourceDefinition[];
  readonly devtoolsTools: ServerTool[];
  readonly breakpoints: BreakpointRegistry;
  private unsubscribeBreakpoints: (() => void) | null = null;
  private readonly toolListChangeListeners = new Set<() => void>();
  private operatorElicitationPort: McpOperatorElicitationPort | null = null;

  constructor(runtimeOrManager: ArborRuntime | CampaignManager = new ArborRuntime(), options: ArborMCPServerOptions = {}) {
    this.runtime = runtimeOrManager instanceof ArborRuntime
      ? runtimeOrManager
      : new ArborRuntime({ manager: runtimeOrManager });
    this.manager = this.runtime.manager;
    // Raw output is now authorized by a matching durable ApprovalService
    // decision inside RuntimeCatalogRouter, not a static transport grant.
    this.runtimeCatalog = new RuntimeCatalogRouter(this.runtime, { recovery_service: this.runtime.recoveryService ?? undefined,
      // ADR/4D.6: A2A is opt-in and fail-closed — null unless
      // ARBOR_A2A_SIGNING_SECRET is set, leaving a2a.* "unavailable".
      ...a2aBridgeOption(),
      ...(options.caller_tier === undefined ? {} : { caller_tier: options.caller_tier }) });
    this.breakpoints = new BreakpointRegistry();
    this.unsubscribeBreakpoints = this.manager.subscribeEvents(this.breakpoints.onEvent);
    this.tools = defineTools(this.manager, this.runtimeCatalog, options.caller_tier ?? "senior");
    this.resources = [
      ...defineResources(this.manager),
      defineFrameResource(this.manager),
      {
        uri_template: "arbor://capabilities",
        description: "Revision-bound capability index. Runtime, native-tool, role, and skill parity reflects their canonical consumer declarations; MCP parity also checks live server tool registration.",
        handler: () => ({
          index: CAPABILITY_INDEX,
          parity: compareCapabilitySurfaces(this.capabilityObservation()),
        }),
      },
    ];
    this.devtoolsTools = defineDevToolsTools(this.runtime, this.runtimeCatalog, this.breakpoints);
  }

  start(): Promise<RuntimeResult<RuntimeHealth>> {
    return this.runtime.start();
  }

  close(): Promise<RuntimeResult<RuntimeHealth>> {
    this.unsubscribeBreakpoints?.();
    this.unsubscribeBreakpoints = null;
    this.breakpoints.clear();
    return this.runtime.close();
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name) ?? this.devtoolsTools.find((t) => t.name === name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    return tool.handler(args, signal);
  }

  /** Dispatch a validated runtime command without inventing an MCP-only schema. */
  dispatchRuntimeCommand(input: unknown): Promise<RuntimeRouterResult<unknown>> {
    return this.runtimeCatalog.dispatchCommand(input);
  }

  /** Execute a validated runtime query without duplicating catalog semantics. */
  executeRuntimeQuery(input: unknown): RuntimeRouterResult<unknown> {
    return this.runtimeCatalog.executeQuery(input);
  }

  readResource(uri: string): unknown {
    const exact = this.resources.find((resource) => resource.uri_template === uri);
    if (exact) return exact.handler("");
    if (uri === "arbor://frame") {
      const res = this.resources.find((r) => r.uri_template === "arbor://frame");
      return res ? res.handler("") : { ok: false, error: "Unknown resource: frame" };
    }
    const match = uri.match(/^arbor:\/\/campaigns\/([^/]+)\/(state|kb|audit)$/);
    if (!match) {
      return { ok: false, error: `Unknown resource URI: ${uri}` };
    }
    const [, campaignId, resource] = match;
    const res = this.resources.find((r) => r.uri_template.includes(resource));
    if (!res) {
      return { ok: false, error: `Unknown resource: ${resource}` };
    }
    return res.handler(campaignId);
  }

  listTools(): { name: string; description: string; inputSchema: object; annotations?: ServerToolAnnotations }[] {
    return [...this.tools, ...this.devtoolsTools].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
    }));
  }

  /** Register a process-local tool and notify connected MCP sessions that opted into rediscovery. */
  registerTool(tool: ServerTool): void {
    if ([...this.tools, ...this.devtoolsTools].length >= MCP_MAX_TOOLS_PER_SERVER) throw new Error(`MCP tool catalog exceeds ${MCP_MAX_TOOLS_PER_SERVER} tools`);
    if (!tool.name || this.tools.some((existing) => existing.name === tool.name) || this.devtoolsTools.some((existing) => existing.name === tool.name)) throw new Error(`MCP tool name is empty or already registered: ${tool.name}`);
    // Built-in arbor tools carry hand-reviewed annotations. Apply a
    // conservative completed classification to dynamically registered arbor
    // tools too, so this alternate registration path cannot silently publish
    // an unclassified tool. Non-arbor extension tools keep their existing
    // optional annotation contract.
    const readOnly = tool.annotations?.readOnlyHint ?? false;
    const registered = tool.name.startsWith("arbor_")
      ? Object.freeze({
        ...tool,
        annotations: Object.freeze({
          ...tool.annotations,
          readOnlyHint: readOnly,
          destructiveHint: tool.annotations?.destructiveHint ?? !readOnly,
          idempotentHint: tool.annotations?.idempotentHint ?? readOnly,
          openWorldHint: tool.annotations?.openWorldHint ?? !readOnly,
        }),
      })
      : tool;
    this.tools.push(registered);
    for (const listener of this.toolListChangeListeners) listener();
  }

  unregisterTool(name: string): boolean {
    const index = this.tools.findIndex((tool) => tool.name === name);
    if (index < 0) return false;
    this.tools.splice(index, 1);
    for (const listener of this.toolListChangeListeners) listener();
    return true;
  }

  subscribeToolListChanges(listener: () => void): () => void {
    this.toolListChangeListeners.add(listener);
    return () => this.toolListChangeListeners.delete(listener);
  }

  bindOperatorElicitationPort(port: McpOperatorElicitationPort | null): void { this.operatorElicitationPort = port; }

  requestOperatorInput(request: McpOperatorElicitationRequest, signal: AbortSignal): Promise<McpOperatorElicitationResult> {
    return this.operatorElicitationPort?.elicit(request, signal) ?? Promise.resolve({ action: "unavailable", reason: "no initialized MCP stdio session is bound" });
  }

  listResources(): { uri: string; name: string; description: string; mimeType: string }[] {
    return this.resources
      .filter((resource) => !resource.uri_template.includes("{"))
      .map((resource) => ({ uri: resource.uri_template, name: resource.uri_template, description: resource.description, mimeType: "application/json" }));
  }

  listResourceTemplates(): { uriTemplate: string; name: string; description: string; mimeType: string }[] {
    return this.resources
      .filter((resource) => resource.uri_template.includes("{"))
      .map((resource) => ({ uriTemplate: resource.uri_template, name: resource.uri_template, description: resource.description, mimeType: "application/json" }));
  }

  private capabilityObservation(): Parameters<typeof compareCapabilitySurfaces>[0] {
    const modelTools = [
      ...NATIVE_REPOSITORY_MODEL_TOOLS,
      ...NATIVE_PLANNING_MODEL_TOOLS,
      ...NATIVE_BUS_THREAD_MODEL_TOOLS,
      // The peer model tools are advertised by CAPABILITY_INDEX.model_tools
      // (capability-index.ts), so omitting them here made this one resource
      // contradict itself: the `index` half listed peer.history/query/reply
      // while the `parity` half beside it reported exactly those as missing
      // (`status: "drift"`). A consumer reading either half got a wrong answer.
      ...NATIVE_MODEL_TOOL_IDS.peer.map((name) => ({ name, risk: NATIVE_TOOL_RISK_MANIFEST.peer[name] })),
    ];
    const hostTools = Object.values(NATIVE_TOOL_RISK_MANIFEST).flatMap((group) => Object.keys(group));
    return {
      mcp_operations: this.listTools().map((tool) => tool.name),
      runtime_operations: RUNTIME_CATALOG.map((entry) => entry.kind),
      host_tool_names: hostTools,
      model_tool_names: [...new Set(modelTools.map((tool) => tool.name))],
      role_ids: Object.keys(NATIVE_ROLE_PROFILES),
      skill_tool_names: Object.keys(NATIVE_SKILL_CAPABILITY_MANIFEST.tools),
      skill_structured_output_ids: NATIVE_SKILL_CAPABILITY_MANIFEST.structured_output_ids,
    };
  }
}
