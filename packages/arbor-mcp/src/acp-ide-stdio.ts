import { AcpIdeJourney, type AcpIdeNotification, type AcpIdeQuestion } from "./acp-ide.js";

/** Minimal host I/O shape; Bun, Node, and an editor-process bridge can supply it. */
export interface AcpIdeStdioInput { readonly [Symbol.asyncIterator]: () => AsyncIterator<string | Uint8Array>; }
export interface AcpIdeStdioOutput { write(chunk: string): unknown; }

type RpcId = string | number | null;
type RpcRequest = Readonly<{ jsonrpc: "2.0"; id?: RpcId; method: string; params?: Readonly<Record<string, unknown>> }>;
interface SessionState { readonly session_id: string; pending_question: AcpIdeQuestion | null; }

const MAX_LINE_BYTES = 1_048_576;

/**
 * Run the governed IDE journey over ACP v1's newline-delimited JSON-RPC 2.0
 * transport. The bridge intentionally advertises no client-owned filesystem,
 * terminal, or MCP authority and refuses non-empty `mcpServers`; those powers
 * remain in Revoy's canonical runtime composition root.
 */
export async function runAcpIdeStdio(journey: AcpIdeJourney, input: AcpIdeStdioInput, output: AcpIdeStdioOutput): Promise<void> {
  let pending = ""; let initialized = false; let sequence = 0;
  const sessions = new Map<string, SessionState>(); const draining = new Set<string>();
  const write = (value: unknown): void => { output.write(`${JSON.stringify(value)}\n`); };
  const result = (id: RpcId, value: Readonly<Record<string, unknown>>): void => write({ jsonrpc: "2.0", id, result: value });
  const error = (id: RpcId, code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message: message.slice(0, 512) } });

  const drainSession = async (session: SessionState): Promise<void> => {
    if (draining.has(session.session_id)) return;
    draining.add(session.session_id);
    try {
      const response = await journey.dispatch({ method: "session/events", session_id: session.session_id, limit: 128 });
      if (!response.ok || !Array.isArray(response.result.events)) return;
      for (const item of response.result.events as readonly AcpIdeNotification[]) {
        if (item.method === "session/request_permission") {
          session.pending_question = item.question;
          writeUpdate(write, session.session_id, `Question: ${item.question.question}`);
        } else if (item.method === "session/result") {
          writeUpdate(write, session.session_id, `${item.result.summary}\n${item.result.files.join("\n")}`);
        } else {
          writeUpdate(write, session.session_id, `Revoy ${item.update.status}${item.update.campaign_id === null ? "" : ` · campaign ${item.update.campaign_id}`}`);
        }
      }
    } finally { draining.delete(session.session_id); }
  };

  const processRequest = async (value: unknown): Promise<void> => {
    const request = parseRpcRequest(value);
    if (request === null) { error(requestId(value), -32600, "Invalid Request"); return; }
    const id = request.id ?? null; const params = request.params ?? {};
    if (request.method === "initialize") {
      if (request.id === undefined || params.protocolVersion !== 1 || !isRecord(params.clientCapabilities)) { error(id, -32602, "initialize requires protocolVersion 1 and clientCapabilities"); return; }
      const clientInfo = isRecord(params.clientInfo) && typeof params.clientInfo.name === "string" ? params.clientInfo.name : "ACP client";
      const response = await journey.dispatch({ method: "initialize", protocol_version: 1, client_name: clientInfo });
      if (!response.ok) { error(id, -32000, response.error.message); return; }
      initialized = true;
      result(id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "revoy", version: "0.2.0" } });
      return;
    }
    if (!initialized) { error(id, -32002, "ACP initialize must complete first"); return; }
    if (request.method === "session/new") {
      if (request.id === undefined || typeof params.cwd !== "string" || !Array.isArray(params.mcpServers)) { error(id, -32602, "session/new requires cwd and mcpServers"); return; }
      if (params.mcpServers.length > 0) { error(id, -32003, "client-supplied MCP servers are outside Revoy's governed composition authority"); return; }
      const sessionId = `revoy-${++sequence}`;
      const response = await journey.dispatch({ method: "session/new", session_id: sessionId });
      if (!response.ok) { error(id, -32000, response.error.message); return; }
      sessions.set(sessionId, { session_id: sessionId, pending_question: null });
      result(id, { sessionId }); return;
    }
    if (request.method === "session/prompt") {
      const session = sessionFor(params, sessions); const prompt = promptText(params.prompt);
      if (request.id === undefined || session === null || prompt === null) { error(id, -32602, "session/prompt requires a known sessionId and bounded text prompt"); return; }
      const response = session.pending_question === null
        ? await journey.dispatch({ method: "session/prompt", session_id: session.session_id, prompt, idempotency_key: `acp-prompt-${sequence}-${String(request.id).replace(/[^A-Za-z0-9._:-]/g, "-")}`, auto_confirm: true })
        : await journey.dispatch({ method: "session/question/answer", session_id: session.session_id, question_id: session.pending_question.question_id, answer: prompt, expected_revision: session.pending_question.revision, ...(session.pending_question.record_id === undefined ? {} : { record_id: session.pending_question.record_id }) });
      if (!response.ok) { error(id, response.error.code === "conflict" ? -32001 : -32003, response.error.message); return; }
      session.pending_question = null;
      await drainSession(session);
      result(id, { stopReason: "end_turn" }); return;
    }
    if (request.method === "session/cancel") {
      const session = sessionFor(params, sessions);
      if (request.id !== undefined || session === null) { if (request.id !== undefined) error(id, -32602, "session/cancel is a notification for a known sessionId"); return; }
      await journey.dispatch({ method: "session/cancel", session_id: session.session_id, reason: "ACP client cancelled the active turn" }); return;
    }
    error(id, -32601, `Method not found: ${request.method}`);
  };

  const timer = setInterval(() => { for (const session of sessions.values()) void drainSession(session); }, 25);
  timer.unref?.();
  try {
    for await (const chunk of input) {
      pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) { error(null, -32600, "ACP input line exceeds the bounded transport limit"); pending = ""; continue; }
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { await processRequest(JSON.parse(line)); }
        catch (cause) { error(null, -32700, cause instanceof SyntaxError ? "Parse error" : cause instanceof Error ? cause.message : "ACP request failed"); }
      }
    }
    if (pending.trim()) {
      try { await processRequest(JSON.parse(pending)); }
      catch (cause) { error(null, -32700, cause instanceof SyntaxError ? "Parse error" : cause instanceof Error ? cause.message : "ACP request failed"); }
    }
  } finally { clearInterval(timer); }
}

function writeUpdate(write: (value: unknown) => void, sessionId: string, text: string): void {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(0, 16_384) } } } });
}
function parseRpcRequest(value: unknown): RpcRequest | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || value.method.length > 128) return null;
  if (value.id !== undefined && value.id !== null && typeof value.id !== "string" && (typeof value.id !== "number" || !Number.isSafeInteger(value.id))) return null;
  if (value.params !== undefined && !isRecord(value.params)) return null;
  return { jsonrpc: "2.0", ...(value.id === undefined ? {} : { id: value.id as RpcId }), method: value.method, ...(value.params === undefined ? {} : { params: value.params }) };
}
function requestId(value: unknown): RpcId { return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number" || value.id === null) ? value.id : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sessionFor(params: Readonly<Record<string, unknown>>, sessions: ReadonlyMap<string, SessionState>): SessionState | null { return typeof params.sessionId === "string" ? sessions.get(params.sessionId) ?? null : null; }
function promptText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const parts: string[] = [];
  for (const block of value) { if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null; parts.push(block.text); }
  const joined = parts.join("\n").trim(); return joined.length > 0 && joined.length <= 16_384 ? joined : null;
}
