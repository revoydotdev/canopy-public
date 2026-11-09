# Roadmap 01 — MCP client (external MCP-server tools for the native specialist)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for MCP client; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — implementation observed at 2348ddbb within the original tools-only scope (stdio/HTTP MCP client); resources, templates, OAuth and Phase 3 conformance unverified
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: implemented within the original tools-only scope.** `packages/arbor-mcp/src/mcp-client/` and `packages/arbor-mcp/tests/mcp-client/` contain stdio/HTTP transports, connector, adapter, and hermetic tests; commits `54be97c1` and `f0987bc8`. MCP resources/templates, OAuth, and broader Phase 3 conformance remain proposed/unverified.

**Audience:** an implementing coding agent (e.g. Codex 5.3-spark) working alone on a
feature branch. This document is your brief. Read it fully before writing code.
Another agent ("the integrator") will review and merge your branch; write for that review.

**One-line goal:** let a revoy2 native specialist call tools exposed by an external
**MCP server** (filesystem, git, a database, a web-search server, …), through the
existing governed native tool path — without weakening any revoy2 invariant.

**revoy2 already has an MCP _server_** (`packages/arbor-mcp/src/server.ts`,
`protocol` handling in the same package). It has **no MCP _client_**. You are building
the client: revoy2 connects _out_ to other MCP servers and adopts their tools.

---

## 0. What "done" means (acceptance, read first)

1. An operator declares one or more MCP servers in config (stdio or streamable-HTTP).
2. On campaign start, revoy2 connects to each and negotiates one of the bounded supported
   protocol shapes (`server/discover` for `2026-07-28`, or legacy `initialize`), then
   lists the server's tools and adapts each into a revoy-owned `NativeToolPort`.
3. Those ports are injected into the specialist's tool set via the existing
   `specialist_tools` seam — the model sees them alongside `file.read`/`file.write`/…
4. When the model calls an MCP tool, revoy2: runs host preflight → (approval if high
   risk) → forwards the call to the MCP server → maps the MCP result into a bounded,
   redacted `NativeToolResponse` with proper `NativeToolExecutionEvidence`.
5. Every failure mode (server down, tool error, oversized output, timeout, protocol
   violation) is a typed, bounded, non-crashing outcome.
6. Full test suite green; new hermetic tests cover the adapter against a **fake in-process
   MCP server** (no network, no real subprocess in committed tests).
7. **Zero new runtime dependencies.** Implement the MCP JSON-RPC client yourself in
   `packages/arbor-mcp/src` — the protocol is small and the repo keeps a zero-runtime-dep
   rule (see §3). You may read the official spec; you may not add an SDK.

Non-goals (do NOT build): MCP _resources_/_prompts_ (tools only for v1); MCP OAuth flows
(support a static bearer token + stdio only); a public re-export of the client as a
library API; letting an MCP server drive campaign admission, approval, or verification.

---

## 1. Read these first (in order)

- `handoff.md` §2 "The biblical commandments" — the twelve invariants. **Every one applies
  to you.** The ones you will most touch: III (authority vs projection), IV (checks &
  balances / capability filtering), VII (raw output is evidence, not ambient context),
  IX (bounds are type-level), X (core never depends upward).
- `packages/arbor-harness/src/native-worker.ts` — the `NativeToolPort`, `NativeToolRequest`,
  `NativeToolResponse` interfaces (lines ~145-176) and how the worker calls a tool
  (`executeTool`, the preflight→approval→execute→evidence flow around line ~530-650).
- `packages/arbor-harness/src/protocol.ts` — `NativeToolExecutionEvidence` (line ~99):
  `{ outcome, stage, code, effect, action_scope }`. Your adapter must produce this.
- `packages/arbor-mcp/src/native-tool-host.ts` — the **reference implementation** of a
  set of `NativeToolPort`s. Copy its shape: the `failure(...)` helper, the redaction, the
  bounded output, the audit record. Your MCP tool ports are the same shape, backed by a
  remote server instead of the local filesystem.
- `packages/arbor-mcp/src/native-agent-executor.ts` — the `specialist_tools` option
  (interface line ~166) and `specialistTools()` (line ~448): this is your injection point.
- `packages/arbor-mcp/src/remote-ingress.ts` — the pattern for validating untrusted
  external input before it reaches authority. Mirror its discipline.
- The MCP spec (authoritative, fetch it — do not reconstruct from memory):
  `https://modelcontextprotocol.io/specification` — implement current `2026-07-28`
  discovery while retaining bounded `2025-11-25`/`2025-06-18` legacy support
  lifecycle, `tools/list`, `tools/call`, the JSON-RPC 2.0 envelope, and the stdio &
  streamable-HTTP transports. **Confirm the current protocol version string there**;
  do not hardcode a guessed date.

---

## 2. Invariants you must honor (these are not style preferences)

- **VII — raw output is evidence, not ambient context.** An MCP tool can return arbitrary,
  unbounded content. You MUST bound the `model_output` you return (head/tail preview +
  byte count + truncation flag, exactly like `native-tool-host.ts`'s reads now do after
  the 2026-08 truncation change). Never splice a raw MCP payload straight into the model
  conversation. If you need the full bytes retained, use the content-addressed output
  evidence store; for v1, bounded-preview-only is acceptable and simpler.
- **IX — bounds are part of the type.** Bound: number of connected servers, tools per
  server, tool-name length, argument byte size, result byte size, call timeout,
  concurrent calls. No "the caller will be sensible."
- **IV — capability filtering happens while projecting.** An MCP tool is `high` risk unless
  proven otherwise; default every adapted tool to `risk: "high"` and let config downgrade
  named read-only tools to `low`. High-risk MCP calls go through the same approval port the
  repository tools use (`NativeSystemPolicyApprovalPort`) — do not invent a second approval
  path.
- **Secrets are opaque leases (commandment on credentials).** An MCP server's bearer token
  is a credential. It must be delivered through the existing credential-lease pattern
  (`NativeCredentialLeasePort` / the scoped broker), never stored on the tool port, never
  logged, never placed in an event or the model conversation. Redact it from all output.
- **X — core never depends upward.** All your code lives in `packages/arbor-mcp` (which may
  depend on `@arbor/harness` and `@arbor/core`). `@arbor/core` and `@arbor/harness` must not
  import your MCP client. The `NativeToolPort` interface you implement lives in
  `@arbor/harness`; you _implement_ it from `arbor-mcp`, you do not modify it (unless a
  genuinely missing field forces an additive change — if so, STOP and report to the
  integrator rather than widening the interface unilaterally).

---

## 3. The transport & protocol you implement (no SDK)

MCP is JSON-RPC 2.0 over a byte stream. You implement a minimal client. Two transports:

### stdio transport (implement first, it is what the tests use)
- Spawn the server: `child_process.spawn(command, args, { stdio: ["pipe","pipe","pipe"], env })`.
  Reuse the **sanitized-env discipline** from `native-tool-host.ts` / `worktree.ts`
  (`sanitizedGitEnv`-style): pass only an explicit allow-list of env vars plus the
  server's declared ones; never leak the whole `process.env`.
- Messages are newline-delimited JSON-RPC on stdin/stdout (per the stdio transport spec —
  **verify framing in the spec**: current MCP stdio is newline-delimited JSON, one message
  per line, no embedded newlines; server logs go to stderr and must be ignored/captured
  separately, exactly the OpenRouter-keepalive lesson from `openai-compatible.ts`'s SSE
  parser — non-message lines must not break your parser).
- Buffer partial reads; split on `\n`; `JSON.parse` each line; correlate responses to
  requests by JSON-RPC `id` (monotonic integer you own).

### streamable-HTTP transport (implement second, guard behind config)
- POST JSON-RPC to the server URL; read the response (which may be an SSE stream for
  server-initiated messages). Reuse the **exact SSE-draining logic** you can lift in spirit
  from `packages/arbor-harness/src/openai-compatible.ts` `drainSse` (comment lines starting
  with `:` are keepalives and must be skipped — do not copy the code across the package
  boundary; re-implement the same idea locally, it is ~15 lines).
- Bearer auth: `Authorization: Bearer <token-from-lease>` — token injected via the lease
  callback only.

### The JSON-RPC envelope (both transports)
```ts
type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown }; // no id
```
Validate every field on the way in (closed shape, safe-integer id) — a malformed frame is
a typed protocol error, never a throw that escapes the client.

### Lifecycle you must implement

> **Post-implementation correction (Roadmap 19):** the original fixed handshake was
> implemented before the canonical specification moved. The client now probes first and
> deliberately preserves the legacy path rather than treating one revision as universal.

1. Send `server/discover` using preferred `2026-07-28` per-request `_meta` fields.
2. If discovery succeeds, require a supported-version intersection and tools capability;
   do not send `notifications/initialized` on this path.
3. Only on `-32601` or discovery-shape mismatch, fall back to legacy `initialize`, accept
   only `2025-11-25`/`2025-06-18`, then send `notifications/initialized`.
4. An advertised unknown future revision fails closed with offered versions in its diagnostic.
5. After negotiation, `tools/list` → adapt each tool and `tools/call` on demand.
6. On close: send nothing special; terminate the transport, kill the child (SIGTERM then
   SIGKILL after a bounded grace, exactly like `LocalBoundedVerificationCommandPort`'s
   `stop()`), await exit.

---

## 4. Files you will create

```
packages/arbor-mcp/src/mcp-client/
  json-rpc.ts            # envelope types + a bounded, correlated request/response client core
  stdio-transport.ts     # spawn + newline-framed JSON-RPC over stdio
  http-transport.ts      # POST + SSE-drain JSON-RPC over streamable-HTTP
  mcp-client.ts          # lifecycle (initialize/initialized/tools.list/tools.call/close) + bounds
  mcp-tool-port.ts       # adapt one MCP tool into a NativeToolPort (the governance boundary)
  mcp-connector.ts       # compose: config -> connected client -> readonly NativeToolPort[]
  contracts.ts           # config shape, closed catalogs, bounds constants
packages/arbor-mcp/tests/mcp-client/
  fake-mcp-server.ts     # an in-process JSON-RPC server for hermetic tests (no subprocess)
  json-rpc.test.ts
  mcp-client.test.ts
  mcp-tool-port.test.ts
  mcp-connector.test.ts
```
Config type additions go in `packages/arbor-config/src/` (see §6). Wiring goes in
`packages/arbor-mcp/src/cli.ts` (see §7).

---

## 5. The tool-port adapter (the heart of the governance boundary)

For each MCP tool `T` reported by `tools/list` (shape: `{ name, description, inputSchema }`):

**Advertise it to the model** by producing a `NativeModelAdapterToolDefinition`
(from `@arbor/harness`, shape `{ name, description, parameters, risk, context_refs? }`):
- `name`: namespace it to avoid collisions with repository tools — e.g. `mcp.<server_id>.<tool>`.
  Bound the total length; reject a server tool whose namespaced name exceeds the bound.
- `description`: pass through, bounded/redacted.
- `parameters`: the MCP `inputSchema` (a JSON Schema) — pass through after validating it is a
  plain object; if absent, use `{ type: "object", additionalProperties: true }`.
- `risk`: `"high"` by default; `"low"` only if the server_id + tool name is in the operator's
  declared read-only allow-list.

**Implement `NativeToolPort`** (from `@arbor/harness`, `native-worker.ts`):
```ts
interface NativeToolPort {
  readonly tool: string;                          // the namespaced name above
  preflight?(request: NativeToolRequest): NativeToolPreflightResult;
  execute(request: NativeToolRequest, secret: string | null, signal: AbortSignal): Promise<NativeToolResponse>;
}
```
- `preflight`: reject before any network call if: the client is not connected; the request
  input is not a plain object; the input exceeds the argument byte bound; the tool is
  high-risk and the session policy forbids it. Return the `{ allowed: false, code, reason,
  evidence }` shape — copy the exact evidence construction from `native-tool-host.ts`.
- `execute`:
  1. Send `tools/call` `{ name: <original server tool name>, arguments: request.input }` with
     a per-call timeout (bound). Correlate the response.
  2. Map the result: MCP `tools/call` returns `{ content: [...], isError?: boolean }`. Flatten
     the `content` array's text parts into a single string, **bounded** (head/tail + count).
     Non-text parts (images/blobs) → replace with a typed placeholder descriptor, never inline.
  3. `isError: true` → `NativeToolResponse` with `evidence.outcome: "failed"`,
     `code: "mcp_tool_error"`, `effect: "none"`. Still bound/redact the error content.
  4. success → `evidence.outcome: "succeeded"`, `stage: "execution"`, `code: "ok"`,
     `effect: "observed"` (or `"applied"` if the tool is declared mutating; default
     `"observed"` — you cannot prove a remote effect, so do not claim `applied` unless the
     operator declared this tool mutating).
  5. Redact secrets from `result_summary` and `model_output` using the same
     `redactNativeText`-style pass the repository host uses.
- `secret`: the worker passes the injected credential here (or `null`). Use it ONLY as the
  bearer token for the HTTP transport call; never store or log it.

**Gotcha — the intent/evidence boundary (commandment: model prose does not grant authority):**
`request.intent_evidence` is content-free justification the host attached. Do NOT let the MCP
server's response text become new "evidence" that authorizes a later high-risk call. Each MCP
call is preflighted and (if high-risk) approved independently.

---

## 6. Config (arbor-config)

Add to the native config shape (`packages/arbor-config/src/types.ts`, and the JSON schema in
`schema.ts`, and validation in `validator.ts` — all three must agree; see the "catalog drift"
gotcha). Suggested shape:
```jsonc
"native": {
  "mcp_servers": [
    {
      "server_id": "fs",                    // stable slug, [a-z0-9-], bounded
      "transport": "stdio",                 // "stdio" | "http"
      "command": "some-mcp-server",         // stdio only
      "args": ["--root", "."],              // stdio only
      "url": "https://…",                   // http only
      "credential_env": "FS_MCP_TOKEN",     // optional; the env var holding the bearer
      "read_only_tools": ["list", "read"]   // tools downgraded to low risk
    }
  ]
}
```
- The credential is env-only (mirror `NATIVE_PROVIDER_API_KEY_ENV` in `native-secret.ts`):
  the config names the env var; the value is never in config.
- Validate: closed transport enum, non-empty bounded `server_id`, uniqueness of `server_id`,
  stdio requires `command`, http requires an absolute https URL. An unsafe combination fails
  admission (mirror `resolveNativeProviderSelection`'s fail-closed style).

---

## 7. Wiring into the campaign (cli.ts)

In `packages/arbor-mcp/src/cli.ts`, where `configuredNativeAgentExecutor(...)` composes the
`NativeAgentExecutor` options, supply the `specialist_tools` callback:
```ts
specialist_tools: ({ campaign_id, node_id, worktree_path, session_id }) =>
  mcpConnector.toolPortsForSession({ campaign_id, node_id, worktree_path, session_id }),
```
- `mcpConnector` is composed once per runtime from `config.native.mcp_servers`, connecting
  lazily on first use and reused across sessions. Connection failures are typed absence: a
  server that will not connect contributes **zero** tools and a recorded diagnostic — it must
  never prevent the campaign from running (mirror the connector-registry's
  `no_healthy_connector` disposition).
- Respect the existing planning-vs-specialist split: MCP tools are for the **specialist**
  (execution), not the Taproot planner. `planningTools()` stays repository-discovery-only.
- Lifecycle: the connector must be closed when the runtime closes. Register it as a
  `RuntimeLifecycleParticipant` (see `runtime.ts`) so `close()` tears down every child/socket.
  Left-open child processes are a real leak — the worktree/verifier code already shows the
  SIGTERM→SIGKILL pattern; reuse it.

---

## 8. Gotchas specific to this repo (learned the hard way)

- **`npm run build` is the only real type gate.** `npx tsc --noEmit` type-checks zero files at
  the repo root (`"files": []` + project references). Never trust `--noEmit`; run
  `npm run build` (a.k.a. `tsc --build`). Tests are excluded from typechecking, so a green
  test proves runtime only, not that fixtures still match types.
- **The repo uses `bun`, not `npm`, for installs.** There is no `package-lock.json`; there is a
  committed `bun.lock` and `workspace:*` deps. Use `bun install`. `npm run build` still works
  (it just runs `tsc --build`).
- **Catalog drift.** A config field must be added in THREE agreeing places:
  `arbor-config/src/types.ts` (the TS type), `schema.ts` (the JSON schema), and `validator.ts`
  (runtime validation). Miss one and either the build or a runtime check fails.
- **Zero runtime deps.** Do not `bun add` anything. If you think you need a dependency, you are
  about to violate a hard rule — implement it or report to the integrator.
- **Redaction is structural, not cosmetic.** A secret must be _absent_ from the projected
  object, not merely hidden at render time. Redact before you build the `NativeToolResponse`.
- **stderr is not protocol.** An MCP server prints diagnostics to stderr; your stdout JSON-RPC
  parser must never see them. Capture stderr separately (bounded) for diagnostics.
- **Pre-commit/pre-push hooks exist.** A hook auto-refreshes the claim-ledger store; commits
  normally succeed. If a hook blocks you for a reason unrelated to your diff, use
  `git commit --no-verify` and say so in your report — do not fight the hook.

---

## 9. Tests (hermetic, no network, no real subprocess in committed tests)

- `fake-mcp-server.ts`: an in-process object implementing your transport's read/write interface
  (inject it via a transport seam so `mcp-client.ts` talks to it without spawning). It answers
  `server/discover`, legacy `initialize`, `tools/list`, `tools/call` (success, `isError`, oversized content, a slow call
  for timeout, a malformed frame). This is your `MachineVerificationCommandPort`-style seam:
  the client takes an injected transport so tests never spawn a process.
- Prove legacy `2025-06-18`, legacy `2025-11-25`, modern `2026-07-28` without an
  initialized notification, and a future version that fails diagnostically. Also prove a
  call before negotiation is rejected; a tool adapts to a
  `NativeToolPort`; a `tools/call` maps success/`isError`/oversized/timeout to the right typed
  `NativeToolResponse`; a bearer token never appears in any returned object or event; a
  malformed JSON-RPC frame is a typed error, not a throw; the connector contributes zero tools
  (and a diagnostic) when a server fails to connect; namespaced names avoid collision with
  `file.read` et al.; bounds enforced (arg size, result size, tool count).
- Run: `npm run build` then `npx vitest run packages/arbor-mcp`. Then full `npx vitest run`.

---

## 10. Feature-branch workflow & handoff

1. `git worktree add ../revoy2-mcp-client -b feature/mcp-client master` and `bun install` in it.
   Claim-ledger and VI-observed JSONL records are union-mergeable; determinism and
   completion-depth snapshots are integration outputs and must not be committed here.
2. Commit in small, reviewable, conventional-commit steps (`feat:`, `test:`, `fix:`) — one
   concern each. No AI attribution, no `Co-Authored-By`. Commit only files your change declares;
   never `git add -A`.
3. Before handing off: `npm run build` green; `npx vitest run` green; your new tests included;
   no new dependency in `bun.lock`/`package.json`.
4. Write a handoff note (`docs/roadmaps/handoffs/mcp-client.md`) covering: exact files changed,
   the connector lifecycle, how a server failure degrades to zero-tools, the bounds you chose
   and why, anything in this roadmap you deviated from and the evidence for it, and any place you
   were tempted to touch `@arbor/harness`/`@arbor/core` (report, do not do it).
5. The integrator will run a live smoke test against a real MCP server (e.g. an official
   filesystem server) and review the diff before merging. Make that review easy.
