/**
 * The 2026-10-06 native cohort: on direct/reviewed tiers a specialist was
 * offered shell.execute/verification.run, but the production tool host was
 * composed with `allowed_commands: []`, so every call -- including the exact
 * authorized `npm test` -- was refused `command_not_allowlisted`.
 *
 * These drive the real `NativeAgentExecutor` -> `NativeHarnessWorker` ->
 * `NativeRepositoryToolHost` -> sandbox broker composition with the
 * production `repository_tools.allowed_commands: []` and the production
 * `composeSessionScope` (cli.ts), so the operator's acceptance command reaches
 * the session the same way it does under `arbor run`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySupport, NativeModelPort, SessionEvent } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { composeSessionScope } from "../src/cli.js";
import { nativeSessionCommandExecutables, type NativeHighRiskToolScope, type NativeToolAuditRecord } from "../src/native-tool-host.js";
import { MINED_ACTION_SCOPE_GENERATOR } from "../src/native-tools/contracts.js";

const capabilities = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-session-command-authority-test", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

const roots: string[] = [];
afterAll(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });
function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-session-command-authority-"));
  roots.push(root);
  return root;
}

// The operator's `verification.acceptance_commands` entry (stands in for `npm test`).
const ACCEPTANCE = [process.execPath, "-e", "process.stdout.write('suite passed')"];
const UNAUTHORIZED = [process.execPath, "-e", "process.stdout.write('not authorized')"];

/** A mined direct-tier scope with no command of its own, composed exactly as cli.ts does. */
function minedScopeFor(input: { campaign_id: string; node_id: string; session_id: string; worktree_path: string }): NativeHighRiskToolScope | null {
  return composeSessionScope({
    scope_id: "mined-scope", campaign_id: input.campaign_id, node_id: input.node_id, session_id: input.session_id, worktree_root: input.worktree_path,
    provenance: { tag: "generated", generator: MINED_ACTION_SCOPE_GENERATOR, input_hash: "sha256:fixture" },
    write_paths: [], command_argv: [],
  }, { tier: "direct", acceptance: [ACCEPTANCE] });
}

function scriptedModel(calls: readonly (readonly string[])[], finalMessage: string): { model: NativeModelPort; turns: () => number } {
  let turn = 0;
  return {
    turns: () => turn,
    model: { async run() {
      turn += 1;
      const argv = calls[turn - 1];
      return argv === undefined
        ? { text: [], tool_calls: [], final_message: finalMessage }
        : { text: [], tool_calls: [{ call_id: `call-${turn}`, tool: "shell.execute", input: { argv }, input_summary: "run a command", risk: "high" }], final_message: null };
    } },
  };
}

function executorFor(root: string, model: NativeModelPort, events: SessionEvent[], audits: NativeToolAuditRecord[]): NativeAgentExecutor {
  return new NativeAgentExecutor({
    workspace_root: root,
    capabilities,
    // Sidesteps host-dependent network-namespace availability; this proves
    // the allowlist/scope composition, not the separate network gate.
    allow_unisolated_shell_network: true,
    approvals: { async decide() { return { approved: true, rationale: "direct-tier system policy" }; } },
    // The production composition (cli.ts): no ambient executables.
    repository_tools: { allowed_commands: [], on_audit: (record) => { audits.push(record); } },
    high_risk_scope_for_session: minedScopeFor,
    model_for_role: () => model,
    on_session_event(record) { events.push(record.event); },
  });
}

describe("native session command authority", () => {
  it("derives a session's executables from its own scope, never from anything else", () => {
    expect(nativeSessionCommandExecutables(null)).toEqual([]);
    const scope = minedScopeFor({ campaign_id: "c", node_id: "n", session_id: "s", worktree_path: "/w" })!;
    expect(scope.command_argv).toEqual([ACCEPTANCE]);
    expect(nativeSessionCommandExecutables(scope)).toEqual([process.execPath]);
  });

  it("runs the operator's exact acceptance command under the production empty allowlist", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    const { model } = scriptedModel([ACCEPTANCE], "acceptance passed");
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "accept", action: {}, prompt: "run the acceptance command", worktree_path: root, specialist_agent: "seed" });

    expect(result.error).toBeUndefined();
    expect(result.output).toBe("acceptance passed");
    expect(audits.some((audit) => audit.code === "command_not_allowlisted")).toBe(false);
    const toolResult = events.find((event): event is Extract<SessionEvent, { kind: "tool_result" }> => event.kind === "tool_result" && event.payload.tool === "shell.execute");
    expect(toolResult?.payload).toMatchObject({ success: true, evidence: { outcome: "succeeded", stage: "execution", code: "ok" } });
  });

  it("refuses an unauthorized argv of the same executable, naming the authorized command, and lets the session continue", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    const { model } = scriptedModel([UNAUTHORIZED, ACCEPTANCE], "recovered");
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "deny", action: {}, prompt: "run a command", worktree_path: root, specialist_agent: "seed" });

    expect(result.error).toBeUndefined();
    expect(result.output).toBe("recovered");
    const results = events.filter((event): event is Extract<SessionEvent, { kind: "tool_result" }> => event.kind === "tool_result" && event.payload.tool === "shell.execute");
    expect(results).toHaveLength(2);
    // The executable is on the derived allowlist, but the exact-argv scope
    // check refuses first: deriving the allowlist did not widen authority.
    expect(results[0]!.payload).toMatchObject({ success: false, evidence: { outcome: "refused", code: "action_scope_command_denied" } });
    expect(results[0]!.payload.result_summary).toContain(`authorized commands: ${ACCEPTANCE.join(" ")}`);
    expect(results[1]!.payload).toMatchObject({ success: true, evidence: { outcome: "succeeded", code: "ok" } });
  });

});
