/**
 * Governed web tools for the native harness: `web.fetch` (HTTPS GET of a
 * model-supplied URL) and `web.search` (a pluggable search-provider seam).
 *
 * Threat model (LR-NH-07 non-claim): this repository has NO OS-level network
 * confinement. `shell.execute`/`verification.run` document the same gap
 * (see `native-agent-executor.ts`'s `allow_unisolated_shell_network` doc
 * comment) — a network-capable tool here is unsandboxed at the process
 * level regardless of what this module checks. Everything below is
 * therefore APPLICATION-LEVEL policy, not a security boundary a hostile
 * codebase or compromised dependency could not route around by other
 * means. Its job is to stop an ordinary or careless model call from an
 * SSRF probe of loopback/private/link-local infrastructure, from reading
 * an unbounded or wrong-shaped response, and from silently talking to a
 * plaintext origin — not to withstand a deliberately adversarial binary
 * running in the same process.
 *
 * Composed only when explicitly capability-granted (deny-by-default; see
 * `native.capabilities.web_fetch`/`native.capabilities.web_search` in
 * `@arbor/config`), exactly the shape `native.capabilities.image_input`
 * already uses to gate a model capability at the admission layer rather
 * than exposing an always-on tool (`cli.ts`'s
 * `configuredNativeAgentExecutor`, `config.native.capabilities?.image_input`).
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { NativeToolActionScopeEvidence, NativeToolEffect, NativeToolExecutionEvidence, NativeToolPort, NativeToolPreflightResult, NativeToolRequest, NativeToolResponse, NativeToolRisk } from "@arbor/harness";
import type { NativeToolOutcome, NativeToolOutcomeStage } from "./native-tools/contracts.js";
import { boundedToolModelOutput } from "./native-tool-host.js";
import { NATIVE_TOOL_RISK_MANIFEST } from "./native-capability-manifest.js";

/**
 * Typed risk classification for `web.fetch`/`web.search`, mirroring
 * `NATIVE_SUBAGENT_TOOL_RISKS`/`NATIVE_SKILL_TOOL_RISKS`/
 * `NATIVE_USERINPUT_TOOL_RISKS` for tools hosted outside
 * `NativeRepositoryToolHost`. `cli.ts`'s advertised definitions and this map
 * are bound together by the same parity test discipline (commit a8733329):
 * advertised risk must READ this map, never repeat a literal. Both tools
 * are "high": unlike every other bus-hosted port, they perform outbound
 * network egress this repository cannot OS-confine (LR-NH-07).
 */
export const NATIVE_WEB_TOOL_RISKS = NATIVE_TOOL_RISK_MANIFEST.web satisfies Record<string, NativeToolRisk>;

const WEB_FETCH_OUTPUT_BYTES = 24 * 1024;
const WEB_SEARCH_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const REDACTED = "[REDACTED]";
const SECRET_VALUE = /(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)([A-Za-z0-9_-]{8,})/gi;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/json", "text/markdown", "text/plain"];
const NOT_REQUIRED_ACTION_SCOPE: NativeToolActionScopeEvidence = Object.freeze({ status: "not_required" });

interface ToolFailure {
  readonly outcome: Exclude<NativeToolOutcome, "succeeded">;
  readonly stage: NativeToolOutcomeStage;
  readonly code: string;
  readonly summary: string;
}

function failure(stage: NativeToolOutcomeStage, code: string, summary: string): ToolFailure {
  return { outcome: stage === "execution" ? (code === "cancelled" ? "cancelled" : "failed") : "refused", stage, code, summary };
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof value === "object" && value !== null && "stage" in value && "code" in value && "summary" in value && "outcome" in value;
}

function asFailure(error: unknown): ToolFailure {
  if (isFailure(error)) return error;
  return { outcome: "failed", stage: "execution", code: "internal_error", summary: "web tool execution failed without exposing internal details" };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure("semantic", "input_invalid", "tool input must be an object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, min: number, max: number): string {
  const field = value[key];
  if (typeof field !== "string" || field.length < min || field.length > max) throw failure("semantic", `${key}_invalid`, `${key} must be a bounded string`);
  return field;
}

function redact(value: string): string {
  return value.replace(SECRET_VALUE, (_whole, secret: string) => REDACTED.repeat(Math.max(1, Math.ceil(secret.length / REDACTED.length))));
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function webToolResponse(tool: string, maxBytes: number, outcome: NativeToolOutcome, stage: NativeToolOutcomeStage, code: string, summary: string, effect: NativeToolEffect, payload: Record<string, unknown> = {}): NativeToolResponse {
  const evidence: NativeToolExecutionEvidence = Object.freeze({ outcome, stage, code, effect, confinement: "application_validated", action_scope: NOT_REQUIRED_ACTION_SCOPE });
  return Object.freeze({
    result_summary: redact(summary).slice(0, 512),
    model_output: boundedToolModelOutput({ outcome, stage, code, ...payload }, maxBytes, tool),
    evidence,
  });
}

/**
 * RFC1918/loopback/link-local/reserved refusal (SSRF is the threat model
 * here — a model-supplied URL must never reach this box's own metadata
 * endpoint, loopback services, or private LAN). Checked against every
 * resolved address, not just the first: `dns.lookup(..., {all:true})`
 * below returns every A/AAAA record and any one private hit is a refusal.
 *
 * This validates the address SET at resolution time only, matching the app
 * -level (not OS-level) posture LR-NH-07 documents: a DNS answer that
 * changes between this check and the actual fetch (DNS rebinding) is not
 * defended against here — an OS-level confinement fix would close that gap
 * (see the LR-NH-04-style long-range item shell.execute's network posture
 * already names), this module does not claim to.
 */
function isPrivateOrReservedAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-1 straddle
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved (224-255)
    return false;
  }
  const lowered = address.toLowerCase();
  if (lowered === "::1" || lowered === "::") return true; // loopback / unspecified
  if (lowered.startsWith("fe80:") || lowered.startsWith("fe8") || lowered.startsWith("fe9") || lowered.startsWith("fea") || lowered.startsWith("feb")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lowered)) return true; // unique local (fc00::/7)
  if (lowered.startsWith("ff")) return true; // multicast
  const mapped = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedAddress(mapped[1]!, 4);
  return false;
}

export interface GovernedNetworkPolicy {
  /** Explicit allowlist. `example.com` also admits its subdomains. Empty is deny-all. */
  readonly allowed_domains: readonly string[];
  /** A composition-owned authorization decision for this individual request. */
  authorize?(request: NativeToolRequest, target: Readonly<{ readonly url: string; readonly hostname: string }>): boolean | { readonly allowed: boolean; readonly reason?: string };
}

interface FetchPolicyResult {
  readonly hostname: string;
  readonly normalized_url: string;
  readonly resolved_addresses: readonly string[];
}

function normalizedPolicyDomains(policy: GovernedNetworkPolicy): readonly string[] {
  return [...new Set(policy.allowed_domains.map((domain) => domain.trim().toLowerCase().replace(/^\./, "")).filter((domain) => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain)))];
}

function domainAllowed(hostname: string, policy: GovernedNetworkPolicy): boolean {
  return normalizedPolicyDomains(policy).some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function authorizationAllowed(policy: GovernedNetworkPolicy, request: NativeToolRequest, target: { readonly url: string; readonly hostname: string }): boolean {
  const answer = policy.authorize?.(request, target);
  return answer === true || (typeof answer === "object" && answer !== null && answer.allowed === true);
}

/**
 * Application-level admission for `web.fetch`: scheme allowlist (https
 * only — plaintext http is refused outright, not merely discouraged) plus
 * the SSRF address check above. Thrown failures are the caller's typed
 * refusal vocabulary.
 */
export async function admitGovernedWebUrl(rawUrl: string, request: NativeToolRequest, policy: GovernedNetworkPolicy, resolve: typeof dnsLookup): Promise<FetchPolicyResult> {
  if (!request.network_allowed) throw failure("semantic", "network_not_authorized", "this request has no network authorization");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw failure("semantic", "url_invalid", "url must be an absolute, well-formed URL");
  }
  if (parsed.protocol !== "https:") throw failure("semantic", "scheme_denied", `url scheme must be https:, got ${parsed.protocol}`);
  if (parsed.username !== "" || parsed.password !== "") throw failure("semantic", "url_invalid", "url must not carry userinfo credentials");
  if (parsed.port !== "" && parsed.port !== "443" && parsed.port !== "80") throw failure("semantic", "port_denied", "url port is not permitted by the governed web policy");
  parsed.hash = "";
  const hostname = parsed.hostname.toLowerCase();
  const literalFamily = isIP(hostname);
  // Address literals are checked before policy membership so the audit tells
  // an operator this was an SSRF-shaped target, rather than merely unknown.
  if (literalFamily !== 0 && isPrivateOrReservedAddress(hostname, literalFamily)) throw failure("semantic", "private_address_denied", "url resolves to a private, loopback, or reserved address");
  if (!domainAllowed(hostname, policy)) throw failure("semantic", "domain_denied", "url hostname is not in this request's explicit domain policy");
  const normalizedUrl = parsed.toString();
  if (!authorizationAllowed(policy, request, { url: normalizedUrl, hostname })) throw failure("semantic", "request_not_authorized", "the composed authority did not authorize this web request");
  if (literalFamily !== 0) {
    return { hostname, normalized_url: normalizedUrl, resolved_addresses: [hostname] };
  }
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await resolve(hostname, { all: true, verbatim: true });
  } catch {
    throw failure("execution", "dns_resolution_failed", "url hostname could not be resolved");
  }
  if (addresses.length === 0) throw failure("execution", "dns_resolution_failed", "url hostname resolved to no addresses");
  if (addresses.some((entry) => isPrivateOrReservedAddress(entry.address, entry.family))) {
    throw failure("semantic", "private_address_denied", "url resolves to a private, loopback, or reserved address");
  }
  return { hostname, normalized_url: normalizedUrl, resolved_addresses: addresses.map((entry) => entry.address) };
}

function contentTypeFamily(header: string | null): string | null {
  if (header === null) return null;
  const family = header.split(";")[0]?.trim().toLowerCase();
  return family && ALLOWED_CONTENT_TYPES.includes(family) ? family : null;
}

/** Cheap tag-strip HTML reduction (no HTML-parsing dependency in this tree — see task notes). */
function htmlToReadableText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface WebFetchPortOptions {
  /** Both a domain allowlist and a request-specific authorization are required. */
  readonly policy: GovernedNetworkPolicy;
  /** Injectable for tests; production wiring passes `node:dns/promises`' `lookup`. */
  readonly resolve_hostname?: typeof dnsLookup;
  readonly max_body_bytes?: number;
  readonly timeout_ms?: number;
  /** Injectable transport seam for tests; defaults to the ambient global `fetch`. */
  readonly fetch_impl?: typeof fetch;
}

async function webFetch(options: WebFetchPortOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return webToolResponse("web.fetch", WEB_FETCH_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "web.fetch cancelled before start", "none");
  const maxBodyBytes = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const resolve = options.resolve_hostname ?? dnsLookup;
  const doFetch = options.fetch_impl ?? fetch;
  let url = "";
  try {
    const value = record(request.input);
    url = stringField(value, "url", 8, 2_048);
    if (maxBodyBytes < 1 || maxBodyBytes > DEFAULT_MAX_BODY_BYTES) throw failure("semantic", "body_limit_invalid", "max_body_bytes must be within the governed limit");
    if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw failure("semantic", "timeout_invalid", "timeout_ms must be within the governed limit");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    let admitted = await admitGovernedWebUrl(url, request, options.policy, resolve);
    let response: Response | undefined;
    let redirects = 0;
    for (;;) {
      // Re-resolve immediately before every dial (and every redirect). This
      // catches changed DNS answers before the ambient transport is entered;
      // a transport that can pin a validated address may provide stronger
      // process-level rebinding resistance, which this portable fetch seam
      // deliberately does not claim.
      admitted = await admitGovernedWebUrl(admitted.normalized_url, request, options.policy, resolve);
      try {
        response = await doFetch(admitted.normalized_url, { signal: combined, redirect: "manual", headers: { accept: ALLOWED_CONTENT_TYPES.join(", ") } });
      } catch (error) {
        if (combined.aborted) throw failure("execution", timeoutSignal.aborted ? "fetch_timeout" : "cancelled", timeoutSignal.aborted ? `web.fetch exceeded ${timeoutMs}ms` : "web.fetch cancelled");
        throw failure("execution", "fetch_failed", error instanceof Error ? error.message : "web.fetch transport error");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects++ >= MAX_REDIRECTS) throw failure("semantic", "redirect_limit", `web.fetch exceeded ${MAX_REDIRECTS} redirects`);
      const location = response.headers.get("location");
      if (location === null) throw failure("semantic", "redirect_invalid", "redirect response had no Location header");
      try { admitted = await admitGovernedWebUrl(new URL(location, admitted.normalized_url).toString(), request, options.policy, resolve); }
      catch (error) { throw error; }
    }
    const finalResponse = response!;
    url = admitted.normalized_url;
    const family = contentTypeFamily(finalResponse.headers.get("content-type"));
    if (family === null) {
      return webToolResponse("web.fetch", WEB_FETCH_OUTPUT_BYTES, "refused", "semantic", "content_type_denied", `refused content-type outside the allowlist (${ALLOWED_CONTENT_TYPES.join(", ")})`, "observed", {
        url, status: finalResponse.status, content_type: finalResponse.headers.get("content-type"), redirects,
      });
    }
    const bodyBuffer = await readBoundedBody(finalResponse, maxBodyBytes, combined);
    const rawText = bodyBuffer.bytes.toString("utf8");
    const text = family === "text/html" ? htmlToReadableText(rawText) : rawText;
    const contentHash = sha256(bodyBuffer.bytes);
    if (!finalResponse.ok) {
      return webToolResponse("web.fetch", WEB_FETCH_OUTPUT_BYTES, "failed", "execution", "http_error", `fetch received HTTP ${response.status}`, "observed", {
        url, status: finalResponse.status, bytes: bodyBuffer.bytes.byteLength, content_hash: contentHash, truncated: bodyBuffer.truncated, redirects,
      });
    }
    return webToolResponse("web.fetch", WEB_FETCH_OUTPUT_BYTES, "succeeded", "execution", "ok", `fetched ${url} (${response.status}, ${bodyBuffer.bytes.byteLength} bytes)`, "observed", {
      url, status: finalResponse.status, content_type: family, bytes: bodyBuffer.bytes.byteLength, content_hash: contentHash, truncated: bodyBuffer.truncated, redirects, resolved_addresses: admitted.resolved_addresses, provenance: { tag: "observed", content_hash: contentHash }, text: text.slice(0, 16_384),
    });
  } catch (error) {
    const failed = asFailure(error);
    return webToolResponse("web.fetch", WEB_FETCH_OUTPUT_BYTES, failed.outcome, failed.stage, failed.code, failed.summary, failed.outcome === "refused" ? "none" : "unknown", url ? { url } : {});
  }
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
  if (response.body === null) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal.aborted) throw failure("execution", "cancelled", "web.fetch cancelled while reading response");
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      if (remaining <= 0) { truncated = true; break; }
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (truncated) { try { await reader.cancel(); } catch { /* best-effort */ } }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/**
 * `web.search` provider port. No search API key exists in this environment
 * (task constraint) — this repository ships the seam plus a typed
 * `provider_unconfigured` refusal; wiring a real provider is a config-only
 * follow-up once a key is available (see the design notes for why a
 * key-free scrape provider was evaluated and rejected).
 */
export interface WebSearchProvider {
  readonly provider_id: string;
  /** Governed HTTPS endpoint dialed by the provider, when it performs network I/O. */
  readonly endpoint_url?: string;
  search(query: string, signal: AbortSignal): Promise<WebSearchProviderResult>;
}

export type WebSearchProviderResult =
  | { readonly ok: true; readonly results: readonly { readonly title: string; readonly url: string; readonly snippet: string }[] }
  | { readonly ok: false; readonly code: string; readonly summary: string };

export interface WebSearchPortOptions {
  readonly provider?: WebSearchProvider;
  readonly policy: GovernedNetworkPolicy;
  readonly max_results?: number;
  readonly resolve_hostname?: typeof dnsLookup;
}

/**
 * Compose a real SearXNG JSON provider. The tool host admits `endpoint_url`
 * through the same request-specific domain/SSRF policy as `web.fetch` before
 * this provider is called; this transport then refuses redirects, non-JSON
 * bodies, oversized responses, and malformed result records.
 */
export function createSearxngWebSearchProvider(options: {
  readonly endpoint_url: string;
  readonly fetch_impl?: typeof fetch;
  readonly max_body_bytes?: number;
}): WebSearchProvider {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint_url); } catch { throw new Error("SearXNG endpoint must be an absolute URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("SearXNG endpoint must be credential-free HTTPS");
  const maxBytes = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BODY_BYTES) throw new Error("SearXNG response bound is invalid");
  const doFetch = options.fetch_impl ?? fetch;
  const endpointUrl = endpoint.toString();
  return Object.freeze({
    provider_id: "searxng",
    endpoint_url: endpointUrl,
    async search(query: string, signal: AbortSignal): Promise<WebSearchProviderResult> {
      const url = new URL(endpointUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      let response: Response;
      try { response = await doFetch(url, { signal, redirect: "manual", headers: { accept: "application/json" } }); }
      catch { return { ok: false, code: signal.aborted ? "cancelled" : "search_transport_failed", summary: signal.aborted ? "web.search was cancelled" : "SearXNG request failed" }; }
      if (response.status >= 300 && response.status < 400) return { ok: false, code: "search_redirect_refused", summary: "SearXNG redirects are refused" };
      if (!response.ok) return { ok: false, code: "search_http_error", summary: `SearXNG returned HTTP ${response.status}` };
      if (contentTypeFamily(response.headers.get("content-type")) !== "application/json") return { ok: false, code: "search_content_type_denied", summary: "SearXNG returned a non-JSON response" };
      let body: Buffer;
      try {
        const bounded = await readBoundedBody(response, maxBytes, signal);
        if (bounded.truncated) return { ok: false, code: "search_response_too_large", summary: "SearXNG response exceeded the configured bound" };
        body = bounded.bytes;
      } catch { return { ok: false, code: signal.aborted ? "cancelled" : "search_read_failed", summary: signal.aborted ? "web.search was cancelled" : "SearXNG response could not be read" }; }
      let decoded: unknown;
      try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return { ok: false, code: "search_response_invalid", summary: "SearXNG returned invalid JSON" }; }
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return { ok: false, code: "search_response_invalid", summary: "SearXNG response omitted results" };
      const decodedRecord = decoded as Record<string, unknown>;
      if (!Array.isArray(decodedRecord.results)) return { ok: false, code: "search_response_invalid", summary: "SearXNG response omitted results" };
      const results = decodedRecord.results.slice(0, 50).flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const result = item as Record<string, unknown>;
        if (typeof result.title !== "string" || typeof result.url !== "string") return [];
        const snippet = typeof result.content === "string" ? result.content : "";
        return [{ title: result.title, url: result.url, snippet }];
      });
      return { ok: true, results };
    },
  });
}

async function webSearch(options: WebSearchPortOptions, request: NativeToolRequest, signal: AbortSignal): Promise<NativeToolResponse> {
  if (signal.aborted) return webToolResponse("web.search", WEB_SEARCH_OUTPUT_BYTES, "cancelled", "execution", "cancelled", "web.search cancelled before start", "none");
  try {
    const value = record(request.input);
    const query = stringField(value, "query", 1, 512);
    if (options.provider === undefined) {
      return webToolResponse("web.search", WEB_SEARCH_OUTPUT_BYTES, "refused", "semantic", "provider_unconfigured", "no web.search provider is configured; set native.web_search.provider", "none", { config_leaf: "native.web_search.provider" });
    }
    if (!request.network_allowed) throw failure("semantic", "network_not_authorized", "this request has no network authorization");
    if (options.provider.endpoint_url !== undefined) {
      await admitGovernedWebUrl(options.provider.endpoint_url, request, options.policy, options.resolve_hostname ?? dnsLookup);
    } else if (!authorizationAllowed(options.policy, request, { url: "https://search.invalid/", hostname: "search.invalid" })) {
      throw failure("semantic", "request_not_authorized", "the composed authority did not authorize this web request");
    }
    const result = await options.provider.search(query, signal);
    if (!result.ok) {
      return webToolResponse("web.search", WEB_SEARCH_OUTPUT_BYTES, "failed", "execution", result.code, result.summary, "unknown", { provider: options.provider.provider_id });
    }
    const maxResults = Math.min(20, Math.max(1, options.max_results ?? 8));
    const results = result.results.slice(0, maxResults).flatMap((item) => {
      try {
        const parsed = new URL(item.url);
        if (!domainAllowed(parsed.hostname.toLowerCase(), options.policy) || parsed.username || parsed.password || !["https:", "http:"].includes(parsed.protocol)) return [];
        return [{ title: item.title.slice(0, 512), url: parsed.toString(), snippet: item.snippet.slice(0, 2_048) }];
      } catch { return []; }
    });
    return webToolResponse("web.search", WEB_SEARCH_OUTPUT_BYTES, "succeeded", "execution", "ok", `${results.length} result(s) for "${query}"`, "observed", { provider: options.provider.provider_id, results, provenance: { tag: "observed", provider: options.provider.provider_id } });
  } catch (error) {
    const failed = asFailure(error);
    return webToolResponse("web.search", WEB_SEARCH_OUTPUT_BYTES, failed.outcome, failed.stage, failed.code, failed.summary, failed.outcome === "refused" ? "none" : "unknown");
  }
}

/**
 * Composition-root factory, mirroring `createNativeSkillToolPorts`. The
 * caller (`cli.ts`'s `specialist_tools` composition) is the deny-by-default
 * gate: it must only call this when `native.capabilities.web_fetch`/
 * `native.capabilities.web_search` are explicitly `true`, exactly as
 * `image_input` gates the image-capable adapter surface. This factory
 * itself does not read config — it has no admission opinion of its own.
 */
export function createNativeWebToolPorts(options: { readonly fetch?: WebFetchPortOptions; readonly search?: WebSearchPortOptions }): readonly NativeToolPort[] {
  const preflight = (request: NativeToolRequest): NativeToolPreflightResult => request.network_allowed
    ? { allowed: true }
    : { allowed: false, code: "network_not_authorized", reason: "this request has no network authorization", evidence: { outcome: "refused", stage: "semantic", code: "network_not_authorized", effect: "none", confinement: "application_validated", action_scope: NOT_REQUIRED_ACTION_SCOPE } };
  const ports: NativeToolPort[] = [];
  if (options.fetch !== undefined) {
    ports.push(Object.freeze({
      tool: "web.fetch",
      preflight,
      recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => webFetch(options.fetch!, request, signal),
    }));
  }
  if (options.search !== undefined) {
    ports.push(Object.freeze({
      tool: "web.search",
      preflight,
      recovery_protection: () => Object.freeze({ effect_kind: "external" as const, repeatable: true, idempotency_key_hash: null, acknowledged_by: null }),
      execute: (request: NativeToolRequest, _secret: string | null, signal: AbortSignal) => webSearch(options.search!, request, signal),
    }));
  }
  return Object.freeze(ports) as readonly NativeToolPort[];
}
