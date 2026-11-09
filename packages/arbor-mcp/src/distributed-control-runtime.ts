import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { RemoteRuntimeIngress } from "./remote-ingress.js";
import type { DistributedControlRoute, DistributedControlResult, DistributedHostGrant } from "./distributed-control-plane.js";
import { DistributedControlClient, DistributedControlHttpHost, DistributedControlPlane } from "./distributed-control-plane.js";
import { DistributedRemoteBridge } from "./distributed-remote-bridge.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DistributedSecretRef = { kind: "env"; name: string } | { kind: "file"; path: string };
export interface DistributedAuthorityConfig {
  version: 1;
  role: "authority";
  persistence_dir: string;
  listener: { host: string; port: number; allow_wildcard_bind?: boolean; tls?: { key_ref: DistributedSecretRef; cert_file: string } };
  grants: Record<string, Omit<DistributedHostGrant, "secret"> & { secret_ref: DistributedSecretRef }>;
}
export interface DistributedJoinConfig {
  version: 1;
  role: "join";
  persistence_dir: string;
  coordinator_url: string;
  host_id: string;
  secret_ref: DistributedSecretRef;
  registration: { repo_id: string; session_id: string; endpoint: string; capabilities: string[]; ttl_ms: number };
  heartbeat_ms?: number;
  bridge?: { enabled: boolean; persistence_dir: string; poll_interval_ms?: number; visibility_timeout_ms?: number };
}
export type DistributedControlRuntimeConfig = DistributedAuthorityConfig | DistributedJoinConfig;
export type DistributedRuntimeProjection = {
  version: 1;
  role: "authority" | "join";
  state: "created" | "started" | "degraded" | "closed";
  host_id: string | null;
  coordinator: { reachable: boolean; address: string | null; error: string | null };
  registration: { registered: boolean; heartbeat_at: string | null; failure_count: number } | null;
  bridge: { status: "disabled" | "ready" | "degraded"; outbox_pending: number; results_pending: number; dead_letters: number };
  health: Json | null;
};
export type DistributedControlOperatorProjection =
  | { availability: "configured"; kind: "control.status"; updated_at: string | null; value: DistributedRuntimeProjection }
  | { availability: "configured"; kind: "control.discover"; updated_at: string | null; value: { hosts: Json[]; truncated: boolean } }
  | { availability: "configured"; kind: "control.inbox"; updated_at: string | null; value: { messages: Json[]; truncated: boolean } };
export interface DistributedControlRuntimeDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  config_dir?: string;
  ingress?: Pick<RemoteRuntimeIngress, "dispatchTransport">;
  fetch?: typeof fetch;
  now?: () => Date;
}

const ROUTES = new Set<DistributedControlRoute>(["hosts.register", "hosts.discover", "messages.send", "messages.receive", "leases.manage", "adoptions.manage", "grants.manage", "health.read"]);
export const DISTRIBUTED_CONTROL_CONFIG_ENV = "ARBOR_DISTRIBUTED_CONTROL_CONFIG";
const atom = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteJson = (value: unknown): value is Json => value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(finiteJson) || record(value) && Object.values(value).every(finiteJson);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

export function resolveDistributedSecret(ref: DistributedSecretRef, options: { env?: Readonly<Record<string, string | undefined>>; config_dir?: string } = {}): string {
  if (!validSecretRef(ref)) throw new Error("distributed secret reference must be an env name or regular file path");
  if (ref.kind === "env") {
    const value = (options.env ?? process.env)[ref.name];
    if (!value || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error(`distributed secret environment reference ${ref.name} is absent or malformed`);
    return value;
  }
  const path = isAbsolute(ref.path) ? ref.path : resolve(options.config_dir ?? process.cwd(), ref.path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 32 || stat.size > 4096) throw new Error("distributed secret file must be a non-symlink regular file, mode 0600 or stricter, and 32 through 4096 bytes");
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error("distributed secret file is empty");
  return value;
}

export function loadDistributedControlConfig(path: string): DistributedControlRuntimeConfig {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("distributed control config must be a bounded regular file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validConfig(parsed)) throw new Error("distributed control config does not match the closed v1 schema");
  return structuredClone(parsed);
}

export function distributedControlFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  dependencies: Omit<DistributedControlRuntimeDependencies, "env" | "config_dir"> = {},
): DistributedControlRuntime | null {
  const configured = env[DISTRIBUTED_CONTROL_CONFIG_ENV];
  if (!configured?.trim()) return null;
  const path = isAbsolute(configured) ? configured : resolve(cwd, configured);
  return new DistributedControlRuntime(loadDistributedControlConfig(path), { ...dependencies, env, config_dir: dirname(path) });
}

export class DistributedControlRuntime {
  private plane: DistributedControlPlane | null = null;
  private server: DistributedControlHttpHost | null = null;
  private client: DistributedControlClient | null = null;
  private bridge: DistributedRemoteBridge | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private state: "created" | "started" | "degraded" | "closed" = "created";
  private address: string | null = null;
  private heartbeatAt: string | null = null;
  private heartbeatFailures = 0;
  private lastError: string | null = null;
  private registrationCounter = 0;
  private cachedHealth: Json | null = null;
  private cachedHosts: Json[] = [];
  private cachedMessages: Json[] = [];
  private cacheUpdatedAt: string | null = null;

  constructor(readonly config: DistributedControlRuntimeConfig, private readonly dependencies: DistributedControlRuntimeDependencies = {}) { if (!validConfig(config)) throw new Error("distributed control runtime config is malformed"); }

  /** Resolve the ArborRuntime/RemoteRuntimeIngress construction cycle exactly once, before lifecycle start. */
  attachIngress(ingress: Pick<RemoteRuntimeIngress, "dispatchTransport">): void {
    if (this.state !== "created") throw new Error("distributed ingress may only be attached before runtime start");
    if (this.dependencies.ingress) throw new Error("distributed ingress is already attached");
    this.dependencies.ingress = ingress;
  }

  async start(): Promise<DistributedRuntimeProjection> {
    if (this.state !== "created") throw new Error("distributed control runtime may only start once");
    try {
      if (this.config.role === "authority") await this.startAuthority(this.config); else await this.startJoin(this.config);
      this.state = "started";
    } catch (error) {
      this.state = "degraded"; this.lastError = error instanceof Error ? error.message : "distributed runtime start failed";
      await this.close(); throw error;
    }
    return this.project();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    this.bridge?.close(); this.bridge = null;
    if (this.server) await this.server.stop(); this.server = null;
    this.plane?.close(); this.plane = null; this.client = null; this.state = "closed";
  }

  async project(): Promise<DistributedRuntimeProjection> {
    let health: Json | null = null;
    if (this.client && this.state !== "closed") {
      const result = await this.client.request<Json>("GET", "/v1/health");
      if (result.ok) health = boundedJson(result.value); else { this.lastError = result.summary; this.state = "degraded"; }
    } else if (this.plane && this.config.role === "authority") {
      const config = this.config;
      const operator = Object.keys(config.grants).find((host) => config.grants[host]?.routes.includes("health.read"));
      if (operator) { const result = this.plane.health(operator); if (result.ok) health = boundedJson(result.value); }
    }
    const bridge = this.bridge?.health();
    return { version: 1, role: this.config.role, state: this.state, host_id: this.config.role === "join" ? this.config.host_id : null, coordinator: { reachable: this.state === "started" && this.lastError === null, address: this.address, error: this.lastError }, registration: this.config.role === "join" ? { registered: this.heartbeatAt !== null, heartbeat_at: this.heartbeatAt, failure_count: this.heartbeatFailures } : null, bridge: bridge ? { status: bridge.status, outbox_pending: bridge.outbox_pending, results_pending: bridge.results_pending, dead_letters: bridge.dead_letters } : { status: "disabled", outbox_pending: 0, results_pending: 0, dead_letters: 0 }, health };
  }

  /** Synchronous, bounded read model for runtime-catalog/TUI/Web consumers. */
  operatorProjection(kind: "control.status" | "control.discover" | "control.inbox"): DistributedControlOperatorProjection {
    if (kind === "control.discover") return { availability: "configured", kind, updated_at: this.cacheUpdatedAt, value: { hosts: structuredClone(this.cachedHosts), truncated: false } };
    if (kind === "control.inbox") return { availability: "configured", kind, updated_at: this.cacheUpdatedAt, value: { messages: structuredClone(this.cachedMessages), truncated: false } };
    const bridge = this.bridge?.health();
    return { availability: "configured", kind, updated_at: this.cacheUpdatedAt, value: { version: 1, role: this.config.role, state: this.state, host_id: this.config.role === "join" ? this.config.host_id : null, coordinator: { reachable: this.state === "started" && this.lastError === null, address: this.address, error: this.lastError }, registration: this.config.role === "join" ? { registered: this.heartbeatAt !== null, heartbeat_at: this.heartbeatAt, failure_count: this.heartbeatFailures } : null, bridge: bridge ? { status: bridge.status, outbox_pending: bridge.outbox_pending, results_pending: bridge.results_pending, dead_letters: bridge.dead_letters } : { status: "disabled", outbox_pending: 0, results_pending: 0, dead_letters: 0 }, health: structuredClone(this.cachedHealth) } };
  }

  async discover(limit = 100): Promise<DistributedControlResult<{ hosts: Json[]; truncated: boolean }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return { ok: false, error: "malformed", summary: "discover limit must be 1 through 500" };
    const result = await this.requiredClient().request<{ hosts: Array<Record<string, unknown>> }>("GET", "/v1/hosts");
    if (!result.ok) return result;
    return { ok: true, value: { hosts: result.value.hosts.slice(0, limit).map((host) => ({ host_id: stringOrNull(host.host_id), repo_id: stringOrNull(host.repo_id), session_id: stringOrNull(host.session_id), capabilities: Array.isArray(host.capabilities) ? host.capabilities.filter((item): item is string => typeof item === "string").slice(0, 64) : [], heartbeat_at: stringOrNull(host.heartbeat_at), expires_at: stringOrNull(host.expires_at) })), truncated: result.value.hosts.length > limit } };
  }

  async inbox(limit = 100): Promise<DistributedControlResult<{ messages: Json[]; truncated: boolean }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return { ok: false, error: "malformed", summary: "inbox limit must be 1 through 500" };
    const result = await this.requiredClient().request<{ messages: Array<Record<string, unknown>> }>("GET", `/v1/inbox?limit=${limit}`);
    if (!result.ok) return result;
    return { ok: true, value: { messages: result.value.messages.slice(0, limit).map((message) => ({ message_id: stringOrNull(message.message_id), sequence: numberOrNull(message.sequence), sender_host_id: stringOrNull(message.sender_host_id), kind: stringOrNull(message.kind), correlation_id: stringOrNull(message.correlation_id), created_at: stringOrNull(message.created_at), delivery_attempts: numberOrNull(message.delivery_attempts), claimed: typeof message.claim_id === "string", payload_bytes: byteLength(message.payload) })), truncated: result.value.messages.length > limit } };
  }

  request<T>(method: "GET" | "POST", path: string, body: Json = {}): Promise<DistributedControlResult<T>> { return this.requiredClient().request<T>(method, path, body); }
  authorityAddress(): string | null { return this.address; }

  private async startAuthority(config: DistributedAuthorityConfig): Promise<void> {
    const grants: Record<string, DistributedHostGrant> = {};
    for (const [host, grant] of Object.entries(config.grants)) grants[host] = { ...grant, secret: resolveDistributedSecret(grant.secret_ref, this.dependencies), routes: grant.routes };
    this.plane = new DistributedControlPlane({ persistence_dir: config.persistence_dir, host_grants: grants, now: this.dependencies.now });
    const tls = config.listener.tls ? { key: resolvePem(config.listener.tls.key_ref, this.dependencies), cert: readBoundedFile(config.listener.tls.cert_file, this.dependencies.config_dir) } : undefined;
    this.server = new DistributedControlHttpHost(this.plane, { enabled: true, host: config.listener.host, port: config.listener.port, allow_wildcard_bind: config.listener.allow_wildcard_bind, ...(tls ? { tls } : {}) });
    const bound = await this.server.start(); this.address = `${bound.protocol}//${bound.host}:${bound.port}`;
  }

  private async startJoin(config: DistributedJoinConfig): Promise<void> {
    const secret = resolveDistributedSecret(config.secret_ref, this.dependencies);
    this.client = new DistributedControlClient({ base_url: config.coordinator_url, host_id: config.host_id, secret, fetch: this.dependencies.fetch, now: this.dependencies.now }); this.address = config.coordinator_url;
    await this.register();
    await this.refreshOperatorView();
    if (config.bridge?.enabled) {
      if (!this.dependencies.ingress) throw new Error("enabled distributed bridge requires a production RemoteRuntimeIngress");
      this.bridge = new DistributedRemoteBridge({ client: this.client, ingress: this.dependencies.ingress, persistence_dir: config.bridge.persistence_dir, poll_interval_ms: config.bridge.poll_interval_ms, visibility_timeout_ms: config.bridge.visibility_timeout_ms }); this.bridge.start();
    }
    const heartbeatMs = config.heartbeat_ms ?? Math.max(1_000, Math.floor(config.registration.ttl_ms / 3));
    this.heartbeat = setInterval(() => { void this.register().then(() => this.refreshOperatorView()).catch((error) => { this.heartbeatFailures++; this.lastError = error instanceof Error ? error.message : "registration heartbeat failed"; this.state = "degraded"; }); }, heartbeatMs); this.heartbeat.unref?.();
  }

  private async register(): Promise<void> {
    if (this.config.role !== "join") return;
    const config = this.config;
    const result = await this.requiredClient().request("POST", "/v1/hosts/register", { request_id: `registration:${config.host_id}:${++this.registrationCounter}:${randomUUID()}`, ...config.registration });
    if (!result.ok) throw new Error(result.summary);
    this.heartbeatAt = (this.dependencies.now ?? (() => new Date()))().toISOString(); this.heartbeatFailures = 0; this.lastError = null; if (this.state === "degraded") this.state = "started";
  }

  private async refreshOperatorView(): Promise<void> {
    if (this.config.role !== "join") return;
    const [health, hosts, inbox] = await Promise.all([
      this.requiredClient().request<Json>("GET", "/v1/health"),
      this.discover(100),
      this.inbox(100),
    ]);
    if (!health.ok || !hosts.ok || !inbox.ok) throw new Error(!health.ok ? health.summary : !hosts.ok ? hosts.summary : inbox.ok ? "control projection refresh failed" : inbox.summary);
    this.cachedHealth = boundedJson(health.value); this.cachedHosts = hosts.value.hosts.slice(0, 100); this.cachedMessages = inbox.value.messages.slice(0, 100); this.cacheUpdatedAt = (this.dependencies.now ?? (() => new Date()))().toISOString();
  }

  private requiredClient(): DistributedControlClient { if (!this.client || this.state === "closed") throw new Error("distributed join runtime is not active"); return this.client; }
}

export interface DistributedControlCliIo extends DistributedControlRuntimeDependencies { cwd: string; stdout: Writable; stderr: Writable; shutdown?: Promise<void>; runtime_factory?: (config: DistributedControlRuntimeConfig, dependencies: DistributedControlRuntimeDependencies) => DistributedControlRuntime }
export async function runDistributedControlCli(args: readonly string[], io: DistributedControlCliIo): Promise<number> {
  const configPath = flag(args, "--config");
  if (!configPath) { io.stderr.write(`${CONTROL_USAGE}\n`); return 2; }
  let runtime: DistributedControlRuntime | null = null;
  try {
    const resolvedConfig = resolve(io.cwd, configPath), config = loadDistributedControlConfig(resolvedConfig), dependencies = { env: io.env, config_dir: dirname(resolvedConfig), ingress: io.ingress, fetch: io.fetch, now: io.now }, create = io.runtime_factory ?? ((value, deps) => new DistributedControlRuntime(value, deps));
    runtime = create(config, dependencies);
    const command = args[0];
    if (command === "serve") { if (config.role !== "authority") throw new Error("control serve requires an authority config"); const projection = await runtime.start(); write(io.stdout, { ...projection, bound_address: runtime.authorityAddress() }); await (io.shutdown ?? new Promise<void>(() => {})); return 0; }
    if (config.role !== "join") throw new Error(`control ${command ?? "command"} requires a join config`);
    await runtime.start();
    if (command === "join") { write(io.stdout, await runtime.project()); if (!args.includes("--once")) await (io.shutdown ?? new Promise<void>(() => {})); return 0; }
    if (command === "status") { write(io.stdout, await runtime.project()); return 0; }
    if (command === "discover") return emit(io, await runtime.discover(numberFlag(args, "--limit", 100)));
    if (command === "inbox") return emit(io, await runtime.inbox(numberFlag(args, "--limit", 100)));
    if (command === "lease") return emit(io, await leaseCommand(runtime, args.slice(1)));
    if (command === "adoption") return emit(io, await adoptionCommand(runtime, args.slice(1)));
    io.stderr.write(`${CONTROL_USAGE}\n`); return 2;
  } catch (error) { io.stderr.write(`${error instanceof Error ? error.message : "distributed control command failed"}\n`); return 4; }
  finally { await runtime?.close(); }
}

const CONTROL_USAGE = "Usage: arbor control <serve|join|status|discover|inbox|lease|adoption> --config <path> [command options]";
async function leaseCommand(runtime: DistributedControlRuntime, args: readonly string[]): Promise<DistributedControlResult<unknown>> {
  const action = args[0], requestId = flag(args, "--request-id") ?? `cli:${randomUUID()}`;
  if (action === "acquire") return runtime.request("POST", "/v1/leases/acquire", { request_id: requestId, resource_id: requiredFlag(args, "--resource"), ttl_ms: numberFlag(args, "--ttl-ms", 30_000) });
  if (action === "renew") return runtime.request("POST", "/v1/leases/renew", { request_id: requestId, lease_id: requiredFlag(args, "--lease"), fencing_token: requiredNumberFlag(args, "--fence"), ttl_ms: numberFlag(args, "--ttl-ms", 30_000) });
  if (action === "release") return runtime.request("POST", "/v1/leases/release", { request_id: requestId, lease_id: requiredFlag(args, "--lease"), fencing_token: requiredNumberFlag(args, "--fence") });
  return { ok: false, error: "malformed", summary: "lease action must be acquire, renew, or release" };
}
async function adoptionCommand(runtime: DistributedControlRuntime, args: readonly string[]): Promise<DistributedControlResult<unknown>> {
  const action = args[0], requestId = flag(args, "--request-id") ?? `cli:${randomUUID()}`;
  if (action === "prepare") return runtime.request("POST", "/v1/adoptions/prepare", { request_id: requestId, resource_id: requiredFlag(args, "--resource"), fencing_token: requiredNumberFlag(args, "--fence"), artifact_hash: requiredFlag(args, "--artifact-sha256"), base_head: requiredFlag(args, "--base-head"), selection_digest: requiredFlag(args, "--selection-sha256") });
  if (action === "commit" || action === "abort") return runtime.request("POST", `/v1/adoptions/${action}`, { request_id: requestId, transaction_id: requiredFlag(args, "--transaction") });
  if (action === "finalize") return runtime.request("POST", "/v1/adoptions/finalize", { request_id: requestId, transaction_id: requiredFlag(args, "--transaction"), result_head: requiredFlag(args, "--result-head"), tree_digest: requiredFlag(args, "--tree-sha256") });
  if (action === "inspect") return runtime.request("GET", `/v1/adoptions/${encodeURIComponent(requiredFlag(args, "--transaction"))}`);
  if (action === "reconcile") { const resolution = requiredFlag(args, "--resolution"); return runtime.request("POST", "/v1/adoptions/reconcile", { request_id: requestId, transaction_id: requiredFlag(args, "--transaction"), resolution, ...(resolution === "finalize" ? { result_head: requiredFlag(args, "--result-head"), tree_digest: requiredFlag(args, "--tree-sha256") } : {}) }); }
  return { ok: false, error: "malformed", summary: "adoption action must be prepare, commit, finalize, abort, inspect, or reconcile" };
}
function emit(io: Pick<DistributedControlCliIo, "stdout" | "stderr">, result: DistributedControlResult<unknown>): number { if (result.ok) { write(io.stdout, result.value); return 0; } io.stderr.write(`${JSON.stringify(result)}\n`); return result.error === "conflict" || result.error === "fence_rejected" ? 3 : 4; }
function write(output: Writable, value: unknown): void { output.write(`${JSON.stringify(boundedJson(value))}\n`); }
function boundedJson(value: unknown): Json { if (!finiteJson(value)) return null; const serialized = JSON.stringify(value); if (Buffer.byteLength(serialized) <= 256 * 1024) return structuredClone(value); return { truncated: true, byte_length: Buffer.byteLength(serialized) }; }
function byteLength(value: unknown): number { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; } }
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value.slice(0, 512) : null; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function flag(args: readonly string[], name: string): string | null { const index = args.indexOf(name); return index >= 0 && index + 1 < args.length ? args[index + 1] ?? null : null; }
function requiredFlag(args: readonly string[], name: string): string { const value = flag(args, name); if (!value) throw new Error(`${name} is required`); return value; }
function numberFlag(args: readonly string[], name: string, fallback: number): number { const raw = flag(args, name); const value = raw === null ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`); return value; }
function requiredNumberFlag(args: readonly string[], name: string): number { const value = Number(requiredFlag(args, name)); if (!positive(value)) throw new Error(`${name} must be a positive safe integer`); return value; }
function validSecretRef(value: unknown): value is DistributedSecretRef { return record(value) && (value.kind === "env" && keysAre(value, ["kind", "name"]) && typeof value.name === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(value.name) || value.kind === "file" && keysAre(value, ["kind", "path"]) && atom(value.path)); }
function validConfig(value: unknown): value is DistributedControlRuntimeConfig {
  if (!record(value) || value.version !== 1 || !atom(value.persistence_dir)) return false;
  if (value.role === "authority") {
    if (!keysAre(value, ["version", "role", "persistence_dir", "listener", "grants"]) || !record(value.listener) || !keysAre(value.listener, ["host", "port", "allow_wildcard_bind", "tls"]) || !atom(value.listener.host) || !Number.isSafeInteger(value.listener.port) || (value.listener.port as number) < 0 || (value.listener.port as number) > 65535 || !record(value.grants) || Object.keys(value.grants).length < 1 || Object.keys(value.grants).length > 10_000) return false;
    if (value.listener.tls !== undefined && (!record(value.listener.tls) || !keysAre(value.listener.tls, ["key_ref", "cert_file"]) || !validSecretRef(value.listener.tls.key_ref) || !atom(value.listener.tls.cert_file))) return false;
    return Object.values(value.grants).every((grant) => record(grant) && keysAre(grant, ["secret_ref", "routes", "resource_prefixes", "audiences", "capabilities", "expires_at", "revoked_at", "generation"]) && validSecretRef(grant.secret_ref) && Array.isArray(grant.routes) && grant.routes.length > 0 && grant.routes.every((route) => ROUTES.has(route as DistributedControlRoute)) && Array.isArray(grant.resource_prefixes ?? []) && Array.isArray(grant.audiences ?? []) && Array.isArray(grant.capabilities ?? []) && atom(grant.expires_at) && Number.isFinite(Date.parse(grant.expires_at as string)));
  }
  if (value.role !== "join" || !keysAre(value, ["version", "role", "persistence_dir", "coordinator_url", "host_id", "secret_ref", "registration", "heartbeat_ms", "bridge"]) || !atom(value.coordinator_url) || !atom(value.host_id) || !validSecretRef(value.secret_ref) || !record(value.registration) || !keysAre(value.registration, ["repo_id", "session_id", "endpoint", "capabilities", "ttl_ms"]) || !atom(value.registration.repo_id) || !atom(value.registration.session_id) || !atom(value.registration.endpoint) || !Array.isArray(value.registration.capabilities) || value.registration.capabilities.some((item) => !atom(item)) || !positive(value.registration.ttl_ms)) return false;
  if (value.heartbeat_ms !== undefined && (!positive(value.heartbeat_ms) || value.heartbeat_ms < 100)) return false;
  return value.bridge === undefined || record(value.bridge) && keysAre(value.bridge, ["enabled", "persistence_dir", "poll_interval_ms", "visibility_timeout_ms"]) && typeof value.bridge.enabled === "boolean" && atom(value.bridge.persistence_dir);
}
function resolvePem(ref: DistributedSecretRef, dependencies: DistributedControlRuntimeDependencies): string { if (ref.kind !== "file") throw new Error("TLS private key must use a permission-checked file secret reference"); return resolveDistributedSecret(ref, dependencies); }
function readBoundedFile(path: string, base = process.cwd()): string { const resolved = isAbsolute(path) ? path : resolve(base, path), stat = lstatSync(resolved); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error("referenced file must be a bounded non-symlink regular file"); return readFileSync(resolved, "utf8"); }
