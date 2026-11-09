import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MCP_MAX_FRAME_BYTES, MCP_STDERR_BYTES } from "./contracts.js";
import { JsonRpcClientError, parseBoundedJson, plain, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcTransport } from "./json-rpc.js";

export interface StdioMcpTransportOptions { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly credential_env?: string; readonly cwd?: string; readonly shutdown_grace_ms?: number; }
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly cleanup: () => void; }

export class StdioMcpTransport implements JsonRpcTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = "";
  private stderr = "";
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  constructor(private readonly options: StdioMcpTransportOptions) {
    if (!options.command.trim()) throw new JsonRpcClientError("transport", "MCP stdio command must be non-empty");
    if (options.credential_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(options.credential_env)) throw new JsonRpcClientError("transport", "MCP stdio credential environment name is invalid");
    if (options.shutdown_grace_ms !== undefined && (!Number.isSafeInteger(options.shutdown_grace_ms) || options.shutdown_grace_ms <= 0 || options.shutdown_grace_ms > 30_000)) throw new JsonRpcClientError("transport", "MCP stdio shutdown grace is invalid");
  }
  get connected(): boolean { return this.child !== null && this.child.exitCode === null && !this.child.killed; }
  onNotification(handler: (message: JsonRpcNotification) => void): () => void { this.notificationHandlers.add(handler); return () => { this.notificationHandlers.delete(handler); }; }
  async open(signal: AbortSignal, secret: string | null): Promise<void> {
    if (this.connected) return;
    if (signal.aborted) throw new JsonRpcClientError("transport", "MCP stdio start aborted");
    const env = sanitizedEnvironment(this.options.env ?? {});
    if (this.options.credential_env !== undefined && secret !== null) env[this.options.credential_env] = secret;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(this.options.command, [...(this.options.args ?? [])], { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false }); }
    catch { throw new JsonRpcClientError("transport", "MCP stdio server could not be spawned"); }
    this.child = child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderr = boundedAppend(this.stderr, chunk, MCP_STDERR_BYTES); });
    child.on("exit", () => { this.rejectAll(new JsonRpcClientError("closed", "MCP stdio server exited")); });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => { cleanup(); resolve(); };
      const onError = (): void => { cleanup(); this.child = null; reject(new JsonRpcClientError("transport", "MCP stdio server could not be spawned")); };
      const onAbort = (): void => { cleanup(); child.kill("SIGTERM"); reject(new JsonRpcClientError("transport", "MCP stdio start aborted")); };
      const cleanup = (): void => { child.off("spawn", onSpawn); child.off("error", onError); signal.removeEventListener("abort", onAbort); };
      child.once("spawn", onSpawn); child.once("error", onError); signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  exchange(message: JsonRpcRequest, options: { readonly signal: AbortSignal }): Promise<unknown> {
    const child = this.child;
    if (!this.connected || child === null) return Promise.reject(new JsonRpcClientError("closed", "MCP stdio transport is closed"));
    return new Promise((resolve, reject) => {
      const cleanup = (): void => options.signal.removeEventListener("abort", abort);
      const abort = (): void => { this.pending.delete(message.id); cleanup(); reject(new JsonRpcClientError("transport", "MCP stdio request aborted")); };
      if (options.signal.aborted) return abort();
      this.pending.set(message.id, { resolve, reject, cleanup });
      options.signal.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
        if (error) { cleanup(); this.pending.delete(message.id); reject(new JsonRpcClientError("transport", "MCP stdio write failed")); }
      });
    });
  }
  async notify(message: JsonRpcNotification, options: { readonly signal: AbortSignal }): Promise<void> {
    const child = this.child;
    if (!this.connected || child === null) throw new JsonRpcClientError("closed", "MCP stdio transport is closed");
    if (options.signal.aborted) throw new JsonRpcClientError("transport", "MCP stdio notification aborted");
    await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => error ? reject(new JsonRpcClientError("transport", "MCP stdio write failed")) : resolve()));
  }
  async close(_secret: string | null, _protocolVersion: string | null): Promise<void> {
    const child = this.child; this.child = null;
    if (child === null) return;
    this.rejectAll(new JsonRpcClientError("closed", "MCP stdio transport closed"));
    child.stdin.end();
    if (child.exitCode !== null) return;
    const grace = this.options.shutdown_grace_ms ?? 1_000;
    if (await exited(child, grace)) return;
    child.kill("SIGTERM");
    if (await exited(child, grace)) return;
    child.kill("SIGKILL");
    await exited(child, grace);
  }
  private onStdout(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) { if (Buffer.byteLength(this.stdout, "utf8") > MCP_MAX_FRAME_BYTES) this.protocolFailure("MCP stdio frame exceeds byte bound"); return; }
      const line = this.stdout.slice(0, newline).replace(/\r$/, ""); this.stdout = this.stdout.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) { this.protocolFailure("MCP stdio frame exceeds byte bound"); return; }
      let value: unknown;
      try { value = parseBoundedJson(line); } catch { this.protocolFailure("malformed MCP stdio frame"); return; }
      if (!plain(value) || value.jsonrpc !== "2.0") { this.protocolFailure("invalid MCP stdio envelope"); return; }
      if (!Object.prototype.hasOwnProperty.call(value, "id")) {
        if (typeof value.method !== "string" || !value.method) { this.protocolFailure("invalid MCP stdio notification"); return; }
        const notification: JsonRpcNotification = Object.freeze({ jsonrpc: "2.0", method: value.method, ...(value.params === undefined ? {} : { params: value.params }) });
        for (const handler of this.notificationHandlers) handler(notification);
        continue;
      }
      if (!Number.isSafeInteger(value.id)) { this.protocolFailure("invalid MCP stdio response id"); return; }
      const pending = this.pending.get(value.id as number); if (pending === undefined) { this.protocolFailure("MCP stdio response id is not pending"); return; }
      this.pending.delete(value.id as number); pending.cleanup(); pending.resolve(value);
    }
  }
  private protocolFailure(message: string): void { this.rejectAll(new JsonRpcClientError("protocol", message)); }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); } this.pending.clear(); }
}

function sanitizedEnvironment(declared: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key] !== undefined) output[key] = process.env[key];
  for (const [key, value] of Object.entries(declared)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && Buffer.byteLength(value, "utf8") <= 8 * 1024) output[key] = value;
  return output;
}
function boundedAppend(current: string, chunk: string, max: number): string { const next = current + chunk; return Buffer.byteLength(next, "utf8") <= max ? next : Buffer.from(next).subarray(-max).toString("utf8"); }
function exited(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> { return new Promise((resolve) => { if (child.exitCode !== null) return resolve(true); const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, ms); const done = (): void => { clearTimeout(timer); resolve(true); }; child.once("exit", done); }); }
