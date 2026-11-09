/**
 * The 2026-10-06 native cohort: on direct/reviewed tiers a specialist was
 * offered shell.execute/verification.run, but the production tool host was
 * composed with `allowed_commands: []`, so every call -- including the exact
 * authorized `npm test` -- was refused, and the model re-proposed the same
 * refused call more than a hundred times per session. This proves the host's
 * no-progress breaker ends such a session with a typed remedy instead.
 *
 * These drive the real `NativeAgentExecutor` -> `NativeHarnessWorker` ->
 * `NativeRepositoryToolHost` -> sandbox broker composition with the
 * production `repository_tools.allowed_commands: []` and the production
 * `composeSessionScope` (cli.ts), so the operator's acceptance command reaches
 * the session the same way it does under `arbor run`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilitySupport, NativeModelPort, SessionEvent } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { composeSessionScope } from "../src/cli.js";
import { NATIVE_TOOL_REFUSAL_LOOP_CODE, NATIVE_TOOL_REFUSAL_LOOP_LIMIT, type NativeHighRiskToolScope, type NativeToolAuditRecord } from "../src/native-tool-host.js";
import { MINED_ACTION_SCOPE_GENERATOR } from "../src/native-tools/contracts.js";

const capabilities = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-tool-refusal-loop-test", observed_at: "2026-10-06T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

const roots: string[] = [];
afterAll(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });
function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-tool-refusal-loop-"));
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

describe("native tool refusal loop breaker", () => {
  it("stops a session that re-proposes the same refused call, with the planner's typed remedy, instead of looping", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    // A model that never adapts: it would propose the refused call forever.
    const { model, turns } = scriptedModel(Array.from({ length: 50 }, () => UNAUTHORIZED), "unreachable");
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "loop", action: {}, prompt: "run a command", worktree_path: root, specialist_agent: "seed" });

    // LIMIT refusals reach the model; the next identical proposal ends the session.
    expect(turns()).toBe(NATIVE_TOOL_REFUSAL_LOOP_LIMIT + 1);
    expect(audits.filter((audit) => audit.code === "action_scope_command_denied")).toHaveLength(NATIVE_TOOL_REFUSAL_LOOP_LIMIT);
    expect(audits.some((audit) => audit.outcome === "succeeded")).toBe(false);
    expect(result.error).toMatchObject({
      kind: "policy_refused",
      code: NATIVE_TOOL_REFUSAL_LOOP_CODE,
      recoverable: false,
      remedy: {
        schema_version: 2, kind: "gate.refusal", state: "refused", gate: "admission",
        correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config", code: NATIVE_TOOL_REFUSAL_LOOP_CODE,
      },
    });
    const diagnostic = events.find((event): event is Extract<SessionEvent, { kind: "diagnostic" }> => event.kind === "diagnostic" && event.payload.code === NATIVE_TOOL_REFUSAL_LOOP_CODE);
    expect(diagnostic?.payload.message).toContain("verification.acceptance_commands");
  });

  it("does not trip on distinct refused argv, however many", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    const distinct = Array.from({ length: NATIVE_TOOL_REFUSAL_LOOP_LIMIT + 2 }, (_, index) => [process.execPath, "-e", `void ${index}`]);
    const { model } = scriptedModel(distinct, "distinct calls finished");
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "distinct", action: {}, prompt: "run commands", worktree_path: root, specialist_agent: "seed" });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("distinct calls finished");
    expect(audits.some((audit) => audit.code === NATIVE_TOOL_REFUSAL_LOOP_CODE)).toBe(false);
  });
  it("counts a corrected cwd as a new call: a specialist that fixes only cwd reaches the run instead of being stopped (UCT Stage 0)", async () => {
    const root = worktree();
    const outside = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    // The live sequence: the authorized argv, byte-identical every time, with
    // only `cwd` changing -- a traversal spelling, a directory outside the
    // workspace, a missing directory -- and then the corrected call.
    const cwds: readonly (string | undefined)[] = ["sub/../..", outside, "missing-dir", undefined];
    let turn = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      if (turn > cwds.length) return { text: [], tool_calls: [], final_message: "ran after correcting cwd" };
      const cwd = cwds[turn - 1];
      return { text: [], tool_calls: [{ call_id: `cwd-${turn}`, tool: "verification.run", input: { argv: ACCEPTANCE, ...(cwd === undefined ? {} : { cwd }) }, input_summary: "run the acceptance command", risk: "high" }], final_message: null };
    } };
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "cwd", action: {}, prompt: "run the tests", worktree_path: root, specialist_agent: "seed" });
    const verification = audits.filter((audit) => audit.tool === "verification.run");
    expect(verification.filter((audit) => audit.outcome === "refused").map((audit) => audit.code)).toEqual(["path_traversal", "path_outside_workspace", "path_not_found"]);
    expect(verification.at(-1)).toMatchObject({ outcome: "succeeded", code: "ok" });
    expect(audits.some((audit) => audit.code === NATIVE_TOOL_REFUSAL_LOOP_CODE)).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("ran after correcting cwd");
  });

  it("runs a command whose cwd is any spelling of the workspace root, or a directory inside it", async () => {
    const root = worktree();
    mkdirSync(join(root, "pkg"));
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    const cwds = [".", "./", "", root, "pkg", join(root, "pkg")];
    let turn = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      return turn > cwds.length
        ? { text: [], tool_calls: [], final_message: "all ran" }
        : { text: [], tool_calls: [{ call_id: `root-${turn}`, tool: "shell.execute", input: { argv: ACCEPTANCE, cwd: cwds[turn - 1] }, input_summary: "run the acceptance command", risk: "high" }], final_message: null };
    } };
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "root-cwd", action: {}, prompt: "run the tests", worktree_path: root, specialist_agent: "seed" });
    expect(audits.filter((audit) => audit.tool === "shell.execute").map((audit) => `${audit.outcome}:${audit.code}`)).toEqual(cwds.map(() => "succeeded:ok"));
    expect(result.output).toBe("all ran");
  });

  it("still stops a session that repeats the identical refused cwd, and treats every root spelling as one call", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    const { model, turns } = scriptedModel(Array.from({ length: 50 }, () => UNAUTHORIZED), "unreachable");
    const cwds = [undefined, ".", "./", ""];
    let turn = 0;
    const spellings: NativeModelPort = { async run(input, secret, signal) {
      const step = await model.run(input, secret, signal);
      turn += 1;
      const cwd = cwds[(turn - 1) % cwds.length];
      return step.tool_calls.length === 0 || cwd === undefined ? step : { ...step, tool_calls: step.tool_calls.map((call) => ({ ...call, input: { ...(call.input as object), cwd } })) };
    } };
    const result = await executorFor(root, spellings, events, audits).specialize({ campaign_id: "c", node_id: "root-loop", action: {}, prompt: "run a command", worktree_path: root, specialist_agent: "seed" });
    expect(turns()).toBe(NATIVE_TOOL_REFUSAL_LOOP_LIMIT + 1);
    expect(result.error).toMatchObject({ kind: "policy_refused", code: NATIVE_TOOL_REFUSAL_LOOP_CODE });
  });

  it("does not count low-risk refusals: a read of a path the session may still create never trips it", async () => {
    const root = worktree();
    const events: SessionEvent[] = [];
    const audits: NativeToolAuditRecord[] = [];
    let turn = 0;
    const model: NativeModelPort = { async run() {
      turn += 1;
      return turn <= NATIVE_TOOL_REFUSAL_LOOP_LIMIT + 2
        ? { text: [], tool_calls: [{ call_id: `read-${turn}`, tool: "file.read", input: { path: "not-yet.txt" }, input_summary: "read a missing file", risk: "low" }], final_message: null }
        : { text: [], tool_calls: [], final_message: "reads finished" };
    } };
    const result = await executorFor(root, model, events, audits).specialize({ campaign_id: "c", node_id: "reads", action: {}, prompt: "read a file", worktree_path: root, specialist_agent: "seed" });
    expect(audits.filter((audit) => audit.tool === "file.read" && audit.outcome === "refused" && audit.code === "path_not_found")).toHaveLength(NATIVE_TOOL_REFUSAL_LOOP_LIMIT + 2);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("reads finished");
  });
});
