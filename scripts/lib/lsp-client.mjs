#!/usr/bin/env node
/**
 * scripts/lib/lsp-client.mjs — ADR-090: a minimal, language-agnostic Language
 * Server Protocol client over stdio.
 *
 * This is the seam that lets VI source its static facts (symbol existence,
 * find-callers/reachability) from a mature per-language server instead of a
 * hand-written per-language graph extractor. The SAME client drives every
 * server that speaks LSP — typescript-language-server, rust-analyzer, pyright,
 * clangd, gopls — because the protocol is uniform; adding a language is
 * pointing this client at that language's server command, not writing a new
 * extractor.
 *
 * It speaks exactly the requests VI's static plane needs, all standard since
 * LSP 3.16:
 *   - textDocument/documentSymbol       — symbol existence (does X exist?)
 *   - textDocument/prepareCallHierarchy  } find-callers / reachability:
 *   - callHierarchy/incomingCalls        } who calls X? what does X call?
 *   - callHierarchy/outgoingCalls        }
 *   - textDocument/references            — reference lookup
 *
 * Framing is the LSP base protocol: `Content-Length: N\r\n\r\n<json>`. Requests
 * carry a monotonic integer id and resolve when the matching response arrives;
 * server-initiated requests (e.g. workspace/configuration) are answered with a
 * benign default so the handshake never deadlocks.
 *
 * Not a general-purpose LSP library: it implements only what the VI static
 * plane calls for, and it is driven by a real server in
 * scripts/tests/lsp-client.test.mjs (no stub — CLAUDE.md §4.4).
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * typescript-language-server is a front end for a separate tsserver process.
 * When tsserver dies on a SIGNAL (the OOM killer's SIGKILL, V8's heap abort)
 * the front end does NOT exit: it only throws for a non-zero exit CODE, and a
 * signalled exit has code null. It keeps answering every later request with
 * an empty result. A full-corpus VI refresh under memory pressure got exactly
 * that: references for the first ~3,090 of 11,688 symbols, then `[]` for
 * every remaining one, and the truncated graph was written as if complete
 * (lsp_references 27,719 -> 7,021; reachable nodes 20,179 -> 12,616).
 *
 * `backendExitPattern` lets the client recognize that event from the one
 * signal the front end does emit: an Error-severity `window/logMessage`
 * ("[tsserver] Exited. Code: null. Signal: SIGKILL").
 */
const TSSERVER_BACKEND = Object.freeze({
  backendExitPattern: /\[tsserver\] Exited\b|tsserver process has exited/,
});

/**
 * The VI registration table is deliberately data, not a switch in an
 * extractor.  A language without a registered server is unavailable: callers
 * must report that fact rather than falling back to a compiler API.
 */
export const VI_LSP_LANGUAGES = Object.freeze({
  typescript: Object.freeze({ command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".mts", ".cts", ".tsx"], languageIds: { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact" }, soundness: "compiler-grade", ...TSSERVER_BACKEND }),
  javascript: Object.freeze({ command: ["typescript-language-server", "--stdio"], extensions: [".js", ".mjs", ".cjs", ".jsx"], languageIds: { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" }, soundness: "compiler-grade", ...TSSERVER_BACKEND }),
  rust: Object.freeze({ command: ["rust-analyzer"], extensions: [".rs"], languageIds: { ".rs": "rust" }, soundness: "compiler-grade" }),
  python: Object.freeze({ command: ["pyright-langserver", "--stdio"], extensions: [".py"], languageIds: { ".py": "python" }, soundness: "best-effort" }),
});

export function viLspRegistration(language) {
  const registration = VI_LSP_LANGUAGES[language];
  if (!registration) throw new Error(`VI has no LSP registration for language '${language}'`);
  return registration;
}

/** Encode one JSON-RPC message with LSP base-protocol framing. */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * Incremental parser for the LSP base protocol. Feed it stdout chunks; it
 * yields complete JSON messages as it accumulates full `Content-Length` bodies.
 */
class MessageBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Unparseable header — drop it rather than spin forever.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Skip a malformed body; the next frame is still recoverable.
      }
    }
    return messages;
  }
}

export class LspClient {
  /**
   * @param {object} opts
   * @param {string[]} opts.command  server argv, e.g. ["typescript-language-server", "--stdio"]
   * @param {string} opts.rootPath   workspace root (absolute)
   * @param {number} [opts.requestTimeoutMs=20000]
   * @param {RegExp} [opts.backendExitPattern]  an Error-severity server log
   *   message matching this means the server's backend died while the server
   *   itself stayed up; the session is then terminal (see TSSERVER_BACKEND).
   */
  constructor({ command, rootPath, requestTimeoutMs = 20000, backendExitPattern }) {
    if (!Array.isArray(command) || command.length === 0) throw new Error("LspClient: command argv required");
    if (!rootPath) throw new Error("LspClient: rootPath required");
    this.command = command;
    this.rootPath = rootPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.proc = null;
    this.parser = new MessageBuffer();
    this.stderr = "";
    this.terminalError = null;
    this.backendExitPattern = backendExitPattern ?? null;
    /** Error-severity window/logMessage and window/showMessage texts, in arrival order. */
    this.serverErrors = [];
  }

  /** Reject every pending request and refuse all future ones with `error`. */
  #fail(error) {
    if (!this.terminalError) this.terminalError = error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(this.terminalError);
    }
    this.pending.clear();
  }

  /**
   * Throw if the session became terminal at any point. A request that
   * resolved in the instant between a backend death and its log message
   * cannot be recalled, so a caller that aggregates many answers must call
   * this once after the last one, before trusting the aggregate.
   */
  assertHealthy() {
    if (this.terminalError) throw this.terminalError;
  }

  start() {
    this.proc = spawn(this.command[0], this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    // `spawn` reports a missing executable asynchronously.  Turn it into the
    // same explicit failure as an exited server; never leave a refresh hanging
    // or silently fall back to compiler-derived facts.
    this.proc.on("error", (error) => {
      this.terminalError = new Error(`LSP server '${this.command[0]}' is unavailable: ${error.message}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(this.terminalError);
      }
      this.pending.clear();
    });
    this.proc.stdout.on("data", (chunk) => {
      for (const message of this.parser.append(chunk)) this.#dispatch(message);
    });
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.proc.on("exit", (code, signal) => {
      if (!this.terminalError) this.terminalError = new Error(`LSP server exited before responding (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(this.terminalError);
      }
      this.pending.clear();
    });
  }

  #dispatch(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      // Response to one of our requests.
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // Server-initiated request — answer with a benign default so a server
      // that blocks on configuration/registration does not deadlock init.
      const result = message.method === "workspace/configuration"
        ? (Array.isArray(message.params?.items) ? message.params.items.map(() => ({})) : null)
        : null;
      this.#send({ jsonrpc: "2.0", id: message.id, result });
    }
    if (message.id === undefined && (message.method === "window/logMessage" || message.method === "window/showMessage") && message.params?.type === 1) {
      const text = String(message.params.message ?? "");
      this.serverErrors.push(text);
      if (this.backendExitPattern?.test(text)) {
        this.#fail(new Error(`LSP server '${this.command[0]}' lost its backend mid-session; its later answers would be empty, not absent facts: ${text.slice(0, 400)}`));
      }
    }
    // Other notifications (diagnostics, progress, non-error logs) are ignored.
  }

  #send(message) {
    if (this.terminalError) throw this.terminalError;
    if (!this.proc || this.proc.killed) throw new Error("LSP server not running");
    this.proc.stdin.write(frame(message));
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${this.requestTimeoutMs}ms${this.stderr ? ` (stderr: ${this.stderr.slice(-400)})` : ""}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Full initialize handshake, declaring the capabilities VI actually uses. */
  async initialize({ tsserverPath } = {}) {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).href,
      workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: "root" }],
      initializationOptions: tsserverPath ? { tsserver: { path: tsserverPath } } : undefined,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
          references: {},
          definition: {},
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    });
    this.notify("initialized", {});
    return result;
  }

  didOpen(filePath, languageId, text) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(filePath).href, languageId, version: 1, text },
    });
  }

  documentSymbol(filePath) {
    return this.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(filePath).href } });
  }

  prepareCallHierarchy(filePath, position) {
    return this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position,
    });
  }

  incomingCalls(item) {
    return this.request("callHierarchy/incomingCalls", { item });
  }

  outgoingCalls(item) {
    return this.request("callHierarchy/outgoingCalls", { item });
  }

  references(filePath, position, includeDeclaration = false) {
    return this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position,
      context: { includeDeclaration },
    });
  }

  async shutdown() {
    if (this.terminalError) {
      if (this.proc && !this.proc.killed) this.proc.kill();
      return;
    }
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Server already gone.
    } finally {
      if (this.proc && !this.proc.killed) this.proc.kill();
    }
  }
}
