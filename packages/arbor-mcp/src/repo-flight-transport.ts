import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acquireWriterLock, canonicalizeForHash, type WriterLockHandle } from "@arbor/core";
import { isRepoFlightOperatorCommandEnvelope, isRepoFlightOperatorQueryEnvelope, type RepoFlightOperatorService } from "./repo-flight-operator.js";

export const REPO_FLIGHT_DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const REPO_FLIGHT_SAFE_SOCKET_PATH_BYTES = 100;
const MAX_REPLAY_RECORDS = 10_000;

export type RepoFlightCredentialScope = "operator" | "agent";

/** Derive one stable UDS endpoint without exceeding Unix pathname limits. */
export function repoFlightTransportSocketPath(persistenceDir: string, socketName = "flight-director.sock"): string {
  const persistence = resolve(persistenceDir);
  const colocated = join(persistence, "repo-flight-transport", socketName);
  if (Buffer.byteLength(colocated) <= REPO_FLIGHT_SAFE_SOCKET_PATH_BYTES) return colocated;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  const digest = createHash("sha256").update(`${persistence}\0${socketName}`).digest("hex").slice(0, 32);
  return join(tmpdir(), `revoy2-flight-${uid}`, `${digest}.sock`);
}
interface RepoFlightOperatorCredential { readonly version: 1; readonly credential_id: string; readonly scope: "operator"; readonly instance_id: string; readonly secret: string }
export interface RepoFlightAgentCredentialBinding { readonly instance_id: string; readonly repository_id: string; readonly repo_run_id: string; readonly provider_session_ref: string; readonly process_identity_ref: string; readonly revocation_epoch: number; readonly active: boolean }
interface RepoFlightAgentCredential extends RepoFlightAgentCredentialBinding { readonly version: 2; readonly credential_id: string; readonly scope: "agent"; readonly operations: readonly ["query.self", "session.drain", "delivery.receipt"]; readonly issued_at: string; readonly expires_at: string; readonly credential_signature: string; readonly secret: string }
type RepoFlightCredential = RepoFlightOperatorCredential | RepoFlightAgentCredential;
interface RepoFlightWireRequest {
  readonly version: 1; readonly request_id: string; readonly credential_id: string; readonly scope: RepoFlightCredentialScope;
  readonly timestamp: string; readonly nonce: string; readonly idempotency_key: string; readonly action: "query" | "command";
  readonly payload: unknown; readonly signature: string;
}
export interface RepoFlightWireResponse {
  readonly version: 1; readonly request_id: string; readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: "validation" | "unauthorized" | "replay" | "conflict" | "unavailable" | "timeout" | "oversized" | "indeterminate" | "internal"; readonly summary: string; readonly response_digest?: `sha256:${string}` };
}
interface ReplayRecord { readonly credential_id: string; readonly idempotency_key: string; readonly request_digest: `sha256:${string}`; readonly nonce: string; readonly timestamp: string; phase: "executing" | "completed"; response: RepoFlightWireResponse | null }
interface ReplayState { readonly version: 1; records: ReplayRecord[]; nonces: { readonly credential_id: string; readonly nonce: string; readonly timestamp: string }[] }

export interface RepoFlightTransportServerOptions {
  readonly persistence_dir: string;
  readonly operator: RepoFlightOperatorService;
  /** Identity durably bound to the private operator credential and injected into every operator command. */
  readonly authenticated_operator_actor: string;
  readonly now?: () => Date;
  readonly max_frame_bytes?: number;
  readonly timestamp_skew_ms?: number;
  readonly socket_name?: string;
  readonly agent_credential_binding?: (instanceId: string) => RepoFlightAgentCredentialBinding | null;
  readonly agent_credential_ttl_ms?: number;
}

/** One elected, repo-local Flight Director transport owner. */
export class RepoFlightTransportServer {
  readonly socket_path: string;
  readonly operator_credential_path: string;
  private readonly directory: string;
  private readonly replayPath: string;
  private readonly owner: WriterLockHandle;
  private readonly now: () => Date;
  private readonly maxFrame: number;
  private readonly skew: number;
  private readonly credentials = new Map<string, RepoFlightCredential>();
  private state: ReplayState;
  private server: Server | null = null;
  private closed = false;

  constructor(private readonly options: RepoFlightTransportServerOptions) {
    if (!options.persistence_dir || options.persistence_dir.length > 4096) throw new Error("repo-flight transport persistence_dir is invalid");
    if (!validId(options.authenticated_operator_actor)) throw new Error("repo-flight authenticated operator actor is invalid");
    this.maxFrame = options.max_frame_bytes ?? REPO_FLIGHT_DEFAULT_MAX_FRAME_BYTES;
    this.skew = options.timestamp_skew_ms ?? 30_000;
    if (!Number.isSafeInteger(this.maxFrame) || this.maxFrame < 1_024 || this.maxFrame > 1_048_576) throw new Error("repo-flight max frame must be 1024 through 1048576 bytes");
    if (!Number.isSafeInteger(this.skew) || this.skew < 1_000 || this.skew > 300_000) throw new Error("repo-flight timestamp skew must be 1000 through 300000 ms");
    this.now = options.now ?? (() => new Date());
    this.directory = join(options.persistence_dir, "repo-flight-transport");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    const elected = acquireWriterLock(this.directory, { holder: "repo-flight-controller" });
    if (!elected.ok) throw new Error(`repo-flight controller unavailable: ${elected.detail}`);
    this.owner = elected.lock;
    this.socket_path = repoFlightTransportSocketPath(options.persistence_dir, options.socket_name);
    const socketDirectory = dirname(this.socket_path);
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(socketDirectory, 0o700);
    const socketDirectoryStat = lstatSync(socketDirectory);
    if (!socketDirectoryStat.isDirectory() || socketDirectoryStat.isSymbolicLink() || (socketDirectoryStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && socketDirectoryStat.uid !== process.getuid())) {
      this.owner.release();
      throw new Error("repo-flight socket directory must be private and owned by the current user");
    }
    this.operator_credential_path = join(this.directory, "operator.credential.json");
    this.replayPath = join(this.directory, "replay.json");
    try {
      const operator = this.loadOrCreateCredential(this.operator_credential_path, "operator", options.authenticated_operator_actor);
      this.credentials.set(operator.credential_id, operator);
      this.loadAgentCredentials();
      this.state = this.restoreReplay();
    } catch (error) { this.owner.release(); throw error; }
  }

  provisionAgentCredential(instanceId: string): string {
    this.assertOpen();
    if (!validId(instanceId)) throw new Error("agent instance id is invalid");
    const binding = this.options.agent_credential_binding?.(instanceId) ?? null;
    if (binding === null || !validAgentBinding(binding) || !binding.active || binding.instance_id !== instanceId) throw new Error("agent credential requires a current live enrollment binding");
    const path = join(this.directory, `agent-${hmacHex("repo-flight-agent-path", instanceId).slice(0, 32)}.credential.json`);
    const ttl = this.options.agent_credential_ttl_ms ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 86_400_000) throw new Error("agent credential TTL is invalid");
    const issuedAt = this.now();
    const operator = [...this.credentials.values()].find((credential): credential is RepoFlightOperatorCredential => credential.scope === "operator");
    if (operator === undefined) throw new Error("operator credential is unavailable for agent credential issuance");
    const unsigned = { version: 2 as const, credential_id: `agent:${randomUUID()}`, scope: "agent" as const, ...binding, operations: ["query.self", "session.drain", "delivery.receipt"] as const, issued_at: issuedAt.toISOString(), expires_at: new Date(issuedAt.getTime() + ttl).toISOString(), secret: randomBytes(32).toString("base64url") };
    const credential: RepoFlightAgentCredential = Object.freeze({ ...unsigned, credential_signature: credentialSignature(operator.secret, unsigned) });
    durableWrite(path, credential);
    this.credentials.set(credential.credential_id, credential);
    return path;
  }

  async start(): Promise<string> {
    this.assertOpen();
    if (this.server !== null) throw new Error("repo-flight controller is already listening");
    this.removeStaleSocket();
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    return await new Promise<string>((resolve, reject) => {
      const failed = (error: Error): void => { server.close(); this.server = null; reject(error); };
      server.once("error", failed);
      server.listen(this.socket_path, () => {
        server.off("error", failed);
        server.on("error", () => { /* availability is observed by clients; never log transport material */ });
        try { chmodSync(this.socket_path, 0o600); resolve(this.socket_path); }
        catch (error) { server.close(); this.server = null; reject(error); }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server; this.server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.socket_path) && lstatSync(this.socket_path).isSocket()) unlinkSync(this.socket_path);
    this.owner.release();
  }

  private accept(socket: Socket): void {
    let bytes = 0, frame = "", rejected = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > this.maxFrame) { rejected = true; this.send(socket, wireFailure("unknown", "oversized", "request frame exceeds the configured bound")); return; }
      frame += chunk;
    });
    socket.on("end", () => {
      if (rejected) return;
      const newline = frame.indexOf("\n");
      if (newline < 0 || frame.slice(newline + 1).length > 0) { this.send(socket, wireFailure("unknown", "validation", "exactly one request frame is permitted")); return; }
      void this.handle(frame.slice(0, newline)).then((response) => this.send(socket, response)).catch(() => socket.destroy());
    });
    socket.on("error", () => { /* responses contain bounded diagnostics; no transport logs */ });
  }

  private async handle(frame: string): Promise<RepoFlightWireResponse> {
    let parsed: unknown;
    try { parsed = JSON.parse(frame); } catch { return wireFailure("unknown", "validation", "request frame is malformed JSON"); }
    if (!validWireRequest(parsed)) return wireFailure(requestIdFrom(parsed), "validation", "request does not satisfy the closed transport schema");
    const request = parsed, credential = this.credentials.get(request.credential_id);
    if (credential === undefined || credential.scope !== request.scope) return wireFailure(request.request_id, "unauthorized", "credential is absent or has the wrong scope");
    if (credential.scope === "agent") {
      const operator = [...this.credentials.values()].find((candidate): candidate is RepoFlightOperatorCredential => candidate.scope === "operator");
      const current = this.options.agent_credential_binding?.(credential.instance_id) ?? null;
      if (operator === undefined || credential.credential_signature !== credentialSignature(operator.secret, credentialClaims(credential)) || Date.parse(credential.expires_at) <= this.now().getTime() || current === null || !current.active || !sameAgentBinding(credential, current)) return wireFailure(request.request_id, "unauthorized", "agent credential is expired, revoked, fenced, or rebound");
    }
    const expected = signWireRequest(credential.secret, request);
    if (!safeEqual(expected, request.signature)) return wireFailure(request.request_id, "unauthorized", "request authentication failed");
    const requestTime = Date.parse(request.timestamp), now = this.now().getTime();
    if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > this.skew) return wireFailure(request.request_id, "unauthorized", "request timestamp is outside the admitted window");
    const duplicateNonce = this.state.nonces.some((record) => record.credential_id === credential.credential_id && record.nonce === request.nonce);
    if (duplicateNonce) return wireFailure(request.request_id, "replay", "request nonce was already consumed");
    this.state.nonces.push({ credential_id: credential.credential_id, nonce: request.nonce, timestamp: request.timestamp });
    this.compactReplay(); this.persistReplay();
    const digest = requestDigest(request);
    const prior = this.state.records.find((record) => record.credential_id === credential.credential_id && record.idempotency_key === request.idempotency_key);
    if (prior !== undefined) {
      if (prior.request_digest !== digest) return wireFailure(request.request_id, "conflict", "idempotency key names a different request");
      if (prior.phase === "executing" || prior.response === null) return wireFailure(request.request_id, "indeterminate", "prior execution was interrupted before a durable outcome");
      return Object.freeze({ ...structuredClone(prior.response), request_id: request.request_id });
    }
    const policy = this.authorizeScope(credential, request);
    if (policy !== null) return wireFailure(request.request_id, "unauthorized", policy);
    const replay: ReplayRecord = { credential_id: credential.credential_id, idempotency_key: request.idempotency_key, request_digest: digest, nonce: request.nonce, timestamp: request.timestamp, phase: "executing", response: null };
    this.state.records.push(replay); this.compactReplay(); this.persistReplay();
    this.afterExecutionCheckpoint();
    let response: RepoFlightWireResponse;
    try {
      const payload = request.action === "command" ? bindAuthenticatedActor(request.payload, credential.instance_id) : request.payload;
      const result = request.action === "query" ? this.options.operator.executeQuery(payload) : this.options.operator.executeCommand(payload);
      response = Object.freeze({ version: 1, request_id: request.request_id, ok: true, result: sanitize(this.scopeResult(credential, request, result)) });
    } catch (error) { response = wireFailure(request.request_id, "internal", boundedError(error)); }
    response = boundedResponse(response, this.maxFrame);
    replay.phase = "completed"; replay.response = response; this.persistReplay();
    return response;
  }

  private authorizeScope(credential: RepoFlightCredential, request: RepoFlightWireRequest): string | null {
    const instanceId = credential.instance_id;
    if (instanceId === null) return "credential lacks an authenticated actor binding";
    if (request.action === "command" && !isRepoFlightOperatorCommandEnvelope(request.payload)) return "command envelope is invalid";
    if (credential.scope === "operator") return null;
    if (request.action === "query") {
      if (!isRepoFlightOperatorQueryEnvelope(request.payload)) return "agent query envelope is invalid";
      return ["repo.flight.sessions", "repo.flight.deliveries"].includes(request.payload.query.kind) ? null : "query is outside enrolled-agent scope";
    }
    const commandEnvelope = request.payload;
    if (!isRepoFlightOperatorCommandEnvelope(commandEnvelope)) return "agent command envelope is invalid";
    if (commandEnvelope.metadata.actor_id !== instanceId) return "command actor does not match the enrolled agent credential";
    const command = commandEnvelope.command;
    if (command.kind === "repo.flight.session.drain") return command.instance_id === instanceId ? null : "agent may drain only its own enrolled instance";
    if (command.kind === "repo.flight.delivery.transition") {
      if (command.request.actor_instance_id !== instanceId) return "delivery receipt actor does not match the enrolled instance";
      return ["claimed", "delivered", "acknowledged"].includes(command.request.to) ? null : "agent may not certify a terminal or ambiguous effect";
    }
    return "command is outside enrolled-agent scope";
  }

  private scopeResult(credential: RepoFlightCredential, request: RepoFlightWireRequest, result: unknown): unknown {
    if (credential.scope !== "agent" || request.action !== "query" || credential.instance_id === null || !isRepoFlightOperatorQueryEnvelope(request.payload)) return result;
    if (typeof result !== "object" || result === null || !(result as { ok?: unknown }).ok || !Array.isArray((result as { value?: unknown }).value)) return result;
    const value = (result as { value: unknown[] }).value;
    if (request.payload.query.kind === "repo.flight.sessions") return { ...(result as object), value: value.filter((item) => typeof item === "object" && item !== null && (item as { instance_id?: unknown }).instance_id === credential.instance_id) };
    if (request.payload.query.kind === "repo.flight.deliveries") return { ...(result as object), value: value.filter((item) => typeof item === "object" && item !== null && (item as { target_instance_id?: unknown }).target_instance_id === credential.instance_id) };
    return result;
  }

  private send(socket: Socket, response: RepoFlightWireResponse): void { socket.end(`${JSON.stringify(sanitize(response))}\n`); }
  /** Testable crash boundary: the executing record is durable and no effect has been dispatched yet. */
  protected afterExecutionCheckpoint(): void { /* host interruption may occur at this boundary */ }
  private assertOpen(): void { if (this.closed) throw new Error("repo-flight controller is closed"); }
  private removeStaleSocket(): void { if (!existsSync(this.socket_path)) return; const stat = lstatSync(this.socket_path); if (!stat.isSocket()) throw new Error("repo-flight socket path is occupied by a non-socket file"); unlinkSync(this.socket_path); }
  private loadOrCreateCredential(path: string, scope: "operator", instanceId: string): RepoFlightOperatorCredential {
    if (!existsSync(path)) durableWrite(path, { version: 1, credential_id: `${scope}:${randomUUID()}`, scope, instance_id: instanceId, secret: randomBytes(32).toString("base64url") });
    const stat = lstatSync(path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("repo-flight credential file must be a private regular file");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validCredential(parsed) || parsed.scope !== scope || parsed.instance_id !== instanceId) throw new Error("repo-flight credential is malformed or rebound");
    return parsed;
  }
  private loadAgentCredentials(): void { for (const name of readNames(this.directory).filter((name) => name.startsWith("agent-") && name.endsWith(".credential.json"))) { const path = join(this.directory, name); const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); if (!validCredential(parsed) || parsed.scope !== "agent" || (lstatSync(path).mode & 0o077) !== 0) throw new Error("repo-flight agent credential is malformed"); this.credentials.set(parsed.credential_id, parsed); } }
  private restoreReplay(): ReplayState { if (!existsSync(this.replayPath)) return { version: 1, records: [], nonces: [] }; const parsed: unknown = JSON.parse(readFileSync(this.replayPath, "utf8")); if (!validReplayState(parsed)) throw new Error("repo-flight replay state is malformed"); return parsed; }
  private persistReplay(): void { durableWrite(this.replayPath, this.state); }
  private compactReplay(): void { if (this.state.records.length > MAX_REPLAY_RECORDS) { const executing = this.state.records.filter((record) => record.phase === "executing"); const completed = this.state.records.filter((record) => record.phase === "completed").slice(-Math.max(0, MAX_REPLAY_RECORDS - executing.length)); this.state.records = [...executing, ...completed]; } if (this.state.nonces.length > MAX_REPLAY_RECORDS) this.state.nonces = this.state.nonces.slice(-MAX_REPLAY_RECORDS); }
}

export interface RepoFlightClientOptions { readonly socket_path: string; readonly credential_path: string; readonly timeout_ms?: number; readonly now?: () => Date; readonly max_frame_bytes?: number }
export class RepoFlightClient {
  private readonly credential: RepoFlightCredential;
  private readonly timeout: number;
  private readonly now: () => Date;
  private readonly maxFrame: number;
  constructor(private readonly options: RepoFlightClientOptions) {
    const stat = lstatSync(options.credential_path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("repo-flight client credential must be a private regular file");
    const parsed: unknown = JSON.parse(readFileSync(options.credential_path, "utf8")); if (!validCredential(parsed)) throw new Error("repo-flight client credential is malformed"); this.credential = parsed;
    this.timeout = options.timeout_ms ?? 5_000; this.maxFrame = options.max_frame_bytes ?? REPO_FLIGHT_DEFAULT_MAX_FRAME_BYTES; this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 300_000) throw new Error("repo-flight client timeout is invalid");
  }

  query(payload: unknown, idempotencyKey = `query:${randomUUID()}`, nonce: string = randomUUID()): Promise<RepoFlightWireResponse> { return this.request("query", payload, idempotencyKey, nonce); }
  command(payload: unknown, idempotencyKey: string, nonce: string = randomUUID()): Promise<RepoFlightWireResponse> { return this.request("command", payload, idempotencyKey, nonce); }

  private request(action: "query" | "command", payload: unknown, idempotencyKey: string, nonce: string): Promise<RepoFlightWireResponse> {
    if (!validId(idempotencyKey) || !validId(nonce)) return Promise.resolve(wireFailure("unknown", "validation", "client idempotency key or nonce is invalid"));
    const unsigned = { version: 1 as const, request_id: `transport:${randomUUID()}`, credential_id: this.credential.credential_id, scope: this.credential.scope, timestamp: this.now().toISOString(), nonce, idempotency_key: idempotencyKey, action, payload };
    const request: RepoFlightWireRequest = Object.freeze({ ...unsigned, signature: signWireRequest(this.credential.secret, unsigned) });
    const bytes = `${JSON.stringify(request)}\n`; if (Buffer.byteLength(bytes) > this.maxFrame) return Promise.resolve(wireFailure(request.request_id, "oversized", "request frame exceeds the configured bound"));
    return new Promise((resolve) => {
      const socket = createConnection(this.options.socket_path); let frame = "", size = 0, settled = false;
      const finish = (response: RepoFlightWireResponse): void => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(response); };
      const timer = setTimeout(() => finish(wireFailure(request.request_id, "timeout", "repo-flight controller did not respond before the deadline")), this.timeout);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.end(bytes));
      socket.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > this.maxFrame) return finish(wireFailure(request.request_id, "oversized", "response frame exceeds the configured bound")); frame += chunk; });
      socket.on("error", () => finish(wireFailure(request.request_id, "unavailable", "repo-flight controller is unavailable")));
      socket.on("end", () => {
        if (settled) return;
        const newline = frame.indexOf("\n");
        if (newline < 0) return finish(wireFailure(request.request_id, "unavailable", "repo-flight controller closed without a complete response"));
        if (frame.slice(newline + 1).trim().length > 0) return finish(wireFailure(request.request_id, "validation", "exactly one response frame is permitted"));
        let parsed: unknown;
        try { parsed = JSON.parse(frame.slice(0, newline)); }
        catch { return finish(wireFailure(request.request_id, "validation", "controller response is malformed")); }
        finish(validWireResponse(parsed) && parsed.request_id === request.request_id ? parsed : wireFailure(request.request_id, "validation", "controller response uses an unknown schema or request binding"));
      });
    });
  }
}

function bindAuthenticatedActor(payload: unknown, actor: string | null): unknown {
  if (actor === null || !isRepoFlightOperatorCommandEnvelope(payload)) throw new Error("repo-flight command lacks an authenticated actor");
  return { ...payload, metadata: { ...payload.metadata, actor_id: actor } };
}
function signWireRequest(secret: string, request: Omit<RepoFlightWireRequest, "signature"> | RepoFlightWireRequest): string { const { signature: _signature, ...unsigned } = request as RepoFlightWireRequest; return hmacHex(secret, canonical(unsigned)); }
function requestDigest(request: RepoFlightWireRequest): `sha256:${string}` { const { signature: _signature, nonce: _nonce, timestamp: _timestamp, request_id: _requestId, ...semantic } = request; return sha256(canonical(semantic)); }
function boundedResponse(response: RepoFlightWireResponse, max: number): RepoFlightWireResponse { const bytes = JSON.stringify(response); return Buffer.byteLength(bytes) <= max ? response : wireFailure(response.request_id, "oversized", "sanitized response exceeds the configured bound", sha256(bytes)); }
function wireFailure(requestId: string, code: NonNullable<RepoFlightWireResponse["error"]>["code"], summary: string, responseDigest?: `sha256:${string}`): RepoFlightWireResponse { return Object.freeze({ version: 1, request_id: validId(requestId) ? requestId : "unknown", ok: false, error: Object.freeze({ code, summary: redact(summary), ...(responseDigest === undefined ? {} : { response_digest: responseDigest }) }) }); }
function safeEqual(a: string, b: string): boolean { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function hmacHex(secret: string, value: string): string { return createHmac("sha256", secret).update(value).digest("hex"); }
function sha256(value: string): `sha256:${string}` { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; }
function sanitize(value: unknown): unknown { if (Array.isArray(value)) return value.slice(0, 1_000).map(sanitize); if (value === null || typeof value !== "object") return typeof value === "string" ? redact(value) : value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/(?:^|_)(?:token|secret|password|signature)(?:$|_)/iu.test(key)).slice(0, 1_000).map(([key, item]) => [key, sanitize(item)])); }
function redact(value: string): string { return value.replace(/(signing[_ -]?secret|api[_ -]?key|bearer|token|password)\s*[:=]\s*\S+/giu, "$1=[redacted]").replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").slice(0, 2_048); }
function boundedError(error: unknown): string { return redact(error instanceof Error ? error.message : "repo-flight transport failed"); }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> { const keys = [...required, ...optional]; return typeof value === "object" && value !== null && !Array.isArray(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key)); }
function validWireRequest(value: unknown): value is RepoFlightWireRequest { return exact(value, ["version", "request_id", "credential_id", "scope", "timestamp", "nonce", "idempotency_key", "action", "payload", "signature"]) && value.version === 1 && validId(value.request_id) && validId(value.credential_id) && (value.scope === "operator" || value.scope === "agent") && typeof value.timestamp === "string" && validId(value.nonce) && validId(value.idempotency_key) && (value.action === "query" || value.action === "command") && typeof value.signature === "string" && /^[a-f0-9]{64}$/.test(value.signature); }
function validWireResponse(value: unknown): value is RepoFlightWireResponse { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const response = value as Record<string, unknown>; if (response.ok === true) return exact(response, ["version", "request_id", "ok", "result"]) && response.version === 1 && validId(response.request_id); if (response.ok !== false || !exact(response, ["version", "request_id", "ok", "error"]) || response.version !== 1 || !validId(response.request_id) || !exact(response.error, ["code", "summary"], ["response_digest"])) return false; return typeof response.error.code === "string" && ["validation", "unauthorized", "replay", "conflict", "unavailable", "timeout", "oversized", "indeterminate", "internal"].includes(response.error.code) && typeof response.error.summary === "string" && (response.error.response_digest === undefined || /^sha256:[a-f0-9]{64}$/.test(String(response.error.response_digest))); }
function validCredential(value: unknown): value is RepoFlightCredential {
  if (exact(value, ["version", "credential_id", "scope", "instance_id", "secret"])) return value.version === 1 && value.scope === "operator" && validId(value.credential_id) && validId(value.instance_id) && validSecret(value.secret);
  return exact(value, ["version", "credential_id", "scope", "instance_id", "repository_id", "repo_run_id", "provider_session_ref", "process_identity_ref", "revocation_epoch", "active", "operations", "issued_at", "expires_at", "credential_signature", "secret"])
    && value.version === 2 && value.scope === "agent" && validId(value.credential_id) && validAgentBinding(value) && value.active === true
    && Array.isArray(value.operations) && JSON.stringify(value.operations) === JSON.stringify(["query.self", "session.drain", "delivery.receipt"])
    && validDate(value.issued_at) && validDate(value.expires_at) && Date.parse(value.expires_at) > Date.parse(value.issued_at)
    && typeof value.credential_signature === "string" && /^[a-f0-9]{64}$/.test(value.credential_signature) && validSecret(value.secret);
}
function validAgentBinding(value: unknown): value is RepoFlightAgentCredentialBinding { return typeof value === "object" && value !== null && validId((value as RepoFlightAgentCredentialBinding).instance_id) && validId((value as RepoFlightAgentCredentialBinding).repository_id) && validId((value as RepoFlightAgentCredentialBinding).repo_run_id) && validId((value as RepoFlightAgentCredentialBinding).provider_session_ref) && validId((value as RepoFlightAgentCredentialBinding).process_identity_ref) && Number.isSafeInteger((value as RepoFlightAgentCredentialBinding).revocation_epoch) && (value as RepoFlightAgentCredentialBinding).revocation_epoch >= 0 && typeof (value as RepoFlightAgentCredentialBinding).active === "boolean"; }
function sameAgentBinding(credential: RepoFlightAgentCredential, current: RepoFlightAgentCredentialBinding): boolean { return credential.instance_id === current.instance_id && credential.repository_id === current.repository_id && credential.repo_run_id === current.repo_run_id && credential.provider_session_ref === current.provider_session_ref && credential.process_identity_ref === current.process_identity_ref && credential.revocation_epoch === current.revocation_epoch; }
function credentialClaims(value: RepoFlightAgentCredential): Omit<RepoFlightAgentCredential, "credential_signature"> { const { credential_signature: _signature, ...claims } = value; return claims; }
function credentialSignature(secret: string, value: unknown): string { return hmacHex(secret, canonicalizeForHash(value)); }
function validSecret(value: unknown): value is string { return typeof value === "string" && value.length >= 43 && value.length <= 128; }
function validDate(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function validReplayState(value: unknown): value is ReplayState { if (!exact(value, ["version", "records", "nonces"]) || value.version !== 1 || !Array.isArray(value.records) || !Array.isArray(value.nonces) || value.records.length > MAX_REPLAY_RECORDS || value.nonces.length > MAX_REPLAY_RECORDS) return false; if (!value.nonces.every((item) => exact(item, ["credential_id", "nonce", "timestamp"]) && validId(item.credential_id) && validId(item.nonce) && typeof item.timestamp === "string")) return false; const nonceKeys = value.nonces.map((item) => `${String((item as Record<string, unknown>).credential_id)}\0${String((item as Record<string, unknown>).nonce)}`); if (new Set(nonceKeys).size !== nonceKeys.length) return false; const records = value.records as unknown[]; if (!records.every((item) => typeof item === "object" && item !== null && validId((item as ReplayRecord).credential_id) && validId((item as ReplayRecord).idempotency_key) && /^sha256:[a-f0-9]{64}$/.test((item as ReplayRecord).request_digest) && validId((item as ReplayRecord).nonce) && ((item as ReplayRecord).phase === "executing" || (item as ReplayRecord).phase === "completed") && ((item as ReplayRecord).response === null || validWireResponse((item as ReplayRecord).response)))) return false; const idemKeys = records.map((item) => `${(item as ReplayRecord).credential_id}\0${(item as ReplayRecord).idempotency_key}`); return new Set(idemKeys).size === idemKeys.length; }
function requestIdFrom(value: unknown): string { return typeof value === "object" && value !== null && validId((value as { request_id?: unknown }).request_id) ? (value as { request_id: string }).request_id : "unknown"; }
function readNames(path: string): string[] { return readdirSync(path); }
function durableWrite(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${randomUUID()}.tmp`; let fd: number | null = null; try { fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); closeSync(fd); fd = null; renameSync(temporary, path); chmodSync(path, 0o600); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } } finally { if (fd !== null) closeSync(fd); if (existsSync(temporary)) try { unlinkSync(temporary); } catch { /* bounded orphan temp */ } } }
