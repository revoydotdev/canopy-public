import { redactNativeText, type NativeCredentialLeasePort, type NativeToolExecutionEvidence, type NativeToolPreflightResult, type NativeToolRequest, type NativeToolResponse } from "@arbor/harness";
import { MCP_CALL_TIMEOUT_MS, MCP_MAX_ARGUMENT_BYTES, MCP_MAX_RESULT_BYTES, MCP_MAX_TOOL_NAME_BYTES, type McpAdvertisedToolPort, type McpToolPortOptions } from "./contracts.js";
import { JsonRpcClientError, assertBoundedTimeout, plain } from "./json-rpc.js";

export function createMcpToolPort(options: McpToolPortOptions): McpAdvertisedToolPort {
  const namespaced = `mcp.${options.server_id}.${options.tool.name}`;
  if (Buffer.byteLength(namespaced, "utf8") > MCP_MAX_TOOL_NAME_BYTES) throw new Error("namespaced MCP tool name exceeds byte bound");
  const argumentLimit = options.max_argument_bytes ?? MCP_MAX_ARGUMENT_BYTES;
  const resultLimit = options.max_result_bytes ?? MCP_MAX_RESULT_BYTES;
  if (!Number.isSafeInteger(argumentLimit) || argumentLimit <= 0 || argumentLimit > MCP_MAX_ARGUMENT_BYTES) throw new Error("MCP argument byte limit is invalid");
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 256 || resultLimit > MCP_MAX_RESULT_BYTES) throw new Error("MCP result byte limit is invalid");
  if (options.call_timeout_ms !== undefined) assertBoundedTimeout(options.call_timeout_ms);
  const redact = (value: string): string => options.redact?.(redactNativeText(value)) ?? redactNativeText(value);
  const definition = Object.freeze({ name: namespaced, description: redact(options.tool.description), parameters: redactJsonObject(options.tool.inputSchema, redact), risk: options.risk });
  const preflight = (request: NativeToolRequest): NativeToolPreflightResult => {
    if (!options.client.connected) return refused("mcp_not_connected", "MCP server is not connected", options.risk);
    if (!plain(request.input)) return refused("mcp_invalid_arguments", "MCP tool arguments must be a plain object", options.risk);
    if (jsonBytes(request.input) > argumentLimit) return refused("mcp_arguments_too_large", "MCP tool arguments exceed the configured byte bound", options.risk);
    return Object.freeze({ allowed: true });
  };
  return Object.freeze({
    tool: namespaced,
    model_definition: definition,
    recovery_protection: () => options.mutating
      ? Object.freeze({ effect_kind: "external" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null })
      : Object.freeze({ effect_kind: "read_only" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
    preflight,
    execute: async (request: NativeToolRequest, workerSecret: string | null, signal: AbortSignal): Promise<NativeToolResponse> => {
      const denied = preflight(request); if (!denied.allowed) return Object.freeze({ result_summary: denied.reason, model_output: denied.reason, evidence: denied.evidence });
      try {
        const invoke = async (secret: string | null): Promise<NativeToolResponse> => {
          const result = await options.client.callTool(options.tool.name, request.input as Record<string, unknown>, { timeout_ms: options.call_timeout_ms ?? MCP_CALL_TIMEOUT_MS, signal, secret });
          const flattened = flatten(result.content);
          const safe = redactNativeText(flattened.text, { secrets: secret === null ? [] : [secret] });
          const preview = boundedPreview(safe, resultLimit, flattened.nonText);
          const outcome = result.isError ? "failed" : "succeeded";
          const code = result.isError ? "mcp_tool_error" : "ok";
          const evidence = evidenceFor(outcome, code, result.isError ? "none" : options.mutating ? "applied" : "observed", options.risk);
          return Object.freeze({ result_summary: result.isError ? "MCP tool reported an error" : "MCP tool completed", model_output: preview, evidence });
        };
        return workerSecret !== null ? await invoke(workerSecret) : await inject(options.credential_for_session?.(request.session_id), invoke);
      } catch (error) {
        const code = error instanceof JsonRpcClientError ? `mcp_${error.code}` : "mcp_transport";
        const summary = code === "mcp_timeout" ? "MCP tool call timed out" : "MCP tool call failed";
        return Object.freeze({ result_summary: summary, model_output: JSON.stringify({ outcome: "failed", code }), evidence: evidenceFor(signal.aborted ? "cancelled" : "failed", code, "unknown", options.risk) });
      }
    },
  });
}

async function inject<T>(lease: NativeCredentialLeasePort | undefined, invoke: (secret: string | null) => Promise<T>): Promise<T> { return lease === undefined ? invoke(null) : lease.inject((secret) => invoke(secret)); }
function refused(code: string, reason: string, risk: "low" | "high"): NativeToolPreflightResult { return Object.freeze({ allowed: false, code, reason, evidence: evidenceFor("refused", code, "none", risk, "audit") }); }
function evidenceFor(outcome: NativeToolExecutionEvidence["outcome"], code: string, effect: NativeToolExecutionEvidence["effect"], risk: "low" | "high", stage: NativeToolExecutionEvidence["stage"] = "execution"): NativeToolExecutionEvidence { return Object.freeze({ outcome, stage, code, effect, action_scope: Object.freeze({ status: risk === "high" ? "absent" : "not_required" }) }); }
function jsonBytes(value: unknown): number { try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; } }
function flatten(content: readonly unknown[]): { text: string; nonText: number } { const output: string[] = []; let nonText = 0; for (const part of content) { if (plain(part) && part.type === "text" && typeof part.text === "string") output.push(part.text); else { nonText += 1; output.push(`[MCP non-text content omitted: ${plain(part) && typeof part.type === "string" ? part.type : "unknown"}]`); } } return { text: output.join("\n"), nonText }; }
function boundedPreview(value: string, maxBytes: number, nonText: number): string {
  const bytes = Buffer.byteLength(value); const full = JSON.stringify({ output: value, byte_count: bytes, truncated: false, non_text_parts: nonText });
  if (Buffer.byteLength(full) <= maxBytes) return full;
  const buffer = Buffer.from(value); let previewBytes = Math.max(0, maxBytes - 160);
  for (;;) {
    const headBytes = Math.floor(previewBytes * 0.7); const tailBytes = previewBytes - headBytes;
    const candidate = JSON.stringify({ head: buffer.subarray(0, headBytes).toString("utf8"), tail: buffer.subarray(Math.max(0, buffer.length - tailBytes)).toString("utf8"), byte_count: bytes, truncated: true, non_text_parts: nonText });
    if (Buffer.byteLength(candidate) <= maxBytes) return candidate;
    if (previewBytes === 0) return JSON.stringify({ truncated: true });
    previewBytes = Math.max(0, previewBytes - 16);
  }
}
function redactJsonObject(value: Record<string, unknown>, redact: (value: string) => string): Record<string, unknown> {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(visit);
    if (plain(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return Object.freeze(visit(value) as Record<string, unknown>);
}
