/**
 * Provider-neutral model routing for the owned native harness.
 *
 * Composition supplies the two model ports and owns what they mean. This
 * module only makes the request's explicit tool-capability boundary
 * enforceable: a tool-capable request can never be retried or recovered by
 * dispatching to the non-tool child, and vice versa.
 */
import { classifyNativeInferenceFailure, type NativeModelIdentity, type NativeRetryClassification } from "./inference.js";
import type { NativeInferenceDelta } from "./inference.js";
import type { NativeModelPort, NativeModelRequest, NativeModelResponse } from "./native-worker.js";

/** A route is a harness fact, deliberately not a provider identity. */
export type NativeModelRoute = "tool_capable" | "non_tool";

/**
 * Content- and credential-free evidence emitted before one child dispatch.
 * `child_identity` is a defensive snapshot so an observer cannot mutate the
 * selected child's metadata through this callback.
 */
export interface NativeModelRouteReceipt {
  readonly route: NativeModelRoute;
  readonly session_id: string;
  readonly turn: number;
  readonly child_identity: NativeModelIdentity | null;
}

export interface RoutedNativeModelPortOptions {
  /** Receives every `tools_allowed !== false` request, including empty-tool roles. */
  readonly tool_capable: NativeModelPort;
  /**
   * Receives only an explicitly `tools_allowed === false` request. The router
   * always supplies it `null` for the model secret, isolating the no-tool
   * boundary from the tool-capable child's opaque session credential.
   */
  readonly non_tool: NativeModelPort;
  /**
   * Synchronous, non-secret observation before the selected child is called.
   * A thrown observer error fails closed: neither child is dispatched.
   */
  readonly on_route_selected?: (receipt: NativeModelRouteReceipt) => void;
}

interface SelectedRoute {
  readonly route: NativeModelRoute;
  readonly child: NativeModelPort;
}

/** The shared, explicit routing predicate. Omitted means tool-capable. */
export function selectNativeModelRoute(request: Pick<NativeModelRequest, "tools_allowed">): NativeModelRoute {
  return request.tools_allowed !== false ? "tool_capable" : "non_tool";
}

/**
 * Compose exactly two children into a NativeModelPort-compatible fail-closed
 * router. It intentionally exposes no aggregate `identity`: one static
 * identity would misrepresent a session whose turns can select different
 * child ports. Callers receive the selected identity through the receipt.
 */
export function createRoutedNativeModelPort(options: RoutedNativeModelPortOptions): NativeModelPort {
  const toolCapable = requirePort(options.tool_capable, "tool_capable");
  const nonTool = requirePort(options.non_tool, "non_tool");
  const onRouteSelected = options.on_route_selected;
  const failures = new WeakMap<object, NativeModelPort>();

  const select = (request: NativeModelRequest): SelectedRoute => selectNativeModelRoute(request) === "tool_capable"
    ? Object.freeze({ route: "tool_capable" as const, child: toolCapable })
    : Object.freeze({ route: "non_tool" as const, child: nonTool });

  const observe = (selected: SelectedRoute, request: NativeModelRequest): void => {
    onRouteSelected?.(freezeReceipt(selected.route, request, selected.child.identity));
  };

  const rememberFailure = (error: unknown, child: NativeModelPort): void => {
    if (typeof error === "object" && error !== null) failures.set(error, child);
  };

  const run = async (request: NativeModelRequest, secret: string | null, signal: AbortSignal): Promise<NativeModelResponse> => {
    const selected = select(request);
    observe(selected, request);
    try {
      return await selected.child.run(request, secretFor(selected, secret), signal);
    } catch (error) {
      // This records the selected child only so the worker's existing bounded
      // retry policy can ask that same child for its classification. It never
      // retries, transforms, or dispatches the other child.
      rememberFailure(error, selected.child);
      throw error;
    }
  };

  const classify_failure = (error: unknown): NativeRetryClassification => {
    const child = typeof error === "object" && error !== null ? failures.get(error) : undefined;
    return child?.classify_failure?.(error) ?? classifyNativeInferenceFailure(error);
  };

  // A NativeModelPort has one optional streaming member. Only expose it when
  // both possible children can stream; otherwise consumers correctly choose
  // `run` and no route gets a synthetic or cross-child stream fallback.
  if (toolCapable.stream === undefined || nonTool.stream === undefined) {
    return Object.freeze({ run, classify_failure });
  }

  const stream = (request: NativeModelRequest, secret: string | null, signal: AbortSignal): AsyncIterable<NativeInferenceDelta> => {
    const selected = select(request);
    observe(selected, request);
    return observeStreamFailure(selected.child.stream!(request, secretFor(selected, secret), signal), selected.child, rememberFailure);
  };

  return Object.freeze({ run, stream, classify_failure });
}

function requirePort(value: NativeModelPort, name: string): NativeModelPort {
  if (value === null || typeof value !== "object" || typeof value.run !== "function") {
    throw new TypeError(`${name} model port must provide run()`);
  }
  return value;
}

function freezeReceipt(route: NativeModelRoute, request: NativeModelRequest, identity: NativeModelIdentity | undefined): NativeModelRouteReceipt {
  return Object.freeze({
    route,
    session_id: request.session_id,
    turn: request.turn,
    child_identity: identity === undefined ? null : freezeIdentity(identity),
  });
}

/** Preserve the tool-capable lease while guaranteeing no-tool secret isolation. */
function secretFor(selected: SelectedRoute, secret: string | null): string | null {
  return selected.route === "tool_capable" ? secret : null;
}

function freezeIdentity(identity: NativeModelIdentity): NativeModelIdentity {
  return Object.freeze({
    provider_id: identity.provider_id,
    model_id: identity.model_id,
    ...(identity.configured_revision === undefined ? {} : { configured_revision: identity.configured_revision }),
    revision: identity.revision,
    capabilities: Object.freeze(identity.capabilities.map((capability) => Object.freeze({ ...capability }))),
  });
}

async function* observeStreamFailure(
  stream: AsyncIterable<NativeInferenceDelta>,
  child: NativeModelPort,
  rememberFailure: (error: unknown, child: NativeModelPort) => void,
): AsyncGenerator<NativeInferenceDelta> {
  try {
    yield* stream;
  } catch (error) {
    rememberFailure(error, child);
    throw error;
  }
}
