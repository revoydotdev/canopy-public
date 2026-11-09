/**
 * Closed composition for the frontier operator native-session route.
 *
 * This module is intentionally an MCP composition concern: harness receives
 * only provider-neutral ports and never knows that the no-tool child is a
 * Claude bridge. Each child has its own credential boundary. In particular,
 * the OpenRouter lease supplied by the worker cannot reach the bridge child.
 */
import { randomUUID } from "node:crypto";
import { createFetchHandler } from "@arbor/claude-bridge";
import {
  createOpenAICompatibleModelPort,
  createRoutedNativeModelPort,
  type NativeModelAdapterRequest,
  type NativeModelAdapterRegistry,
  type NativeModelAdapterStructuredSchema,
  type NativeModelPort,
  type NativeModelRouteReceipt,
  type OpenAICompatibleFetch,
} from "@arbor/harness";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PROVIDER_ID = "openrouter";
const CLAUDE_BRIDGE_PROVIDER_ID = "claude-bridge";
const BRIDGE_BASE_URL = "http://arbor-claude-bridge.invalid";
const FLASH_MODEL_ID = "deepseek/deepseek-v4-flash";

export interface ClosedProviderRoutingSelection {
  readonly tool_model_id: string;
  readonly tool_revision: string | null;
  readonly non_tool_model_id: string;
}

export interface ClosedProviderRoutingModelOptions {
  readonly adapters: Pick<NativeModelAdapterRegistry, "create">;
  readonly cwd: string;
  readonly observed_at: string;
  readonly selection: ClosedProviderRoutingSelection;
  readonly tool_request: Omit<NativeModelAdapterRequest, "adapter_id" | "base_url" | "provider_id" | "model_id" | "revision" | "observed_at">;
  readonly non_tool_structured_schemas: readonly NativeModelAdapterStructuredSchema[];
  /** Test-only transport seam; production composes the owned bridge handler. */
  readonly bridge_fetch?: OpenAICompatibleFetch;
  readonly on_route_selected?: (receipt: NativeModelRouteReceipt) => void;
}

/**
 * Compose exactly two closed children. The tool-capable port is pinned to the
 * OpenRouter endpoint irrespective of an ambient provider base URL; the
 * no-tool port invokes the local bridge through an in-process Fetch boundary.
 */
export function createClosedProviderRoutedModel(options: ClosedProviderRoutingModelOptions): NativeModelPort {
  const selection = validateSelection(options.selection);
  const toolCapable = options.adapters.create({
    ...options.tool_request,
    adapter_id: "openai-compatible",
    base_url: OPENROUTER_BASE_URL,
    provider_id: OPENROUTER_PROVIDER_ID,
    model_id: selection.tool_model_id,
    revision: selection.tool_revision,
    observed_at: options.observed_at,
  });
  const bridgeSecret = `bridge-${randomUUID()}`;
  const bridgeFetch = options.bridge_fetch ?? createBridgeFetch(options.cwd, bridgeSecret);
  const bridgePort = createOpenAICompatibleModelPort({
    fetch: bridgeFetch,
    base_url: BRIDGE_BASE_URL,
    provider_id: CLAUDE_BRIDGE_PROVIDER_ID,
    model_id: selection.non_tool_model_id,
    observed_at: options.observed_at,
    tools: [],
    structured_schemas: options.non_tool_structured_schemas,
    credential_required: true,
  });
  const nonTool = bridgeCredentialIsolatedPort(bridgePort, bridgeSecret);
  return createRoutedNativeModelPort({
    tool_capable: toolCapable,
    non_tool: nonTool,
    ...(options.on_route_selected === undefined ? {} : { on_route_selected: options.on_route_selected }),
  });
}

function createBridgeFetch(cwd: string, bridgeSecret: string): OpenAICompatibleFetch {
  // SSE usage is already returned through the model port. The bridge's
  // default access logger writes JSON to stderr, which is not an operator-TUI
  // evidence channel and would corrupt the terminal surface.
  const handler = createFetchHandler({ apiKey: bridgeSecret, port: 0, cwd, onAccess: () => {} });
  return (input, init) => handler(new Request(typeof input === "string" ? input : input.toString(), init));
}

/** Refuse testing-only DeepSeek on either production route before dispatch. */
export function assertClosedProductionModel(modelId: string, boundary: "tool_capable" | "non_tool"): string {
  const model = modelId.trim();
  if (model.length === 0) throw new Error(`${boundary} model selection is required for closed provider routing`);
  if (model.toLowerCase().includes("deepseek")) {
    throw new Error(`${boundary} production route cannot select DeepSeek; ${FLASH_MODEL_ID} is OpenRouter testing-only and has no fallback`);
  }
  return model;
}

function validateSelection(selection: ClosedProviderRoutingSelection): ClosedProviderRoutingSelection {
  return Object.freeze({
    tool_model_id: assertClosedProductionModel(selection.tool_model_id, "tool_capable"),
    tool_revision: selection.tool_revision === null ? null : selection.tool_revision.trim() || null,
    non_tool_model_id: assertClosedProductionModel(selection.non_tool_model_id, "non_tool"),
  });
}

/**
 * The router itself supplies null to its non-tool child. This closure injects
 * only the bridge-local, per-composition bearer secret required by the bridge
 * handler; it never observes or forwards the worker's model lease.
 */
function bridgeCredentialIsolatedPort(port: NativeModelPort, bridgeSecret: string): NativeModelPort {
  const run = (request: Parameters<NativeModelPort["run"]>[0], _secret: string | null, signal: AbortSignal) => port.run(request, bridgeSecret, signal);
  if (port.stream === undefined) return Object.freeze({ get identity() { return port.identity; }, run, classify_failure: port.classify_failure });
  return Object.freeze({
    get identity() { return port.identity; },
    run,
    stream: (request: Parameters<NonNullable<NativeModelPort["stream"]>>[0], _secret: string | null, signal: AbortSignal) => port.stream!(request, bridgeSecret, signal),
    classify_failure: port.classify_failure,
  });
}
