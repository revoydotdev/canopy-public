/**
 * StdioMcpTransport talks to a real child process over real pipes — there is
 * no seam to fake here, so these tests spawn tiny `node -e` scripts (this
 * repository's established idiom for exercising a real process boundary
 * hermetically, see sandbox-broker.test.ts) rather than mocking child_process.
 */
import { describe, expect, it } from "vitest";
import { StdioMcpTransport } from "../../src/mcp-client/stdio-transport.js";

const echoServer = `
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  const joined = chunks.join('');
  const parts = joined.split('\\n');
  chunks.length = 0;
  chunks.push(parts.pop());
  for (const line of parts) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } }) + '\\n');
  }
});
`;
const spawnEcho = () => new StdioMcpTransport({ command: process.execPath, args: ["-e", echoServer] });

describe("stdio MCP transport construction", () => {
  it("rejects an empty command", () => {
    expect(() => new StdioMcpTransport({ command: "  " })).toThrow(/non-empty/);
  });
  it("rejects a credential_env name that is not a valid identifier", () => {
    expect(() => new StdioMcpTransport({ command: "x", credential_env: "1bad-name" })).toThrow(/credential/);
  });
  it("accepts a valid credential_env name", () => {
    expect(() => new StdioMcpTransport({ command: "x", credential_env: "MCP_TOKEN" })).not.toThrow();
  });
  it("rejects a non-integer shutdown_grace_ms", () => {
    expect(() => new StdioMcpTransport({ command: "x", shutdown_grace_ms: 1.5 })).toThrow(/grace/);
  });
  it("rejects a zero or negative shutdown_grace_ms", () => {
    expect(() => new StdioMcpTransport({ command: "x", shutdown_grace_ms: 0 })).toThrow(/grace/);
  });
  it("rejects a shutdown_grace_ms above the 30s ceiling", () => {
    expect(() => new StdioMcpTransport({ command: "x", shutdown_grace_ms: 30_001 })).toThrow(/grace/);
  });
  it("starts disconnected before open()", () => {
    expect(spawnEcho().connected).toBe(false);
  });
});

describe("stdio MCP transport open()", () => {
  it("refuses to start once the caller's signal is already aborted", async () => {
    const transport = spawnEcho(); const controller = new AbortController(); controller.abort();
    await expect(transport.open(controller.signal, null)).rejects.toMatchObject({ code: "transport" });
    expect(transport.connected).toBe(false);
  });
  it("becomes connected after a real spawn succeeds", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    expect(transport.connected).toBe(true);
    await transport.close(null, null);
  });
  it("is a no-op the second time when already connected", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    await expect(transport.open(new AbortController().signal, null)).resolves.toBeUndefined();
    expect(transport.connected).toBe(true);
    await transport.close(null, null);
  });
  it("rejects when the command cannot be spawned at all", async () => {
    const transport = new StdioMcpTransport({ command: "/definitely/not/a/real/binary-xyz" });
    await expect(transport.open(new AbortController().signal, null)).rejects.toMatchObject({ code: "transport" });
    expect(transport.connected).toBe(false);
  });
});

describe("stdio MCP transport exchange()/notify()", () => {
  it("rejects exchange before the transport is open", async () => {
    const transport = spawnEcho();
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "ping" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "closed" });
  });
  it("writes a request to the child's stdin and resolves with its framed response", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    const result = await transport.exchange({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { signal: new AbortController().signal });
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: "tools/list" } });
    await transport.close(null, null);
  });
  it("rejects an in-flight exchange when its own signal aborts", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    const controller = new AbortController();
    const pending = transport.exchange({ jsonrpc: "2.0", id: 1, method: "slow" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "transport", message: expect.stringContaining("aborted") });
    await transport.close(null, null);
  });
  it("rejects notify before the transport is open", async () => {
    const transport = spawnEcho();
    await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "closed" });
  });
  it("writes a notification without waiting for a response", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, { signal: new AbortController().signal })).resolves.toBeUndefined();
    await transport.close(null, null);
  });
});

describe("stdio MCP transport protocol framing", () => {
  it("rejects a malformed JSON line as a protocol failure that rejects the pending call", async () => {
    const badServer = `process.stdout.write('not json\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", badServer] });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("malformed") });
    await transport.close(null, null);
  });
  it("rejects a response frame with the wrong jsonrpc envelope", async () => {
    const badServer = `process.stdout.write(JSON.stringify({jsonrpc:'1.0',id:1,result:{}})+'\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", badServer] });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("envelope") });
    await transport.close(null, null);
  });
  it("dispatches a frame with no id to registered notification handlers instead of treating it as a response", async () => {
    const server = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed',params:{}})+'\\n');setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})+'\\n');},50);`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", server] });
    await transport.open(new AbortController().signal, null);
    const seen: string[] = [];
    const unsubscribe = transport.onNotification?.((message) => seen.push(message.method));
    const result = await transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ id: 1, result: { ok: true } });
    expect(seen).toEqual(["notifications/tools/list_changed"]);
    unsubscribe?.();
    await transport.close(null, null);
  });
  it("rejects a no-id frame that carries no method as an invalid notification", async () => {
    const server = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',params:{}})+'\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", server] });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("notification") });
    await transport.close(null, null);
  });
  it("rejects a response whose id is not a safe integer", async () => {
    const badServer = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'not-a-number',result:{}})+'\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", badServer] });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("id") });
    await transport.close(null, null);
  });
  it("rejects a response id that has no matching pending call", async () => {
    const badServer = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999,result:{}})+'\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", badServer] });
    await transport.open(new AbortController().signal, null);
    await expect(transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("not pending") });
    await transport.close(null, null);
  });
  it("treats a blank line between frames as filler and keeps parsing", async () => {
    const server = `process.stdout.write('\\n' + JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}}) + '\\n');`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", server] });
    await transport.open(new AbortController().signal, null);
    const result = await transport.exchange({ jsonrpc: "2.0", id: 1, method: "x" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ id: 1, result: { ok: true } });
    await transport.close(null, null);
  });
});

describe("stdio MCP transport shutdown", () => {
  it("close() before any open() is a no-op", async () => {
    const transport = spawnEcho();
    await expect(transport.close(null, null)).resolves.toBeUndefined();
  });
  it("close() returns immediately once the child has already exited on its own", async () => {
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", "process.exit(0)"] });
    await transport.open(new AbortController().signal, null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(transport.close(null, null)).resolves.toBeUndefined();
  });
  it("close() rejects every in-flight call and marks the transport disconnected", async () => {
    const transport = spawnEcho();
    await transport.open(new AbortController().signal, null);
    const pending = transport.exchange({ jsonrpc: "2.0", id: 1, method: "never-answered" }, { signal: new AbortController().signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "closed" });
    await transport.close(null, null);
    await assertion;
    expect(transport.connected).toBe(false);
  });
  it("escalates from SIGTERM to SIGKILL when the child ignores termination within the grace window", async () => {
    const stubborn = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const transport = new StdioMcpTransport({ command: process.execPath, args: ["-e", stubborn], shutdown_grace_ms: 100 });
    await transport.open(new AbortController().signal, null);
    await expect(transport.close(null, null)).resolves.toBeUndefined();
    expect(transport.connected).toBe(false);
  }, 15_000);
});
