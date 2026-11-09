/**
 * ADR-119 (scope binds at first use, not predicted at plan time):
 * `native-tool-host.ts`'s bind-on-first-use enforcement for
 * `shell.execute`/`verification.run`, driven through the real
 * `createNativeRepositoryToolHost` tool-port surface (preflight + execute),
 * exactly as `native-tool-host.test.ts` drives the pre-existing literal-argv
 * `sameArgv` path this decision extends rather than replaces.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolRequest } from "@arbor/harness";
import { createNativeRepositoryToolHost, type NativeHighRiskToolScope, type NativeToolAuditRecord } from "../src/native-tool-host.js";

const created: string[] = [];
function directory(prefix: string): string {
  const result = mkdtempSync(join(tmpdir(), prefix));
  created.push(result);
  return result;
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function request(root: string, argv: readonly string[]): NativeToolRequest {
  return { session_id: "session-a", turn: 1, call_id: "call-a", input: { argv }, workspace_roots: [root], filesystem: "workspace_write", intent_evidence: [], network_allowed: false };
}

function baseScope(root: string, extra: Partial<NativeHighRiskToolScope>): NativeHighRiskToolScope {
  return {
    scope_id: "test-scope", campaign_id: "campaign", node_id: "node", session_id: "session-a",
    worktree_root: root, provenance: { tag: "claimed", claimant: "test" },
    write_paths: [], command_argv: [],
    ...extra,
  };
}

function host(root: string, scope: NativeHighRiskToolScope, records: NativeToolAuditRecord[] = []) {
  const descriptors = createNativeRepositoryToolHost({
    filesystem: "workspace_write",
    workspace_roots: [root],
    allowed_commands: [process.execPath],
    resolve_intent: () => ({ purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } }),
    resolve_high_risk_scope: () => scope,
    on_audit: (record) => records.push(record),
  });
  return new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));
}

/** Narrows `Map.get`'s possibly-undefined result by construction, not by silencing it -- a missing tool port is a real fixture bug and should throw, not typecheck away. */
function toolPort(tools: ReturnType<typeof host>, tool: string) {
  const port = tools.get(tool);
  if (port === undefined) throw new Error(`test fixture missing tool port: ${tool}`);
  return port;
}

async function execute(tools: ReturnType<typeof host>, tool: string, value: NativeToolRequest): Promise<Record<string, unknown>> {
  const response = await toolPort(tools, tool).execute(value, null, new AbortController().signal);
  return JSON.parse(response.model_output) as Record<string, unknown>;
}

describe("ADR-119: scope binds at first use (native-tool-host.ts)", () => {
  it("binds an unbound intent on the first matching call, durably recording it via bind_intent before the call returns", async () => {
    const root = directory("adr119-bind-");
    const binds: { bind_id: number; argv: readonly string[] }[] = [];
    const scope = baseScope(root, {
      command_intents: [{ bind_id: 0, intent: { argv_prefix: [process.execPath, "-e"], purpose: "run a generated probe script" } }],
      bind_intent: (input) => { binds.push(input); return true; },
    });
    const tools = host(root, scope);
    const result = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(result.outcome).toBe("succeeded");
    expect(binds).toEqual([{ bind_id: 0, argv: [process.execPath, "-e", "process.exit(0)"] }]);
  });

  it("enforces sameArgv byte-exact against the bound argv for every call after the first (ADR-119 O1)", async () => {
    const root = directory("adr119-monotonic-");
    const scope = baseScope(root, {
      command_intents: [{ bind_id: 0, intent: { argv_prefix: [process.execPath, "-e"], purpose: "run a generated probe script" } }],
      bind_intent: () => true,
    });
    const tools = host(root, scope);
    const first = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(first.outcome).toBe("succeeded");
    // Same argv again: still authorized, now via the bound literal.
    const second = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(second.outcome).toBe("succeeded");
    // A DIFFERENT argv under the same already-bound intent is refused exactly
    // like an unauthorized argv today -- the prefix only ever governs the
    // first call.
    const third = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(1)"]));
    expect(third).toMatchObject({ outcome: "refused", code: "action_scope_command_denied" });
  });

  it("refuses to bind when no durable sink is wired -- an intent match with no bind_intent never authorizes the call", async () => {
    const root = directory("adr119-no-sink-");
    const scope = baseScope(root, {
      command_intents: [{ bind_id: 0, intent: { argv_prefix: [process.execPath, "-e"], purpose: "run a generated probe script" } }],
      // bind_intent intentionally absent.
    });
    const tools = host(root, scope);
    const result = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(result).toMatchObject({ outcome: "refused", code: "action_scope_command_denied" });
  });

  it("refuses to bind when bind_intent itself refuses (e.g. a slot already bound elsewhere)", async () => {
    const root = directory("adr119-refused-sink-");
    const scope = baseScope(root, {
      command_intents: [{ bind_id: 0, intent: { argv_prefix: [process.execPath, "-e"], purpose: "run a generated probe script" } }],
      bind_intent: () => false,
    });
    const tools = host(root, scope);
    const result = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(result).toMatchObject({ outcome: "refused", code: "action_scope_command_denied" });
  });

  it("a literal command_argv declaration is unaffected: exact-match coverage holds unmodified alongside intents (ADR-119 O1)", async () => {
    const root = directory("adr119-literal-");
    const scope = baseScope(root, { command_argv: [[process.execPath, "-e", "process.exit(0)"]] });
    const tools = host(root, scope);
    const ok = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(ok.outcome).toBe("succeeded");
    const denied = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.exit(1)"]));
    expect(denied).toMatchObject({ outcome: "refused", code: "action_scope_command_denied" });
  });

  it("preflight previews an intent match without consuming the bind -- execute() alone performs the real bind", async () => {
    const root = directory("adr119-preflight-");
    const binds: { bind_id: number; argv: readonly string[] }[] = [];
    const scope = baseScope(root, {
      command_intents: [{ bind_id: 0, intent: { argv_prefix: [process.execPath, "-e"], purpose: "run a generated probe script" } }],
      bind_intent: (input) => { binds.push(input); return true; },
    });
    const tools = host(root, scope);
    const port = toolPort(tools, "shell.execute");
    if (port.preflight === undefined) throw new Error("test fixture's tool port has no preflight");
    const preview = port.preflight(request(root, [process.execPath, "-e", "process.exit(0)"]));
    expect(preview.allowed).toBe(true);
    // Preflight must not have durably bound anything yet.
    expect(binds).toHaveLength(0);
    // execute() with a DIFFERENT (but still zero-exit) argv under the same
    // still-unbound intent succeeds -- proof that preflight's preview did
    // not consume the slot.
    const executed = await execute(tools, "shell.execute", request(root, [process.execPath, "-e", "process.stdout.write('ok')"]));
    expect(executed.outcome).toBe("succeeded");
    expect(binds).toEqual([{ bind_id: 0, argv: [process.execPath, "-e", "process.stdout.write('ok')"] }]);
  });
});
