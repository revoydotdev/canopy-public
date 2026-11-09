import { randomUUID } from "node:crypto";
import { createFetchHandler } from "@arbor/claude-bridge";
import { createOpenAICompatibleModelPort, OpenAICompatibleAdapterError, classifyNativeInferenceFailure,
  type NativeModelPort, type NativeModelAdapterRequest, type NativeModelRequest,
  type NativeModelRouteReceipt, type NativeInferenceDelta, type OpenAICompatibleFetch } from "@arbor/harness";

export interface OpenRouterBridgeFallbackOptions {
  readonly primary: NativeModelPort;
  readonly request: NativeModelAdapterRequest;
  readonly cwd: string;
  readonly model: string;
  readonly on_route_selected?: (receipt: NativeModelRouteReceipt) => void;
  readonly bridge_fetch?: OpenAICompatibleFetch;
}

/** Only provider availability/billing errors can change the model boundary. */
function eligible(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(error instanceof OpenAICompatibleAdapterError)) return false;
  return error.kind === "transport" || error.kind === "timeout" || (error.kind === "http"
    && (error.status === 402 || error.status === 429 || (error.status !== null && error.status >= 500 && error.status <= 599)));
}

/**
 * Preserve the native tool host: Claude only proposes function calls through
 * the bridge schema. Its own tools/hooks/MCP are disabled by the owned bridge.
 * A partial stream is never replayed, and OpenRouter credentials never cross.
 */
export function createOpenRouterBridgeFallback(options: OpenRouterBridgeFallbackOptions): NativeModelPort {
  if (options.request.provider_id.toLowerCase() !== "openrouter" || options.request.adapter_id !== "openai-compatible") {
    throw new Error("Claude bridge failover requires an OpenRouter OpenAI-compatible primary");
  }
  const secret = `bridge-${randomUUID()}`;
  const handler = createFetchHandler({ apiKey: secret, port: 0, cwd: options.cwd, onAccess: () => {} });
  const bridge = createOpenAICompatibleModelPort({
    ...options.request,
    fetch: options.bridge_fetch ?? ((url, init) => handler(new Request(url.toString(), init))),
    base_url: "http://arbor-claude-bridge.invalid",
    provider_id: "claude-bridge", model_id: options.model,
    // The primary's response revision and credential mechanism do not govern
    // the bridge child. Its only bearer is this composition-local nonce.
    revision: null, credential_required: true,
  });
  let selected = options.primary;
  const observe = (request: NativeModelRequest): void => options.on_route_selected?.({
    route: request.tools_allowed === false ? "non_tool" : "tool_capable",
    session_id: request.session_id, turn: request.turn, child_identity: selected.identity ?? null,
  });
  const port: NativeModelPort = {
    get identity() { return selected.identity; },
    classify_failure: (error) => selected.classify_failure?.(error) ?? classifyNativeInferenceFailure(error),
    async run(request, primarySecret, signal) {
      observe(request);
      try { return await selected.run(request, selected === bridge ? secret : primarySecret, signal); }
      catch (error) {
        if (selected === bridge || !eligible(error, signal)) throw error;
        selected = bridge;
        observe(request);
        return bridge.run(request, secret, signal);
      }
    },
  };
  if (options.primary.stream !== undefined) {
    port.stream = async function* (request, primarySecret, signal): AsyncIterable<NativeInferenceDelta> {
      observe(request);
      let emitted = false;
      try {
        for await (const delta of selected.stream!(request, selected === bridge ? secret : primarySecret, signal)) {
          emitted = true;
          yield delta;
        }
      } catch (error) {
        if (selected === bridge || emitted || !eligible(error, signal)) throw error;
        selected = bridge;
        observe(request);
        yield* bridge.stream!(request, secret, signal);
      }
    };
  }
  return port;
}
