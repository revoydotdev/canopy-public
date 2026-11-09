import { a2aBridgeOption } from "./a2a-bridge.js";
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CapabilityContext, RuntimeEventSubscription } from "@arbor/core";
import { SsePainter } from "@arbor/tui";
import { ArborRuntime } from "./runtime.js";
import { RuntimeCatalogRouter, type RuntimeRouterResult } from "./runtime-catalog.js";
import { projectGateRefusal } from "./gate-refusal-projection.js";
import { buildCampaignsFrame } from "./frame-resource.js";
import { createRepoFlightOperatorClient } from "./repo-flight-director.js";

const SSE_DRAIN_MS = 50;
const SSE_MAX_PENDING = 64;

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface SSEClient {
  response: http.ServerResponse;
  subscription: RuntimeEventSubscription;
  writable: boolean;
}

export class ArborWebUIServer {
  readonly runtime: ArborRuntime;
  /** Anonymous transport retained for read access and explicit junior refusals. */
  private readonly catalog: RuntimeCatalogRouter;
  /** Selected only after possession of the process-generated operator session secret. */
  private readonly operatorCatalog: RuntimeCatalogRouter;
  private bootstrapToken: string | null;
  private readonly operatorSessionToken: string;
  private server: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private assignedPort: number | null = null;
  private sseClients = new Map<http.ServerResponse, SSEClient>();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  /** 4F.5: the SSE backend that paints the same typed Frame the terminal/MCP resource paint. */
  private readonly framePainter = new SsePainter();

  constructor(runtime?: ArborRuntime, options: { readonly bootstrap_token?: string; readonly operator_session_token?: string } = {}) {
    this.runtime = runtime ?? new ArborRuntime();
    this.bootstrapToken = options.bootstrap_token ?? randomBytes(32).toString("base64url");
    this.operatorSessionToken = options.operator_session_token ?? randomBytes(32).toString("base64url");
    // This is an unauthenticated HTTP ingress.  Loopback binding and same-
    // origin checks constrain where requests arrive from; neither establishes
    // who sent one.  Keep the catalog at junior so a request cannot claim an
    // actor or a tier in its JSON body and obtain durable mutation authority.
    // An authenticated Web control plane would be a separately composed
    // transport, just as ADR-084's signed remote-serve ingress is.
    this.catalog = new RuntimeCatalogRouter(this.runtime, { recovery_service: this.runtime.recoveryService ?? undefined,
      caller_tier: "junior",
      // ADR/4D.6: A2A is opt-in and fail-closed — null unless
      // ARBOR_A2A_SIGNING_SECRET is set, leaving a2a.* "unavailable".
      ...a2aBridgeOption() });
    this.operatorCatalog = new RuntimeCatalogRouter(this.runtime, { recovery_service: this.runtime.recoveryService ?? undefined,
      caller_tier: "senior",
      ...a2aBridgeOption() });
  }

  /** Start the HTTP server on the given port (0 = ephemeral). */
  start(port: number, onReady?: () => void): Promise<void> {
    if (this.server !== null || this.stopPromise !== null) throw new Error("WebUI server is already running or stopping");
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server = server;
    // This is a local operator cockpit, not a remote-control API. Anonymous
    // reads remain available, while mutation authority requires the opaque
    // operator session established through the one-use bootstrap URL. Keep
    // both surfaces on loopback; remote authority belongs to ADR-084's signed
    // remote-serve ingress.
    const starting = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.removeListener("listening", onListening);
        server.removeListener("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        if (this.server === server) {
          this.server = null;
          this.assignedPort = null;
        }
        reject(error);
      };
      const onListening = () => {
        cleanup();
        // A stop may have been requested while bind() was pending. Use only
        // the captured server here, and let stop() close it after this promise
        // settles; never publish readiness or install a drain timer then.
        if (this.server !== server || this.stopPromise !== null) {
          resolve();
          return;
        }
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("WebUI server listened without a TCP address"));
          return;
        }
        this.assignedPort = address.port;
        this.startSSEDrain();
        try {
          onReady?.();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      server.once("listening", onListening);
      server.once("error", onError);
      try {
        server.listen(port, "127.0.0.1");
      } catch (error) {
        cleanup();
        if (this.server === server) this.server = null;
        reject(error);
      }
    });
    this.startPromise = starting;
    void starting.then(
      () => { if (this.startPromise === starting) this.startPromise = null; },
      () => { if (this.startPromise === starting) this.startPromise = null; },
    );
    return starting;
  }

  /** Stop the server and wait until its HTTP connections have closed. */
  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;

    const starting = this.startPromise;
    const server = this.server;
    this.server = null;
    this.assignedPort = null;
    if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }

    const errors: unknown[] = [];
    for (const client of [...this.sseClients.values()]) {
      try { this.removeSSEClient(client); } catch (error) { errors.push(error); }
      try { client.response.end(); } catch (error) { errors.push(error); }
    }

    const closing = (async () => {
      // listen() and close() are not interchangeable while a bind is pending:
      // wait until startup either listened or failed before closing the
      // captured server. This also makes concurrent stop() calls share one
      // settled shutdown result.
      if (starting !== null) {
        try { await starting; } catch { /* start() reports its own bind failure */ }
      }
      if (server !== null) {
        try {
          await new Promise<void>((resolve, reject) => {
            if (!server.listening) { resolve(); return; }
            try {
              server.close((error) => error ? reject(error) : resolve());
              // `close()` stops new connections and drains active requests;
              // this also releases idle keep-alive sockets on supported Node
              // versions. SSE responses above are ended before this point.
              server.closeIdleConnections();
            } catch (error) {
              reject(error);
            }
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "WebUI shutdown encountered multiple errors");
    })();
    this.stopPromise = closing;
    void closing.then(
      () => { if (this.stopPromise === closing) this.stopPromise = null; },
      () => { if (this.stopPromise === closing) this.stopPromise = null; },
    );
    return closing;
  }

  getPort(): number | null { return this.assignedPort; }

  /** One-use local bootstrap URL; exchanging it establishes the operator cookie. */
  getOperatorUrl(): string | null {
    return this.assignedPort === null || this.bootstrapToken === null ? null : `http://127.0.0.1:${this.assignedPort}/?operator_token=${encodeURIComponent(this.bootstrapToken)}`;
  }

  /** In-process automation seam carrying the same opaque session a browser cookie carries. */
  operatorRequestHeaders(): Readonly<Record<string, string>> {
    return Object.freeze({ cookie: `arbor_operator=${this.operatorSessionToken}` });
  }

  /** Observable only for transport health/tests; clients remain read-only. */
  getSSEClientCount(): number { return this.sseClients.size; }

  // ---- Routing ----------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Do not make a loopback operator authority callable from an arbitrary
    // browser origin.  The bare HTTP clients used for local automation have
    // no Origin header and remain supported; browser-originated requests
    // must come from this exact dashboard instance.
    if (!this.isSameOriginBrowserRequest(req)) {
      this.forbidden(res, "cross-origin dashboard requests are not permitted");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const parsed = this.parseUrl(url);

    try {
      if (req.method === "GET" && parsed.path === "/" && !parsed.parts.length) {
        const supplied = this.queryValue(url, "operator_token");
        if (supplied !== null) {
          if (this.bootstrapToken === null || !sameSecret(supplied, this.bootstrapToken)) { this.forbidden(res, "operator bootstrap token is invalid or already used"); return; }
          this.bootstrapToken = null;
          res.writeHead(303, { location: "/", "referrer-policy": "no-referrer", "set-cookie": `arbor_operator=${this.operatorSessionToken}; HttpOnly; SameSite=Strict; Path=/` });
          res.end();
          return;
        }
        this.serveIndex(res);
      } else if (req.method === "GET" && parsed.path === "/api/stream") {
        this.handleSSE(req, res);
      } else if (req.method === "GET" && parsed.parts[0] === "api" && parsed.parts[1] === "campaigns" && parsed.parts.length === 2) {
        this.jsonResponse(res, this.runtime.manager.listCampaigns());
      } else if (req.method === "GET" && parsed.parts[0] === "api" && parsed.parts[1] === "campaigns" && parsed.parts.length === 3) {
        const cid = parsed.parts[2];
        const snapshot = this.runtime.manager.getCampaignSnapshot(cid);
        if (!snapshot) { this.notFound(res, `Campaign ${cid} not found`); return; }
        this.jsonResponse(res, snapshot);
      } else if (req.method === "GET" && parsed.parts[0] === "api" && parsed.parts[1] === "campaigns" && parsed.parts.length === 4 && (parsed.parts[3] === "kb" || parsed.parts[3] === "audit" || parsed.parts[3] === "telemetry")) {
        // A campaign that does not exist is a 404 on every sub-resource.
        // Before this guard, /audit and /telemetry answered 200 with
        // all-zero stats for an unknown id (absence rendered as zero) and
        // /kb answered 500 with a stringified exception (audit 2026-08-23,
        // WA-22 / WA-23).
        const cid = parsed.parts[2];
        if (!this.runtime.manager.getCampaignSnapshot(cid)) { this.notFound(res, `Campaign ${cid} not found`); return; }
        if (parsed.parts[3] === "kb") {
          // Critic visibility only behind the operator session (security
          // review 2026-10-06). Any local process can reach this loopback
          // port, so an anonymous caller reads what a specialist may read and
          // never a critic_only entry.
          const cap: CapabilityContext = { tier: this.isOperatorRequest(req) ? "critic" : "specialist" };
          this.jsonResponse(res, this.runtime.manager.kbQuery(cid, null, cap));
        } else if (parsed.parts[3] === "audit") {
          this.jsonResponse(res, { stats: this.runtime.manager.auditCampaign(cid), bypasses: this.runtime.manager.auditBypasses(cid) });
        } else {
          this.jsonResponse(res, this.runtime.manager.projectTelemetry(cid));
        }
      } else if (parsed.parts[0] === "api" && parsed.parts[1] === "campaigns" && parsed.parts.length === 4 && parsed.parts[3] === "interrupt") {
        const cid = parsed.parts[2];
        this.handleInterrupt(req, res, cid);
      } else if (parsed.parts[0] === "api" && parsed.parts.length === 3 && parsed.parts[1] === "runtime" && parsed.parts[2] === "command") {
        if (req.method !== "POST") { this.notFound(res, `Method for /api/runtime/command must be POST`); return; }
        this.readJsonBody(req, res, async (body) => {
          this.jsonResponse(res, await this.catalogForRequest(req).dispatchCommand(toCommandEnvelope(body)), 200);
        });
      } else if (parsed.parts[0] === "api" && parsed.parts.length === 3 && parsed.parts[1] === "runtime" && parsed.parts[2] === "query") {
        const route = (body: unknown) => {
          const envelope = toQueryEnvelope(body);
          const catalog = this.catalogForRequest(req);
          const refusal = catalog === this.catalog ? anonymousDisclosureRefusal(envelope) : null;
          this.jsonResponse(res, refusal ?? catalog.executeQuery(envelope), 200);
        };
        if (req.method === "POST") this.readJsonBody(req, res, route);
        else route(this.readQueryParams(req));
      } else if (parsed.parts[0] === "api" && parsed.parts.length === 3 && parsed.parts[1] === "repo-flight" && parsed.parts[2] === "query") {
        if (!this.isOperatorRequest(req)) { this.forbidden(res, "repo-flight projections require the authenticated operator session"); return; }
        const route = async (body: unknown) => {
          const envelope = toRepoFlightQueryEnvelope(body);
          this.jsonResponse(res, await this.repoFlightClient().query(envelope), 200);
        };
        if (req.method === "POST") this.readJsonBody(req, res, route);
        else if (req.method === "GET") void route(this.readQueryParams(req)).catch((error) => this.errorResponse(res, String(error)));
        else this.notFound(res, "Repo Flight query supports GET or POST");
      } else if (parsed.parts[0] === "api" && parsed.parts.length === 3 && parsed.parts[1] === "repo-flight" && parsed.parts[2] === "command") {
        if (req.method !== "POST") { this.notFound(res, "Repo Flight command must be POST"); return; }
        if (!this.isOperatorRequest(req)) { this.forbidden(res, "repo-flight commands require the authenticated operator session"); return; }
        this.readJsonBody(req, res, async (body) => {
          const envelope = toRepoFlightCommandEnvelope(body);
          this.jsonResponse(res, await this.repoFlightClient().command(envelope, envelope.metadata.idempotency_key), 200);
        });
      } else {
        this.notFound(res, `Not found: ${url}`);
      }
    } catch (err) {
      this.errorResponse(res, String(err));
    }
  }

  private catalogForRequest(req: http.IncomingMessage): RuntimeCatalogRouter {
    return this.isOperatorRequest(req) ? this.operatorCatalog : this.catalog;
  }

  private isOperatorRequest(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("arbor_operator="))?.slice("arbor_operator=".length) ?? null;
    return cookie !== null && sameSecret(cookie, this.operatorSessionToken);
  }

  private repoFlightClient() {
    if (this.runtime.persistenceRoot === null) throw new Error("repo-flight transport is unavailable without durable runtime persistence");
    return createRepoFlightOperatorClient(this.runtime.persistenceRoot);
  }

  private queryValue(url: string, name: string): string | null {
    try { return new URL(url, "http://127.0.0.1").searchParams.get(name); }
    catch { return null; }
  }

  private readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, onBody: (body: unknown) => void | Promise<void>): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); if (body.length > 262_144) { req.destroy(); this.errorResponse(res, "request body too large"); } });
    req.on("end", () => {
      if (!body.trim()) { void Promise.resolve(onBody({})).catch((error) => this.errorResponse(res, String(error))); return; }
      let parsedBody: unknown;
      // Malformed JSON is the client's error (400), not a server failure
      // (500) — audit 2026-08-23, J6-20.
      try { parsedBody = JSON.parse(body); } catch { this.badRequest(res, "invalid JSON body"); return; }
      void Promise.resolve(onBody(parsedBody)).catch((error) => this.errorResponse(res, String(error)));
    });
  }

  private readQueryParams(req: http.IncomingMessage): Record<string, unknown> {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const out: Record<string, unknown> = {};
    if (q < 0) return out;
    for (const part of url.substring(q + 1).split("&").filter(Boolean)) {
      const [k, v] = part.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
    return out;
  }
  private handleInterrupt(req: http.IncomingMessage, res: http.ServerResponse, cid: string): void {
    const route = async (body: { node_id?: string; scope?: "node" | "subtree"; reason?: string; operation_id?: string }) => {
      const nodeId = body.node_id ?? null;
      const snapshot = this.runtime.manager.getCampaignSnapshot(cid);
      if (!snapshot) { this.notFound(res, `Campaign ${cid} not found`); return; }

      // This older convenience route predates the catalog command endpoint.
      // It must not become a senior backdoor merely because it calls the
      // runtime directly.  Feed a complete interruption envelope through the
      // same router as /api/runtime/command; the anonymous Web catalog is
      // junior, so enforceAction refuses it before an operation or tree state
      // can be created.  Request-supplied actor/tier-like fields are ignored.
      const targets = nodeId === null
        ? snapshot.nodes.filter((node) => node.state === "expanding" || node.state === "pending").map((node) => node.id)
        : [nodeId];
      const catalog = this.catalogForRequest(req);
      if (targets.length === 0) {
        if (catalog === this.catalog) { this.jsonResponse(res, { ok: false, error: { code: "permission", summary: "Web interruption requires an authenticated operator session" } }, 200); return; }
        this.jsonResponse(res, { ok: true, affected_node_ids: [], version: this.runtime.manager.getCampaignVersion(cid) }, 200);
        return;
      }
      const affected: string[] = [];
      for (const [index, target] of targets.entries()) {
        const operation = body.operation_id === undefined ? `webui-interrupt-${cid}-${target}` : `${body.operation_id}:${index}`;
        const result = await catalog.dispatchCommand({
          schema_version: 1,
          metadata: {
            operation_id: operation,
            idempotency_key: `${operation}:key`,
            correlation_id: operation,
            actor_id: catalog === this.operatorCatalog ? "webui-operator-session" : "unauthenticated-web",
            requested_at: new Date().toISOString(),
            expected_version: this.runtime.manager.getCampaignVersion(cid),
          },
          command: {
            kind: "tree.interrupt" as const,
            campaign_id: cid,
            node_id: target,
            scope: body.scope ?? "subtree",
            reason: body.reason ?? "webui_operator",
            provenance: { tag: "generated" as const, generator: "arbor-webui", input_hash: `interrupt:${cid}:${target}` },
          },
        });
        if (!result.ok || result.value.accepted !== true) {
          const error = result.ok ? (result.value as { error?: { code: string; summary: string } }).error : result.error;
          this.jsonResponse(res, { ok: false, error: error ?? { code: "permission", summary: "interruption was refused" } }, 200);
          return;
        }
        affected.push(target);
      }
      this.jsonResponse(res, { ok: true, affected_node_ids: affected, version: this.runtime.manager.getCampaignVersion(cid) }, 202);
    };

    if (req.method === "GET") {
      const snapshot = this.runtime.manager.getCampaignSnapshot(cid);
      if (!snapshot) { this.notFound(res, `Campaign ${cid} not found`); return; }
      const interruptible = snapshot.nodes.filter((n) => n.state === "expanding" || n.state === "pending").map((n) => n.id);
      this.jsonResponse(res, { campaign_id: cid, interruptible_node_ids: interruptible });
      return;
    }

    if (req.method !== "POST") { this.notFound(res, `Method ${req.method ?? ""} not allowed for /api/campaigns/${cid}/interrupt`); return; }

    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); if (body.length > 64_384) { req.destroy(); this.errorResponse(res, "request body too large"); } });
    req.on("end", () => {
      let parsed: { node_id?: string; scope?: "node" | "subtree"; reason?: string; operation_id?: string } = {};
      if (body.trim()) {
        try { parsed = JSON.parse(body) as typeof parsed; } catch { this.badRequest(res, "invalid JSON body"); return; }
      }
      void route(parsed).catch((error) => this.errorResponse(res, String(error)));
    });
  }

  private parseUrl(url: string): { path: string; parts: string[] } {
    const q = url.indexOf("?");
    const path = q >= 0 ? url.substring(0, q) : url;
    const parts = path.split("/").filter(Boolean);
    return { path, parts };
  }

  private isSameOriginBrowserRequest(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const port = this.assignedPort;
    if (port === null) return false;
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }

  // ---- SSE --------------------------------------------------------

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":\n"); // establish the stream before data frames
    const client: SSEClient = {
      response: res,
      subscription: this.runtime.eventStream.subscribe({ max_pending: SSE_MAX_PENDING }),
      writable: true,
    };
    this.sseClients.set(res, client);
    res.on("drain", () => { client.writable = true; this.drainClient(client); });
    res.on("close", () => { this.removeSSEClient(client); });
    req.on("aborted", () => { this.removeSSEClient(client); });
    req.on("close", () => { if (req.destroyed) this.removeSSEClient(client); });

    const lastId = this.parseLastEventId(req);
    if (lastId === null) {
      this.writeSSE(client, "snapshot", this.runtime.snapshot().value);
    } else {
      const resumed = this.runtime.eventStream.resume(
        { stream_id: this.runtime.eventStream.cursor().stream_id, sequence: lastId },
        this.runtime.snapshot().value,
      );
      if (resumed.kind === "events") {
        for (const event of resumed.events) this.writeEvent(client, event);
      } else {
        this.writeSSE(client, "snapshot", resumed.snapshot);
      }
    }
    this.writeFrame(client);
  }

  private startSSEDrain(): void {
    this.drainTimer = setInterval(() => {
      for (const client of [...this.sseClients.values()]) this.drainClient(client);
    }, SSE_DRAIN_MS);
  }

  private drainClient(client: SSEClient): void {
    const status = client.subscription.status();
    if (status.closed) {
      if (status.reason === "backpressure") this.writeSSE(client, "resync", this.runtime.snapshot().value);
      this.removeSSEClient(client);
      client.response.end();
      return;
    }
    if (!client.writable) return;
    for (const event of client.subscription.poll(16)) {
      if (!this.writeEvent(client, event)) break;
    }
  }

  private writeEvent(client: SSEClient, event: unknown): boolean {
    const cursor = typeof event === "object" && event !== null && "cursor" in event
      ? (event as { cursor?: { sequence?: number } }).cursor?.sequence
      : undefined;
    const ok = this.writeSSE(client, "runtime", event, cursor);
    if (ok) this.writeFrame(client);
    return ok;
  }

  /** 4F.5: pushes the same canonical Frame arbor://frame resolves, as an SSE 'frame' event. */
  private writeFrame(client: SSEClient): boolean {
    if (!client.writable || client.response.writableEnded) return false;
    let ok = true;
    this.framePainter.paint(buildCampaignsFrame(this.runtime.manager), {
      write: (value) => { ok = client.response.write(value); },
    });
    client.writable = ok;
    return ok;
  }

  private writeSSE(client: SSEClient, name: string, value: unknown, id?: number): boolean {
    if (!client.writable || client.response.writableEnded) return false;
    const prefix = id === undefined ? "" : `id: ${id}\n`;
    client.writable = client.response.write(`${prefix}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    return client.writable;
  }

  private removeSSEClient(client: SSEClient): void {
    if (!this.sseClients.delete(client.response)) return;
    client.subscription.close();
  }

  private parseLastEventId(req: http.IncomingMessage): number | null {
    const raw = req.headers["last-event-id"];
    const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  // ---- Static serve -------------------------------------------------

  private serveIndex(res: http.ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arbor Dashboard</title>
<style>
:root {
  --bg: #0b1115;
  --surface: #131d22;
  --surface2: #1a282e;
  --text: #edf3ef;
  --muted: #91a5a7;
  --accent: #41b9c4;
  --accent2: #78d5b5;
  --warm: #ef8f72;
  --warn: #e7b85f;
  --fail: #df6676;
  --ok: #70c98f;
  --border: #2a3b42;
  --radius: 8px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
* { box-sizing: border-box; }
body { margin: 0 auto; padding: clamp(16px, 3vw, 36px); max-width: 1320px; line-height: 1.45; background: radial-gradient(circle at 50% -12%, #16343b 0, transparent 38rem), linear-gradient(145deg, #0b1115, #0e171b 55%, #12171d); }
h1 { font-size: clamp(1.5rem, 3vw, 2.2rem); margin: 0; color: var(--accent); letter-spacing: -0.03em; }
.skip-link { position: absolute; left: 12px; top: -64px; padding: 8px 12px; background: var(--accent); color: #fff; border-radius: var(--radius); z-index: 2; }
.skip-link:focus { top: 12px; }
.app-header { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 8px 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.eyebrow { margin: 0 0 4px; color: var(--accent2); font-size: 0.76rem; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase; }
.workspace-nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 18px; }
.workspace-nav a { color: var(--text); border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 5px 10px; font-size: 0.84rem; text-decoration: none; }
.workspace-nav a:hover { border-color: var(--accent); color: var(--accent); }
.workspace { display: grid; gap: 12px; }
.workspace > * { min-width: 0; }
.muted { color: var(--muted); font-size: 0.85rem; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 12px;
}
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 0.9rem; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; }
label { display: block; font-size: 0.85rem; font-weight: 650; margin-top: 10px; }
textarea, input, button { font: inherit; }
textarea { min-height: 108px; resize: vertical; }
button { cursor: pointer; color: var(--text); background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 5px 9px; font-size: 0.84rem; }
button:hover { border-color: var(--accent); color: #fff; }
button:disabled { cursor: not-allowed; opacity: 0.52; }
button.danger:hover { border-color: var(--fail); color: var(--fail); }
button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.78rem; font-weight: 600; }
.badge-halted { background: var(--warn); color: #0f1117; }
.badge-running { background: var(--ok); color: #0f1117; }
.badge-verified { background: var(--accent2); color: #0f1117; }
.badge-failed { background: var(--fail); color: #fff; }
.badge-pending { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
.badge-expanding { background: var(--accent); color: #fff; }
.tree-hero { position: relative; overflow: hidden; padding: clamp(16px, 2.5vw, 30px); border-color: color-mix(in srgb, var(--accent) 44%, var(--border)); background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 90%, #163e42), color-mix(in srgb, var(--bg) 94%, #512f35)); box-shadow: 0 22px 70px rgba(0,0,0,.32); }
.tree-hero::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .22; background-image: linear-gradient(rgba(120,213,181,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(65,185,196,.09) 1px, transparent 1px); background-size: 28px 28px; mask-image: linear-gradient(to bottom, black, transparent 86%); }
.tree-hero-head { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: start; gap: 20px; }
.tree-kicker { color: var(--warm); text-transform: uppercase; letter-spacing: .16em; font: 700 .7rem/1.2 ui-monospace, monospace; }
.tree-title { margin: 4px 0 2px; color: var(--text); font-size: clamp(1.25rem, 2.4vw, 2rem); letter-spacing: -.035em; }
.tree-live { display: inline-flex; align-items: center; gap: 8px; color: var(--accent2); font: 700 .72rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.tree-live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 16%, transparent); animation: node-breathe 1.5s ease-in-out infinite; }
.tree-metrics { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(5, minmax(5rem, 1fr)); gap: 8px; margin: 18px 0 12px; }
.tree-metric { padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: 6px; background: rgba(8,16,19,.58); }
.tree-metric strong, .tree-metric span { display: block; }
.tree-metric strong { font: 700 1.1rem/1.1 ui-monospace, monospace; color: var(--text); }
.tree-metric span { margin-top: 3px; color: var(--muted); font-size: .68rem; text-transform: uppercase; letter-spacing: .09em; }
.tree-progress { position: relative; z-index: 1; height: 5px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.07); }
.tree-progress > span { display: block; width: var(--progress); height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent2), var(--warm)); transition: width 500ms cubic-bezier(.2,.8,.2,1); }
.kinetic-stage { position: relative; z-index: 1; width: 100%; min-height: 290px; margin-top: 8px; overflow: auto hidden; scrollbar-color: var(--border) transparent; }
.kinetic-stage svg { display: block; width: 100%; min-width: 680px; height: auto; overflow: visible; }
.kinetic-edge { fill: none; stroke: #3a555c; stroke-width: 1.5; vector-effect: non-scaling-stroke; transition: stroke 300ms ease, opacity 300ms ease; }
.kinetic-edge.is-active { stroke: var(--accent2); stroke-width: 2.5; stroke-dasharray: 5 8; animation: edge-flow 1s linear infinite; }
.kinetic-edge.is-backtrack { stroke: var(--fail); stroke-width: 2.2; stroke-dasharray: 4 7; animation: edge-reverse .7s linear infinite; }
.kinetic-node .node-core { fill: #17262b; stroke: #60757a; stroke-width: 2; vector-effect: non-scaling-stroke; transition: fill 250ms ease, stroke 250ms ease; }
.kinetic-node text { fill: var(--text); font: 600 12px/1 ui-monospace, monospace; text-anchor: middle; paint-order: stroke; stroke: #0d1619; stroke-width: 3px; stroke-linejoin: round; }
.kinetic-node .node-meta { fill: var(--muted); font-size: 10px; font-weight: 500; }
.kinetic-node.state-verified .node-core { fill: #17372f; stroke: var(--accent2); }
.kinetic-node.state-expanding .node-core, .kinetic-node.state-claimed .node-core { fill: #17333a; stroke: var(--accent); stroke-width: 3; }
.kinetic-node.state-failed .node-core, .kinetic-node.state-interrupted .node-core { fill: #3c2028; stroke: var(--fail); }
.kinetic-node.state-pruned .node-core, .kinetic-node.state-abandoned .node-core { opacity: .55; stroke-dasharray: 3 4; }
.kinetic-node.is-active .node-ring { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 4 5; transform-box: fill-box; transform-origin: center; animation: orbit 4s linear infinite; }
.kinetic-node.is-new .node-motion { animation: node-arrive 560ms cubic-bezier(.18,.8,.2,1) both; }
.kinetic-node.is-changed .node-core { animation: state-flare 700ms ease-out; }
.trajectory-list { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 7px; max-height: 210px; overflow: auto; margin: 12px 0 0; padding: 0; list-style: none; }
.trajectory-list li { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 8px 9px; border: 1px solid var(--border); border-radius: 5px; background: rgba(9,16,19,.66); font-size: .78rem; }
.trajectory-list .node-index { color: var(--muted); font: 600 .67rem/1 ui-monospace, monospace; }
.trajectory-list .node-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trajectory-list .node-telemetry { color: var(--muted); font: 500 .67rem/1 ui-monospace, monospace; }
.tree-node { padding: 3px 0 3px 20px; font-size: 0.85rem; border-left: 1px solid var(--border); margin-left: 8px; }
.tree-node .score { color: var(--muted); font-size: 0.8rem; margin-left: 8px; }
.node-list { max-height: 400px; overflow-y: auto; }
.pulse { animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes edge-flow { to { stroke-dashoffset: -26; } }
@keyframes edge-reverse { to { stroke-dashoffset: 22; } }
@keyframes orbit { to { transform: rotate(360deg); } }
@keyframes node-breathe { 50% { opacity: .45; transform: scale(.72); } }
@keyframes node-arrive { from { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(.25); } to { opacity: 1; transform: translate(0,0) scale(1); } }
@keyframes state-flare { 0% { filter: drop-shadow(0 0 0 transparent); } 35% { filter: drop-shadow(0 0 10px var(--accent2)); } 100% { filter: drop-shadow(0 0 0 transparent); } }
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot-ok { background: var(--ok); }
.dot-warn { background: var(--warn); }
.dot-fail { background: var(--fail); }
#ts { color: var(--muted); font-size: 0.8rem; }
pre { background: var(--surface2); padding: 12px; border-radius: var(--radius); overflow-x: auto; font-size: 0.82rem; max-height: 300px; overflow-y: auto; }
.section-title { font-size: 1rem; margin: 0 0 4px; color: var(--accent2); }
.table-scroll { overflow-x: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: var(--radius); }
.table-scroll table { min-width: 760px; margin: 0; }
.campaign-card { display: block; width: 100%; text-align: left; padding: 15px; margin-bottom: 12px; background: var(--surface); }
.campaign-card:focus-visible { position: relative; z-index: 1; }
.result-summary { max-width: 34rem; }
.diff-review { border-left: 3px solid var(--accent2); max-height: 440px; white-space: pre; }
.adoption-notice { margin-top: 12px; padding: 10px; border: 1px solid var(--warn); border-radius: var(--radius); background: color-mix(in srgb, var(--warn) 9%, var(--surface)); }
.file-adoption { display: grid; gap: 6px; margin: 12px 0; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.file-adoption legend { padding: 0 5px; color: var(--accent2); font-size: 0.9rem; font-weight: 650; }
.file-adoption label { display: flex; align-items: start; gap: 8px; margin: 0; font-weight: 400; overflow-wrap: anywhere; }
.file-adoption input { margin-top: 4px; accent-color: var(--accent); }
.session-row-selected td { background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
.session-facts { display: grid; grid-template-columns: minmax(9rem, 0.32fr) 1fr; gap: 5px 14px; margin: 12px 0; font-size: 0.88rem; }
.session-facts dt { color: var(--muted); }
.session-facts dd { margin: 0; overflow-wrap: anywhere; }
.session-events { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }
.session-events li { padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface2); }
.session-events summary { cursor: pointer; overflow-wrap: anywhere; }
.live-session-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; margin: 12px 0; }
.live-session-controls select { min-width: 0; color: var(--text); background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; }
.live-session-steer { display: grid; gap: 8px; margin-top: 12px; }
.live-session-steer textarea { min-height: 78px; width: 100%; }
.live-session-log { max-height: 320px; overflow: auto; overscroll-behavior: contain; }
.live-session-log li { overflow-wrap: anywhere; }
.setup-checklist { display: grid; gap: 9px; margin: 14px 0 0; padding: 0; list-style: none; }
.setup-checklist li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 10px; align-items: start; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface2); }
.setup-state { display: inline-block; min-width: 4.9rem; padding: 2px 7px; border-radius: 999px; font-size: 0.74rem; font-weight: 700; text-align: center; text-transform: uppercase; letter-spacing: 0.04em; }
.setup-detected { color: #0f1117; background: var(--ok); }
.setup-missing { color: #fff; background: var(--fail); }
.setup-manual { color: #0f1117; background: var(--warn); }
.setup-command { display: inline-block; margin-top: 5px; padding: 2px 5px; border-radius: 3px; background: var(--bg); color: var(--accent2); overflow-wrap: anywhere; }
.attention-list { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }
.attention-list li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 10px; border-left: 3px solid var(--warn); background: var(--surface2); }
.operation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 12px; }
.operation-card { padding: 13px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface2); }
.operation-card h3 { margin: 0 0 5px; color: var(--accent2); font-size: 0.95rem; }
.operation-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.operation-facts { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 0.86rem; }
.operation-facts li { overflow-wrap: anywhere; }
.unavailable { border-left: 3px solid var(--warn); padding-left: 9px; }
.session-filter { width: min(100%, 30rem); padding: 7px 9px; color: var(--text); background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; }
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 8px; margin-top: 10px; }
.metric { padding: 9px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); }
.metric strong, .metric span { display: block; overflow-wrap: anywhere; }
.metric span { color: var(--muted); font-size: 0.77rem; }
.evidence-facts { display: grid; grid-template-columns: minmax(10rem, 0.4fr) 1fr; gap: 5px 14px; margin: 12px 0; font-size: 0.88rem; }
.evidence-facts dt { color: var(--muted); }
.evidence-facts dd { margin: 0; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.hidden { display: none; }
@media (max-width: 700px) {
  .app-header { align-items: start; flex-direction: column; gap: 6px; }
  .workspace-nav { margin-top: 10px; }
  .card { padding: 13px; }
  th, td { padding: 6px 8px; }
  .campaign-card { min-height: 74px; }
  .session-facts { grid-template-columns: 1fr; gap: 2px; }
  .evidence-facts { grid-template-columns: 1fr; gap: 2px; }
  .live-session-controls { grid-template-columns: 1fr; align-items: stretch; }
  .operation-grid { grid-template-columns: 1fr; }
  .tree-hero-head { display: block; }
  .tree-live { margin-top: 10px; }
  .tree-metrics { grid-template-columns: repeat(2, 1fr); }
  .kinetic-stage { min-height: 250px; }
}
@media (prefers-reduced-motion: reduce) {
  .pulse, .tree-live::before, .kinetic-edge, .kinetic-node .node-ring, .kinetic-node .node-motion, .kinetic-node .node-core { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<a class="skip-link" href="#workspace">Skip to workspace</a>
<header class="app-header">
  <div><p class="eyebrow">Arbor / governed operations</p><h1>Operator workspace</h1><p class="muted">Plan deliberately, stop work safely, review result captures, then adopt only through explicit runtime authority.</p></div>
  <p id="ts" class="muted" role="status" aria-live="polite"></p>
</header>
<nav class="workspace-nav" aria-label="Workspace sections">
  <a href="#guided-setup">Setup</a><a href="#attention">Attention</a><a href="#task-composer">Planning</a><a href="#campaigns">Campaigns</a><a href="#results-workspace">Result captures</a><a href="#system-operations">Operations</a><a href="#flight-control">Flight control</a><a href="#live-session">Live session</a><a href="#interviews">Interviews</a><a href="#harness-evaluations">Evaluations</a><a href="#governance-panel">Governance</a><a href="#operator-read-panels">Read panels</a><a href="#operator-mutating-panel">Operator actions</a>
</nav>
<main id="workspace" class="workspace">
<div id="detail" class="hidden"></div>
<section id="guided-setup" aria-label="First-run setup"></section>
<section id="attention" aria-label="Operator attention" aria-live="polite"></section>
<section id="task-composer" aria-label="Task planning"></section>
<section id="campaigns" aria-label="Campaigns"></section>
<section id="results-workspace" aria-label="Result captures"></section>
<div id="result-detail" class="hidden"></div>
<section id="system-operations" aria-label="System operations"></section>
<section id="flight-control" aria-label="Distributed flight control"></section>
<div id="detail-kb" class="hidden"></div>
<div id="detail-audit" class="hidden"></div>
<section id="native-config" aria-label="Native harness"></section>
<section id="native-readiness" aria-label="Native readiness"></section>
<section id="campaign-spend" aria-label="Campaign budget"></section>
<section id="harness-connectors" aria-label="Harness connectors"></section>
<section id="harness-sessions" aria-label="Harness sessions"></section>
<div id="harness-detail" class="hidden"></div>
<section id="live-session" aria-label="Live session attach and steering"></section>
<section id="interviews" aria-label="Governed interviews"></section>
<section id="harness-evaluations" aria-label="Harness evaluations"></section>
<div id="harness-evaluation-detail" class="hidden"></div>
<section id="governance-panel" aria-label="Governance"></section>
<section id="operator-read-panels" aria-label="Operator read panels">
  <div class="card"><h2 class="section-title">Operator read panels</h2><p class="muted">Read-only projections for operator-facing capabilities that have no dedicated control here yet.</p>
  <div id="output-captures-panel"></div>
  <div id="capability-catalog-panel"></div>
  <div id="surveillance-findings-panel"></div>
  <div id="communications-panel"></div>
  <div id="subagent-executions-panel"></div>
  </div>
</section>
<section id="operator-mutating-panel" aria-label="Operator actions">
  <div class="card"><h2 class="section-title">Operator actions</h2><p class="muted">Governed mutating controls the TUI already exposes as operator forms (job submission, output-evidence capture, sibling spawning) plus an on-demand surveillance scan. Every submission runs through the same runtime validator and command router as every other control on this page.</p>
  <p id="mutating-operation-status" role="status" aria-live="polite"></p>
  <form onsubmit="submitJobForm(event)"><h3>Submit job</h3><label>Campaign id (owner scope)<input name="owner_scope_id" required maxlength="256"></label><label>Job kind<input name="job_kind" required maxlength="256" placeholder="e.g. liveness.noop"></label><button type="submit">Submit job</button></form>
  <form onsubmit="captureOutputForm(event)"><h3>Capture output evidence</h3><label>Campaign id<input name="campaign_id" required maxlength="256"></label><label>Node id<input name="node_id" required maxlength="256"></label><label>Stream<select name="stream"><option value="stdout">stdout</option><option value="stderr">stderr</option><option value="model">model</option><option value="transcript">transcript</option><option value="other">other</option></select></label><label>Media type<input name="media_type" required value="text/plain" maxlength="256"></label><label>Content<textarea name="content" required maxlength="65536"></textarea></label><button type="submit">Capture output</button></form>
  <form onsubmit="spawnSiblingForm(event)"><h3>Spawn sibling</h3><label>Campaign id<input name="campaign_id" required maxlength="256"></label><label>Parent node id<input name="parent_node_id" required maxlength="256"></label><label>Action description<input name="description" required maxlength="1024"></label><label>Category<input name="category" required maxlength="128"></label><label>Delegate to<input name="delegate_to" required maxlength="128"></label><label>Estimated gain<input name="estimated_gain" type="number" step="any" required value="0"></label><label>Estimated cost<input name="estimated_cost" type="number" step="any" required value="0"></label><button class="danger" type="submit">Spawn sibling</button></form>
  <form onsubmit="runSurveillanceScanForm(event)"><h3>Run surveillance scan</h3><label>Campaign id<input name="campaign_id" required maxlength="256"></label><button type="submit">Run scan</button></form>
  </div>
</section>
</main>

<script>
const api = (p) => fetch(p).then(r => r.ok ? r.json() : Promise.reject(r.status));
const $ = (s) => document.querySelector(s);
const esc = (s) => (String(s ?? '')).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const runtimeQuery = (kind, params = {}) => fetch('/api/runtime/query', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({kind, ...params}) })
  .then(r => r.ok ? r.json() : Promise.reject(r.status)).then(r => { if (!r.ok) throw new Error(r.error?.summary ?? 'runtime query failed'); return r.value; });
let runtimeOperationSequence = 0;
const pendingResultAdoptions = new Set();
const pendingResultReverts = new Set();
const resultAdoptionReviews = new Map();
const resultAdoptionReceipts = new Map();
let selectedHarnessSessionId = null;
let latestHarnessSessionView = null;
let selectedLiveSessionId = null;
let liveSessionTailCursor = 0;
let liveSessionTailTimer = null;
let latestTaskDrafts = [];
let taskComposerDraftText = '';
let taskComposerTier = 'auto';
let taskComposerSubmitPending = false;
const TASK_COMPOSER_MAX_ATTACHMENT_FILES = 4;
const TASK_COMPOSER_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const TASK_COMPOSER_MAX_DOCUMENT_BYTES = 256 * 1024;
const taskComposerAttachmentTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/markdown', 'application/json']);
const taskComposerTextExtensions = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|c|h|cpp|hpp|sh|sql|graphql|gql)$/i;
let taskComposerAttachmentFiles = [];
let taskComposerAttachmentNames = [];
let taskComposerAttachmentError = '';
let taskComposerDetail = null;
let browserAttentionEnabled = false;
const announcedAttention = new Set();
let selectedCampaignDetailId = null;
const kineticTreeHistory = new Map();
let detailRefreshPending = false;
const nextRuntimeOperationId = (kind) => {
  runtimeOperationSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return 'webui:'+kind+':'+Date.now().toString(36)+':'+runtimeOperationSequence.toString(36)+':'+random;
};
const runtimeCommand = (kind, params = {}) => {
  const stamp = nextRuntimeOperationId(kind);
  return fetch('/api/runtime/command', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ kind, ...params, metadata: {operation_id:stamp, idempotency_key:stamp, correlation_id:stamp, actor_id:'webui-operator', requested_at:new Date().toISOString()} }) })
    .then(r => r.ok ? r.json() : Promise.reject(r.status)).then(r => { if (!r.ok || r.value?.accepted === false) throw new Error(r.error?.summary ?? r.value?.error?.summary ?? 'runtime command failed'); return r.value; });
};
const sessionArg = (id) => encodeURIComponent(String(id)).replace(/'/g, '%27');
function workspaceStatus(message, failed = false) {
  const target = document.getElementById('ts');
  if (!target) return;
  target.textContent = message;
  target.style.color = failed ? 'var(--fail)' : '';
}
// S2: durable state/status enums (node states, task-draft statuses, halt
// reasons, ...) are snake_case wire values, not display copy — render them
// as "awaiting review" rather than the raw "awaiting_review".
const humanizeEnum = (s) => String(s ?? '').replace(/_/g, ' ');

function badge(s) {
  const cls = 'badge-' + (s === 'verified' ? 'verified' : s === 'failed' ? 'failed' : s === 'expanding' ? 'expanding' : 'pending');
  return '<span class="badge '+cls+'">'+esc(humanizeEnum(s))+'</span>';
}

// ---- Live session attach / steer ---------------------------------
// This panel is a thin projection of the catalog's attach/steer contracts.
// It never fabricates liveness or writes to a terminal session: attach is the
// authority for both the bounded event cursor and control availability.
function liveSessionStatus(message, failed = false) {
  const target = document.getElementById('live-session-status');
  if (target) { target.textContent = message; target.style.color = failed ? 'var(--fail)' : ''; }
}
function liveSessionOptionId(value) { return sessionArg(String(value)); }
function renderLiveSessionPanel(sessions, attached = null) {
  const target = document.getElementById('live-session');
  if (!target) return;
  const live = Array.isArray(sessions) ? sessions.filter((session) => session?.attachable === true) : [];
  const activeId = attached?.session?.session_id || selectedLiveSessionId;
  const terminal = attached?.session?.terminal !== null && attached?.session?.terminal !== undefined;
  const steerable = attached?.live === true && !terminal;
  let h = '<div class="card"><h2 class="section-title">Live session</h2><p class="muted">Attach to a live worker for a bounded redacted event tail. Steering is queued to the worker and never rewrites its history.</p>';
  if (!live.length && !attached) {
    h += '<p class="muted">No live sessions are available to attach.</p><p id="live-session-status" role="status" aria-live="polite"></p></div>';
    target.innerHTML = h;
    return;
  }
  h += '<div class="live-session-controls"><label for="live-session-select">Live worker<select id="live-session-select" onchange="attachLiveSession(this.value, true)">';
  h += '<option value="">Select a live session</option>';
  for (const session of live) {
    const id = String(session.session_id || '');
    h += '<option value="'+esc(id)+'"'+(id === activeId ? ' selected' : '')+'>'+esc(id)+' ('+esc(humanizeEnum(session.state || 'running'))+')</option>';
  }
  h += '</select></label><button type="button" onclick="refreshLiveSessionPanel()">Refresh live sessions</button></div>';
  if (attached) {
    const session = attached.session || {};
    const events = Array.isArray(attached.events) ? attached.events : [];
    h += '<dl class="session-facts"><dt>Session</dt><dd>'+esc(session.session_id)+'</dd><dt>State</dt><dd>'+esc(humanizeEnum(session.state))+'</dd><dt>Tail cursor</dt><dd>'+esc(attached.next_after_sequence)+'</dd><dt>Queued steering</dt><dd>'+esc(attached.pending_steering)+'</dd></dl>';
    if (terminal) h += '<p class="adoption-notice" role="status">This session is terminal. Its tail remains available, but steering is disabled.</p>';
    else if (!attached.live) h += '<p class="adoption-notice" role="status">This session is no longer live in this runtime. Steering is disabled.</p>';
    h += '<form class="live-session-steer" onsubmit="submitLiveSessionSteering(event)"><label for="live-session-message">Steer worker<textarea id="live-session-message" maxlength="8192" required '+(steerable ? '' : 'disabled')+' aria-describedby="live-session-steer-help"></textarea></label><span id="live-session-steer-help" class="muted">A bounded operator message is queued for the live worker; secrets are redacted by the runtime.</span><div><button type="submit" '+(steerable ? '' : 'disabled')+'>Queue steering</button></div></form>';
    h += '<h3 class="section-title">Attached event tail</h3><ol class="session-events live-session-log" aria-live="polite">';
    h += events.length ? events.map((event) => '<li><strong>#'+esc(event.sequence)+' '+esc(humanizeEnum(event.kind))+'</strong><br><span class="muted">'+esc(event.occurred_at)+'</span><details><summary>Redacted event detail</summary><pre>'+esc(JSON.stringify(event.payload, null, 2))+'</pre></details></li>').join('') : '<li class="muted">No new events in this bounded tail.</li>';
    h += '</ol>';
  }
  h += '<p id="live-session-status" role="status" aria-live="polite"></p></div>';
  target.innerHTML = h;
}
async function refreshLiveSessionPanel() {
  try {
    const value = await runtimeQuery('harness.session.list', {limit:100});
    renderLiveSessionPanel(value?.sessions || []);
    if (selectedLiveSessionId) await attachLiveSession(selectedLiveSessionId, false, value?.sessions || []);
  } catch (error) { liveSessionStatus('Unable to load live sessions: '+String(error), true); }
}
async function attachLiveSession(sessionId, resetCursor = true, sessions = null) {
  if (!sessionId) return;
  if (resetCursor || selectedLiveSessionId !== sessionId) { selectedLiveSessionId = sessionId; liveSessionTailCursor = 0; }
  try {
    const attached = await runtimeQuery('harness.session.attach', {session_id:sessionId, after_sequence:liveSessionTailCursor, limit:50});
    liveSessionTailCursor = Number(attached.next_after_sequence || liveSessionTailCursor);
    renderLiveSessionPanel(sessions || (await runtimeQuery('harness.session.list', {limit:100}))?.sessions || [], attached);
  } catch (error) { liveSessionStatus('Unable to attach to this session: '+String(error), true); }
}
async function submitLiveSessionSteering(event) {
  event.preventDefault();
  const input = document.getElementById('live-session-message');
  const message = input?.value?.trim() || '';
  if (!selectedLiveSessionId || !message) { liveSessionStatus('Choose a live session and enter a steering message.', true); return; }
  try {
    await runtimeCommand('harness.session.steer', {session_id:selectedLiveSessionId, message, provenance:{tag:'claimed', claimant:'webui-operator'}});
    liveSessionStatus('Steering message queued for the live worker.');
    await attachLiveSession(selectedLiveSessionId, false);
  } catch (error) { liveSessionStatus('Steering was not queued: '+String(error), true); }
}
refreshLiveSessionPanel();
liveSessionTailTimer = window.setInterval(() => { if (selectedLiveSessionId) void attachLiveSession(selectedLiveSessionId, false); }, 5000);

// ---- Governed task composer ---------------------------------------
// This is only a local projection/control over the canonical catalog.  It
// does not expose artifacts, raw model text, credentials, or a direct campaign
// start path; a task remains a draft until the manager admits its reviewed
// proposal through taskcomposer.confirm.
function taskComposerStatus(message, failed = false) {
  const target = document.getElementById('task-composer-status');
  if (target) { target.textContent = message; target.style.color = failed ? 'var(--fail)' : ''; }
}
function taskComposerAttachmentIssue(files) {
  if (files.length > TASK_COMPOSER_MAX_ATTACHMENT_FILES) return 'Choose no more than '+TASK_COMPOSER_MAX_ATTACHMENT_FILES+' files.';
  for (const file of files) {
    const textDocument = taskComposerTextExtensions.test(file.name) && (!file.type || file.type.startsWith('text/') || file.type === 'application/json');
    if (!taskComposerAttachmentTypes.has(file.type) && !textDocument) return 'Only PNG, JPEG, GIF, WebP, and bounded UTF-8 text/source documents are supported.';
    if (textDocument && file.size > TASK_COMPOSER_MAX_DOCUMENT_BYTES) return 'Each text document must be 256 KiB or smaller.';
    if (!textDocument && file.size > TASK_COMPOSER_MAX_ATTACHMENT_BYTES) return 'Each image must be 5 MiB or smaller.';
  }
  return '';
}
function renderTaskComposerAttachmentState() {
  const selected = document.getElementById('task-composer-attachment-selection');
  const error = document.getElementById('task-composer-attachment-error');
  if (selected) selected.textContent = taskComposerAttachmentNames.length
    ? taskComposerAttachmentNames.length+' file'+(taskComposerAttachmentNames.length === 1 ? '' : 's')+' selected: '+taskComposerAttachmentNames.join(', ')
    : 'No files selected.';
  if (error) error.textContent = taskComposerAttachmentError;
}
function selectTaskComposerAttachments(input) {
  const files = Array.from(input?.files || []);
  const issue = taskComposerAttachmentIssue(files);
  if (issue) {
    taskComposerAttachmentFiles = [];
    taskComposerAttachmentNames = [];
    taskComposerAttachmentError = issue;
    if (input) input.value = '';
    renderTaskComposerAttachmentState();
    return;
  }
  taskComposerAttachmentFiles = files;
  taskComposerAttachmentNames = files.map((file) => file.name);
  taskComposerAttachmentError = '';
  if (files.length) {
    taskComposerTier = 'governed';
    const tier = document.getElementById('task-composer-tier');
    if (tier) tier.value = 'governed';
  }
  renderTaskComposerAttachmentState();
}
function encodeTaskComposerAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read '+file.name));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0 || !result.slice(separator + 1)) { reject(new Error('Unable to encode '+file.name)); return; }
      resolve({display_name:file.name, content_base64:result.slice(separator + 1)});
    };
    reader.readAsDataURL(file);
  });
}
function composerQuestion(draft) {
  const questions = Array.isArray(draft?.proposal?.questions) ? draft.proposal.questions : [];
  return questions.find((question) => question && typeof question.id === 'string' && question.answer === null) || null;
}
function taskComposerControls(draft) {
  const id = sessionArg(draft.id), revision = Number(draft.revision);
  let controls = '<button type="button" onclick="showTaskComposerDraft(decodeURIComponent(\\''+id+'\\'))" aria-label="Review task draft">review plan</button>';
  if (draft.status === 'planning') controls += ' <button type="button" class="danger" onclick="cancelTaskComposerDraft(decodeURIComponent(\\''+id+'\\'),'+revision+')" aria-label="Stop planning this task">stop planning</button>';
  if (draft.status === 'failed' || draft.status === 'cancelled') controls += ' <button type="button" onclick="retryTaskComposerDraft(decodeURIComponent(\\''+id+'\\'),'+revision+')" aria-label="Retry this task draft">retry</button>';
  const question = composerQuestion(draft);
  if (question) controls += ' <button type="button" onclick="answerTaskComposerQuestion(decodeURIComponent(\\''+id+'\\'),'+revision+',decodeURIComponent(\\''+sessionArg(question.id)+'\\'))">answer question</button>';
  if (draft.status === 'proposed') {
    controls += ' <button type="button" onclick="confirmTaskComposerDraft(decodeURIComponent(\\''+id+'\\'),'+revision+')">confirm proposal</button>';
    controls += ' <button type="button" class="danger" onclick="rejectTaskComposerDraft(decodeURIComponent(\\''+id+'\\'),'+revision+')">reject</button>';
  }
  if (typeof draft.campaign_id === 'string' && draft.campaign_id) controls += ' <button type="button" onclick="followUpTaskComposer(decodeURIComponent(\\''+sessionArg(draft.campaign_id)+'\\'))">follow-up</button>';
  return controls;
}
function attentionForDraft(draft) {
  const question = composerQuestion(draft);
  const state = String(draft?.status || '').toLowerCase();
  if (question) return { key:String(draft.id)+':'+String(draft.revision)+':question', kind:'planning question', message:'A planning question needs an operator answer.', question };
  if (state === 'proposed') return { key:String(draft.id)+':'+String(draft.revision)+':proposal', kind:'proposal ready', message:'A proposal is ready for explicit review and confirmation.' };
  if (state === 'failed' || state === 'rejected' || state === 'cancelled') return { key:String(draft.id)+':'+String(draft.revision)+':'+state, kind:String(draft?.guidance?.headline || 'Task needs attention'), message:String(draft?.guidance?.recommendation || 'Review the task before retrying.') };
  return null;
}
function notifyAttention(notices) {
  const active = new Set(notices.map((notice) => notice.key));
  for (const key of announcedAttention) if (!active.has(key)) announcedAttention.delete(key);
  if (!browserAttentionEnabled || !('Notification' in window) || window.Notification.permission !== 'granted') return;
  for (const notice of notices) {
    if (announcedAttention.has(notice.key)) continue;
    announcedAttention.add(notice.key);
    new window.Notification('Arbor needs attention', {body:notice.kind+': '+notice.message});
  }
}
function enableBrowserAttention() {
  if (!('Notification' in window)) { workspaceStatus('Browser attention notifications are unavailable in this browser.', true); return; }
  window.Notification.requestPermission().then((permission) => {
    browserAttentionEnabled = permission === 'granted';
    workspaceStatus(browserAttentionEnabled ? 'Browser attention notifications enabled for this page session.' : 'Browser attention notifications were not enabled.');
    renderAttention(latestTaskDrafts);
  });
}
function renderAttention(items) {
  const target = document.getElementById('attention');
  if (!target) return;
  const notices = items.map((draft) => ({draft, notice:attentionForDraft(draft)})).filter((item) => item.notice !== null);
  notifyAttention(notices.map((item) => item.notice));
  if (!notices.length) { target.innerHTML = ''; return; }
  let h = '<div class="card"><h2 class="section-title">Needs operator attention</h2><span class="muted">These background planning states require a review or answer. Alerts are off by default.</span> ';
  if ('Notification' in window) h += '<button type="button" onclick="enableBrowserAttention()">'+(browserAttentionEnabled ? 'Browser alerts enabled' : 'Enable browser alerts')+'</button>';
  h += '<ol class="attention-list">';
  for (const item of notices) {
    const draft = item.draft, notice = item.notice, id = sessionArg(draft.id), revision = Number(draft.revision);
    const action = notice.question
      ? '<button type="button" onclick="answerTaskComposerQuestion(decodeURIComponent(\\''+id+'\\'),'+revision+',decodeURIComponent(\\''+sessionArg(notice.question.id)+'\\'))">answer question</button>'
      : '<button type="button" onclick="showTaskComposerDraft(decodeURIComponent(\\''+id+'\\'))">review draft</button>';
    h += '<li><span><strong>'+esc(notice.kind)+'</strong> · '+esc(String(draft.task || 'Untitled task').slice(0, 180))+'<br><span class="muted">'+esc(notice.message)+'</span></span>'+action+'</li>';
  }
  target.innerHTML = h+'</ol></div>';
}
function cancelTaskComposerDraft(draftId, revision) {
  if (!window.confirm('Stop planning this task? The current planning operation will be cancelled; no campaign will be started.')) return;
  taskComposerStatus('Stopping planner…');
  runtimeCommand('taskcomposer.cancel', {draft_id:draftId, expected_revision:revision, reason:'operator cancelled task planning from web workspace'})
    .then(() => { taskComposerStatus('Planning stopped.'); refreshTaskComposer(); })
    .catch(error => taskComposerStatus('Cancellation unavailable: '+error.message, true));
}
function renderTaskComposer(view) {
  const target = document.getElementById('task-composer');
  if (!target) return;
  const liveInput = document.getElementById('task-composer-input');
  if (typeof liveInput?.value === 'string') taskComposerDraftText = liveInput.value;
  const liveTier = document.getElementById('task-composer-tier');
  if (typeof liveTier?.value === 'string') taskComposerTier = liveTier.value;
  const items = Array.isArray(view?.items) ? view.items : [];
  latestTaskDrafts = items;
  renderAttention(items);
  let h = '<div class="card"><h2 class="section-title">What should Revoy change?</h2><span class="muted">Describe the outcome in your own words. Revoy plans, checks, and starts the work; it asks before proceeding only when human input is actually needed.</span>';
  h += '<label for="task-composer-tier">Governance tier</label><select id="task-composer-tier" onchange="taskComposerTier=this.value"><option value="auto"'+(taskComposerTier === 'auto' ? ' selected' : '')+'>Auto - classify from scope</option><option value="direct"'+(taskComposerTier === 'direct' ? ' selected' : '')+'>Direct - one bounded action</option><option value="reviewed"'+(taskComposerTier === 'reviewed' ? ' selected' : '')+'>Reviewed - independent review</option><option value="governed"'+(taskComposerTier === 'governed' ? ' selected' : '')+'>Governed - planned tree search</option></select><span class="muted">Auto is the default. An explicit tier is recorded as an operator override.</span>';
  h += '<label for="task-composer-input">Describe the change</label><textarea id="task-composer-input" rows="4" aria-describedby="task-composer-help" oninput="taskComposerDraftText=this.value" placeholder="For example: Make the mobile menu keyboard accessible and verify the production build."'+(taskComposerSubmitPending?' disabled':'')+'>'+esc(taskComposerDraftText)+'</textarea>';
  h += '<span id="task-composer-help" class="muted">Safety boundaries, evidence, and independent review remain active behind the scenes.</span>';
  h += '<label for="task-composer-attachments">Reference files (optional)</label><input id="task-composer-attachments" type="file" accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/json,.md,.markdown,.json,.jsonc,.yaml,.yml,.toml,.csv,.tsv,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.h,.cpp,.hpp,.sh,.sql,.graphql,.gql" multiple aria-describedby="task-composer-attachment-help task-composer-attachment-selection task-composer-attachment-error" onchange="selectTaskComposerAttachments(this)"'+(taskComposerSubmitPending?' disabled':'')+'><span id="task-composer-attachment-help" class="muted">Up to 4 images or UTF-8 text/source documents. Images: 5 MiB each; documents: 256 KiB each. Files use governed planning and are treated as untrusted reference data.</span><span id="task-composer-attachment-selection" class="muted" role="status" aria-live="polite">'+esc(taskComposerAttachmentNames.length ? taskComposerAttachmentNames.length+' file'+(taskComposerAttachmentNames.length === 1 ? '' : 's')+' selected: '+taskComposerAttachmentNames.join(', ') : 'No files selected.')+'</span><span id="task-composer-attachment-error" role="alert" aria-live="assertive">'+esc(taskComposerAttachmentError)+'</span>';
  h += '<br><button id="task-composer-submit" type="button" style="margin-top:8px" onclick="submitTaskComposer()"'+(taskComposerSubmitPending?' disabled':'')+'>'+(taskComposerSubmitPending?'starting…':'start task')+'</button> <span id="task-composer-status" class="muted" role="status" aria-live="polite"></span></div>';
  h += '<div class="card"><h2 class="section-title">Planning queue</h2>';
  if (!items.length) h += '<br><span class="muted">No task drafts yet.</span>';
  else {
    h += '<div class="table-scroll" tabindex="0" aria-label="Planning queue table"><table><caption class="sr-only">Planning queue</caption><tr><th>Task</th><th>State</th><th>Revision</th><th>Source</th><th>Proposal</th><th>Linked campaign</th><th>Actions</th></tr>';
    for (const draft of items.slice(0, 100)) {
      const proposal = draft?.proposal;
      const summary = draft?.guidance?.headline || (typeof proposal?.summary === 'string' ? proposal.summary : (draft?.planner?.error || 'planning'));
      h += '<tr><td>'+esc(String(draft?.task || '—').slice(0, 180))+'</td><td>'+badge(draft?.status || 'unknown')+'</td><td>'+esc(draft?.revision)+'</td><td>'+esc(draft?.source)+'</td><td>'+esc(String(summary).slice(0, 160))+'</td><td>'+esc(draft?.parent_campaign_id || draft?.campaign_id || '—')+'</td><td>'+taskComposerControls(draft)+'</td></tr>';
    }
    h += '</table></div>';
  }
  h += '<div id="task-composer-detail" class="hidden"></div></div>';
  target.innerHTML = h;
  if (taskComposerDetail !== null) showTaskComposerDraft(taskComposerDetail);
}
function submitTaskComposer() {
  if (taskComposerSubmitPending) return;
  const input = document.getElementById('task-composer-input');
  const task = typeof input?.value === 'string' ? input.value.trim() : '';
  if (!task) { taskComposerStatus('Enter a task before planning.', true); return; }
  const tier = document.getElementById('task-composer-tier')?.value || taskComposerTier;
  const attachmentIssue = taskComposerAttachmentIssue(taskComposerAttachmentFiles);
  if (attachmentIssue) { taskComposerAttachmentError = attachmentIssue; renderTaskComposerAttachmentState(); return; }
  if (taskComposerAttachmentFiles.length && tier !== 'governed') { taskComposerStatus('Image attachments require the Governed tier.', true); return; }
  const idempotencyKey = nextRuntimeOperationId('taskcomposer.submit');
  const attachmentFiles = taskComposerAttachmentFiles;
  taskComposerAttachmentFiles = [];
  taskComposerAttachmentNames = [];
  taskComposerAttachmentError = '';
  taskComposerSubmitPending = true;
  taskComposerDraftText = task;
  renderTaskComposer({items:latestTaskDrafts});
  taskComposerStatus('Understanding the request and applying safety checks…');
  Promise.all(attachmentFiles.map((file) => encodeTaskComposerAttachment(file)))
    .then((attachment_uploads) => runtimeCommand('taskcomposer.submit', {task, source:'web', idempotency_key:idempotencyKey, auto_confirm:true, ...(attachment_uploads.length ? {attachment_uploads} : {}), ...(tier === 'auto' ? {} : {tier_override:tier})}))
    .then((result) => { taskComposerDraftText = ''; const current = document.getElementById('task-composer-input'); if (current) current.value = ''; const draft = result?.draft || result?.value?.draft; taskComposerStatus(draft?.guidance?.headline || 'Task accepted.'); })
    .catch(error => taskComposerStatus('Task submission unavailable: '+error.message, true))
    .finally(() => { taskComposerSubmitPending = false; refreshTaskComposer(); });
}
function showTaskComposerDraft(draftId) {
  taskComposerDetail = draftId;
  const target = document.getElementById('task-composer-detail'); if (!target) return;
  target.classList.remove('hidden'); target.innerHTML = '<span class="muted">Loading task draft…</span>';
  runtimeQuery('taskcomposer.get', {draft_id:draftId}).then((view) => {
    const draft = view?.draft || view;
    const proposal = draft?.proposal || null;
    let h = '<div class="card"><strong class="section-title">Task draft '+esc(draft?.id || draftId)+'</strong><br><span class="muted">State '+esc(humanizeEnum(draft?.status))+' · revision '+esc(draft?.revision)+' · source '+esc(draft?.source)+'.</span>';
    h += '<p>'+esc(draft?.task || '')+'</p>';
    if (proposal) {
      h += '<strong>Plan</strong><p>'+esc(proposal.summary || '—')+'</p>';
      const assumptions = Array.isArray(proposal.assumptions) ? proposal.assumptions : [];
      const actions = Array.isArray(proposal.actions) ? proposal.actions : [];
      const checks = Array.isArray(proposal.acceptance_checks) ? proposal.acceptance_checks : [];
      const risks = Array.isArray(proposal.risk_notes) ? proposal.risk_notes : [];
      h += '<span class="muted">Assumptions: '+esc(assumptions.join('; ') || 'none stated')+'</span><br>';
      h += '<span class="muted">Proposed actions: '+esc(actions.map(a => a?.description || a?.category || 'action').join('; ') || 'none')+'</span><br>';
      h += '<span class="muted">Verification: '+esc(checks.join('; ') || 'none stated')+'</span><br>';
      h += '<span class="muted">Risks: '+esc(risks.join('; ') || 'none stated')+'</span><br>';
    }
    if (draft?.guidance) h += '<strong>What happens next</strong><p>'+esc(draft.guidance.headline || '')+'</p><span class="muted">'+esc(draft.guidance.detail || '')+' '+esc(draft.guidance.recommendation || '')+'</span><br>';
    h += '<span class="muted">Evidence references: '+esc(Array.isArray(draft?.evidence_ids) ? draft.evidence_ids.length+' selected references' : 'none')+'. Raw evidence is not available from this dashboard.</span></div>';
    target.innerHTML = h;
  }).catch(error => { target.innerHTML = '<div class="card"><span class="muted">Task detail unavailable: '+esc(error.message)+'</span></div>'; });
}
function answerTaskComposerQuestion(draftId, revision, questionId) {
  const draft = latestTaskDrafts.find((item) => item?.id === draftId);
  const question = (Array.isArray(draft?.proposal?.questions) ? draft.proposal.questions : []).find((item) => item?.id === questionId);
  const answer = window.prompt(String(question?.question || draft?.guidance?.detail || 'Answer the governed planning question:'));
  if (answer === null || !answer.trim()) return;
  runtimeCommand('taskcomposer.answer', {draft_id:draftId, expected_revision:revision, question_id:questionId, answer:answer.trim()})
    .then(refreshTaskComposer).catch(error => taskComposerStatus('Answer unavailable: '+error.message, true));
}
function retryTaskComposerDraft(draftId, revision) {
  runtimeCommand('taskcomposer.retry', {draft_id:draftId, expected_revision:revision, idempotency_key:nextRuntimeOperationId('taskcomposer.retry')})
    .then(refreshTaskComposer).catch(error => taskComposerStatus('Retry unavailable: '+error.message, true));
}
function confirmTaskComposerDraft(draftId, revision) {
  if (!window.confirm('Confirm this exact proposal revision? Revoy will admit the reviewed campaign through its governed runtime.')) return;
  runtimeCommand('taskcomposer.confirm', {draft_id:draftId, expected_revision:revision, idempotency_key:nextRuntimeOperationId('taskcomposer.confirm')})
    .then(refreshTaskComposer).catch(error => taskComposerStatus('Confirmation unavailable: '+error.message, true));
}
function rejectTaskComposerDraft(draftId, revision) {
  const reason = window.prompt('Reason for rejecting this proposal:');
  if (reason === null || !reason.trim()) return;
  runtimeCommand('taskcomposer.reject', {draft_id:draftId, expected_revision:revision, reason:reason.trim()})
    .then(refreshTaskComposer).catch(error => taskComposerStatus('Rejection unavailable: '+error.message, true));
}
function followUpTaskComposer(campaignId) {
  const task = window.prompt('New linked follow-up task for '+campaignId+':');
  if (task === null || !task.trim()) return;
  const idempotencyKey = nextRuntimeOperationId('taskcomposer.follow-up');
  runtimeCommand('taskcomposer.submit', {task:task.trim(), source:'web', idempotency_key:idempotencyKey, parent_campaign_id:campaignId, auto_confirm:true})
    .then(refreshTaskComposer).catch(error => taskComposerStatus('Follow-up unavailable: '+error.message, true));
}
function refreshTaskComposer() { runtimeQuery('taskcomposer.list', {limit:100}).then(renderTaskComposer).catch(error => renderTaskComposer({items:[]})); }

// ---- Result captures ------------------------------------------------
// The dashboard can inspect canonical captures and their diff material, and
// submits adoption/revert through the same governed result.adopt/result.revert
// commands the TUI uses -- gated on a clean selected-subset preflight and an
// explicit operator confirmation (see adoptResult/revertResultAdoption below).
function resultNodeId(item) {
  return typeof item?.node_id === 'string' && item.node_id ? item.node_id : null;
}
function resultText(item, keys, fallback) {
  for (const key of keys) if (typeof item?.[key] === 'string' && item[key].trim()) return item[key];
  return fallback;
}
function resultAdoptionKey(campaignId, nodeId) { return campaignId+'\u0000'+nodeId; }
function inspectedResultFiles(record) {
  return Array.isArray(record?.files)
    ? [...new Set(record.files.filter((file) => typeof file === 'string' && file.trim()))]
    : [];
}
function resultArray(record, paths) {
  for (const path of paths) {
    let value = record;
    for (const part of path) value = value && typeof value === 'object' ? value[part] : undefined;
    if (Array.isArray(value)) return value;
  }
  return [];
}
function resultEvidenceMarkup(record) {
  const tests = resultArray(record, [['tests'], ['test_evidence'], ['verification', 'tests'], ['acceptance_checks']]);
  const evidence = resultArray(record, [['evidence_ids'], ['evidence'], ['verification', 'evidence_ids']]);
  const provenance = resultText(record, ['provenance_tag', 'verification_status'], record?.provenance?.tag || 'not recorded');
  const testStates = tests.map((test) => typeof test === 'object' && test !== null ? String(test.status ?? test.state ?? test.outcome ?? 'unclassified') : 'unclassified');
  const passing = testStates.filter((state) => /pass|success|verified/i.test(state)).length;
  const failing = testStates.filter((state) => /fail|error|reject/i.test(state)).length;
  let h = '<h3 class="section-title">Recorded verification evidence</h3><dl class="evidence-facts"><dt>Verification signal</dt><dd>'+esc(provenance)+'</dd><dt>Test records</dt><dd>'+(tests.length ? esc(tests.length+' recorded · '+passing+' passing signal(s) · '+failing+' failing signal(s)') : 'No test records were supplied.')+'</dd><dt>Evidence references</dt><dd>'+(evidence.length ? esc(evidence.length+' recorded reference(s)') : 'No evidence references were supplied.')+'</dd></dl>';
  if (tests.length) h += '<details><summary class="muted">Recorded test evidence</summary><pre>'+esc(boundedSessionText(tests.slice(0, 50), 8192))+'</pre></details>';
  return h;
}
function resultFollowUpMarkup(record, campaignId) {
  const linked = resultText(record, ['task_draft_id', 'source_task_id', 'follow_up_task_id'], 'no task linkage recorded');
  return '<div class="adoption-notice"><strong>Follow-up task linkage</strong><br><span class="muted">Current linkage: '+esc(linked)+'. A follow-up creates a new governed planning draft linked to campaign '+esc(campaignId)+'; it does not change this result.</span><br><button type="button" onclick="followUpTaskComposer(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'))">plan campaign-linked follow-up</button></div>';
}
function verifiedResult(record) {
  const provenance = record?.provenance;
  const verification = record?.verification;
  return record?.verified === true
    || record?.status === 'verified'
    || record?.provenance_tag === 'verified'
    || provenance?.tag === 'verified'
    || verification?.status === 'verified'
    || verification?.verified === true;
}
function resultAdoptionEligibility(record, patch, content, files) {
  const state = String(record?.status ?? record?.state ?? '').toLowerCase();
  if (state === 'failed' || record?.inspection_status === 'failed') return { eligible:false, reason:'inspection reports failure' };
  if (!verifiedResult(record)) return { eligible:false, reason:'result is not verified' };
  if (patch?.truncated !== false || typeof content !== 'string') return { eligible:false, reason:'inspection patch is incomplete or truncated' };
  if (typeof patch.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(patch.sha256)) return { eligible:false, reason:'a full patch SHA-256 is required' };
  if (!files.length) return { eligible:false, reason:'changed files were not supplied' };
  return { eligible:true, hash:patch.sha256 };
}
function adoptResult(campaignId, nodeId) {
  const key = resultAdoptionKey(campaignId, nodeId);
  const review = resultAdoptionReviews.get(key);
  if (!review || pendingResultAdoptions.has(key) || pendingResultReverts.has(key) || resultAdoptionReceipts.has(key)) return;
  const selectedFiles = Array.from(document.querySelectorAll('#result-detail input[data-result-adoption-file]:checked'))
    .map((input) => input.value).filter((file) => review.files.includes(file));
  if (!selectedFiles.length) {
    workspaceStatus('Choose at least one changed file before adopting.', true);
    return;
  }
  const fileList = selectedFiles.map((file) => '- '+file).join('\\n');
  pendingResultAdoptions.add(key);
  workspaceStatus('Preflighting the exact selected file subset for '+nodeId+'…');
  showResultInspection(campaignId, nodeId);
  runtimeQuery('result.review.workspace', {campaign_id:campaignId, node_id:nodeId, files:selectedFiles, max_patch_bytes:1048576})
    .then((preview) => {
      if (preview?.patch_sha256 !== review.hash) throw new Error('captured patch changed during selected-subset preflight');
      if (preview?.conflict_preview?.status !== 'clean') throw new Error(preview?.conflict_preview?.detail || 'selected file subset does not apply cleanly');
      const detail = String(preview.conflict_preview.detail || 'git apply --check passed');
      if (!window.confirm('Adopt the verified result for node '+nodeId+'?\\n\\nSelected files:\\n'+fileList+'\\n\\nConflict preview: CLEAN\\n'+detail+'\\n\\nThis sends an explicit governed adoption confirmation.')) {
        workspaceStatus('Result adoption was not confirmed after a clean selected-subset preview.');
        return null;
      }
      workspaceStatus('Submitting governed result adoption for '+nodeId+' after a clean selected-subset preview…');
      return runtimeCommand('result.adopt', {campaign_id:campaignId, node_id:nodeId, expected_patch_sha256:review.hash, confirmed:true, files:selectedFiles});
    })
    .then((receipt) => {
      if (receipt === null) return;
      const operationId = typeof receipt?.operation_id === 'string' ? receipt.operation_id : null;
      if (operationId) {
        resultAdoptionReceipts.set(key, {operationId, hash:review.hash, reverted:false});
        workspaceStatus('Result adoption accepted for '+nodeId+'. Undo is available for this page session.');
      } else workspaceStatus('Result adoption accepted for '+nodeId+', but no operation receipt was returned; undo is unavailable.');
      refreshResults();
      showResultInspection(campaignId, nodeId);
    })
    .catch((error) => { workspaceStatus('Result adoption rejected: '+error.message, true); })
    .finally(() => { pendingResultAdoptions.delete(key); showResultInspection(campaignId, nodeId); });
}
function revertResultAdoption(campaignId, nodeId) {
  const key = resultAdoptionKey(campaignId, nodeId);
  const receipt = resultAdoptionReceipts.get(key);
  if (!receipt || receipt.reverted || pendingResultAdoptions.has(key) || pendingResultReverts.has(key)) return;
  if (!window.confirm('Undo the adoption for node '+nodeId+'? This requests a governed revert using adoption operation '+receipt.operationId+'.')) {
    workspaceStatus('Adoption undo was not confirmed.');
    return;
  }
  pendingResultReverts.add(key);
  workspaceStatus('Submitting governed adoption undo for '+nodeId+'…');
  showResultInspection(campaignId, nodeId);
  runtimeCommand('result.revert', {adoption_operation_id:receipt.operationId, expected_patch_sha256:receipt.hash, confirmed:true})
    .then(() => {
      receipt.reverted = true;
      workspaceStatus('Adoption undo accepted for '+nodeId+'.');
      refreshResults();
      showResultInspection(campaignId, nodeId);
    })
    .catch((error) => { workspaceStatus('Adoption undo rejected or conflicted: '+error.message, true); })
    .finally(() => { pendingResultReverts.delete(key); });
}
function renderResults(groups) {
  const target = document.getElementById('results-workspace');
  if (!target) return;
  const captures = Array.isArray(groups) ? groups.flatMap((group) => {
    const campaignId = typeof group?.campaign_id === 'string' ? group.campaign_id : 'unknown campaign';
    return Array.isArray(group?.items) ? group.items.map((item) => ({ campaignId, item })) : [];
  }) : [];
  let h = '<div class="card"><h2 class="section-title">Result captures</h2><span class="muted">Read-only evidence and diff review. Reviewing a capture does not adopt it or alter a campaign.</span>';
  if (!captures.length) h += '<p class="muted">No result captures are available.</p>';
  else {
    h += '<div class="table-scroll" tabindex="0" aria-label="Result captures table"><table><caption class="sr-only">Result captures</caption><tr><th>Campaign</th><th>Node</th><th>State</th><th>Summary</th><th>Review</th></tr>';
    for (const capture of captures.slice(0, 100)) {
      const nodeId = resultNodeId(capture.item);
      const state = resultText(capture.item, ['status', 'state'], 'captured');
      const summary = resultText(capture.item, ['summary', 'title', 'description'], 'No summary supplied.');
      const review = nodeId === null ? '<span class="muted">Node identifier unavailable</span>' : '<button type="button" onclick="showResultInspection(decodeURIComponent(\\''+sessionArg(capture.campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'))">review capture</button>';
      h += '<tr><td>'+esc(capture.campaignId)+'</td><td>'+esc(nodeId || 'unidentified')+'</td><td>'+badge(state)+'</td><td class="result-summary">'+esc(summary.slice(0, 220))+'</td><td>'+review+'</td></tr>';
    }
    h += '</table></div>';
  }
  h += '</div>';
  target.innerHTML = h;
}
const resultReviewModes = new Map();
function setResultReviewMode(campaignId, nodeId, mode) { resultReviewModes.set(resultAdoptionKey(campaignId, nodeId), mode === 'side-by-side' ? 'side-by-side' : 'unified'); showResultInspection(campaignId, nodeId); }
function resultReviewMutation(kind, campaignId, nodeId, workspace, fields) {
  workspaceStatus('Recording '+humanizeEnum(kind.replace('result.review.', ''))+'…');
  return runtimeCommand(kind, {campaign_id:campaignId, node_id:nodeId, expected_patch_sha256:workspace.patch_sha256, expected_revision:workspace.review_revision, ...fields})
    .then((receipt) => { workspaceStatus(humanizeEnum(kind.replace('result.review.', ''))+' recorded at review revision '+String(receipt?.review?.review_revision ?? 'updated')+'.'); showResultInspection(campaignId, nodeId); return receipt; })
    .catch((error) => { workspaceStatus('Review update rejected: '+error.message, true); throw error; });
}
function addInlineResultComment(campaignId, nodeId, workspace, filePath, line, side) {
  const body = window.prompt('Inline review comment for '+filePath+':'+line+' ('+side+'):', '');
  if (body === null || !body.trim()) return;
  resultReviewMutation('result.review.comment', campaignId, nodeId, workspace, {file_path:filePath, line, side, body:body.trim(), author_id:'webui-operator'}).catch(() => {});
}
function requestResultRevision(campaignId, nodeId, workspace) {
  const reason = window.prompt('Revision request. State the concrete change required:', '');
  if (reason === null || !reason.trim()) return;
  resultReviewMutation('result.review.request_revision', campaignId, nodeId, workspace, {reason:reason.trim(), author_id:'webui-operator', comment_ids:(workspace.comments || []).map((comment) => comment.id)}).catch(() => {});
}
function handoffResultEditor(campaignId, nodeId, workspace, filePath, line, editor) {
  resultReviewMutation('result.review.editor_handoff', campaignId, nodeId, workspace, {file_path:filePath, line, editor}).then((receipt) => {
    const sessions = receipt?.review?.editor_sessions;
    const uri = Array.isArray(sessions) ? sessions.at(-1)?.uri : null;
    if (typeof uri === 'string' && /^(vscode|cursor):\\/\\/file\\//.test(uri)) window.location.assign(uri);
  }).catch(() => {});
}
function resultDiffMarkup(workspace, campaignId, nodeId) {
  const mode = resultReviewModes.get(resultAdoptionKey(campaignId, nodeId)) || 'unified';
  const switcher = '<div class="diff-mode" role="group" aria-label="Diff display mode"><button type="button" '+(mode === 'unified' ? 'aria-pressed="true"' : '')+' onclick="setResultReviewMode(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),\\'unified\\')">Unified</button><button type="button" '+(mode === 'side-by-side' ? 'aria-pressed="true"' : '')+' onclick="setResultReviewMode(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),\\'side-by-side\\')">Side by side</button></div>';
  if (mode === 'side-by-side') {
    const rows = Array.isArray(workspace.side_by_side) ? workspace.side_by_side.slice(0, 5000) : [];
    return switcher+'<div class="table-scroll diff-split" tabindex="0"><table><caption class="sr-only">Side-by-side result diff</caption><tr><th>Old</th><th>Old content</th><th>New</th><th>New content</th><th>Review</th></tr>'+rows.map((line) => { const file = String(line.file_path || 'unknown'); const number = Number(line.new_line || line.old_line || 1); const side = line.new_line ? 'new' : 'old'; return '<tr class="diff-'+esc(line.kind || 'context')+'"><td>'+esc(line.old_line ?? '')+'</td><td><code>'+esc(line.old_text || '')+'</code></td><td>'+esc(line.new_line ?? '')+'</td><td><code>'+esc(line.new_text || '')+'</code></td><td><button type="button" onclick="addInlineResultComment(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),window.__resultReviewWorkspace,decodeURIComponent(\\''+sessionArg(file)+'\\'),'+number+',\\''+side+'\\')">comment</button></td></tr>'; }).join('')+'</table></div>';
  }
  const lines = Array.isArray(workspace.unified) ? workspace.unified.slice(0, 5000) : [];
  return switcher+'<div class="diff-unified" role="table" aria-label="Unified result diff">'+lines.map((line) => { const file = String(line.file_path || 'unknown'); const number = Number(line.new_line || line.old_line || 1); const side = line.new_line ? 'new' : line.old_line ? 'old' : 'file'; const prefix = line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : line.kind === 'context' ? ' ' : ''; return '<div class="diff-line diff-'+esc(line.kind || 'header')+'" role="row"><span class="diff-number">'+esc(line.old_line ?? '')+'</span><span class="diff-number">'+esc(line.new_line ?? '')+'</span><code>'+esc(prefix+String(line.text ?? ''))+'</code>'+(line.file_path ? '<button type="button" onclick="addInlineResultComment(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),window.__resultReviewWorkspace,decodeURIComponent(\\''+sessionArg(file)+'\\'),'+number+',\\''+side+'\\')">+</button>' : '')+'</div>'; }).join('')+'</div>';
}
function showResultInspection(campaignId, nodeId) {
  const target = document.getElementById('result-detail');
  if (!target) return;
  target.classList.remove('hidden');
  target.innerHTML = '<div class="card"><span class="muted">Loading result capture…</span></div>';
  runtimeQuery('result.review.workspace', {campaign_id:campaignId, node_id:nodeId, max_patch_bytes:1048576}).then((inspection) => {
    window.__resultReviewWorkspace = inspection;
    const record = inspection?.capture && typeof inspection.capture === 'object' ? inspection.capture : {};
    const content = Array.isArray(inspection?.unified) ? inspection.unified.map((line) => (line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : line.kind === 'context' ? ' ' : '')+String(line.text ?? '')).join('\\n') : '';
    const patch = {content, total_bytes:new TextEncoder().encode(content).length, truncated:inspection?.truncated === true, sha256:inspection?.patch_sha256};
    const summary = resultText(record, ['summary', 'description', 'title'], 'Result capture inspection.');
    const patchBytes = Number.isSafeInteger(patch.total_bytes) ? patch.total_bytes+' bytes' : 'size unavailable';
    const patchState = patch.truncated === true ? 'truncated to the workspace limit' : 'complete projection';
    const patchHash = typeof patch.sha256 === 'string' ? ' · sha256 '+patch.sha256 : '';
    const files = Array.isArray(inspection?.files) ? inspection.files.map((file) => String(file.path || '')).filter(Boolean) : inspectedResultFiles(record);
    const adoption = resultAdoptionEligibility(record, patch, content, files);
    const adoptionKey = resultAdoptionKey(campaignId, nodeId);
    if (adoption.eligible) resultAdoptionReviews.set(adoptionKey, {hash:adoption.hash, files}); else resultAdoptionReviews.delete(adoptionKey);
    const receipt = resultAdoptionReceipts.get(adoptionKey);
    const pending = pendingResultAdoptions.has(adoptionKey) || pendingResultReverts.has(adoptionKey);
    let h = '<div class="card"><h2 class="section-title">Review result capture</h2><p class="muted">Campaign '+esc(campaignId)+' · node '+esc(nodeId)+'</p><p>'+esc(summary)+'</p>';
    h += '<p class="muted">Patch: '+esc(patchBytes)+' · '+esc(patchState)+esc(patchHash)+'.</p>';
    h += resultEvidenceMarkup(record);
    const relationships = inspection?.relationships || {};
    const verification = relationships.verification;
    h += '<div class="review-evidence"><strong>Critic, tests, and provenance</strong><p class="muted">Critic: '+esc(relationships.critic?.detail || 'canonical critic relationship unavailable')+'</p><p class="muted">Verification: '+esc(verification ? (verification.confidence+' · '+(verification.checks || []).length+' retained check(s) · provenance '+String(verification.provenance?.tag || 'unavailable')) : 'no canonical verification record retained')+'</p><p class="muted">Capture provenance: '+esc(relationships.provenance?.capture || 'unavailable')+'; adoption still requires a verified capture.</p></div>';
    h += resultFollowUpMarkup(record, campaignId);
    const tree = Array.isArray(inspection?.file_tree) ? inspection.file_tree : [];
    h += '<div class="review-file-tree"><strong>Changed-file tree · '+esc(inspection?.counts?.files ?? files.length)+' files · +'+esc(inspection?.counts?.additions ?? 0)+' -'+esc(inspection?.counts?.deletions ?? 0)+'</strong><ul>'+tree.map((entry) => '<li style="padding-left:'+Math.min(48, Number(entry.depth || 0)*12)+'px">'+(entry.kind === 'directory' ? '▸ ' : '• ')+esc(entry.path)+(entry.kind === 'file' ? ' <span class="muted">+'+esc(entry.additions)+' -'+esc(entry.deletions)+'</span>' : '')+'</li>').join('')+'</ul></div>';
    if (files.length) {
      h += '<fieldset class="file-adoption" '+(adoption.eligible && !pending ? '' : 'aria-disabled="true"')+'><legend>Files to adopt</legend><span class="muted">All files are selected by default. Clear any file that should remain outside this adoption.</span>';
      for (const file of files) h += '<label><input type="checkbox" data-result-adoption-file value="'+esc(file)+'" checked '+(adoption.eligible && !pending ? '' : 'disabled ')+'><span>'+esc(file)+'</span></label>';
      h += '</fieldset>';
    }
    h += '<h3 class="section-title">Diff material</h3>'+resultDiffMarkup(inspection, campaignId, nodeId);
    const comments = Array.isArray(inspection?.comments) ? inspection.comments : []; const requests = Array.isArray(inspection?.revision_requests) ? inspection.revision_requests : []; const editorSessions = Array.isArray(inspection?.editor_sessions) ? inspection.editor_sessions : [];
    h += '<div class="review-collaboration"><h3 class="section-title">Review collaboration</h3><p>'+esc(comments.length)+' inline comment(s) · '+esc(requests.length)+' revision request(s) · durable review revision '+esc(inspection?.review_revision ?? '?')+'</p><ul>'+comments.map((comment) => '<li><strong>'+esc(comment.file_path)+':'+esc(comment.line)+'</strong> '+esc(comment.body)+' <span class="muted">— '+esc(comment.author_id)+'</span></li>').join('')+'</ul><button type="button" onclick="requestResultRevision(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),window.__resultReviewWorkspace)">Request revision</button></div>';
    if (files[0]) h += '<div class="editor-handoff"><strong>Editor handoff with continuity</strong><p class="muted">A handoff creates a durable review session bound to this patch and review revision.</p><button type="button" onclick="handoffResultEditor(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),window.__resultReviewWorkspace,decodeURIComponent(\\''+sessionArg(files[0])+'\\'),1,\\'vscode\\')">Open first file in VS Code</button> <button type="button" onclick="handoffResultEditor(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'),window.__resultReviewWorkspace,decodeURIComponent(\\''+sessionArg(files[0])+'\\'),1,\\'cursor\\')">Open in Cursor</button><ul>'+editorSessions.map((session) => '<li>'+esc(session.editor)+' · '+esc(session.file_path)+':'+esc(session.line)+' · session '+esc(session.id)+'</li>').join('')+'</ul></div>';
    h += '<div class="adoption-notice"><strong>Conflict preview: '+esc(inspection?.conflict_preview?.status || 'blocked')+'</strong><br><span class="muted">'+esc(inspection?.conflict_preview?.detail || 'No conflict preview was returned.')+'</span></div>';
    const adoptionControl = adoption.eligible && !receipt
      ? '<button type="button" '+(pending ? 'disabled ' : '')+'onclick="adoptResult(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'))">'+(pending ? 'Adoption pending…' : 'Confirm and adopt verified result')+'</button>'
      : '<button type="button" disabled>Adoption unavailable</button>';
    const adoptionMessage = receipt && !receipt.reverted
      ? 'This page holds the immediate adoption receipt. You may request one governed undo before leaving or reloading the workspace.'
      : receipt?.reverted
        ? 'This adoption was reverted in this page session. A new adoption receipt is required before another undo can be requested.'
      : adoption.eligible
      ? 'Adoption is available only after confirming the selected changed-file list above.'
      : 'Adoption is unavailable: '+adoption.reason+'.';
    const undoControl = receipt && !receipt.reverted
      ? '<button type="button" class="danger" '+(pending ? 'disabled ' : '')+'onclick="revertResultAdoption(decodeURIComponent(\\''+sessionArg(campaignId)+'\\'),decodeURIComponent(\\''+sessionArg(nodeId)+'\\'))">'+(pending ? 'Undo pending…' : 'Undo adoption')+'</button>'
      : '<button type="button" disabled>Undo adoption unavailable</button>';
    h += '<div class="adoption-notice"><strong>Adoption requires governed authority</strong><br><span class="muted">'+esc(adoptionMessage)+'</span><br>'+adoptionControl+' '+undoControl+'</div>';
    h += '<details><summary class="muted">Raw inspection payload</summary><pre>'+esc(JSON.stringify(inspection, null, 2))+'</pre></details></div>';
    target.innerHTML = h;
  }).catch(error => { target.innerHTML = '<div class="card"><span class="muted">Result inspection unavailable: '+esc(error.message)+'</span></div>'; });
}
function refreshResults() {
  api('/api/campaigns').then((campaigns) => {
    const list = Array.isArray(campaigns) ? campaigns : (campaigns?.campaigns || []);
    return Promise.all(list.map((campaign) => runtimeQuery('result.list', {campaign_id:campaign.id}).then((value) => ({campaign_id:typeof value?.campaign_id === 'string' ? value.campaign_id : campaign.id, items:Array.isArray(value?.items) ? value.items : []}))));
  }).then(renderResults).catch(() => renderResults([]));
}

// ---- Governance (C-08) ----------------------------------------------
// Read-only projection of the ADR governance snapshot/backlog the TUI's
// governance/backlog screens already render, mirroring the same real
// decisions/ corpus fields (governance-projection.ts). No mutation
// authority here: an operator disposition still flows through the decision
// records themselves, not this dashboard.
function renderGovernancePanel(snapshot, backlogValue) {
  const target = document.getElementById('governance-panel');
  if (!target) return;
  if (!snapshot && !backlogValue) { target.innerHTML = '<div class="card"><h2 class="section-title">Governance</h2><p class="muted unavailable">Governance snapshot/backlog are unavailable from this runtime.</p></div>'; return; }
  const distribution = snapshot?.decision_status_distribution || {};
  const distRows = Object.keys(distribution).length
    ? Object.entries(distribution).map(([status, count]) => '<li>'+esc(humanizeEnum(status))+': '+esc(count)+'</li>').join('')
    : '<li class="muted">No decision-status distribution reported.</li>';
  const coverage = snapshot?.obligation_coverage;
  const coverageText = coverage
    ? esc(coverage.total_obligations ?? 'unavailable')+' obligation(s) across '+esc(coverage.total_records ?? 'unavailable')+' record(s) ('+esc(coverage.records_with_obligations_section ?? 'unavailable')+' declare an Obligations section, '+esc(coverage.records_fully_covered ?? 'unavailable')+' fully covered)'
    : 'Obligation coverage unavailable.';
  const findings = Array.isArray(snapshot?.policy_findings) ? snapshot.policy_findings : [];
  const findingsRows = findings.length
    ? findings.slice(0, 100).map((finding) => { const subject = finding?.subject?.record_id || (finding?.subject?.kind && finding?.subject?.path ? finding.subject.kind+':'+finding.subject.path : '?'); return '<li><strong>'+esc(finding?.rule_id || '?')+'</strong> ('+esc(finding?.severity || '?')+') — '+esc(subject)+': '+esc(finding?.detail || '?')+'</li>'; }).join('')
    : '<li class="muted">No policy findings.</li>';
  const counts = snapshot?.repository_counts || {};
  const countsText = [['adr_total','ADRs'],['catalog_kinds','Catalog kinds'],['src_files','Src files'],['packages','Packages'],['test_files','Test files'],['allowlist_entries','Allowlist entries']]
    .filter(([key]) => counts[key] !== undefined).map(([key, label]) => label+': '+counts[key]).join(' · ') || 'unavailable';
  const legacy = snapshot?.legacy_classification || {};
  const legacyText = ['total','parsed','parsed_with_warnings','unparseable'].filter((key) => legacy[key] !== undefined).map((key) => key+': '+legacy[key]).join(' · ') || 'unavailable';
  const backlogItems = Array.isArray(backlogValue?.backlog?.items) ? backlogValue.backlog.items : [];
  const selected = backlogValue?.selected;
  // WA-23: absence is a typed value, not zero. A failed governance.backlog
  // query (backlogValue === null) is a distinct state from a real,
  // zero-item backlog — collapsing them into "0 record(s) scanned" /
  // "Backlog is empty." would misrepresent an unknown backlog as a known
  // empty one.
  const backlogSection = !backlogValue
    ? '<p class="muted unavailable">Governance backlog is unavailable from this runtime.</p>'
    : '<p class="muted">'+esc(backlogValue.backlog?.total_records_scanned ?? 'unavailable')+' record(s) scanned'+(selected ? ' · next: '+esc(selected.record_id) : '')+'</p><ul>'+(backlogItems.length
        ? backlogItems.slice(0, 100).map((item) => '<li>'+(selected && selected.record_id === item.record_id ? '<strong>→ </strong>' : '')+esc(item.record_id || '?')+' — '+esc(item.title || '?')+' ('+esc(humanizeEnum(item.decision_status || '?'))+', '+esc(item.classification || '?')+', tier '+esc(item.rank_tier ?? '?')+')</li>').join('')
        : '<li class="muted">Backlog is empty.</li>')+'</ul>';
  target.innerHTML = '<div class="card"><h2 class="section-title">Governance</h2><p class="muted">Read-only ADR governance snapshot and work backlog, projected live from the real decisions/ corpus.</p>'
    + (snapshot ? '' : '<p class="muted unavailable">Governance snapshot is unavailable from this runtime.</p>')
    + '<h3 class="section-title">Records by decision status</h3><ul>'+distRows+'</ul>'
    + '<h3 class="section-title">Obligation coverage</h3><p>'+coverageText+'</p>'
    + '<h3 class="section-title">Policy findings</h3><ul>'+findingsRows+'</ul>'
    + '<h3 class="section-title">Repository counts</h3><p>'+esc(countsText)+'</p>'
    + '<h3 class="section-title">Legacy classification</h3><p>'+esc(legacyText)+'</p>'
    + '<h3 class="section-title">Governance backlog</h3>'+backlogSection
    + '</div>';
}
function refreshGovernance() {
  Promise.all([
    runtimeQuery('governance.snapshot', {}).catch(() => null),
    runtimeQuery('governance.backlog', {}).catch(() => null),
  ]).then(([snapshot, backlog]) => renderGovernancePanel(snapshot, backlog)).catch(() => renderGovernancePanel(null, null));
}

// ---- Operator read panels (C-07) -------------------------------------
// Read-only projections for operator-facing catalog kinds that already have
// a TUI form (communications, output evidence, surveillance findings,
// capability catalog, declarative subagent executions) but no Web view.
// Write/approve kinds for fold/playbook/harness revisions stay out of scope
// here.
function renderOutputCaptures(entries) {
  const target = document.getElementById('output-captures-panel');
  if (!target) return;
  // WA-23: a failed output.list query (entries === null/undefined) is not
  // the same fact as a real, zero-item capture list — do not collapse the
  // two into the same "No captured output" copy.
  if (entries == null) { target.innerHTML = '<h3 class="section-title">Output captures</h3><p class="muted unavailable">Output captures are unavailable from this runtime.</p><div id="output-descriptor-view"></div>'; return; }
  const rows = Array.isArray(entries) ? entries : [];
  const list = rows.length ? rows.slice(0, 100).map((entry) => {
    const corrupt = entry.status === 'corrupt';
    const record = entry.record || {};
    const evidenceId = corrupt ? (typeof entry.id === 'string' ? entry.id : null) : (typeof record.id === 'string' ? record.id : null);
    const label = corrupt ? 'corrupt: '+esc(evidenceId || '?') : esc(record.operation_id || record.id || '?')+' · '+esc(record.stream || 'unavailable')+' · '+esc(record.byte_count ?? 'unavailable')+' bytes';
    const view = evidenceId ? ' <button type="button" onclick="loadOutputDescriptor(decodeURIComponent(\\''+sessionArg(evidenceId)+'\\'))">view</button>' : '';
    return '<li>'+label+view+'</li>';
  }).join('') : '<li class="muted">No captured tool/stream output.</li>';
  target.innerHTML = '<h3 class="section-title">Output captures</h3><ul>'+list+'</ul><div id="output-descriptor-view"></div>';
}
function loadOutputDescriptor(evidence_id) {
  const target = document.getElementById('output-descriptor-view');
  if (target) target.innerHTML = '<p class="muted">Loading descriptor…</p>';
  runtimeQuery('output.descriptor', {evidence_id}).then((value) => {
    const descriptor = value?.descriptor || {};
    if (target) target.innerHTML = '<dl class="evidence-facts"><dt>Evidence</dt><dd>'+esc(descriptor.id || evidence_id)+'</dd><dt>Stream</dt><dd>'+esc(descriptor.stream || 'unavailable')+'</dd><dt>Media type</dt><dd>'+esc(descriptor.media_type || 'unavailable')+'</dd><dt>Bytes</dt><dd>'+esc(descriptor.byte_count ?? 'unavailable')+'</dd><dt>Provenance</dt><dd>'+esc(descriptor.provenance?.tag || 'unavailable')+'</dd></dl>';
  }).catch((error) => { if (target) target.innerHTML = '<p class="muted unavailable">Descriptor unavailable: '+esc(error.message)+'</p>'; });
}
function refreshOutputCaptures() { runtimeQuery('output.list', {}).then(renderOutputCaptures).catch(() => renderOutputCaptures(null)); }
function renderCapabilityCatalog(value) {
  const target = document.getElementById('capability-catalog-panel');
  if (!target) return;
  // WA-23: a failed capability.introspect query is unavailable, not an
  // empty catalog.
  if (value == null) { target.innerHTML = '<h3 class="section-title">Capability catalog</h3><p class="muted unavailable">Capability catalog is unavailable from this runtime.</p>'; return; }
  const catalog = Array.isArray(value.catalog) ? value.catalog : [];
  target.innerHTML = '<h3 class="section-title">Capability catalog ('+catalog.length+')</h3>'+(catalog.length
    ? '<div class="table-scroll" tabindex="0"><table><tr><th>Kind</th><th>Class</th><th>Min tier</th><th>State</th></tr>'+catalog.slice(0, 300).map((entry) => '<tr><td>'+esc(entry.kind || '?')+'</td><td>'+esc(entry.action_class || '?')+'</td><td>'+esc(entry.minimum_tier || 'never')+'</td><td>'+(entry.supported === true ? 'supported' : 'unavailable')+'</td></tr>').join('')+'</table></div>'
    : '<p class="muted">No catalog entries reported.</p>');
}
function refreshCapabilityCatalog() { runtimeQuery('capability.introspect', {}).then(renderCapabilityCatalog).catch(() => renderCapabilityCatalog(null)); }
function renderSurveillanceFindings(value) {
  const target = document.getElementById('surveillance-findings-panel');
  if (!target) return;
  // WA-23: no campaign selected or the query failed is "unavailable", not
  // "zero findings" — those read as opposite operator conclusions.
  if (value == null) { target.innerHTML = '<h3 class="section-title">Surveillance findings</h3><p class="muted unavailable">Surveillance findings are unavailable — select a campaign or check runtime connectivity.</p>'; return; }
  const findings = Array.isArray(value.findings) ? value.findings : [];
  target.innerHTML = '<h3 class="section-title">Surveillance findings ('+findings.length+')</h3>'+(findings.length
    ? '<ul>'+findings.slice(0, 100).map((finding) => '<li><strong>'+esc(finding.severity || '?')+'</strong> '+esc(finding.kind || '?')+' — '+esc(finding.summary || '?')+'</li>').join('')+'</ul>'
    : '<p class="muted">No surveillance findings recorded.</p>');
}
function renderCommunications(selectionValue, historyValue) {
  const target = document.getElementById('communications-panel');
  if (!target) return;
  // WA-23: a failed/unselected query window is unavailable, not "none
  // recorded" — the latter implies the window was checked and is empty.
  const renderWindow = (value, label) => {
    if (value == null) return '<h4>'+esc(label)+'</h4><p class="muted unavailable">Unavailable.</p>';
    const comms = Array.isArray(value.communications) ? value.communications : [];
    return '<h4>'+esc(label)+' ('+comms.length+')</h4>'+(comms.length
      ? '<ul>'+comms.slice(0, 50).map((record) => { const comm = record.communication || record; return '<li>'+esc(comm.kind || '?')+' · '+esc(comm.capability_tier || '?')+' · '+esc(comm.author_node_id || '?')+' → '+esc(comm.recipient_node_id || '?')+'</li>'; }).join('')+'</ul>'
      : '<p class="muted">None recorded.</p>');
  };
  target.innerHTML = '<h3 class="section-title">Node communications</h3>'+renderWindow(selectionValue, 'Selection window')+renderWindow(historyValue, 'Full history');
}
function renderSubagentExecutions(value) {
  const target = document.getElementById('subagent-executions-panel');
  if (!target) return;
  // WA-23: a failed/unselected subagent.executions query is unavailable,
  // not zero executions.
  if (value == null) { target.innerHTML = '<h3 class="section-title">Subagent executions</h3><p class="muted unavailable">Subagent executions are unavailable — select a campaign or check runtime connectivity.</p>'; return; }
  const rows = Array.isArray(value) ? value : [];
  target.innerHTML = '<h3 class="section-title">Subagent executions ('+rows.length+')</h3>'+(rows.length
    ? '<ul>'+rows.slice(0, 100).map((row) => '<li>'+esc(row.id || '?')+' · '+esc(humanizeEnum(row.state || '?'))+' · parent '+esc(row.parent_node_id || '?')+' · requested by '+esc(row.requested_by || '?')+'</li>').join('')+'</ul>'
    : '<p class="muted">No subagent executions recorded.</p>');
}
function refreshOperatorReadPanels() {
  refreshOutputCaptures();
  refreshCapabilityCatalog();
  api('/api/campaigns').then((campaigns) => {
    const list = Array.isArray(campaigns) ? campaigns : [];
    const campaignId = selectedCampaignDetailId || (list[0] && list[0].id) || null;
    if (!campaignId) { renderSurveillanceFindings(null); renderCommunications(null, null); renderSubagentExecutions(null); return; }
    runtimeQuery('surveillance.findings', {campaign_id: campaignId, limit: 200}).then(renderSurveillanceFindings).catch(() => renderSurveillanceFindings(null));
    runtimeQuery('subagent.executions', {campaign_id: campaignId}).then(renderSubagentExecutions).catch(() => renderSubagentExecutions(null));
    api('/api/campaigns/'+encodeURIComponent(campaignId)).then((snap) => {
      const nodes = Array.isArray(snap?.nodes) ? snap.nodes : [];
      const rootNode = nodes.find((n) => !n.parent_id) || nodes[0];
      if (!rootNode) { renderCommunications(null, null); return; }
      Promise.all([
        runtimeQuery('communication.selection', {campaign_id: campaignId, node_id: rootNode.id, limit: 50}).catch(() => null),
        runtimeQuery('communication.history', {campaign_id: campaignId, node_id: rootNode.id, limit: 50}).catch(() => null),
      ]).then(([selection, history]) => renderCommunications(selection, history));
    }).catch(() => renderCommunications(null, null));
  }).catch(() => { renderSurveillanceFindings(null); renderCommunications(null, null); renderSubagentExecutions(null); });
}

// ---- Operator mutating controls (C-07/C-08 hollow-parity BLOCKER rows:
// job.submit, output.capture, sibling.spawn, surveillance.scan) -------
// job.submit and output.capture already have an operator form in the TUI
// (default-catalog.ts's JOB_SUBMIT_ACTION_ID / OUTPUT_CAPTURE_ACTION_ID);
// this mirrors the same catalog contract on the web surface. sibling.spawn
// has no TUI form either, but is authorized the same way (no privileged
// caller context required) — unlike peer.grant, which the unauthenticated
// webui router can never satisfy (see the api-only note on peer.* below)
// and is deliberately NOT given a control here.
function mutatingOperationStatus(message, failed = false) {
  const target = document.getElementById('mutating-operation-status');
  if (target) { target.textContent = message; target.style.color = failed ? 'var(--fail)' : ''; }
}
function submitJobForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const owner_scope_id = String(data.get('owner_scope_id') || '').trim();
  const job_kind = String(data.get('job_kind') || '').trim();
  if (!owner_scope_id || !job_kind) { mutatingOperationStatus('Campaign id and job kind are required.', true); return; }
  if (!window.confirm('Submit job kind "'+job_kind+'" against '+owner_scope_id+'?')) { mutatingOperationStatus('Job submission was not confirmed.'); return; }
  const stamp = nextRuntimeOperationId('job.submit');
  mutatingOperationStatus('Submitting job…');
  runtimeCommand('job.submit', { id: stamp, operation_id: stamp, job_kind, owner_scope_id, idempotency_key: stamp })
    .then((result) => { mutatingOperationStatus('Job '+esc(result?.job?.id || stamp)+' submitted.'); event.currentTarget.reset(); })
    .catch((error) => mutatingOperationStatus('Job submission unavailable: '+error.message, true));
}
function captureOutputForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const campaign_id = String(data.get('campaign_id') || '').trim();
  const node_id = String(data.get('node_id') || '').trim();
  const media_type = String(data.get('media_type') || '').trim();
  const stream = String(data.get('stream') || 'other');
  const content = String(data.get('content') || '');
  if (!campaign_id || !node_id || !media_type || !content) { mutatingOperationStatus('Campaign id, node id, media type, and content are required.', true); return; }
  if (!window.confirm('Capture '+content.length+' byte(s) of '+stream+' output evidence for '+campaign_id+'/'+node_id+'?')) { mutatingOperationStatus('Output capture was not confirmed.'); return; }
  mutatingOperationStatus('Capturing output evidence…');
  runtimeCommand('output.capture', { artifact: { campaign_id, node_id, media_type, stream, provenance: operatorProvenance('output capture') }, content })
    .then((result) => { mutatingOperationStatus('Output captured: '+esc(result?.output?.descriptor?.id || 'accepted')+'.'); event.currentTarget.reset(); refreshOutputCaptures(); })
    .catch((error) => mutatingOperationStatus('Output capture unavailable: '+error.message, true));
}
function spawnSiblingForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const campaign_id = String(data.get('campaign_id') || '').trim();
  const parent_node_id = String(data.get('parent_node_id') || '').trim();
  const description = String(data.get('description') || '').trim();
  const category = String(data.get('category') || '').trim();
  const delegate_to = String(data.get('delegate_to') || '').trim();
  const estimated_gain = Number(data.get('estimated_gain'));
  const estimated_cost = Number(data.get('estimated_cost'));
  if (!campaign_id || !parent_node_id || !description || !category || !delegate_to || !Number.isFinite(estimated_gain) || !Number.isFinite(estimated_cost)) {
    mutatingOperationStatus('All sibling-spawn fields are required.', true); return;
  }
  if (!window.confirm('Spawn a sibling under '+campaign_id+'/'+parent_node_id+' in a new isolated worktree?')) { mutatingOperationStatus('Sibling spawn was not confirmed.'); return; }
  mutatingOperationStatus('Spawning sibling…');
  runtimeCommand('sibling.spawn', { campaign_id, parent_node_id, action: { description, category, delegate_to, estimated_gain, estimated_cost } })
    .then((result) => { mutatingOperationStatus('Sibling spawned: '+esc(result?.child_node_id || 'accepted')+'.'); event.currentTarget.reset(); refreshSelectedCampaignDetail(); })
    .catch((error) => mutatingOperationStatus('Sibling spawn unavailable: '+error.message, true));
}
function runSurveillanceScanForm(event) {
  event.preventDefault();
  const campaign_id = String(new FormData(event.currentTarget).get('campaign_id') || '').trim();
  if (!campaign_id) { mutatingOperationStatus('A campaign id is required.', true); return; }
  if (!window.confirm('Run a surveillance scan against '+campaign_id+'?')) { mutatingOperationStatus('Surveillance scan was not confirmed.'); return; }
  mutatingOperationStatus('Running surveillance scan…');
  runtimeCommand('surveillance.scan', { campaign_id })
    .then((result) => { mutatingOperationStatus('Scan recorded '+esc(result?.newly_recorded_count ?? 0)+' new finding(s) of '+esc(result?.finding_count ?? 0)+' total.'); refreshOperatorReadPanels(); })
    .catch((error) => mutatingOperationStatus('Surveillance scan unavailable: '+error.message, true));
}

// ---- System operations --------------------------------------------
// Every control here stays a projection of an existing catalog contract. It
// has no local authority: if a deployment omits a contract, the workspace
// names that limitation rather than silently presenting a successful state.
let operationSessions = [];
function operationStatus(message, failed = false) { workspaceStatus(message, failed); }
function operationItems(value, keys) {
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}
function operationText(value, keys, fallback = 'not recorded') {
  for (const key of keys) if (typeof value?.[key] === 'string' && value[key].trim()) return value[key];
  return fallback;
}
function operationList(values, fallback = 'not recorded') {
  const list = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.trim()) : [];
  return list.length ? list.map(esc).join(', ') : esc(fallback);
}
function unavailableOperation(title, reason) {
  return '<div class="operation-card"><h3>'+esc(title)+'</h3><p class="muted unavailable">Unavailable: '+esc(reason || 'this runtime did not expose a status projection.')+'</p></div>';
}
function operationButton(label, handler, danger = false) {
  return '<button type="button"'+(danger ? ' class="danger"' : '')+' onclick="'+handler+'">'+esc(label)+'</button>';
}
// Audit 2026-08-23 WA-28: the former card-level Enable/Disable remote and
// Resume/Pause scheduler buttons sent payloads the runtime validator rejects
// on every click (no target id, invalid actions, no acknowledge_risk or
// provenance). The contract is per-entity: remote.control revokes ONE
// session; scheduler.control suspends (with a reason) or resumes ONE
// schedule. Render those controls from the real inspect projections.
function remoteSessionControls(sessions) {
  const items = Array.isArray(sessions) ? sessions.filter((s) => s && s.state !== 'revoked') : [];
  if (!items.length) return '<p class="muted">No active remote sessions. Enrol one with <code>arbor remote-grant</code>; revocation is per session.</p>';
  return '<div class="operation-actions">'+items.map((s) => operationButton('Revoke '+s.session_id, "confirmOperation('remote.control', {action:'revoke', session_id:"+esc(JSON.stringify(String(s.session_id)))+"}, 'Revoke remote session "+esc(s.session_id)+"? Its operators are disconnected and its grants stop verifying.')", true)).join('')+'</div>';
}
function scheduleControls(schedules) {
  const items = Array.isArray(schedules) ? schedules.filter((s) => s && (s.state === 'active' || s.state === 'paused' || s.state === 'human_required')) : [];
  if (!items.length) return '<p class="muted">No controllable schedules. Register one with <code>arbor scheduler register</code>.</p>';
  return '<div class="operation-actions">'+items.map((s) => s.state === 'active'
    ? operationButton('Suspend '+s.schedule_id, "suspendSchedule("+esc(JSON.stringify(String(s.schedule_id)))+")", true)
    : operationButton('Resume '+s.schedule_id, "confirmOperation('scheduler.control', {action:'resume', schedule_id:"+esc(JSON.stringify(String(s.schedule_id)))+"}, 'Resume schedule "+esc(s.schedule_id)+"? Due work may start on the next tick.')")).join('')+'</div>';
}
function suspendSchedule(schedule_id) {
  const reason = window.prompt('Reason for suspending '+schedule_id+' (recorded with the operation):', '');
  if (reason === null || !reason.trim()) { operationStatus('Suspension needs a reason.', true); return; }
  confirmOperation('scheduler.control', {action:'suspend', schedule_id, reason:reason.trim()}, 'Suspend schedule '+schedule_id+'? Existing work is not automatically interrupted.');
}
function confirmOperation(kind, params, prompt) {
  if (!window.confirm(prompt)) { operationStatus('Operation was not confirmed.'); return; }
  operationStatus('Submitting '+kind+'…');
  runtimeCommand(kind, {...params, confirmed:true, acknowledge_risk:true, provenance:operatorProvenance(kind)})
    .then(() => { operationStatus(kind+' accepted by the runtime.'); refreshSystemOperations(); })
    .catch((error) => operationStatus(kind+' unavailable: '+error.message, true));
}
const operatorProvenance = (input) => ({tag:'claimed', claimant:'webui-operator', note:String(input || 'operator-confirmed').slice(0, 256)});
function migrationApply(event) {
  event.preventDefault(); const form = event.currentTarget; const source_path = String(new FormData(form).get('source_path') || '').trim(); const expected_source_sha256 = String(new FormData(form).get('expected_source_sha256') || '').trim(); const overwrite = new FormData(form).get('overwrite') === 'on';
  if (!source_path || !expected_source_sha256) { operationStatus('Preview source path and SHA-256 are required.', true); return; }
  if (!window.confirm('Apply this previewed migration? This can change durable state.')) return;
  runtimeCommand('migration.apply', {source_path, expected_source_sha256, overwrite, provenance:operatorProvenance('migration apply')}).then(() => { operationStatus('Migration apply accepted.'); refreshSystemOperations(); }).catch((error) => operationStatus('Migration apply unavailable: '+error.message, true));
}
function migrationRollback(event) {
  event.preventDefault(); const receipt_id = String(new FormData(event.currentTarget).get('receipt_id') || '').trim();
  if (!receipt_id) { operationStatus('A migration receipt id is required.', true); return; }
  if (!window.confirm('Roll back this migration receipt? This can revert durable state.')) return;
  runtimeCommand('migration.rollback', {receipt_id, provenance:operatorProvenance('migration rollback')}).then(() => { operationStatus('Migration rollback accepted.'); refreshSystemOperations(); }).catch((error) => operationStatus('Migration rollback unavailable: '+error.message, true));
}
function integrationAdmit(integrationId) {
  const raw = window.prompt('Optional capability ids to admit (comma-separated, at most 16):', ''); if (raw === null) return;
  const capabilities = raw.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 16);
  runtimeQuery('integration.admit', {integration_id:integrationId, capabilities}).then(() => { operationStatus('Integration admission reviewed.'); refreshSystemOperations(); }).catch((error) => operationStatus('Integration admission unavailable: '+error.message, true));
}
function integrationMutation(kind, integration_id) {
  const version = kind === 'integration.update' ? window.prompt('Exact target SemVer (for example 1.2.3):', '') : undefined; if (kind === 'integration.update' && version === null) return;
  if (!window.confirm(humanizeEnum(kind)+' requires the disclosed authority. Continue?')) return;
  runtimeCommand(kind, {integration_id, ...(version === undefined ? {} : {version:version.trim()}), acknowledge_risk:true, provenance:operatorProvenance(kind)}).then(() => { operationStatus(kind+' accepted.'); refreshSystemOperations(); }).catch((error) => operationStatus(kind+' unavailable: '+error.message, true));
}
function previewMigration() {
  operationStatus('Loading migration preview…');
  runtimeQuery('migration.preview').then((preview) => {
    const target = document.getElementById('system-operations-status');
    if (target) target.textContent = 'Migration preview: '+JSON.stringify(preview).slice(0, 500);
  }).catch((error) => operationStatus('Migration preview unavailable: '+error.message, true));
}
function inspectIntegration(integrationId) {
  const target = document.getElementById('integration-disclosure');
  if (target) { target.classList.remove('hidden'); target.innerHTML = '<div class="card"><span class="muted">Loading integration disclosure…</span></div>'; }
  runtimeQuery('integration.inspect', {integration_id:integrationId}).then((detail) => {
    const permissions = operationItems(detail, ['permissions', 'required_permissions', 'capabilities']);
    const dependencies = operationItems(detail, ['dependencies', 'required_dependencies']);
    if (target) target.innerHTML = '<div class="card"><h2 class="section-title">Integration disclosure: '+esc(integrationId)+'</h2><dl class="evidence-facts"><dt>Permissions</dt><dd>'+operationList(permissions, 'not disclosed')+'</dd><dt>Dependencies</dt><dd>'+operationList(dependencies, 'not disclosed')+'</dd><dt>Status</dt><dd>'+esc(operationText(detail, ['status', 'state', 'availability']))+'</dd></dl><pre>'+esc(JSON.stringify(detail, null, 2).slice(0, 16_000))+'</pre></div>';
  }).catch((error) => { if (target) target.innerHTML = '<div class="card"><span class="muted unavailable">Integration disclosure unavailable: '+esc(error.message)+'</span></div>'; });
}
function filterOperationSessions(query) {
  const needle = String(query || '').toLocaleLowerCase();
  const rows = operationSessions.filter((session) => JSON.stringify(session).toLocaleLowerCase().includes(needle));
  const target = document.getElementById('operation-session-rows');
  if (!target) return;
  target.innerHTML = rows.length ? rows.slice(0, 100).map((session) => '<tr><td>'+esc(operationText(session, ['session_id', 'id'], 'unidentified'))+'</td><td>'+esc(humanizeEnum(operationText(session, ['state', 'status'], 'unknown')))+'</td><td>'+operationList(session?.tags, 'none')+'</td><td>'+esc(operationText(session, ['display_name', 'name'], 'unnamed'))+'</td></tr>').join('') : '<tr><td colspan="4" class="muted">No sessions match this filter.</td></tr>';
}
function renderFlightControl(projection) {
  const target = document.getElementById('flight-control'); if (!target) return;
  const actions = '<div class="operation-actions"><button type="button" onclick="refreshFlightControl(\\'control.status\\')">Status</button><button type="button" onclick="refreshFlightControl(\\'control.discover\\')">Discover hosts</button><button type="button" onclick="refreshFlightControl(\\'control.inbox\\')">Redacted inbox</button></div>';
  let h = '<div class="card"><h2 class="section-title">Distributed flight control</h2><p class="muted">Coordinator, live-host, fencing transport, and durable delivery visibility. Message payload bodies and credentials are never projected.</p>'+actions;
  if (!projection || projection.availability === 'disabled') { target.innerHTML = h+'<p class="muted unavailable">'+esc(projection?.remediation || 'Set ARBOR_DISTRIBUTED_CONTROL_CONFIG to a closed v1 authority or join config, then restart this runtime.')+'</p></div>'; return; }
  const value = projection.value || {};
  if (projection.kind === 'control.status') { const coordinator=value.coordinator||{}, registration=value.registration||{}, bridge=value.bridge||{}; h += '<dl class="evidence-facts"><dt>Role / host</dt><dd>'+esc(value.role||'unknown')+' / '+esc(value.host_id||'authority')+'</dd><dt>Runtime</dt><dd>'+esc(value.state||'unknown')+'</dd><dt>Coordinator</dt><dd>'+(coordinator.reachable?'reachable':'offline: '+esc(coordinator.error||'unconfigured'))+'</dd><dt>Heartbeat</dt><dd>'+esc(registration.heartbeat_at||'not registered')+'</dd><dt>Bridge</dt><dd>'+esc(bridge.status||'disabled')+' · outbox '+esc(bridge.outbox_pending??0)+' · results '+esc(bridge.results_pending??0)+' · dead letters '+esc(bridge.dead_letters??0)+'</dd><dt>Ledger refresh</dt><dd>'+esc(projection.updated_at||'pending')+'</dd></dl>'; }
  else if (projection.kind === 'control.discover') { const hosts=Array.isArray(value.hosts)?value.hosts.slice(0,100):[]; h += hosts.length?'<div class="table-scroll" tabindex="0"><table><caption class="sr-only">Live distributed control hosts</caption><tr><th>Host</th><th>Repository</th><th>Session</th><th>Capabilities</th><th>Heartbeat</th><th>Expires</th></tr>'+hosts.map((host)=>'<tr><td>'+esc(host.host_id||'?')+'</td><td>'+esc(host.repo_id||'?')+'</td><td>'+esc(host.session_id||'?')+'</td><td>'+esc(Array.isArray(host.capabilities)?host.capabilities.slice(0,16).join(', '):'none')+'</td><td>'+esc(host.heartbeat_at||'—')+'</td><td>'+esc(host.expires_at||'—')+'</td></tr>').join('')+'</table></div>':'<p class="muted">No live hosts are currently advertised.</p>'; }
  else { const messages=Array.isArray(value.messages)?value.messages.slice(0,100):[]; h += messages.length?'<div class="table-scroll" tabindex="0"><table><caption class="sr-only">Redacted durable coordinator inbox</caption><tr><th>Seq</th><th>Sender</th><th>Kind</th><th>Correlation</th><th>Created</th><th>Attempts</th><th>Payload bytes</th><th>Claimed</th></tr>'+messages.map((message)=>'<tr><td>'+esc(message.sequence??'—')+'</td><td>'+esc(message.sender_host_id||'?')+'</td><td>'+esc(message.kind||'?')+'</td><td>'+esc(message.correlation_id||'—')+'</td><td>'+esc(message.created_at||'—')+'</td><td>'+esc(message.delivery_attempts??'—')+'</td><td>'+esc(message.payload_bytes??'—')+'</td><td>'+(message.claimed?'yes':'no')+'</td></tr>').join('')+'</table></div>':'<p class="muted">The durable inbox has no visible pending messages.</p>'; }
  target.innerHTML = h+'</div>';
}
function refreshFlightControl(kind='control.status') { runtimeQuery(kind, kind==='control.status'?{}:{limit:100}).then(renderFlightControl).catch((error)=>renderFlightControl({availability:'disabled',remediation:'Flight control projection unavailable: '+error.message})); }
function renderSystemOperations(view) {
  const target = document.getElementById('system-operations');
  if (!target) return;
  const doctor = view?.doctor;
  const migration = doctor?.migration;
  const integrations = operationItems(doctor?.operational, ['integrations']);
  const remote = doctor?.operational?.remote;
  const scheduler = doctor?.operational?.scheduler;
  const extensions = doctor?.operational?.extensions;
  const continuity = doctor?.operational?.sessions;
  const doctorChecks = operationItems(doctor, ['next_actions', 'checks', 'findings', 'remediations', 'items']);
  let h = '<div class="card"><h2 class="section-title">System operations</h2><p class="muted">Status projections and governed remediation. Risky changes require a separate browser confirmation and may still be rejected by runtime policy.</p><p id="system-operations-status" role="status" aria-live="polite"></p><div class="operation-grid">';
  h += doctor ? '<div class="operation-card"><h3>System doctor v'+esc(doctor.schema_version||'?')+'</h3><p>Persistence '+esc(doctor.persistence?.inventory_agrees?'consistent':'needs attention')+' · extensions '+esc(extensions?.status||'unobserved')+' · sessions '+esc(continuity?.status||'unobserved')+'</p><ul class="operation-facts">'+(doctorChecks.length ? doctorChecks.slice(0, 8).map((check) => '<li>'+esc(operationText(check, ['action', 'summary', 'message', 'code', 'id', 'name']))+'</li>').join('') : '<li>No remediation findings were recorded.</li>')+'</ul></div>' : unavailableOperation('System doctor', view?.doctor_error);
  h += migration ? '<div class="operation-card"><h3>Migration</h3><p>'+esc(operationText(migration, ['status', 'state', 'summary']))+'</p><div class="operation-actions">'+operationButton('Preview', 'previewMigration()')+'</div><form onsubmit="migrationApply(event)"><label>Preview source path<input name="source_path" required maxlength="4096"></label><label>Preview SHA-256<input name="expected_source_sha256" required pattern="sha256:[a-f0-9]{64}"></label><label><input name="overwrite" type="checkbox"> Explicit overwrite</label><button class="danger" type="submit">Apply reviewed migration</button></form><form onsubmit="migrationRollback(event)"><label>Migration receipt id<input name="receipt_id" required pattern="migration-[a-z0-9-]+"></label><button class="danger" type="submit">Rollback receipt</button></form></div>' : unavailableOperation('Migration', view?.migration_error);
  h += remote ? '<div class="operation-card"><h3>Remote control</h3><p>'+esc(remote.status)+' · '+esc(remote.registered_sessions)+' registered session(s)<br><span class="muted">'+esc(remote.detail)+'</span></p>'+remoteSessionControls(view?.remote_sessions)+'</div>' : unavailableOperation('Remote control', 'Unified doctor did not inspect remote authority.');
  h += scheduler ? '<div class="operation-card"><h3>Scheduler</h3><p>'+esc(scheduler.status)+' · '+esc(scheduler.active)+'/'+esc(scheduler.schedules)+' active · '+esc(scheduler.runs)+' recorded run(s)<br><span class="muted">'+esc(scheduler.detail)+'</span></p>'+scheduleControls(view?.schedules)+'</div>' : unavailableOperation('Scheduler', 'Unified doctor did not inspect scheduler composition.');
  h += '</div><h3 class="section-title">Integrations</h3>';
  if (!integrations.length) h += '<p class="muted unavailable">No integration inventory is available from this runtime.</p>';
  else { h += '<div class="table-scroll" tabindex="0" aria-label="Integration inventory"><table><caption class="sr-only">Integration inventory and required disclosures</caption><tr><th>Name</th><th>Status</th><th>Permissions and dependencies</th><th>Governed actions</th></tr>'+integrations.slice(0, 100).map((integration) => { const id = operationText(integration, ['integration_id', 'id', 'name'], 'unidentified'); const idJson = esc(JSON.stringify(id)); const action = (kind, label, danger = false) => operationButton(label, "integrationMutation('"+kind+"', "+idJson+")", danger); return '<tr><td>'+esc(id)+'</td><td>'+esc(humanizeEnum(operationText(integration, ['status', 'state', 'availability'])))+'</td><td><button type="button" onclick="inspectIntegration('+idJson+')">inspect disclosure</button></td><td><button type="button" onclick="integrationAdmit('+idJson+')">Admit</button>'+action('integration.install', 'Install', true)+action('integration.enable', 'Enable', true)+action('integration.disable', 'Disable', true)+action('integration.update', 'Update', true)+'</td></tr>'; }).join('')+'</table></div>'; }
  h += '<h3 class="section-title">Session finder</h3><label for="operation-session-filter" class="sr-only">Filter session history</label><input id="operation-session-filter" class="session-filter" type="search" placeholder="Filter by session, state, tag, or name" oninput="filterOperationSessions(this.value)"><div class="table-scroll" tabindex="0" aria-label="Filtered session inventory"><table><caption class="sr-only">Filtered session inventory</caption><tr><th>Session</th><th>State</th><th>Tags</th><th>Name</th></tr><tbody id="operation-session-rows"></tbody></table></div>';
  h += '<h3 class="section-title">Result evidence metrics</h3><div id="operation-result-metrics" class="metrics-grid"><span class="muted">Loading durable result metrics…</span></div><div id="durable-product-records" class="card"><span class="muted">Loading durable notifications, identities, verification, and lineage…</span></div></div><div id="integration-disclosure" class="hidden"></div>';
  target.innerHTML = h;
  operationSessions = operationItems(view?.sessions, ['sessions', 'items']);
  filterOperationSessions('');
}
function renderOperationMetrics(groups) {
  const target = document.getElementById('operation-result-metrics');
  if (!target) return;
  const records = Array.isArray(groups) ? groups.flatMap((group) => operationItems(group, ['items', 'records'])) : [];
  if (!records.length) { target.innerHTML = '<span class="muted unavailable">Result metrics are unavailable or no durable captures were retained.</span>'; return; }
  target.innerHTML = records.slice(0, 100).map((record) => { const checks = operationItems(record, ['checks', 'verification_checks']); const files = operationItems(record, ['files_changed', 'files']); const diff = record?.diffstat || {}; const duration = checks.reduce((total, check) => total + (Number.isFinite(check?.duration_ms) ? check.duration_ms : 0), 0); return '<div class="metric"><strong>'+esc(operationText(record, ['node_id', 'id'], 'result'))+'</strong><span>checks: '+checks.length+' · files: '+files.length+'</span><span>+ '+esc(diff.additions ?? 'unavailable')+' / - '+esc(diff.deletions ?? 'unavailable')+'</span><span>duration: '+esc(duration || 'unavailable')+' ms · confidence: '+esc(record?.confidence ?? 'unavailable')+'</span><span>provenance: '+esc(record?.provenance?.tag ?? 'unavailable')+'</span></div>'; }).join('');
}
function refreshSystemOperations() {
  Promise.all([
    runtimeQuery('doctor.get').catch((error) => ({__error:String(error)})),
    runtimeQuery('harness.session.list', {limit:200}).catch((error) => ({__error:String(error)})),
    runtimeQuery('remote.inspect').catch(() => null),
    runtimeQuery('scheduler.inspect').catch(() => null),
  ]).then(([doctor, sessions, remote, scheduler]) => {
    renderSystemOperations({ doctor:doctor?.__error ? null : doctor, doctor_error:doctor?.__error, sessions:sessions?.__error ? null : sessions, remote_sessions:remote?.sessions, schedules:scheduler?.schedules });
    return api('/api/campaigns').then((campaigns) => Promise.all((Array.isArray(campaigns) ? campaigns : []).map((campaign) => runtimeQuery('result.list', {campaign_id:campaign.id}).catch(() => ({items:[]})))));
  }).then(renderOperationMetrics).catch(() => renderOperationMetrics([]));
  refreshDurableProductRecords();
}
function markDurableNotificationRead(notification_id) { runtimeCommand('notification.read', {notification_id}).then(() => refreshDurableProductRecords()).catch((error) => operationStatus('Notification update unavailable: '+error.message, true)); }
function editSessionIdentity(session_id) { const display_name = window.prompt('Durable session display name (blank clears):', ''); if (display_name === null) return; const raw = window.prompt('Tags (comma-separated, at most 12):', ''); if (raw === null) return; const tags = raw.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 12); runtimeCommand('session.identity.mutate', {session_id, display_name:display_name || null, tags, provenance:operatorProvenance('session identity')}).then(() => refreshDurableProductRecords()).catch((error) => operationStatus('Session identity update unavailable: '+error.message, true)); }
function createDurableFollowup(parent_campaign_id) { const node_id = window.prompt('Source result node id:', ''); if (!node_id) return; runtimeCommand('followup.create', {parent_campaign_id, source_result:{campaign_id:parent_campaign_id, node_id}, source_node:null, provenance:operatorProvenance('follow-up lineage')}).then(() => refreshDurableProductRecords()).catch((error) => operationStatus('Follow-up creation unavailable: '+error.message, true)); }
function refreshDurableProductRecords() { const target = document.getElementById('durable-product-records'); if (!target) return; Promise.all([runtimeQuery('notification.list', {limit:50}).catch(() => ({notifications:[]})), runtimeQuery('session.identity.search', {limit:50}).catch(() => ({items:[]})), api('/api/campaigns').catch(() => [])]).then(([notificationView, identityView, campaigns]) => { const notifications = operationItems(notificationView, ['notifications', 'items']); const identities = operationItems(identityView, ['items', 'sessions']); const firstCampaign = Array.isArray(campaigns) && campaigns[0]?.id ? campaigns[0].id : null; const reads = firstCampaign ? Promise.all([runtimeQuery('result.verification.list', {campaign_id:firstCampaign, limit:50}).catch(() => ({records:[]})), runtimeQuery('followup.list', {parent_campaign_id:firstCampaign, limit:50}).catch(() => ({follow_ups:[]}))]) : Promise.resolve([{records:[]}, {follow_ups:[]}]); return reads.then(([verification, lineage]) => ({notifications, identities, verification:operationItems(verification, ['records', 'items']), lineage:operationItems(lineage, ['follow_ups', 'items']), firstCampaign})); }).then((view) => { const notes = view.notifications.slice(0, 20).map((item) => '<li>'+esc(operationText(item, ['title', 'body', 'id']))+' '+(item.read_at ? '' : '<button type="button" onclick="markDurableNotificationRead('+esc(JSON.stringify(operationText(item, ['id'], '')))+')">mark read</button>')+'</li>').join('') || '<li class="muted">No durable notifications.</li>'; const identities = view.identities.slice(0, 20).map((item) => { const id = operationText(item, ['session_id', 'id']); return '<li>'+esc(id)+' · '+esc(operationText(item, ['display_name', 'name'], 'unnamed'))+' <button type="button" onclick="editSessionIdentity('+esc(JSON.stringify(id))+')">name/tags</button></li>'; }).join('') || '<li class="muted">No named sessions.</li>'; const verification = view.verification.slice(0, 20).map((item) => '<li>'+esc(operationText(item, ['node_id', 'id']))+' · confidence '+esc(String(item.confidence ?? 'unavailable'))+' · '+esc(String(item.provenance?.tag ?? 'unavailable'))+'</li>').join('') || '<li class="muted">No durable verification records.</li>'; const lineage = view.lineage.slice(0, 20).map((item) => '<li>'+esc(operationText(item, ['id', 'parent_campaign_id']))+'</li>').join('') || '<li class="muted">No follow-up lineage.</li>'; target.innerHTML = '<h3 class="section-title">Durable product records</h3><div class="operation-grid"><div><strong>Notifications</strong><ul>'+notes+'</ul></div><div><strong>Session identities</strong><ul>'+identities+'</ul></div><div><strong>Verification</strong><ul>'+verification+'</ul></div><div><strong>Follow-up lineage</strong><ul>'+lineage+'</ul>'+(view.firstCampaign ? '<button type="button" onclick="createDurableFollowup('+esc(JSON.stringify(view.firstCampaign))+')">Create follow-up</button>' : '')+'</div></div>'; }).catch(() => { target.textContent = 'Durable product records are unavailable from this runtime.'; }); }

function renderCampaigns(data) {
  const c = document.getElementById('campaigns');
  if (!c) return;
  const list = (data && data.campaigns) ? data.campaigns : (Array.isArray(data) ? data : []);
  if (!list.length) { c.innerHTML = '<div class="card"><span class="muted">No campaigns yet. Describe a change in the task workspace above to start one.</span></div>'; return; }
  let h = '';
  for (const cam of list) {
    const campaignArg = sessionArg(cam.id);
    const running = !cam.halted ? '<span class="status-dot dot-ok pulse"></span>' : '<span class="status-dot dot-warn"></span>';
    const outcome = cam.halted ? humanizeEnum(cam.terminal_outcome || cam.halt_reason || 'halted') : humanizeEnum(cam.root_node_state || 'running');
    h += '<button type="button" class="campaign-card" onclick="loadDetail(decodeURIComponent(\\''+campaignArg+'\\'))" aria-label="Open campaign '+esc(cam.id)+'">' +
      running + '<strong>'+esc(cam.id)+'</strong> ' +
      '<span class="muted">'+esc(cam.plan_path)+'</span> ' +
      (cam.halted ? '<span class="badge badge-halted">'+esc(outcome)+'</span>' : '<span class="badge badge-running">'+esc(outcome)+'</span>') +
      '<br><span class="muted">iters: '+cam.iterations_completed+' | best: '+cam.best_score.toFixed(2)+' | nodes: '+cam.total_nodes+' | verified: '+esc(cam.verified_nodes ?? 0)+'</span>' +
      '</button>';
  }
  c.innerHTML = h;
}

function treeStateClass(state) { return 'state-'+String(state || 'unknown').replace(/[^a-z0-9-]/gi, '-').toLowerCase(); }
function shortTreeLabel(value, limit=28) { const text=String(value || 'unnamed action').replace(/\\s+/g,' ').trim(); return text.length > limit ? text.slice(0, limit-1)+'…' : text; }
function nodeFailureSummary(node) { if(node?.state!=='failed'||typeof node?.specialist_output!=='string')return ''; const text=node.specialist_output.replace(/^FAILED:\\s*/,'').replace(/\\s+/g,' ').trim(); return text.length>320?text.slice(0,319)+'…':text; }
function activeTreePath(nodes, activeNode) { const byId=new Map(nodes.map((node)=>[node.id,node])); const ids=new Set(); let cursor=activeNode; while(cursor){ ids.add(cursor.id); cursor=cursor.parent_id ? byId.get(cursor.parent_id) : null; } return ids; }
function kineticTreeMarkup(snap) {
  const nodes=Array.isArray(snap.nodes)?snap.nodes:[]; const byId=new Map(nodes.map((node)=>[node.id,node]));
  const prior=kineticTreeHistory.get(snap.id)||new Map(); const changed=new Set(); const fresh=new Set(); const backtracked=new Set();
  for(const node of nodes){ if(!prior.has(node.id)) fresh.add(node.id); else if(prior.get(node.id)!==node.state){ changed.add(node.id); if(['failed','pruned','interrupted','abandoned'].includes(node.state)) backtracked.add(node.id); } }
  kineticTreeHistory.set(snap.id,new Map(nodes.map((node)=>[node.id,node.state])));
  const active=nodes.find((node)=>node.state==='expanding')||nodes.find((node)=>node.state==='claimed')||null; const activePath=activeTreePath(nodes,active);
  const levels=new Map(); for(const node of nodes){ const depth=Number.isSafeInteger(node.depth)?node.depth:0; const level=levels.get(depth)||[]; level.push(node); levels.set(depth,level); }
  const positions=new Map(); for(const [depth,level] of levels){ level.forEach((node,index)=>positions.set(node.id,{x:80+((index+1)/(level.length+1))*840,y:64+depth*126})); }
  const maxDepth=Math.max(0,...nodes.map((node)=>Number.isSafeInteger(node.depth)?node.depth:0)); const height=Math.max(280,132+maxDepth*126);
  const edges=nodes.filter((node)=>node.parent_id&&positions.has(node.parent_id)).map((node)=>{ const from=positions.get(node.parent_id),to=positions.get(node.id); const bend=(from.y+to.y)/2; const activeEdge=activePath.has(node.id)&&activePath.has(node.parent_id); const cls=backtracked.has(node.id)?' is-backtrack':activeEdge?' is-active':''; return '<path class="kinetic-edge'+cls+'" d="M '+from.x+' '+(from.y+22)+' C '+from.x+' '+bend+', '+to.x+' '+bend+', '+to.x+' '+(to.y-22)+'"/>'; }).join('');
  const nodeSvg=nodes.map((node,index)=>{ const pos=positions.get(node.id)||{x:500,y:64}; const parent=node.parent_id?positions.get(node.parent_id):null; const dx=parent?parent.x-pos.x:0,dy=parent?parent.y-pos.y:0; const classes=['kinetic-node',treeStateClass(node.state),activePath.has(node.id)?'is-path':'',node.id===active?.id?'is-active':'',fresh.has(node.id)?'is-new':'',changed.has(node.id)?'is-changed':''].filter(Boolean).join(' '); const radius=17+Math.min(8,Math.max(0,Number(node.score)||0)); const failure=nodeFailureSummary(node); return '<g class="'+classes+'" transform="translate('+pos.x+' '+pos.y+')"><g class="node-motion" style="--dx:'+dx+'px;--dy:'+dy+'px"><title>'+esc(node.action_description)+' · '+esc(humanizeEnum(node.state))+(failure?' · '+esc(failure):'')+' · score '+esc(Number(node.score||0).toFixed(2))+' · visits '+esc(node.visit_count||0)+'</title>'+(node.id===active?.id?'<circle class="node-ring" r="'+(radius+9)+'"/>':'')+'<circle class="node-core" r="'+radius+'"/><text y="4">'+esc(index+1)+'</text><text class="node-meta" y="'+(radius+18)+'">'+esc(shortTreeLabel(node.action_description,24))+'</text></g></g>'; }).join('');
  const verified=nodes.filter((node)=>node.state==='verified').length, frontier=nodes.filter((node)=>node.state==='pending').length, closed=nodes.filter((node)=>['failed','pruned','interrupted','abandoned'].includes(node.state)).length; const progress=nodes.length?Math.round(verified/nodes.length*100):0;
  const activity=active?'In flight: '+shortTreeLabel(active.action_description,56):snap.halted?'Campaign halted':'Awaiting the next selection'; const transition=backtracked.size?' · backtracking from '+backtracked.size+' branch'+(backtracked.size===1?'':'es'):changed.size?' · '+changed.size+' state transition'+(changed.size===1?'':'s'):fresh.size?' · '+fresh.size+' node'+(fresh.size===1?'':'s')+' joined':''; const haltState=snap.halted?' · '+esc(humanizeEnum(snap.halt_reason)):'';
  const list=nodes.map((node,index)=>{const failure=nodeFailureSummary(node);return '<li><span class="node-index">'+String(index+1).padStart(2,'0')+'</span><span class="node-copy">'+badge(node.state)+' '+esc(node.action_description)+(failure?'<br><span class="muted">Why: '+esc(failure)+'</span>':'')+'</span><span class="node-telemetry">s'+esc(Number(node.score||0).toFixed(2))+' · v'+esc(node.visit_count||0)+'</span></li>';}).join('');
  const latestFailure=[...nodes].reverse().map(nodeFailureSummary).find(Boolean)||''; const recovery=snap.halted&&latestFailure?'<div class="adoption-notice" role="alert"><strong>Why work stopped</strong><br><span class="muted">'+esc(latestFailure)+'</span><br><span class="muted">Use a campaign-linked follow-up or retry after correcting the reported condition.</span></div>':'';
    const interruptControl='<div class="operation-actions"><button type="button" class="danger" onclick="interruptCampaign(decodeURIComponent(\\''+sessionArg(snap.id)+'\\'))">Interrupt campaign</button></div><p id="interrupt-status" role="status" aria-live="polite"></p>';
  return '<section class="card tree-hero" aria-labelledby="tree-hero-title"><div class="tree-hero-head"><div><span class="tree-kicker">Live cognition topology</span><h2 id="tree-hero-title" class="tree-title">'+esc(snap.id)+'</h2><span class="muted">'+esc(snap.plan_path)+' · iteration '+esc(snap.iterations_completed)+haltState+'</span></div><span class="tree-live">'+(snap.halted?'settled':'live traversal')+'</span></div>'+interruptControl+'<div class="tree-metrics"><div class="tree-metric"><strong>'+nodes.length+'</strong><span>nodes</span></div><div class="tree-metric"><strong>'+verified+'</strong><span>verified</span></div><div class="tree-metric"><strong>'+frontier+'</strong><span>frontier</span></div><div class="tree-metric"><strong>'+closed+'</strong><span>closed</span></div><div class="tree-metric"><strong>'+maxDepth+'</strong><span>max depth</span></div></div><div class="tree-progress" aria-label="'+progress+' percent of nodes verified"><span style="--progress:'+progress+'%"></span></div><div class="kinetic-stage"><svg viewBox="0 0 1000 '+height+'" role="img" aria-label="Campaign search tree with '+nodes.length+' nodes; '+verified+' verified and '+frontier+' pending"><g>'+edges+'</g><g>'+nodeSvg+'</g></svg></div><p class="muted" role="status" aria-live="polite">'+esc(activity+transition)+'</p>'+recovery+'<ol class="trajectory-list" aria-label="Accessible node trajectory">'+list+'</ol></section>';
}

function refreshSelectedCampaignDetail() { if(!selectedCampaignDetailId||detailRefreshPending)return; detailRefreshPending=true; api('/api/campaigns/'+encodeURIComponent(selectedCampaignDetailId)).then(renderCampaignDetail).catch(()=>{}).finally(()=>{detailRefreshPending=false;}); }
function renderCampaignDetail(snap) { const d=document.getElementById('detail'); if(!d)return; d.innerHTML=kineticTreeMarkup(snap); }

// ---- Campaign interrupt (C-03) -------------------------------------
// The node_id-optional whole-campaign form: omitting node_id sweeps every
// expanding/pending node in the campaign, the same route the CLI/TUI already
// exercise (webui.ts's own POST /api/campaigns/:id/interrupt handler).
function interruptStatus(message, failed = false) {
  const target = document.getElementById('interrupt-status');
  if (target) { target.textContent = message; target.style.color = failed ? 'var(--fail)' : ''; }
}
function interruptCampaign(campaignId, nodeId) {
  if (!window.confirm(nodeId ? 'Interrupt this node? In-flight work is stopped safely.' : 'Interrupt the whole campaign? Every expanding/pending node is stopped safely.')) return;
  interruptStatus('Submitting interrupt…');
  const body = nodeId ? { node_id: nodeId, reason: 'webui_operator' } : { reason: 'webui_operator' };
  fetch('/api/campaigns/'+encodeURIComponent(campaignId)+'/interrupt', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) })
    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((result) => { const affected = Array.isArray(result?.affected_node_ids) ? result.affected_node_ids.length : 0; interruptStatus('Interrupt accepted: '+affected+' node(s) affected.'); refreshSelectedCampaignDetail(); })
    .catch((error) => interruptStatus('Interrupt failed: '+String(error), true));
}

function loadDetail(id) {
  const d = document.getElementById('detail');
  const dk = document.getElementById('detail-kb');
  const da = document.getElementById('detail-audit');
  d.classList.remove('hidden');
  dk.classList.remove('hidden');
  da.classList.remove('hidden');
  selectedCampaignDetailId=id;
  const campaignPath=encodeURIComponent(id);
  api('/api/campaigns/'+campaignPath).then(renderCampaignDetail).catch((status) => { d.innerHTML = '<div class="card"><span class="muted unavailable">'+(status === 404 ? 'Campaign not found.' : 'Campaign detail unavailable (status '+esc(status)+').')+'</span></div>'; });
  api('/api/campaigns/'+campaignPath+'/kb').then(entries => {
    let h = '<div class="card"><strong class="section-title">KB</strong><pre>' + esc(JSON.stringify(entries, null, 2)) + '</pre></div>';
    dk.innerHTML = h;
  }).catch((status) => { dk.innerHTML = '<div class="card"><span class="muted unavailable">'+(status === 404 ? 'Campaign not found.' : 'KB unavailable (status '+esc(status)+').')+'</span></div>'; });
  api('/api/campaigns/'+campaignPath+'/audit').then(audit => {
    let h = '<div class="card"><strong class="section-title">Audit</strong><pre>' + esc(JSON.stringify(audit, null, 2)) + '</pre></div>';
    da.innerHTML = h;
  }).catch((status) => { da.innerHTML = '<div class="card"><span class="muted unavailable">'+(status === 404 ? 'Campaign not found.' : 'Audit unavailable (status '+esc(status)+').')+'</span></div>'; });
  refreshOperatorReadPanels();
}

function renderNativeConfig(view) {
  const target = document.getElementById('native-config');
  if (!target) return;
  const selection = view?.native_selection;
  let text = 'Native selection unavailable';
  if (selection?.kind === 'native') {
    const revision = typeof selection.revision === 'string' && selection.revision.trim()
      ? ' · revision configured '+esc(selection.revision)+' (unobserved until a response carries it)'
      : ' · revision unpinned';
    text = 'Direct native · '+esc(selection.adapter_id)+' → '+esc(selection.provider_id)+' / '+esc(selection.model)+' ('+esc(selection.selected_by)+')'+revision;
  }
  else if (selection?.kind === 'fallback') text = 'Connector fallback · '+esc(humanizeEnum(selection.reason));
  else if (selection?.kind === 'unavailable') text = 'Native blocked · '+esc(humanizeEnum(selection.reason));
  const leaves = Array.isArray(view?.leaves) ? view.leaves : [];
  const value = (path) => leaves.find((leaf) => leaf?.path === path)?.value;
  const limits = [['input', value('native.usage_budget.max_session_input_tokens')], ['output', value('native.usage_budget.max_session_output_tokens')], ['total', value('native.usage_budget.max_session_total_tokens')]]
    .filter(([, limit]) => limit !== undefined).map(([name, limit]) => esc(name)+' ≤ '+esc(limit)).join(' · ');
  const priceSource = value('native.pricing.price_source_id');
  const policy = limits || priceSource !== undefined
    ? 'Session policy: '+(limits || 'no token ceiling')+(priceSource === undefined ? '' : ' · price source '+esc(priceSource))
    : 'Session policy: no budget/pricing configured';
  target.innerHTML = '<div class="card"><strong class="section-title">Native Harness</strong><br><span class="muted">'+text+'</span><br><span class="muted">'+policy+'</span></div>';
}

function renderNativeReadiness(view) {
  const target = document.getElementById('native-readiness');
  if (!target) return;
  const execution = view?.execution, adapter = view?.adapter, credential = view?.credential;
  if (!execution || !adapter || !credential) { target.innerHTML = '<div class="card"><strong class="section-title">Native Setup Doctor</strong><br><span class="muted">Readiness projection unavailable.</span></div>'; return; }
  const outcome = execution.kind === 'direct_native' ? 'direct native ('+esc(execution.selected_by)+')' : esc(humanizeEnum(execution.kind))+' ('+esc(humanizeEnum(execution.reason))+')';
  const credentialText = credential.present === true ? 'present' : 'absent';
  const missing = Array.isArray(view?.missing_requirements) ? view.missing_requirements : [];
  let h = '<div class="card"><strong class="section-title">Native Setup Doctor</strong><br><span class="muted">Execution: '+outcome+'. Adapter: '+esc(adapter.adapter_id || 'not selected')+' ('+esc(humanizeEnum(adapter.availability))+'). Credential: '+credentialText+'.</span>';
  h += '<br><span class="muted">Model revision: '+esc(humanizeEnum(view?.model_revision?.readiness) || 'unreported')+' · pricing: '+esc(humanizeEnum(view?.pricing?.readiness) || 'unreported')+' · budget: '+esc(humanizeEnum(view?.budget?.readiness) || 'unreported')+'. This does not read credential values or probe endpoints.</span>';
  if (missing.length) { h += '<table><tr><th>Requirement</th><th>Action</th></tr>'; for (const item of missing.slice(0, 20)) h += '<tr><td>'+esc(item.code || 'missing')+'</td><td>'+esc(item.action || 'unreported')+'</td></tr>'; h += '</table>'; }
  else h += '<br><span class="muted">No blocking native setup requirement is missing.</span>';
  target.innerHTML = h+'</div>';
}

// ---- First-run guidance ---------------------------------------------
// This workspace has no setup mutation authority. It only combines canonical
// read projections into a manual checklist and never sees credential values.
function setupStep(state, title, detail, command) {
  return '<li><span class="setup-state setup-'+esc(state)+'">'+esc(state)+'</span><div><strong>'+esc(title)+'</strong><br><span class="muted">'+esc(detail)+'</span>'+(command ? '<br><code class="setup-command">'+esc(command)+'</code>' : '')+'</div></li>';
}
function setupHookState(project) {
  const gates = Array.isArray(project?.entries) ? project.entries.flatMap((entry) => Array.isArray(entry?.gates) ? entry.gates : []) : [];
  return gates.find((gate) => /hook|pre-push/i.test(String(gate?.gate_id || ''))) || null;
}
function renderGuidedSetup({ config, readiness, connectors, project }) {
  const target = document.getElementById('guided-setup');
  if (!target) return;
  const nativeReady = readiness?.execution?.kind === 'direct_native';
  const connectorList = Array.isArray(connectors?.connectors) ? connectors.connectors : [];
  const selectedConnectorId = connectors?.selection?.kind === 'selected' ? connectors.selection.connector_id : null;
  const selectedConnector = selectedConnectorId === null ? null : connectorList.find((connector) => connector?.connector_id === selectedConnectorId) || null;
  const connectorReady = connectors?.selected_execution?.readiness === 'ready' || selectedConnector?.health === 'healthy' || selectedConnector?.health === 'ready';
  if (nativeReady || connectorReady) { target.innerHTML = ''; return; }
  const adapterId = readiness?.adapter?.adapter_id || config?.native_selection?.adapter_id || null;
  const healthyConnector = connectorList.find((connector) => connector?.health === 'healthy' || connector?.health === 'ready') || null;
  const credential = readiness?.credential;
  const sources = readiness?.config_sources;
  const enrolled = Number.isSafeInteger(project?.entry_count) && project.entry_count > 0;
  const projectHealthy = enrolled && Array.isArray(project?.entries) && project.entries.every((entry) => entry?.ok === true);
  const hook = setupHookState(project);
  let h = '<div class="card"><h2 class="section-title">First-run route checklist</h2><span class="muted">No executable native or connector route is currently ready. These are detected read-only facts and manual terminal remediations; this page does not install, enroll, or configure anything.</span><ol class="setup-checklist">';
  h += adapterId || healthyConnector
    ? setupStep('detected', 'Provider or connector choice', adapterId ? 'Configured adapter: '+adapterId+'.'+(healthyConnector ? ' A healthy connector is also visible.' : '') : 'Healthy connector: '+String(healthyConnector.connector_id || 'unnamed')+'.', 'arbor doctor --json')
    : setupStep('missing', 'Provider or connector choice', 'No selected adapter or healthy connector was reported.', 'arbor doctor --json');
  h += credential?.present === true
    ? setupStep('detected', 'Credential and configuration', 'Credential presence was detected'+(credential.env_var ? ' through '+credential.env_var : '')+'. Its value is never exposed here.', 'arbor doctor --json')
    : setupStep('missing', 'Credential and configuration', 'No credential was detected. Config sources: defaults '+(sources?.defaults_present ? 'detected' : 'unreported')+', file '+(sources?.file_present ? 'detected' : 'missing')+', environment '+(sources?.env_present ? 'detected' : 'not detected')+'.', 'arbor setup --dry-run');
  h += projectHealthy
    ? setupStep('detected', 'Repository enrollment', 'At least one enrolled project passed its latest canonical project-management report.', 'arbor project status . --json')
    : setupStep(enrolled ? 'missing' : 'manual', 'Repository enrollment', enrolled ? 'An enrolled project has an unresolved readiness or gate report.' : 'No enrolled project was reported. Enrollment must be performed manually in a terminal.', enrolled ? 'arbor project status . --json' : 'arbor project enroll . --dry-run');
  h += hook === null
    ? setupStep('manual', 'Pre-push hook', 'No canonical hook-status field was returned, so this workspace cannot claim whether hooks are installed.', 'bun run install-hooks')
    : hook.status === 'pass'
      ? setupStep('detected', 'Pre-push hook', 'Canonical project report recorded '+String(hook.gate_id)+' as passing.', 'arbor project status . --json')
      : setupStep('missing', 'Pre-push hook', 'Canonical project report recorded '+String(hook.gate_id)+' as '+String(hook.status || 'not ready')+'.', 'bun run install-hooks');
  h += '</ol><p class="muted">After manual remediation, reload this workspace or run <code>arbor doctor --json</code> to obtain a fresh canonical readiness projection.</p></div>';
  target.innerHTML = h;
}
function refreshGuidedSetup() {
  Promise.all([
    runtimeQuery('config.get').catch(() => null),
    runtimeQuery('harness.native.readiness').catch(() => null),
    runtimeQuery('harness.connector.inventory').catch(() => null),
    runtimeQuery('project.manage').catch(() => null),
  ]).then(([config, readiness, connectors, project]) => renderGuidedSetup({config, readiness, connectors, project}));
}

function formatNativeBudgetCost(cost) {
  if (!cost || typeof cost !== 'object') return 'unavailable';
  if (cost.kind === 'unpriced') return 'unpriced: '+esc(humanizeEnum(cost.reason) || 'reason unavailable');
  if (cost.kind !== 'priced' || !Number.isSafeInteger(cost.minor_units) || typeof cost.currency !== 'string' || !Number.isSafeInteger(cost.minor_unit_exponent)) return 'unavailable';
  const digits = Math.abs(cost.minor_units).toString().padStart(cost.minor_unit_exponent + 1, '0');
  const amount = cost.minor_unit_exponent === 0 ? digits : digits.slice(0, -cost.minor_unit_exponent)+'.'+digits.slice(-cost.minor_unit_exponent);
  return (cost.minor_units < 0 ? '-' : '')+amount+' '+esc(cost.currency);
}

function renderCampaignBudget(items) {
  const target = document.getElementById('campaign-spend');
  if (!target) return;
  let h = '<div class="card"><strong class="section-title">Native campaign budget</strong>';
  if (!items?.length) { target.innerHTML = h+'<br><span class="muted">No campaigns to inspect.</span></div>'; return; }
  h += '<table><tr><th>Campaign</th><th>Allocation</th><th>Tokens used / reserved / remaining</th><th>Cost used / reserved / remaining</th><th>Revision</th></tr>';
  for (const item of items) {
    if (item.availability !== 'configured') {
      h += '<tr><td>'+esc(item.campaign_id)+'</td><td>not configured</td><td>—</td><td>—</td><td>—</td></tr>';
      continue;
    }
    const tokenRemaining = item.remaining_tokens === null ? 'not configured' : item.remaining_tokens;
    h += '<tr><td>'+esc(item.campaign_id)+'</td><td>configured</td><td>'+esc(item.consumed_tokens)+' / '+esc(item.reserved_tokens)+' / '+esc(tokenRemaining)+'</td><td>'+formatNativeBudgetCost(item.consumed_cost)+' / '+formatNativeBudgetCost(item.reserved_cost)+' / '+formatNativeBudgetCost(item.remaining_cost)+'</td><td>'+esc(item.revision)+'</td></tr>';
  }
  target.innerHTML = h+'</table><br><span class="muted">Values are the durable allocation authority snapshot, not telemetry-derived estimates.</span></div>';
}

function refreshCampaignBudget() {
  api('/api/campaigns').then((campaigns) => {
    const list = Array.isArray(campaigns) ? campaigns : (campaigns?.campaigns || []);
    return Promise.all(list.map((campaign) => runtimeQuery('native.budget.get', {campaign_id:campaign.id})));
  }).then(renderCampaignBudget).catch(() => renderCampaignBudget([]));
}

function renderHarnessConnectors(view) {
  const target = document.getElementById('harness-connectors');
  if (!target) return;
  const execution = view?.selected_execution;
  const connectors = Array.isArray(view?.connectors) ? view.connectors : [];
  let h = '<div class="card"><strong class="section-title">Harness Connectors</strong>';
  if (!execution) { target.innerHTML = h+'<br><span class="muted">Connector inventory unavailable.</span></div>'; return; }
  const reason = execution.reason === null ? 'direct dispatch admitted' : humanizeEnum(execution.reason) || 'unreported';
  h += '<br><span class="muted">Selected execution: '+esc(humanizeEnum(execution.kind))+' via '+esc(execution.connector_id)+' ('+esc(humanizeEnum(execution.readiness))+') — '+esc(reason)+'.</span>';
  const requirements = Array.isArray(view?.requirements) ? view.requirements.map((item) => esc(item.capability)+' ≥ '+esc(item.minimum_grade)).join(', ') : 'unreported';
  h += '<br><span class="muted">Admission requirements: '+requirements+'. Connector fallback is never presented as an upstream health check.</span>';
  if (!connectors.length) { target.innerHTML = h+'<br><span class="muted">No direct-native connector is registered.</span></div>'; return; }
  h += '<table><tr><th>Connector</th><th>Health</th><th>Version</th><th>Capabilities / grades</th><th>Diagnostic</th></tr>';
  for (const connector of connectors) {
    const capabilities = Array.isArray(connector.capabilities) ? connector.capabilities.map((capability) => String(capability.capability)+' : '+String(capability.grade)).join(', ') : '—';
    h += '<tr><td>'+esc(connector.connector_id)+'</td><td>'+badge(connector.health)+'</td><td>'+esc(connector.implementation_version)+'</td><td>'+esc(capabilities)+'</td><td>'+esc(connector.diagnostic || '—')+'</td></tr>';
  }
  target.innerHTML = h+'</table></div>';
}

let harnessSessionCursorStack = [];
let harnessSessionCursor = null;
function pageHarnessSessions(direction) {
  if (direction === 'previous') harnessSessionCursor = harnessSessionCursorStack.pop() || null;
  else if (latestHarnessSessionView?.next_cursor) { harnessSessionCursorStack.push(harnessSessionCursor); harnessSessionCursor = latestHarnessSessionView.next_cursor; }
  runtimeQuery('harness.session.list', {limit:200, ...(harnessSessionCursor ? {cursor:harnessSessionCursor} : {})}).then(renderHarnessSessions).catch(error => renderHarnessSessions({availability:'unavailable', reason:error.message}));
}
function renderHarnessSessions(view) {
  const target = document.getElementById('harness-sessions');
  if (!target) return;
  latestHarnessSessionView = view;
  if (view?.availability === 'unavailable') { selectedHarnessSessionId = null; target.innerHTML = '<div class="card"><h2 class="section-title">Harness session history</h2><span class="muted">History is unavailable: '+esc(view.reason)+'. Resume and fork are not available from this workspace.</span></div>'; return; }
  const sessions = Array.isArray(view?.sessions) ? view.sessions : [];
  let h = '<div class="card"><h2 class="section-title">Harness session history</h2><span class="muted">Select a recorded session to inspect bounded event evidence. Historical evidence is not a resumable or forkable execution.</span>';
  if (!sessions.length) { target.innerHTML = h+'<p class="muted">No observed harness sessions.</p></div>'; return; }
  h += '<div class="table-scroll" tabindex="0" aria-label="Harness session history table"><table><caption class="sr-only">Harness session history</caption><tr><th>Connector</th><th>Execution</th><th>Role</th><th>Provider/model</th><th>Revision</th><th>State</th><th>Actions</th></tr>';
  for (const session of sessions) {
    const id = sessionArg(session.session_id);
    const selected = session.session_id === selectedHarnessSessionId;
    const identity = session?.model_identity;
    const model = identity && typeof identity.provider_id === 'string' && typeof identity.model_id === 'string'
      ? identity.provider_id+' / '+identity.model_id : 'unreported';
    const revision = identity && typeof identity.revision === 'string' && identity.revision.trim()
      ? 'observed '+identity.revision
      : identity && typeof identity.configured_revision === 'string' && identity.configured_revision.trim()
        ? 'configured '+identity.configured_revision+'; unobserved' : identity ? 'unobserved / unpinned' : 'unreported';
    // A durable terminal record is useful to inspect, but it no longer owns a
    // live AbortController. Do not render an interrupt control that is known
    // to be unavailable; session detail/events remain available for audit.
    const interrupt = session.terminal === null
      ? ' <button type="button" class="danger" onclick="interruptHarnessSession(decodeURIComponent(\\''+id+'\\'))">interrupt</button>'
      : '';
    h += '<tr class="'+(selected ? 'session-row-selected' : '')+'"><td>'+esc(session.connector_id)+'</td><td>'+esc(humanizeEnum(session.execution_kind))+'</td><td>'+esc(session.profile_id)+'</td><td>'+esc(model)+'</td><td>'+esc(revision)+'</td><td>'+badge(session.state)+'</td>'+
      '<td><button type="button" aria-pressed="'+(selected ? 'true' : 'false')+'" onclick="selectHarnessSession(decodeURIComponent(\\''+id+'\\'))">'+(selected ? 'selected' : 'inspect history')+'</button>'+interrupt+'</td></tr>';
  }
  h += '</table></div><div class="operation-actions"><button type="button" onclick="pageHarnessSessions(\\'previous\\')"'+(harnessSessionCursorStack.length ? '' : ' disabled')+'>Previous sessions</button><button type="button" onclick="pageHarnessSessions(\\'next\\')"'+(view?.next_cursor ? '' : ' disabled')+'>Next sessions</button></div>';
  target.innerHTML = h+'</div>';
}

function selectHarnessSession(sessionId) {
  selectedHarnessSessionId = sessionId;
  if (latestHarnessSessionView) renderHarnessSessions(latestHarnessSessionView);
  loadHarnessSession(sessionId);
}
function sessionField(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const part of path) current = current && typeof current === 'object' ? current[part] : undefined;
    if (typeof current === 'string' && current.trim()) return current;
    if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  }
  return null;
}
function boundedSessionText(value, maximum = 8192) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > maximum ? text.slice(0, maximum)+'\\n… [bounded in Web workspace]' : text;
}
function sessionEvents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
function renderSessionEvent(event, index) {
  if (typeof event === 'string') return '<li><strong>Event '+(index + 1)+'</strong><pre>'+esc(boundedSessionText(event, 4096))+'</pre></li>';
  const kind = resultText(event, ['kind', 'type', 'event_kind'], 'recorded event');
  const at = resultText(event, ['at', 'timestamp', 'created_at'], 'time unrecorded');
  const summary = resultText(event, ['summary', 'message', 'detail'], 'No summary recorded.');
  return '<li><details><summary><strong>'+esc(kind)+'</strong> <span class="muted">'+esc(at)+' · '+esc(summary.slice(0, 240))+'</span></summary><pre>'+esc(boundedSessionText(event, 8192))+'</pre></details></li>';
}
function continuationAvailability(inspection, kind) {
  const candidate = inspection?.continuations?.[kind] ?? inspection?.continuation?.[kind] ?? inspection?.[kind+'_availability'] ?? inspection?.[kind];
  if (candidate === true) return {available:true, reason:'available'};
  if (candidate && typeof candidate === 'object') return {available:candidate.available === true || candidate.availability === 'available', reason:operationText(candidate, ['reason', 'summary', 'availability'], 'not available')};
  return {available:false, reason:typeof candidate === 'string' ? candidate : 'this recorded session did not advertise a canonical '+kind+' capability'};
}
// WA-33: the catalog's own rejection is the only place this browser panel can
// learn plan.requires_disposition from -- there is no query kind that
// projects a session's continuation plan, only harness.session.resume/fork/
// respawn's typed "operation <id> requires an explicit disposition" summary
// (recovery/continuation-plan.ts's validateContinuationDispositions,
// surfaced verbatim as error.summary by runtimeCommand's rejection). A
// first submission with no known required operations discovers one operation
// id per round trip; each discovered id gets its own persistent decision
// select, exactly the way the CLI's repeatable --disposition
// <operation_id>=<decision> flag lets an operator name more than one.
const sessionContinuationRequiredDispositions = Object.create(null);
const RECOVERY_DISPOSITION_DECISIONS = ['retry', 'accept_observed', 'compensate', 'abandon'];
const continuationDispositionKey = (sessionId, kind) => sessionId+' '+kind;
function renderSessionContinuation(sessionId, inspection) {
  const operations = ['resume', 'fork', 'respawn'];
  let h = '<div class="adoption-notice"><strong>Continuation availability</strong><p class="muted">Continuation commands use the runtime-advertised recovery authority; historical evidence alone is never executable.</p><p id="session-continuation-status" role="status" aria-live="polite"></p>';
  for (const kind of operations) {
    const availability = continuationAvailability(inspection, kind);
    const sessionJson = esc(JSON.stringify(sessionId));
    const disabled = availability.available ? '' : ' disabled';
    const requiredOperationIds = sessionContinuationRequiredDispositions[continuationDispositionKey(sessionId, kind)] || [];
    const dispositionSelects = requiredOperationIds.map((operationId) =>
      '<label>Disposition for '+esc(operationId)+'<select name="disposition-op" data-operation-id="'+esc(operationId)+'" required'+disabled+'>'+
      RECOVERY_DISPOSITION_DECISIONS.map((decision) => '<option value="'+esc(decision)+'">'+esc(decision)+'</option>').join('')+
      '</select></label>').join('');
    h += '<form class="live-session-steer" onsubmit="submitSessionContinuation(event, '+sessionJson+', \\''+kind+'\\')"><h3 class="section-title">'+esc(humanizeEnum(kind))+'</h3><p class="muted">'+(availability.available ? 'Available from this session projection.' : 'Unavailable: '+esc(availability.reason))+ '</p><label>Disposition<textarea name="disposition" maxlength="2048" required'+disabled+' placeholder="State the governed operator disposition"></textarea></label>'+dispositionSelects+'<label>Type '+kind.toUpperCase()+' to confirm<input name="confirmation" type="text" autocomplete="off" required'+disabled+'></label><div><button type="submit"'+disabled+'>'+esc(humanizeEnum(kind))+' session</button></div></form>';
  }
  return h+'</div>';
}
function sessionContinuationStatus(message, failed = false) {
  const target = document.getElementById('session-continuation-status');
  if (target) { target.textContent = message; target.style.color = failed ? 'var(--fail)' : ''; }
}
function submitSessionContinuation(event, sessionId, kind) {
  event.preventDefault();
  const form = event.currentTarget;
  const disposition = String(new FormData(form).get('disposition') || '').trim();
  const confirmation = String(new FormData(form).get('confirmation') || '').trim().toUpperCase();
  const commands = {resume:'harness.session.resume', fork:'harness.session.fork', respawn:'harness.session.respawn'};
  const command = commands[kind];
  if (!command) { sessionContinuationStatus('Unknown continuation operation.', true); return; }
  if (!disposition) { sessionContinuationStatus('A disposition is required.', true); return; }
  if (confirmation !== kind.toUpperCase()) { sessionContinuationStatus('Type '+kind.toUpperCase()+' exactly to confirm.', true); return; }
  // The free-text disposition doubles as both the session-level reason and,
  // per operation, the governed RecoveryDisposition.reason -- the same
  // "one operator statement" the CLI's --reason fills for the session while
  // parseRecoveryDispositions fills a generated reason per operation.
  const dispositions = Array.from(form.querySelectorAll('select[name="disposition-op"]'), (select) =>
    ({operation_id:select.dataset.operationId, decision:select.value, reason:disposition}));
  sessionContinuationStatus('Submitting '+kind+' request…');
  runtimeCommand(command, {session_id:sessionId, reason:disposition, dispositions:dispositions})
    .then((outcome) => { sessionContinuationStatus(kind+' accepted: '+JSON.stringify(outcome).slice(0, 500)); refreshNativeHarness(); loadHarnessSession(sessionId); })
    .catch((error) => {
      const match = /^operation (.+) requires an explicit disposition$/.exec(String(error?.message || ''));
      if (match) {
        const key = continuationDispositionKey(sessionId, kind);
        const known = sessionContinuationRequiredDispositions[key] || [];
        if (!known.includes(match[1])) sessionContinuationRequiredDispositions[key] = known.concat([match[1]]);
        sessionContinuationStatus(kind+' requires a disposition for operation '+match[1]+' — choose one below and resubmit.', true);
        loadHarnessSession(sessionId);
        return;
      }
      sessionContinuationStatus(kind+' unavailable or rejected: '+error.message, true);
    });
}
function loadHarnessSession(sessionId) {
  const target = document.getElementById('harness-detail');
  if (!target) return;
  target.classList.remove('hidden');
  target.innerHTML = '<div class="card"><span class="muted">Loading bounded session history…</span></div>';
  Promise.all([runtimeQuery('harness.session.inspect', {session_id:sessionId}), runtimeQuery('harness.session.events', {session_id:sessionId, limit:100}), runtimeQuery('harness.session.availability', {session_id:sessionId})]).then(([detail, eventProjection, availability]) => {
    const inspection = detail?.session && typeof detail.session === 'object' ? detail.session : detail;
    const events = sessionEvents(eventProjection).slice(0, 100);
    const total = Number.isSafeInteger(eventProjection?.total) ? eventProjection.total : null;
    const lineage = sessionField(inspection, [['parent_session_id'], ['lineage', 'parent_session_id'], ['lineage', 'root_session_id'], ['parent', 'session_id']]) || 'not recorded';
    const checkpoint = sessionField(inspection, [['checkpoint_id'], ['checkpoint', 'id'], ['checkpoint', 'state'], ['latest_checkpoint', 'id']]) || 'not recorded';
    const recovery = sessionField(inspection, [['recovery_state'], ['recovery', 'state'], ['recovery', 'status'], ['state']]) || 'not recorded';
    const transcriptNote = total === null ? 'Showing up to 100 recorded events.' : 'Showing '+events.length+' of '+total+' recorded events.';
    let h = '<div class="card"><h2 class="section-title">Harness session '+esc(sessionId)+'</h2><span class="muted">Bounded historical evidence and any runtime-advertised continuation authority.</span>';
    h += '<dl class="session-facts"><dt>Lineage</dt><dd>'+esc(lineage)+'</dd><dt>Checkpoint</dt><dd>'+esc(checkpoint)+'</dd><dt>Recovery state</dt><dd>'+esc(humanizeEnum(recovery))+'</dd></dl>';
    h += renderSessionContinuation(sessionId, availability || inspection);
    h += '<h3 class="section-title">Recorded event transcript</h3><span class="muted">'+esc(transcriptNote)+'</span>';
    h += events.length ? '<ol class="session-events">'+events.map(renderSessionEvent).join('')+'</ol>' : '<p class="muted">No recorded events were returned.</p>';
    h += '<details><summary class="muted">Bounded inspection payload</summary><pre>'+esc(boundedSessionText({inspection, event_projection:eventProjection}, 16384))+'</pre></details></div>';
    target.innerHTML = h;
  }).catch(error => { target.innerHTML = '<div class="card"><span class="muted">Harness detail unavailable: '+esc(error.message)+'</span></div>'; });
}

function interruptHarnessSession(sessionId) {
  runtimeCommand('harness.session.interrupt', {session_id:sessionId, reason:'webui-operator requested interruption', provenance:{tag:'generated', generator:'arbor-webui', input_hash:'webui:'+sessionId}})
    .then(() => { refreshNativeHarness(); loadHarnessSession(sessionId); })
    .catch(error => { const target = document.getElementById('harness-detail'); if (target) { target.classList.remove('hidden'); target.innerHTML = '<div class="card"><span class="muted">Interrupt unavailable: '+esc(error.message)+'</span></div>'; } });
}

function refreshNativeHarness() {
  runtimeQuery('config.get').then(renderNativeConfig).catch(() => renderNativeConfig(null));
  runtimeQuery('harness.native.readiness').then(renderNativeReadiness).catch(() => renderNativeReadiness(null));
  runtimeQuery('harness.connector.inventory').then(renderHarnessConnectors).catch(() => renderHarnessConnectors(null));
  runtimeQuery('harness.session.list', {limit:200, ...(harnessSessionCursor ? {cursor:harnessSessionCursor} : {})}).then(renderHarnessSessions).catch(error => renderHarnessSessions({availability:'unavailable', reason:error.message}));
}

function renderHarnessEvaluations(items) {
  const target = document.getElementById('harness-evaluations'); if (!target) return;
  const candidates = (items || []).flatMap((item) => (item.candidates || []).map((revision) => ({campaign_id:item.campaign_id, revision})));
  const runs = (items || []).flatMap((item) => (item.runs || []).map((run) => ({campaign_id:item.campaign_id, run})));
  let h = '<div class="card"><strong class="section-title">Controlled Overlay Evaluation</strong><br><span class="muted">Starting a run requests the composed evaluator and may contact a configured provider. A measured result requires paired fresh read-only sessions with no tools or human input, plus one durable replay and one holdout scenario bound to expected-output hashes. This dashboard exposes only redacted canonical records.</span>';
  h += '<h3>Eligible candidates</h3>';
  if (!candidates.length) h += '<span class="muted">No active unevaluated revisions.</span>';
  else { h += '<table><tr><th>Campaign</th><th>Revision</th><th>Component</th><th>Action</th></tr>'; for (const row of candidates) { const revision = sessionArg(row.revision.id); h += '<tr><td>'+esc(row.campaign_id)+'</td><td>'+esc(row.revision.id)+'</td><td>'+esc(row.revision.component)+'</td><td><button onclick="startHarnessEvaluation(decodeURIComponent(\\''+revision+'\\'))">start controlled evaluation</button></td></tr>'; } h += '</table>'; }
  h += '<h3>Durable evaluation runs</h3>';
  if (!runs.length) h += '<span class="muted">No evaluation runs recorded.</span>';
  else { h += '<table><tr><th>Campaign</th><th>Revision</th><th>State</th><th>Outcome</th><th>Evaluator</th><th>Evidence</th><th>Action</th></tr>'; for (const row of runs) {
    const run = row.run || {}, evaluation = run.evaluation || {}, runId = sessionArg(run.id), revision = sessionArg(run.revision_id), evidence = sessionArg(JSON.stringify(Array.isArray(run.evidence_ids) ? run.evidence_ids : []));
    const eligiblePromotion = run.state === 'measured' && evaluation.outcome === 'improved' && evaluation.regression_detected === false;
    const eligibleQuarantine = run.state === 'measured' && Array.isArray(run.evidence_ids) && run.evidence_ids.length > 0;
    let actions = '<button onclick="loadHarnessEvaluationDetail(decodeURIComponent(\\''+runId+'\\'))">detail</button>';
    if (eligiblePromotion) actions += ' <button onclick="promoteHarnessRevision(decodeURIComponent(\\''+revision+'\\'))">promote</button>';
    if (eligibleQuarantine) actions += ' <button onclick="quarantineHarnessRevision(decodeURIComponent(\\''+revision+'\\'), decodeURIComponent(\\''+evidence+'\\'))">quarantine</button>';
    h += '<tr><td>'+esc(row.campaign_id)+'</td><td>'+esc(run.revision_id)+'</td><td>'+esc(humanizeEnum(run.state))+'</td><td>'+esc(humanizeEnum(evaluation.outcome) || 'unmeasured')+'</td><td>'+esc(run.evaluator_id)+'</td><td>'+esc(Array.isArray(run.evidence_ids) ? run.evidence_ids.length : 0)+'</td><td>'+actions+'</td></tr>';
  } h += '</table>'; }
  target.innerHTML = h+'</div>';
}
function startHarnessEvaluation(revisionId) { runtimeCommand('harness.evaluation.start', {revision_id:revisionId}).then(refreshHarnessEvaluations).catch(error => alert('Evaluation unavailable: '+error.message)); }
function promoteHarnessRevision(revisionId) { runtimeCommand('harness.promote', {revision_id:revisionId, human_approver:'webui-operator'}).then(refreshHarnessEvaluations).catch(error => alert('Promotion unavailable: '+error.message)); }
function quarantineHarnessRevision(revisionId, evidenceIdsJson) { const reason = window.prompt('Independent quarantine reason for '+revisionId+':'); if (reason === null || !reason.trim()) return; let evidenceIds; try { evidenceIds = JSON.parse(evidenceIdsJson); } catch { alert('Evaluation evidence is unavailable.'); return; } runtimeCommand('harness.quarantine', {revision_id:revisionId, reason, evidence_ids:evidenceIds}).then(refreshHarnessEvaluations).catch(error => alert('Quarantine unavailable: '+error.message)); }
function loadHarnessEvaluationDetail(runId) { const target = document.getElementById('harness-evaluation-detail'); if (!target) return; target.classList.remove('hidden'); runtimeQuery('harness.evaluation.detail', {run_id:runId}).then((detail) => { target.innerHTML = '<div class="card"><strong class="section-title">Controlled evaluation run '+esc(runId)+'</strong><pre>'+esc(JSON.stringify(detail, null, 2))+'</pre></div>'; }).catch(error => { target.innerHTML = '<div class="card"><span class="muted">Evaluation detail unavailable: '+esc(error.message)+'</span></div>'; }); }
function refreshHarnessEvaluations() { api('/api/campaigns').then((campaigns) => { const list = Array.isArray(campaigns) ? campaigns : (campaigns?.campaigns || []); return Promise.all(list.map((campaign) => Promise.all([runtimeQuery('harness.evaluation.candidates', {campaign_id:campaign.id}), runtimeQuery('harness.evaluation.runs', {campaign_id:campaign.id})]).then(([candidates, runs]) => ({campaign_id:campaign.id, candidates, runs})))); }).then(renderHarnessEvaluations).catch(() => renderHarnessEvaluations([])); }

// The web surface can answer only already-governed ledger records.  It has no
// userinput.ask control, so a sibling/model cannot bypass loop-owned
// lead/delegated authority by minting a direct web-to-human question.
function isGovernedInterviewRecord(record) {
  const question = record?.question;
  return record?.kind === 'request_user_input'
    && typeof question?.question === 'string' && question.question.trim().length > 0
    && (question.authority === 'lead' || question.authority === 'delegated_needs_input')
    && (question.blocking === 'blocking' || question.blocking === 'async')
    && typeof question.requester_role === 'string' && question.requester_role.trim().length > 0;
}
function renderInterviews(items, accessIssues = []) {
  const target = document.getElementById('interviews');
  if (!target) return;
  const records = (items || []).flatMap((item) => (item.records || []).filter((record) => !(item.answered_record_ids || []).includes(record.id)).map((record) => ({campaign_id:item.campaign_id, record})));
  const pending = records.filter((item) => isGovernedInterviewRecord(item.record));
  const withheld = records.filter((item) => !isGovernedInterviewRecord(item.record));
  let h = '<div class="card"><strong class="section-title">Governed Interviews</strong>';
  const issues = [...accessIssues, ...withheld.map((item) => ({campaign_id:item.campaign_id, message:'A malformed input record was withheld from the answer flow.'}))];
  if (issues.length) h += '<div class="adoption-notice" role="alert"><strong>Runtime capability issue</strong><br><span class="muted">No operator answer is requested for this condition. Correct the runtime or inspect its diagnostics; do not use an interview response as a substitute for a missing tool or capability.</span><ul>'+issues.map((issue) => '<li>'+esc(issue.campaign_id ? String(issue.campaign_id)+': ' : '')+esc(issue.message)+'</li>').join('')+'</ul></div>';
  if (!pending.length) { target.innerHTML = h+'<br><span class="muted">No pending governed interviews.</span></div>'; return; }
  h += '<table><tr><th>Campaign</th><th>Question</th><th>Authority</th><th>Blocking</th><th>Requester</th><th>Session</th><th>Action</th></tr>';
  for (const item of pending) {
    const q = item.record.question || {};
    const campaign = sessionArg(item.campaign_id), record = sessionArg(item.record.id);
    h += '<tr><td>'+esc(item.campaign_id)+'</td><td>'+esc(q.question)+'</td><td>'+esc(q.authority)+'</td><td>'+esc(q.blocking)+'</td><td>'+esc(q.requester_role)+'</td><td>'+esc(q.origin_session_id || '—')+'</td>'+
      '<td><button onclick="answerInterview(decodeURIComponent(\\''+campaign+'\\'),decodeURIComponent(\\''+record+'\\'))">answer</button></td></tr>';
  }
  target.innerHTML = h+'</table></div>';
}

function answerInterview(campaignId, recordId) {
  const answer = window.prompt('Governed answer for '+recordId+' (recorded durably):');
  if (answer === null || !answer.trim()) return;
  runtimeCommand('userinput.answer', {record_id:recordId, answer:{option_id:null, custom_text:answer, answered_by:'webui-operator', answered_at:new Date().toISOString()}})
    .then(() => refreshInterviews())
    .catch(error => { const target = document.getElementById('interviews'); if (target) target.innerHTML = '<div class="card"><strong class="section-title">Governed Interviews</strong><div class="adoption-notice" role="alert"><strong>Runtime capability issue</strong><br><span class="muted">The recorded interview remains unanswered because the runtime rejected the response. This is not a new authority request.</span><br><span class="muted">'+esc(error.message)+'</span></div></div>'; });
}

function refreshInterviews() {
  api('/api/campaigns').then((campaigns) => {
    const list = Array.isArray(campaigns) ? campaigns : (campaigns?.campaigns || []);
    return Promise.all(list.map((campaign) => runtimeQuery('userinput.list', {campaign_id:campaign.id, limit:50})
      .then((value) => ({campaign_id:campaign.id, ...value}))
      .catch((error) => ({campaign_id:campaign.id, records:[], answered_record_ids:[], interview_access_error:String(error)}))));
  }).then((items) => renderInterviews(items, items.filter((item) => typeof item.interview_access_error === 'string').map((item) => ({campaign_id:item.campaign_id, message:item.interview_access_error}))))
    .catch(error => renderInterviews([], [{campaign_id:null, message:'Interview ledger unavailable: '+String(error)}]));
}

// SSE connection. A snapshot establishes the projection; subsequent runtime
// events trigger a fresh read-only campaign projection.
const es = new EventSource('/api/stream');
es.addEventListener('snapshot', (e) => {
  const snapshot = JSON.parse(e.data);
  renderCampaigns(snapshot.value);
  document.getElementById('ts').textContent = 'Snapshot cursor: ' + snapshot.cursor.sequence;
});
es.addEventListener('runtime', () => { api('/api/campaigns').then(renderCampaigns).catch(() => {}); refreshSelectedCampaignDetail(); refreshTaskComposer(); refreshResults(); refreshNativeHarness(); refreshHarnessEvaluations(); refreshCampaignBudget(); refreshInterviews(); refreshSystemOperations(); refreshFlightControl(); refreshGovernance(); refreshOperatorReadPanels(); });
es.addEventListener('resync', () => { api('/api/campaigns').then(renderCampaigns).catch(() => {}); refreshSelectedCampaignDetail(); refreshTaskComposer(); refreshResults(); refreshNativeHarness(); refreshHarnessEvaluations(); refreshCampaignBudget(); refreshInterviews(); refreshSystemOperations(); refreshFlightControl(); refreshGovernance(); refreshOperatorReadPanels(); });
es.onerror = () => { document.getElementById('ts').textContent = 'SSE disconnected. Retrying...'; };

// Initial fetch
api('/api/campaigns').then(renderCampaigns).catch(() => {});
const deepLinkedCampaign = new URLSearchParams(window.location.search).get('campaign');
if (deepLinkedCampaign) loadDetail(deepLinkedCampaign);
refreshTaskComposer();
refreshResults();
refreshGuidedSetup();
refreshNativeHarness();
refreshHarnessEvaluations();
refreshCampaignBudget();
refreshInterviews();
refreshSystemOperations();
refreshFlightControl();
refreshGovernance();
refreshOperatorReadPanels();
</script>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  // ---- Helpers ------------------------------------------------------

  private jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private badRequest(res: http.ServerResponse, msg: string): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }

  private notFound(res: http.ServerResponse, msg: string): void {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }

  private forbidden(res: http.ServerResponse, msg: string): void {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }

  private errorResponse(res: http.ServerResponse, msg: string): void {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

let bareWebUiCommandSequence = 0;

function nextBareWebUiCommandId(kind: unknown): string {
  bareWebUiCommandSequence += 1;
  return `webui:${String(kind)}:${Date.now().toString(36)}:${bareWebUiCommandSequence.toString(36)}`;
}

/** Wrap a bare `{ kind, ...params }` command body into the catalog command envelope. */
export function toCommandEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === "object" && (body as Record<string, unknown>).command !== undefined) return body;
  const { kind, ...params } = (body ?? {}) as Record<string, unknown>;
  const metadata = params.metadata as Record<string, unknown> | undefined;
  const { metadata: _m, ...commandParams } = params;
  const generatedId = nextBareWebUiCommandId(kind);
  return {
    schema_version: 1,
    metadata: metadata ?? { operation_id: generatedId, idempotency_key: generatedId },
    command: { kind, ...commandParams } as unknown,
  };
}

/** Wrap a bare `{ kind, ...params }` query body into the catalog query envelope. */
/**
 * Queries an anonymous Web caller may not run (security review 2026-10-06).
 * The loopback port is reachable by any local process, including a
 * specialist's verification command when its sandbox shares the host
 * network, so an anonymous request is held to what a specialist may read:
 * no approved raw output, no critic-visibility KB projection (`kb.list`
 * reads at critic tier), and no critic_only context artifact. The operator
 * session behaves exactly as before; GET /api/campaigns/:id/kb still serves
 * anonymous callers at specialist visibility. Approval listing stays open: it
 * carries record metadata, never raw content.
 */
function anonymousDisclosureRefusal(envelope: unknown): RuntimeRouterResult<never> | null {
  const query = envelope !== null && typeof envelope === "object" ? (envelope as { query?: unknown }).query : undefined;
  if (query === null || typeof query !== "object") return null;
  const { kind, visibility } = query as { kind?: unknown; visibility?: unknown };
  const withheld = kind === "output.raw" ? "raw output disclosure"
    : kind === "kb.list" ? "the critic-visibility KB projection (kb.list)"
    : kind === "context.workspace" && visibility === "critic_only" ? "a critic_only context artifact"
    : null;
  if (withheld === null) return null;
  const summary = `${withheld} requires the authenticated operator session`;
  return {
    ok: false, capability: null,
    error: {
      code: "permission", severity: "warning", recoverable: true, source: "webui", summary,
      gate_refusal: projectGateRefusal({
        gate: "capability", code: "operator_session_required", summary,
        remediation: "Open the one-use operator URL `arbor webui` printed at startup in this browser to establish the operator session, then retry. A request without that session cookie is never granted these reads.",
        correcting_actor: "caller", corrective_action: "reauthenticate",
      }),
    },
  };
}

function toQueryEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === "object" && (body as Record<string, unknown>).query !== undefined) return body;
  const { kind, ...query } = (body ?? {}) as Record<string, unknown>;
  return {
    schema_version: 1,
    query_id: `webui:${kind}:${Date.now().toString(36)}`,
    query: { kind, ...query } as unknown,
  };
}

function toRepoFlightQueryEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === "object" && (body as Record<string, unknown>).query !== undefined) return body;
  const { kind, ...query } = (body ?? {}) as Record<string, unknown>;
  return { schema_version: 1, query_id: `webui-flight:${String(kind)}:${Date.now().toString(36)}`, query: { kind, ...query } };
}

function toRepoFlightCommandEnvelope(body: unknown): { readonly metadata: Readonly<Record<string, unknown>> & { readonly idempotency_key: string }; readonly [key: string]: unknown } {
  if (body !== null && typeof body === "object" && (body as Record<string, unknown>).command !== undefined) return body as { readonly metadata: Readonly<Record<string, unknown>> & { readonly idempotency_key: string }; readonly [key: string]: unknown };
  const { kind, ...params } = (body ?? {}) as Record<string, unknown>;
  const supplied = params.metadata as Record<string, unknown> | undefined;
  const { metadata: _metadata, ...command } = params;
  const id = nextBareWebUiCommandId(kind);
  return {
    schema_version: 1,
    metadata: {
      operation_id: typeof supplied?.operation_id === "string" ? supplied.operation_id : id,
      idempotency_key: typeof supplied?.idempotency_key === "string" ? supplied.idempotency_key : id,
      correlation_id: typeof supplied?.correlation_id === "string" ? supplied.correlation_id : id,
      actor_id: "webui-envelope-assertion",
      requested_at: new Date().toISOString(),
    },
    command: { kind, ...command },
  };
}
