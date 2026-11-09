/**
 * Bounded browser automation is a capability port, not an ambient browser.
 * A deployment must compose a provider that owns its browser/session.  This
 * adapter only validates request authority and records a redacted, bounded
 * observation; it never launches a browser or falls back to a local one.
 */
import type { NativeToolActionScopeEvidence, NativeToolEffect, NativeToolExecutionEvidence, NativeToolPort, NativeToolRequest, NativeToolResponse, NativeToolRisk } from "@arbor/harness";
import type { NativeToolOutcome, NativeToolOutcomeStage } from "./native-tools/contracts.js";
import { boundedToolModelOutput } from "./native-tool-host.js";
import { admitGovernedWebUrl, type GovernedNetworkPolicy } from "./native-web-tools.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { NATIVE_TOOL_RISK_MANIFEST } from "./native-capability-manifest.js";

export const NATIVE_BROWSER_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.browser satisfies Record<string, NativeToolRisk>;
const OUTPUT_BYTES = 16 * 1024;
const NO_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

export interface BrowserObservation { readonly url: string; readonly title: string; readonly text: string; readonly screenshot_hash?: string; }
export interface BrowserAutomationProvider {
  readonly provider_id: string;
  /** Governed HTTPS endpoint dialed by an out-of-process browser bridge. */
  readonly endpoint_url?: string;
  observe(input: Readonly<{ url: string }>, signal: AbortSignal): Promise<BrowserObservation>;
  interact(input: Readonly<{ action: "click" | "type" | "select"; target: string; value?: string }>, signal: AbortSignal): Promise<BrowserObservation>;
}
export interface BrowserToolPortOptions {
  readonly provider?: BrowserAutomationProvider;
  readonly policy: GovernedNetworkPolicy;
  readonly resolve_hostname?: typeof dnsLookup;
  readonly max_text_bytes?: number;
}

function response(tool: string, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, effect: NativeToolEffect, payload: Record<string, unknown> = {}): NativeToolResponse {
  const evidence: NativeToolExecutionEvidence = Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: NO_SCOPE });
  return Object.freeze({ result_summary: summary.slice(0, 512), model_output: boundedToolModelOutput({ outcome, stage, code, ...payload }, OUTPUT_BYTES, tool), evidence });
}
function input(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("input_invalid"); return value as Record<string, unknown>; }
function bounded(value: unknown, min: number, max: number): string | null { return typeof value === "string" && value.length >= min && value.length <= max ? value : null; }
function uncomposed(tool: string): NativeToolResponse { return response(tool, "refused", "semantic", "browser_uncomposed", "no governed browser provider is composed", "none", { capability: tool, integration: "browser.uncomposed" }); }

function parseBridgeObservation(value: unknown): BrowserObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("browser bridge returned an invalid observation");
  const item = value as Record<string, unknown>;
  if (typeof item.url !== "string" || item.url.length > 2_048 || typeof item.title !== "string" || item.title.length > 4_096 || typeof item.text !== "string" || item.text.length > 64 * 1024) throw new Error("browser bridge returned an invalid observation");
  if (item.screenshot_hash !== undefined && (typeof item.screenshot_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.screenshot_hash))) throw new Error("browser bridge returned an invalid screenshot hash");
  return { url: item.url, title: item.title, text: item.text, ...(typeof item.screenshot_hash === "string" ? { screenshot_hash: item.screenshot_hash } : {}) };
}

async function readBridgeBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("browser bridge request cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > 128 * 1024) throw new Error("browser bridge response exceeded the bound");
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best-effort */ }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Compose a bounded HTTPS JSON browser bridge. The bridge owns browser
 * process/session isolation; this client refuses credentials, redirects,
 * non-JSON/oversized responses, and is admitted through the tool's network
 * policy before every call.
 */
export function createHttpBrowserAutomationProvider(options: { readonly endpoint_url: string; readonly fetch_impl?: typeof fetch }): BrowserAutomationProvider {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint_url); } catch { throw new Error("browser endpoint must be an absolute URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("browser endpoint must be credential-free HTTPS");
  const endpointUrl = endpoint.toString();
  const doFetch = options.fetch_impl ?? fetch;
  const invoke = async (operation: "observe" | "interact", payload: Record<string, unknown>, signal: AbortSignal): Promise<BrowserObservation> => {
    const url = new URL(operation, endpointUrl.endsWith("/") ? endpointUrl : `${endpointUrl}/`);
    const result = await doFetch(url, { method: "POST", signal, redirect: "manual", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
    if (result.status >= 300 && result.status < 400) throw new Error("browser bridge redirect refused");
    if (!result.ok) throw new Error(`browser bridge returned HTTP ${result.status}`);
    if (result.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("browser bridge returned non-JSON content");
    const declared = Number(result.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 128 * 1024) throw new Error("browser bridge response exceeded the bound");
    const bytes = await readBridgeBody(result, signal);
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("browser bridge returned invalid JSON"); }
    return parseBridgeObservation(decoded);
  };
  const provider: BrowserAutomationProvider = {
    provider_id: "https-json-browser",
    endpoint_url: endpointUrl,
    observe: ({ url }: Readonly<{ url: string }>, signal: AbortSignal) => invoke("observe", { url }, signal),
    interact: (action: Readonly<{ action: "click" | "type" | "select"; target: string; value?: string }>, signal: AbortSignal) => invoke("interact", { ...action }, signal),
  };
  return Object.freeze(provider);
}

async function observe(options: BrowserToolPortOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return response("browser.observe", "cancelled", "execution", "cancelled", "browser observation cancelled before start", "none");
  if (!request.network_allowed) return response("browser.observe", "refused", "semantic", "network_not_authorized", "this request has no network authorization", "none");
  if (!options.provider) return uncomposed("browser.observe");
  try {
    const url = bounded(input(request.input).url, 8, 2_048); if (!url) return response("browser.observe", "refused", "semantic", "url_invalid", "url must be a bounded string", "none");
    if (options.provider.endpoint_url !== undefined) await admitGovernedWebUrl(options.provider.endpoint_url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    const admitted = await admitGovernedWebUrl(url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    const result = await options.provider.observe({ url: admitted.normalized_url }, signal);
    await admitGovernedWebUrl(result.url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    const max = Math.min(64 * 1024, Math.max(1, options.max_text_bytes ?? 12 * 1024));
    return response("browser.observe", "succeeded", "execution", "ok", `observed ${admitted.hostname} through ${options.provider.provider_id}`, "observed", { provider: options.provider.provider_id, url: result.url, title: result.title.slice(0, 512), text: result.text.slice(0, max), ...(result.screenshot_hash === undefined ? {} : { screenshot_hash: result.screenshot_hash }), provenance: { tag: "observed", provider: options.provider.provider_id } });
  } catch (error) {
    const refusal = typeof error === "object" && error !== null && "code" in error && "outcome" in error ? error as { code: string; outcome: NativeToolOutcome; stage: NativeToolOutcomeStage; summary: string } : null;
    if (refusal) return response("browser.observe", refusal.outcome, refusal.stage, refusal.code, refusal.summary, refusal.outcome === "refused" ? "none" : "unknown");
    const code = error instanceof Error && error.message === "input_invalid" ? "input_invalid" : "browser_observe_failed";
    return response("browser.observe", "failed", "execution", code, "browser observation failed", "unknown");
  }
}

async function interact(options: BrowserToolPortOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return response("browser.interact", "cancelled", "execution", "cancelled", "browser interaction cancelled before start", "none");
  if (!request.network_allowed) return response("browser.interact", "refused", "semantic", "network_not_authorized", "this request has no network authorization", "none");
  if (!options.provider) return uncomposed("browser.interact");
  try {
    if (options.provider.endpoint_url !== undefined) await admitGovernedWebUrl(options.provider.endpoint_url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    else {
      const authorization = options.policy.authorize?.(request, { url: "https://browser.invalid/interaction", hostname: "browser.invalid" });
      if (!(authorization === true || (typeof authorization === "object" && authorization !== null && authorization.allowed === true))) return response("browser.interact", "refused", "semantic", "request_not_authorized", "the composed authority did not authorize this browser request", "none");
    }
    const value = input(request.input); const action = bounded(value.action, 1, 16); const target = bounded(value.target, 1, 512); const text = value.value === undefined ? undefined : bounded(value.value, 0, 2_048);
    if ((action !== "click" && action !== "type" && action !== "select") || !target || (value.value !== undefined && text === null)) return response("browser.interact", "refused", "semantic", "interaction_invalid", "browser interaction is outside the bounded action contract", "none");
    const result = await options.provider.interact({ action, target, ...(typeof text === "string" ? { value: text } : {}) }, signal);
    await admitGovernedWebUrl(result.url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    return response("browser.interact", "succeeded", "execution", "ok", `browser ${action} completed through ${options.provider.provider_id}`, "unknown", { provider: options.provider.provider_id, url: result.url, title: result.title.slice(0, 512), text: result.text.slice(0, Math.min(64 * 1024, Math.max(1, options.max_text_bytes ?? 12 * 1024))), provenance: { tag: "observed", provider: options.provider.provider_id } });
  } catch {
    return response("browser.interact", "failed", "execution", "browser_interact_failed", "browser interaction failed", "unknown");
  }
}

/** Always returns ports: missing provider is an explicit, typed refusal rather than an ambient fallback. */
export function createNativeBrowserToolPorts(options: BrowserToolPortOptions): readonly NativeToolPort[] {
  const preflight = (request: NativeToolRequest) => request.network_allowed ? { allowed: true as const } : { allowed: false as const, code: "network_not_authorized", reason: "this request has no network authorization", evidence: { outcome: "refused" as const, stage: "semantic" as const, code: "network_not_authorized", effect: "none" as const, confinement: "application_validated" as const, action_scope: NO_SCOPE } };
  return Object.freeze([
    Object.freeze({ tool: "browser.observe", preflight, recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }), execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => observe(options, request, signal) }),
    Object.freeze({ tool: "browser.interact", preflight, recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: false, idempotency_key_hash: null, acknowledged_by: null }), execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => interact(options, request, signal) }),
  ]);
}
