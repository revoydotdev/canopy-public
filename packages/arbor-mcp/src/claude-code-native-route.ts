/**
 * Stateless Anthropic inference through the locally authenticated Claude Code
 * CLI. The CLI's own project tools, hooks, settings and MCP servers are
 * disabled by arbor-claude-bridge; Canopy remains the only tool host.
 */
import { randomUUID } from "node:crypto";
import { createFetchHandler } from "@arbor/claude-bridge";
import {
  createOpenAICompatibleModelPort,
  type NativeModelAdapterRequest,
  type NativeModelPort,
  type OpenAICompatibleFetch,
} from "@arbor/harness";

const BRIDGE_BASE_URL = "http://arbor-claude-bridge.invalid";

/** Compose a process-local bearer boundary; no Claude OAuth token enters Arbor. */
export function createClaudeCodeNativeModelPort(options: {
  readonly request: NativeModelAdapterRequest;
  readonly cwd: string;
  readonly fetch?: OpenAICompatibleFetch;
}): NativeModelPort {
  const secret = `bridge-${randomUUID()}`;
  const handler = createFetchHandler({ apiKey: secret, port: 0, cwd: options.cwd, onAccess: () => {} });
  const port = createOpenAICompatibleModelPort({
    ...options.request,
    fetch: options.fetch ?? ((url, init) => handler(new Request(url.toString(), init))),
    base_url: BRIDGE_BASE_URL,
    provider_id: options.request.provider_id,
    model_id: options.request.model_id,
    revision: null,
    credential_required: true,
  });
  const run = (request: Parameters<NativeModelPort["run"]>[0], _lease: string | null, signal: AbortSignal) => port.run(request, secret, signal);
  if (port.stream === undefined) return Object.freeze({ get identity() { return port.identity; }, run, classify_failure: port.classify_failure });
  return Object.freeze({
    get identity() { return port.identity; },
    run,
    stream: (request: Parameters<NonNullable<NativeModelPort["stream"]>>[0], _lease: string | null, signal: AbortSignal) => port.stream!(request, secret, signal),
    classify_failure: port.classify_failure,
  });
}
