import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { RemoteRuntimeIngress } from "../remote-ingress.js";
import { RemoteGrantError, RemoteOperationTokenAuthority } from "./ephemeral-token.js";
import { RemoteResultReconciler, type RemoteResultClaim } from "./remote-reconcile.js";
import type { BoundRemoteTransportAddress, BoundRemoteTransportHost } from "./transport-contract.js";
import { parseIJson, remoteTransportError, type RemoteTransportErrorCode } from "../remote-transport-contracts.js";

export interface AuthenticatedRemoteHttpOptions { enabled?: boolean; host: string; port: number; allow_wildcard_bind?: boolean; tls?: { key: string | Buffer; cert: string | Buffer }; max_request_bytes?: number; max_response_bytes?: number; max_in_flight_requests?: number }

/** Explicitly composed single-tenant HTTP host; disabled until `enabled: true`. */
export class AuthenticatedRemoteHttpHost implements BoundRemoteTransportHost {
  private server: Server | null = null; private inFlight = 0;
  private readonly maxRequest: number; private readonly maxResponse: number; private readonly maxInFlight: number;
  constructor(private readonly ingress: RemoteRuntimeIngress, private readonly tokens: RemoteOperationTokenAuthority, private readonly reconciler: RemoteResultReconciler, private readonly options: AuthenticatedRemoteHttpOptions) {
    if (!options.host.trim() || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("remote listener requires an explicit host and valid port");
    if (["0.0.0.0", "::"].includes(options.host) && options.allow_wildcard_bind !== true) throw new Error("remote wildcard bind requires explicit allow_wildcard_bind");
    if (!["127.0.0.1", "::1", "localhost"].includes(options.host) && options.tls === undefined) throw new Error("non-loopback remote listener requires TLS key and certificate");
    this.maxRequest = bounded(options.max_request_bytes, 64 * 1024, 1024, 1024 * 1024); this.maxResponse = bounded(options.max_response_bytes, 256 * 1024, 1024, 4 * 1024 * 1024); this.maxInFlight = bounded(options.max_in_flight_requests, 8, 1, 1024);
  }
  start(): Promise<BoundRemoteTransportAddress> {
    if (this.options.enabled !== true) return Promise.reject(new Error("remote HTTP listener is disabled; explicit opt-in is required"));
    if (this.server) return Promise.reject(new Error("remote HTTP listener is already started"));
    this.server = this.options.tls === undefined ? createServer((request, response) => void this.handle(request, response)) : createHttpsServer(this.options.tls, (request, response) => void this.handle(request, response));
    return new Promise((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port, this.options.host, () => { const address = this.server!.address(); if (!address || typeof address === "string") return reject(new Error("remote listener address is unavailable")); resolve({ host: this.options.host, port: address.port, protocol: this.options.tls === undefined ? "http:" : "https:" }); }); });
  }
  stop(): Promise<void> { const server = this.server; this.server = null; if (!server) return Promise.resolve(); return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" }, this.maxResponse);
    if (this.inFlight >= this.maxInFlight) return send(response, 429, remoteTransportError("rate_limited", "remote listener in-flight request limit is reached"), this.maxResponse);
    this.inFlight++;
    try {
      const match = /^\/v1\/sessions\/([^/]+)\/(commands|results)$/.exec(request.url ?? ""); if (!match) return send(response, 404, { error: "not_found" }, this.maxResponse);
      const token = bearer(request.headers.authorization); if (!token) return send(response, 401, remoteTransportError("authentication_failed", "remote listener requires a bearer operation grant"), this.maxResponse);
      const body = await readJson(request, this.maxRequest); const session = decodeURIComponent(match[1]!); const operation = operationId(body); const campaign = campaignId(body);
      if (!operation || !campaign) return send(response, 400, remoteTransportError("malformed_envelope", "request is missing an operation_id or campaign_id"), this.maxResponse);
      const capability = match[2] === "commands" ? "command.dispatch" as const : "result.submit" as const;
      if (capability === "command.dispatch") {
        const result = await this.ingress.dispatchTransport(body, () => {
          this.tokens.verifyAndConsume(token, { session_id: session, campaign_id: campaign, operation_id: operation, capability });
        });
        return send(response, result.ok ? 200 : 403, result, this.maxResponse);
      }
      this.tokens.verifyAndConsume(token, { session_id: session, campaign_id: campaign, operation_id: operation, capability });
      const result = await this.reconciler.reconcile(body as RemoteResultClaim, session); return send(response, 200, { ok: true, value: result }, this.maxResponse);
    } catch (error) {
      if (error instanceof BodyError) return send(response, error.status, remoteTransportError(error.code, error.summary), this.maxResponse);
      if (error instanceof RemoteGrantError) return send(response, error.code === "consent_required" ? 409 : error.code === "authorization_denied" ? 403 : 401, { error: error.code, summary: error.message }, this.maxResponse);
      return send(response, 500, remoteTransportError("internal_error", "remote listener failed to complete the request"), this.maxResponse);
    } finally { this.inFlight--; }
  }
}
export function createAuthenticatedRemoteHttpHost(ingress: RemoteRuntimeIngress, tokens: RemoteOperationTokenAuthority, reconciler: RemoteResultReconciler, options: AuthenticatedRemoteHttpOptions): AuthenticatedRemoteHttpHost { return new AuthenticatedRemoteHttpHost(ingress, tokens, reconciler, options); }
class BodyError extends Error { constructor(readonly status: number, readonly code: RemoteTransportErrorCode, readonly summary: string) { super(code); } }
/**
 * ADR-041 §2 requires the byte boundary to reject duplicate JSON members and
 * non-I-JSON numbers *before* the envelope reaches signature verification.
 * `JSON.parse` erases both — a duplicate member silently becomes last-wins and
 * `1e400` becomes `Infinity` — which makes the signed representation ambiguous
 * against a conforming cross-language peer. `parseIJson` is that boundary.
 */
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > limit) throw new BodyError(413, "request_too_large", `request exceeds ${limit} byte listener limit`); chunks.push(bytes); } try { return parseIJson(Buffer.concat(chunks)); } catch (error) { throw new BodyError(400, "malformed_envelope", error instanceof Error ? error.message : "request body is not I-JSON"); } }
function bearer(value: string | undefined): string | null { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value ?? "")?.[1] ?? null; }
function operationId(body: unknown): string | null { if (!record(body)) return null; if (record(body.metadata) && text(body.metadata.operation_id)) return body.metadata.operation_id; return text(body.operation_id) ? body.operation_id : null; }
function campaignId(body: unknown): string | null { if (!record(body)) return null; if (record(body.command) && record(body.command.params) && text(body.command.params.campaign_id)) return body.command.params.campaign_id; return text(body.campaign_id) ? body.campaign_id : null; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); } function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function send(response: ServerResponse, status: number, value: unknown, limit: number): void { const body = JSON.stringify(value); if (Buffer.byteLength(body) > limit) { response.statusCode = 500; response.end('{"error":"response_too_large"}'); return; } response.statusCode = status; response.end(body); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { const actual = value ?? fallback; if (!Number.isSafeInteger(actual) || actual < min || actual > max) throw new Error("remote listener bound is invalid"); return actual; }
