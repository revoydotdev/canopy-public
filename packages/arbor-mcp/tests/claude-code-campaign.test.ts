import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_HARNESS_CONNECTOR_ID, createClaudeCodeCampaignIntegration, createClaudeCodeHarnessConnectorDescriptor, createClaudeCodeTaskPlanner, resolveClaudeCodeTimeoutMs } from "../src/integrations/claude-code-campaign.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticCallResult, type NativeCriticPort } from "../src/native-critic-transport.js";
import { RepositoryGraphIndex } from "../src/repository-graph.js";

/**
 * Writes a small executable node script as a stand-in "claude" binary so the
 * real spawn/exit/stdio path in createClaudeCodeRunner is exercised without
 * ever invoking the real Claude Code CLI. Cleaned up by the caller.
 */
interface FixtureCommand {
  readonly claude_bin: string;
  readonly claude_args?: readonly string[];
}

function writeFixtureBinary(scriptBody: string): FixtureCommand & { readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-fixture-"));
  const scriptPath = join(dir, "claude-fixture.mjs");
  writeFileSync(scriptPath, `${scriptBody}\n`);
  // Always invoke the fixture through the current runtime, not a shebang.
  // `--` keeps generated Claude argv from being parsed as runtime flags.
  return { dir, claude_bin: process.execPath, claude_args: [scriptPath, "--"] };
}

const REPORT_MAX_TURNS_AND_FAIL = `
const idx = process.argv.indexOf("--max-turns");
process.stderr.write(idx >= 0 ? process.argv[idx + 1] : "missing");
process.exit(1);
`;

const REPORT_ARGV_AND_ENV_AND_FAIL = `
process.stderr.write(JSON.stringify({
  hasSafeMode: process.argv.includes("--safe-mode"),
  hasSecretToken: Object.prototype.hasOwnProperty.call(process.env, "ARBOR_TEST_SECRET_TOKEN"),
  hasPath: Object.prototype.hasOwnProperty.call(process.env, "PATH"),
}));
process.exit(1);
`;

describe("Claude Code campaign integration", () => {
  const fixtureDirs: string[] = [];
  afterEach(() => {
    while (fixtureDirs.length > 0) {
      const dir = fixtureDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
    delete process.env[ARBOR_CRITIC_TRANSPORT_ENV];
  });
  function fixture(scriptBody: string): FixtureCommand & { readonly dir: string } {
    const { dir, ...command } = writeFixtureBinary(scriptBody);
    fixtureDirs.push(dir);
    return { dir, ...command };
  }

  it("plans task-composer drafts through the read-only OAuth-owned runner", async () => {
    const calls: unknown[] = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: "/repo",
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input);
        return { ok: true, text: JSON.stringify({ summary: "Ship it", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [{ description: "work one", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, { description: "work two", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }], acceptance_checks: ["green"], acceptance_mapping: [{ criterion: "green", action_descriptions: ["work one"] }], risk_notes: [] }), usage: { kind: "unavailable", reason: "test" } };
      },
    });
    const result = await planner.plan({ draft_id: "draft-one", task: "one atomic action for themes; do not split", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(calls).toEqual([expect.objectContaining({ cwd: "/repo", mode: "planner", prompt: expect.stringContaining("plan:one atomic action") })]);
    expect(result).toMatchObject({ session_id: "claude-code:draft-one", model_identity: "claude-code/sonnet" });
    expect(JSON.parse(result.raw_proposal).actions).toEqual([expect.objectContaining({ description: "root", delegate_to: "seed" })]);
    expect(JSON.parse(result.raw_proposal).acceptance_mapping).toEqual([{ criterion: "green", action_descriptions: ["root"] }]);
  });
  it("threads the real Claude Code session id through for resume, and the parsed usage counter", async () => {
    const planner = createClaudeCodeTaskPlanner({
      cwd: "/repo",
      planning_prompt: (input) => `plan:${input.task}`,
      run: async () => ({
        ok: true,
        text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }),
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" },
        session_id: "real-cli-session-uuid",
      }),
    });
    const result = await planner.plan({ draft_id: "draft-two", task: "do it", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(result.session_id).toBe("real-cli-session-uuid");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" });
  });

  it("patches a prior proposal by resuming the planner's own session instead of a fresh plan() call", async () => {
    const calls: unknown[] = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: "/repo",
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input);
        return {
          ok: true,
          text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }),
          usage: { kind: "unavailable", reason: "test" },
          session_id: "real-cli-session-uuid",
        };
      },
    });
    const result = await planner.patch!({
      draft_id: "draft-two",
      session_id: "real-cli-session-uuid",
      prior_proposal: JSON.stringify({ summary: "old" }),
      answers: { q1: "yes" },
      newly_answered: { q1: "yes" },
    });
    expect(calls).toEqual([expect.objectContaining({ mode: "planner", session_id: "real-cli-session-uuid", prompt: expect.stringContaining("Clarification answers") })]);
    expect(result.session_id).toBe("real-cli-session-uuid");
  });

  it("patch() omits the full prior proposal text when resuming a session (fix #4: context amplification)", async () => {
    const calls: unknown[] = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: "/repo",
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input);
        return {
          ok: true,
          text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }),
          usage: { kind: "unavailable", reason: "test" },
          session_id: "real-cli-session-uuid",
        };
      },
    });
    await planner.patch!({
      draft_id: "draft-two",
      session_id: "real-cli-session-uuid",
      prior_proposal: "UNIQUE_MARKER_the_full_prior_proposal_text_should_not_be_resent",
      answers: { q1: "yes" },
      newly_answered: { q1: "yes" },
    });
    expect(calls).toEqual([expect.objectContaining({ session_id: "real-cli-session-uuid" })]);
    const sent = (calls[0] as { prompt: string }).prompt;
    expect(sent).not.toContain("UNIQUE_MARKER_the_full_prior_proposal_text_should_not_be_resent");
    expect(sent).toContain("Newly answered questions");
  });

  it("patch() still includes the prior proposal text on a fresh (non-resumed) session", async () => {
    const calls: unknown[] = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: "/repo",
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input);
        return {
          ok: true,
          text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }),
          usage: { kind: "unavailable", reason: "test" },
        };
      },
    });
    await planner.patch!({
      draft_id: "draft-three",
      session_id: null,
      prior_proposal: "UNIQUE_MARKER_needed_because_there_is_no_session_history",
      answers: { q1: "yes" },
      newly_answered: { q1: "yes" },
    });
    const sent = (calls[0] as { prompt: string }).prompt;
    expect(sent).toContain("UNIQUE_MARKER_needed_because_there_is_no_session_history");
  });

  describe("timeout ceiling resolution (fix #1: read_only gets the specialist ceiling, not the short reviewer one)", () => {
    it("gives read_only and specialist the same, longer ceiling; planner/critic keep the short 180s ceiling", () => {
      const env = {} as NodeJS.ProcessEnv;
      expect(resolveClaudeCodeTimeoutMs("specialist", undefined, env)).toBe(900_000);
      expect(resolveClaudeCodeTimeoutMs("read_only", undefined, env)).toBe(900_000);
      expect(resolveClaudeCodeTimeoutMs("planner", undefined, env)).toBe(180_000);
      expect(resolveClaudeCodeTimeoutMs("critic", undefined, env)).toBe(180_000);
    });
    it("honors a configured ARBOR_CLAUDE_CODE_TIMEOUT_MS ceiling for both specialist and read_only", () => {
      const env = { ARBOR_CLAUDE_CODE_TIMEOUT_MS: "60000" } as unknown as NodeJS.ProcessEnv;
      expect(resolveClaudeCodeTimeoutMs("specialist", undefined, env)).toBe(60_000);
      expect(resolveClaudeCodeTimeoutMs("read_only", undefined, env)).toBe(60_000);
      expect(resolveClaudeCodeTimeoutMs("critic", undefined, env)).toBe(180_000);
    });
    it("an explicit per-call timeout_ms always wins regardless of mode", () => {
      const env = {} as NodeJS.ProcessEnv;
      expect(resolveClaudeCodeTimeoutMs("read_only", 5_000, env)).toBe(5_000);
      expect(resolveClaudeCodeTimeoutMs("critic", 5_000, env)).toBe(5_000);
    });
  });

  describe("timeout partial-work preservation (fix #2, real spawn/timer against a fixture binary)", () => {
    async function specializeWithShortTimeout(scriptBody: string, timeoutMs: number, mode: "read_only" | "high_risk" = "high_risk") {
      const bin = fixture(scriptBody);
      const integration = createClaudeCodeCampaignIntegration({ ...bin, timeout_ms: timeoutMs });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      return await executor.specialize({
        campaign_id: "campaign",
        node_id: "node",
        action: mode === "high_risk"
          ? { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["fixture.txt"], command_argv: [] } }
          : { description: "inspect", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change",
        worktree_path: process.cwd(),
        specialist_agent: "seed",
      });
    }

    it("surfaces real elapsed_ms, salvaged stdout as partial_output, and an honest unavailable usage on a kill mid-stream", async () => {
      const result = await specializeWithShortTimeout(
        `process.stdout.write("partial findings: auth flow looks fine so far\\n");
         setTimeout(() => {}, 60000);`,
        5_000,
      );
      expect(result.error).toMatchObject({ kind: "timeout" });
      const error = result.error as { kind: "timeout"; elapsed_ms: number; partial_output: string | null; usage: unknown };
      expect(error.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(typeof error.elapsed_ms).toBe("number");
      expect(error.partial_output).toContain("partial findings: auth flow looks fine so far");
      expect(error.usage).toMatchObject({ kind: "unavailable" });
      // The partial output is also surfaced in the specialist's own output,
      // not just discarded behind the error string.
      expect(result.output).toContain("partial findings: auth flow looks fine so far");
      expect(result.token_usage).toMatchObject({ kind: "unavailable" });
    }, 10_000);

    it("reports partial_output as null when nothing was streamed before the kill", async () => {
      const result = await specializeWithShortTimeout(`setTimeout(() => {}, 60000);`, 1_000);
      expect(result.error).toMatchObject({ kind: "timeout" });
      const error = result.error as { partial_output: string | null };
      expect(error.partial_output).toBeNull();
    }, 10_000);

    it("applies the same real timeout/salvage behavior to a read_only (fix #1) dispatch", async () => {
      const result = await specializeWithShortTimeout(
        `process.stdout.write("investigating email relay config\\n"); setTimeout(() => {}, 60000);`,
        1_000,
        "read_only",
      );
      expect(result.error).toMatchObject({ kind: "timeout" });
      const error = result.error as { partial_output: string | null };
      expect(error.partial_output).toContain("investigating email relay config");
    }, 10_000);
  });

  it("fails closed before spawning a Claude child when flight admission holds a read-only lane", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "started"), "unexpected");
    `);
    const admissions: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      ...bin,
      repo_flight_hook: { admit: (context) => { admissions.push(context); return { admitted: false, reason: "gate is holding this read-only lane" }; } },
    });
    const result = await integration.createDecomposer!({ cwd: process.cwd() } as never).decompose({ action: { description: "inspect" } } as never);
    expect(result).toMatchObject({ ok: false, reason: "Claude Code flight admission refused: gate is holding this read-only lane" });
    expect(admissions).toEqual([expect.objectContaining({ provider: "claude", mode: "read_only", scope: "read_only" })]);
    expect((await import("node:fs")).existsSync(join(bin.dir, "started"))).toBe(false);
  });

  it("enrolls the real Claude child PID before handing it a prompt and reports terminal facts", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      let prompt = "";
      process.stdin.on("data", (chunk) => { prompt += chunk; });
      process.stdin.on("end", () => {
        fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "prompt"), prompt);
        process.stdout.write(JSON.stringify({ result: "[]", usage: {} }));
      });
    `);
    const events: Array<Record<string, unknown>> = [];
    const integration = createClaudeCodeCampaignIntegration({
      ...bin,
      repo_flight_hook: {
        enroll_child: (context) => { events.push({ type: "enroll", ...context }); },
        terminal: (context) => { events.push({ type: "terminal", ...context }); },
      },
    });
    const result = await integration.createDecomposer!({ cwd: process.cwd() } as never).decompose({ action: { description: "inspect" } } as never);
    expect(result).toMatchObject({ ok: true, children: [] });
    expect(events[0]).toMatchObject({ type: "enroll", provider: "claude", scope: "read_only", pid: expect.any(Number), launch_id: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[1]).toMatchObject({ type: "terminal", code: 0, signal: null, pid: events[0]?.pid, launch_id: events[0]?.launch_id });
    expect((await import("node:fs")).readFileSync(join(bin.dir, "prompt"), "utf8")).toContain("Decompose this action");
  });

  it("carries exact specialist task authority into the optional flight hook context without prompt content", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const integration = createClaudeCodeCampaignIntegration({
      run: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { ok: true, text: "completed", usage: { kind: "unavailable", reason: "fixture" } };
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign-flight",
      cwd: process.cwd(),
      connector: createClaudeCodeHarnessConnectorDescriptor(),
    });
    await executor.specialize({
      campaign_id: "campaign-flight",
      node_id: "node-flight",
      action: {
        description: "edit the fixture", category: "code",
        high_risk_tool_scope: { write_paths: ["src/fixture.ts"], command_argv: [["bun", "test", "src/fixture.test.ts"]] },
      },
      prompt: "private provider prompt must not enter governance metadata",
      worktree_path: process.cwd(), specialist_agent: "seed",
    } as never);
    expect(calls).toEqual([expect.objectContaining({
      flight_governance: {
        campaign_id: "campaign-flight", node_id: "node-flight", task_id: "node-flight",
        write_paths: ["src/fixture.ts"], command_argv: [["bun", "test", "src/fixture.test.ts"]],
      },
    })]);
  });

  it("treats terminal hook refusal as a failed Claude call rather than accepting provider output", async () => {
    const bin = fixture(`
      process.stdin.resume();
      process.stdin.on("end", () => process.stdout.write(JSON.stringify({ result: "[]", usage: {} })));
    `);
    const integration = createClaudeCodeCampaignIntegration({
      ...bin,
      repo_flight_hook: { terminal: () => { throw new Error("terminal receipt was rejected"); } },
    });
    const result = await integration.createDecomposer!({ cwd: process.cwd() } as never).decompose({ action: { description: "inspect" } } as never);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("terminal receipt was rejected") });
  });

  it("injects a bounded repository context capsule into the planning prompt and tells the planner it is grounded, tool-free context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-code-repo-graph-"));
    fixtureDirs.push(dir);
    writeFileSync(join(dir, "widget.ts"), "export function renderWidget() { return 1; }\n");
    const calls: unknown[] = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: dir,
      repository_graph: new RepositoryGraphIndex(),
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input);
        return { ok: true, text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }), usage: { kind: "unavailable", reason: "test" } };
      },
    });
    await planner.plan({ draft_id: "draft-capsule", task: "renderWidget needs a fix", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(calls).toEqual([expect.objectContaining({
      context_capsule: expect.stringContaining("Task-ranked repository graph"),
      prompt: expect.stringContaining("grounded repository signal"),
    })]);
  });

  it("E-1: ARBOR_CONTEXT_CAPSULE=off ablates the capsule and the grounded-context instruction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-code-repo-graph-"));
    fixtureDirs.push(dir);
    writeFileSync(join(dir, "widget.ts"), "export function renderWidget() { return 1; }\n");
    const calls: Array<{ context_capsule?: string }> = [];
    const planner = createClaudeCodeTaskPlanner({
      cwd: dir,
      repository_graph: new RepositoryGraphIndex(),
      planning_prompt: (input) => `plan:${input.task}`,
      run: async (input) => {
        calls.push(input as { context_capsule?: string });
        return { ok: true, text: JSON.stringify({ summary: "s", assumptions: [], questions: [], root_action: { description: "root", estimated_gain: 1, estimated_cost: 1, category: "ux", delegate_to: "writer" }, actions: [], acceptance_checks: [], risk_notes: [] }), usage: { kind: "unavailable", reason: "test" } };
      },
    });
    process.env.ARBOR_CONTEXT_CAPSULE = "off";
    try {
      await planner.plan({ draft_id: "draft-no-capsule", task: "renderWidget needs a fix", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    } finally {
      delete process.env.ARBOR_CONTEXT_CAPSULE;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].context_capsule).toBeUndefined();
  });

  it("declares only the bounded capabilities Revoy actually governs or observes", () => {
    const descriptor = createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z");
    expect(descriptor.connector_id).toBe(CLAUDE_CODE_HARNESS_CONNECTOR_ID);
    expect(descriptor.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "interruption", grade: "governed" }),
      expect.objectContaining({ capability: "workspace_isolation", grade: "governed" }),
      expect.objectContaining({ capability: "usage_reporting", grade: "observed" }),
    ]));
  });

  it("dispatches a specialist through the injected credential-free process bridge", async () => {
    const calls: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async (input) => {
        calls.push(input);
        return { ok: true, text: "changed the fixture", usage: { kind: "unavailable", reason: "fixture" } };
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["fixture.txt"], command_argv: [] } },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(calls).toEqual([expect.objectContaining({ cwd: "/repo/worktree", model: "fixture-sonnet", mode: "specialist" })]);
    expect((calls[0] as { prompt: string }).prompt).toContain('Your exact write authority is ["fixture.txt"]');
    expect((calls[0] as { prompt: string }).prompt).toContain("do not add, edit, replace, or delete tests unless their exact paths appear in that list");
    expect(result).toMatchObject({ output: "changed the fixture", provenance: { tag: "claimed" }, model_identity: "claude-code/fixture-sonnet" });
  });

  it("routes a specialist action with no high_risk_tool_scope through the read-only, mutation-free tool grant", async () => {
    const calls: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async (input) => {
        calls.push(input);
        return { ok: true, text: "inspected only", usage: { kind: "unavailable", reason: "fixture" } };
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "inspect", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "look into this",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(calls).toEqual([expect.objectContaining({ cwd: "/repo/worktree", model: "fixture-sonnet", mode: "read_only", prompt: expect.stringContaining("You may use non-mutating repository inspection commands") })]);
    expect(result).toMatchObject({ output: "inspected only" });
  });

  it("routes a command-only validation action through executable transport without granting file edits", async () => {
    const calls: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async (input) => {
        calls.push(input);
        return { ok: true, text: "tests passed", usage: { kind: "unavailable", reason: "fixture" } };
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "validate", estimated_gain: 1, estimated_cost: 1, category: "test", delegate_to: "seed", high_risk_tool_scope: { write_paths: [], command_argv: [["bun", "test", "fixture.test.ts"]] } },
      prompt: "run the declared test",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(calls).toEqual([expect.objectContaining({ mode: "specialist", prompt: expect.stringContaining("Do not edit, create, or delete repository files") })]);
  });

  describe("exploration/reflection split turn guidance (X-3, turn-efficiency #2+#3)", () => {
    async function specializePrompt(turnBudgetEstimate: number): Promise<string> {
      const calls: unknown[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => {
          calls.push(input);
          return { ok: true, text: "changed the fixture", usage: { kind: "unavailable", reason: "fixture" } };
        },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: "/repo",
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      await executor.specialize({
        campaign_id: "campaign",
        node_id: "node",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["fixture.txt"], command_argv: [] } },
        prompt: "make the change",
        worktree_path: "/repo/worktree",
        specialist_agent: "seed",
        turn_budget_estimate: turnBudgetEstimate,
      });
      return (calls[0] as { prompt: string }).prompt;
    }

    it("derives both the exploration ceiling and the reflection remainder from the same turn budget", async () => {
      // budget 32 -> exploration ceil(32/3) = 11, reflection = 21
      const prompt = await specializePrompt(32);
      expect(prompt).toContain("32-turn budget");
      expect(prompt).toContain("exploration is capped at 11 turns");
      expect(prompt).toContain("exploration turns beyond 11 before the first material edit will be scored as inefficiency by the reviewer");
      expect(prompt).toContain("remaining 21 turns are your reflection allowance");
    });

    it("recomputes both numbers when the turn budget differs", async () => {
      // budget 8 (the min) -> exploration ceil(8/3) = 3, reflection = 5
      const prompt = await specializePrompt(8);
      expect(prompt).toContain("8-turn budget");
      expect(prompt).toContain("exploration is capped at 3 turns");
      expect(prompt).toContain("remaining 5 turns are your reflection allowance");
    });

    it("leaves the read-only dispatch prompt unchanged (no turn-split guidance)", async () => {
      const calls: unknown[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => {
          calls.push(input);
          return { ok: true, text: "inspected only", usage: { kind: "unavailable", reason: "fixture" } };
        },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: "/repo",
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      await executor.specialize({
        campaign_id: "campaign",
        node_id: "node",
        action: { description: "inspect", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "look into this",
        worktree_path: "/repo/worktree",
        specialist_agent: "seed",
      });
      const prompt = (calls[0] as { prompt: string }).prompt;
      expect(prompt).not.toContain("exploration is capped");
      expect(prompt).not.toContain("reflection allowance");
      expect(prompt).toContain("no write or mutating-command authority");
      expect(prompt).toContain("non-mutating repository inspection commands");
    });
  });

  it("upgrades provenance to verified only from the injected verifier's own pass", async () => {
    const verifyCalls: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "changed the fixture", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: {
        verify: async (input, signal) => {
          verifyCalls.push({ input, aborted: signal.aborted });
          return {
            message: "machine verification passed: fixture",
            provenance: { tag: "verified", cmd: "fixture", exit: 0, stdout_hash: "sha256:fixture", check: { kind: "shell_command", breadth: "single" } },
            command_argv: ["fixture"],
          };
        },
      },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(verifyCalls).toEqual([{
      input: {
        campaign_id: "campaign", node_id: "node", specialist_agent: "seed", session_id: "claude-code:campaign:node",
        worktree_path: "/repo/worktree", final_message: "changed the fixture", history: [],
      },
      aborted: false,
    }]);
    // OPT-1: the upgrade now arrives through the deferred (pipelined)
    // verification rather than the immediate return — same guarantee, new
    // seam: only the injected verifier's own pass upgrades provenance.
    expect(result).toMatchObject({ output: "changed the fixture", provenance: { tag: "claimed" } });
    await expect(result.deferred_verification).resolves.toMatchObject({ provenance: { tag: "verified", cmd: "fixture" } });
  });

  it("leaves provenance claimed when the injected verifier reports null", async () => {
    let calls = 0;
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "changed the fixture", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: { verify: async () => { calls += 1; return null; } },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ output: "changed the fixture", provenance: { tag: "claimed", claimant: "seed" } });
  });

  it("never runs the verifier when the specialist call itself fails", async () => {
    let calls = 0;
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: false, error: "Claude Code exited 1: boom" }),
      specialist_verification: { verify: async () => { calls += 1; return null; } },
    });
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
    });
    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ provenance: { tag: "claimed", claimant: "seed" }, error: { kind: "internal_error" } });
  });

  it("dispatches reviewers through the closed structured critic contract", async () => {
    const calls: Array<{ mode: string; prompt: string }> = [];
    const verdict = {
      approved: true,
      rationale: "verified",
      root_cause: null,
      measurement_validated: true,
      guardrails_enforced: true,
      introspection_passed: true,
      stability_ok: true,
      checks: [
        { name: "root_cause", passed: true, detail: "no blocker" },
        { name: "measurement_validation", passed: true, detail: "evidence present" },
        { name: "guardrail_enforcement", passed: true, detail: "guardrails held" },
        { name: "introspection", passed: true, detail: "state inspected" },
        { name: "stability_monitoring", passed: true, detail: "stable" },
      ],
    };
    const integration = createClaudeCodeCampaignIntegration({
      run: async (input) => {
        calls.push({ mode: input.mode, prompt: input.prompt });
        return { ok: true, text: JSON.stringify(verdict), usage: { kind: "unavailable", reason: "fixture" } };
      },
    });
    const reviewer = integration.createReviewer!({ cwd: "/repo" } as never);
    await expect(reviewer("design", {} as never)).resolves.toMatchObject({ approved: true, verdict: { critic: "lenticel" } });
    expect(calls).toEqual([expect.objectContaining({ mode: "critic", prompt: expect.stringContaining("Return exactly one JSON object") })]);
    expect(calls[0]?.prompt).toContain("do not broaden a named rule");
    expect(calls[0]?.prompt).toContain("Provider-sandbox EPERM");
    expect(calls[0]?.prompt).toContain("Do not require a repository-wide test command unless that command is explicitly part");
    expect(calls[0]?.prompt).toContain("when it is explicitly authored, its failure remains blocking");
  });

  describe("PERF: native critic transport (ARBOR_CRITIC_TRANSPORT=native)", () => {
    const nativeVerdict = {
      approved: true,
      rationale: "native approved",
      root_cause: null,
      measurement_validated: true,
      guardrails_enforced: true,
      introspection_passed: true,
      stability_ok: true,
      checks: [
        { name: "root_cause", passed: true, detail: "no blocker" },
        { name: "measurement_validation", passed: true, detail: "evidence present" },
        { name: "guardrail_enforcement", passed: true, detail: "guardrails held" },
        { name: "introspection", passed: true, detail: "state inspected" },
        { name: "stability_monitoring", passed: true, detail: "stable" },
      ],
    };
    const nativeExecutorEnv = {
      runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-15T00:00:00.000Z"),
    };
    const reviewParams = { prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never;
    function fakeNativeCritic(result: NativeCriticCallResult, modelId = "gpt-fixture"): NativeCriticPort {
      return { ready: true, model_id: modelId, async call() { return result; } };
    }

    it("uses the native transport when the env is set and the port is ready, recording native/<model> as model_identity", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const cliCalls: unknown[] = [];
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(nativeVerdict), usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } });
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => { cliCalls.push(input); return { ok: true, text: "unused", usage: { kind: "unavailable", reason: "fixture" } }; },
        native_critic,
      });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: true, verdict: { critic: "lenticel" }, model_identity: "native/gpt-fixture" });
      expect(cliCalls).toEqual([]);
    });

    it("does not use the native transport when the env is unset, even if a ready port is injected", async () => {
      const cliCalls: unknown[] = [];
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(nativeVerdict), usage: { kind: "unavailable", reason: "fixture" } });
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => { cliCalls.push(input); return { ok: true, text: JSON.stringify(nativeVerdict), usage: { kind: "unavailable", reason: "fixture" } }; },
        native_critic,
      });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: true, model_identity: "claude-code/fixture-sonnet" });
      expect(cliCalls).toEqual([expect.objectContaining({ mode: "critic" })]);
    });

    it("falls back to the CLI critic path when the port reports not ready", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const cliCalls: unknown[] = [];
      const notReadyPort: NativeCriticPort = { ready: false, model_id: null, async call() { throw new Error("must not be called"); } };
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => { cliCalls.push(input); return { ok: true, text: JSON.stringify(nativeVerdict), usage: { kind: "unavailable", reason: "fixture" } }; },
        native_critic: notReadyPort,
      });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: true, model_identity: "claude-code/fixture-sonnet" });
      expect(cliCalls).toEqual([expect.objectContaining({ mode: "critic" })]);
    });

    it("falls back to the CLI critic path when the native call errors, never failing the review", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const cliCalls: unknown[] = [];
      const native_critic = fakeNativeCritic({ ok: false, error: "native transport exploded", usage: { kind: "unavailable", reason: "native transport exploded" } });
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => { cliCalls.push(input); return { ok: true, text: JSON.stringify(nativeVerdict), usage: { kind: "unavailable", reason: "fixture" } }; },
        native_critic,
      });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: true, model_identity: "claude-code/fixture-sonnet" });
      expect(cliCalls).toEqual([expect.objectContaining({ mode: "critic" })]);
    });

    it("parses the native verdict text through parseCriticVerdict; a malformed response is an unparseable_critic_verdict rejection, not a fallback", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const cliCalls: unknown[] = [];
      const native_critic = fakeNativeCritic({ ok: true, text: "not json at all", usage: { kind: "unavailable", reason: "fixture" } });
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => { cliCalls.push(input); return { ok: true, text: JSON.stringify(nativeVerdict), usage: { kind: "unavailable", reason: "fixture" } }; },
        native_critic,
      });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: false, root_cause: "unparseable_critic_verdict", model_identity: "native/gpt-fixture" });
      expect(cliCalls).toEqual([]);
    });

    it("a template-only native verdict is malformed_critic_verdict with an error, not a rejection (ADR-184)", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const templated = { ...nativeVerdict, rationale: "placeholder" };
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(templated), usage: { kind: "unavailable", reason: "fixture" } });
      const integration = createClaudeCodeCampaignIntegration({ run: async () => ({ ok: true, text: "unused", usage: { kind: "unavailable", reason: "fixture" } }), native_critic });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result).toMatchObject({ approved: false, root_cause: "malformed_critic_verdict", model_identity: "native/gpt-fixture" });
      expect(result?.error).toBeDefined();
    });

    it("maps native usage into token_usage on the recorded verdict", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const usage = { input_tokens: 11, output_tokens: 4, cached_input_tokens: 2, cache_write_input_tokens: 0, counter_source: "provider_counter" as const };
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(nativeVerdict), usage });
      const integration = createClaudeCodeCampaignIntegration({ run: async () => ({ ok: true, text: "unused", usage: { kind: "unavailable", reason: "fixture" } }), native_critic });
      const executor = integration.createExecutor(nativeExecutorEnv);
      const result = await executor.review?.(reviewParams);
      expect(result?.token_usage).toEqual(usage);
    });
  });

  describe("bounded nonzero-exit diagnostics (real spawn against a fixture binary, never the real Claude CLI)", () => {
    async function specializeAgainst(claude: FixtureCommand): Promise<{ output: string; error?: { message: string } }> {
      const integration = createClaudeCodeCampaignIntegration(claude);
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      const result = await executor.specialize({
        campaign_id: "campaign",
        node_id: "node",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change",
        worktree_path: process.cwd(),
        specialist_agent: "seed",
      });
      return result as { output: string; error?: { message: string } };
    }

    it("carries the stderr detail into the diagnostic without dropping or redacting it", async () => {
      const bin = fixture(`process.stderr.write("permission denied: cannot write to /etc/passwd"); process.exit(1);`);
      const result = await specializeAgainst(bin);
      expect(result.output).toBe("[claude-code error] Claude Code exited 1: permission denied: cannot write to /etc/passwd");
      expect(result.error?.message).toBe("Claude Code exited 1: permission denied: cannot write to /etc/passwd");
    });

    it("truncates an overlong stderr diagnostic instead of silently dropping it", async () => {
      const bin = fixture(`process.stderr.write("e".repeat(800)); process.exit(1);`);
      const result = await specializeAgainst(bin);
      expect(result.error?.message).toBe(`Claude Code exited 1: ${"e".repeat(500)}`);
    });

    it("falls back to the stdout JSON error field when stderr is empty", async () => {
      const bin = fixture(`process.stdout.write(JSON.stringify({ error: "tool permission denied by policy" })); process.exit(2);`);
      const result = await specializeAgainst(bin);
      expect(result.error?.message).toBe("Claude Code exited 2: tool permission denied by policy");
    });

    it("falls back to the stdout JSON result field when there is no error field or stderr", async () => {
      const bin = fixture(`process.stdout.write(JSON.stringify({ result: "specialist attempted a forbidden command" })); process.exit(3);`);
      const result = await specializeAgainst(bin);
      expect(result.error?.message).toBe("Claude Code exited 3: specialist attempted a forbidden command");
    });

    it("falls back to raw stdout text when stdout isn't JSON and stderr is empty", async () => {
      const bin = fixture(`process.stdout.write("raw crash trace without a json wrapper"); process.exit(4);`);
      const result = await specializeAgainst(bin);
      expect(result.error?.message).toBe("Claude Code exited 4: raw crash trace without a json wrapper");
    });

    it("never emits an empty 'exited N:' message when stdout and stderr are both empty", async () => {
      const bin = fixture(`process.exit(5);`);
      const result = await specializeAgainst(bin);
      expect(result.error?.message).toBe("Claude Code exited 5 with no stdout or stderr output");
    });
  });

  describe("configurable specialist max turns (ARBOR_CLAUDE_CODE_MAX_TURNS)", () => {
    async function maxTurnsSeenBySpecialist(claude: FixtureCommand): Promise<string> {
      const integration = createClaudeCodeCampaignIntegration(claude);
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      const result = await executor.specialize({
        campaign_id: "campaign",
        node_id: "node",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change",
        worktree_path: process.cwd(),
        specialist_agent: "seed",
      });
      const error = (result as { error?: { message: string } }).error;
      const match = error?.message.match(/Claude Code exited 1: (.*)$/);
      if (!match) throw new Error(`unexpected specialist result: ${JSON.stringify(result)}`);
      return match[1];
    }

    it("defaults to the balanced 32-turn allowance when routing is absent", async () => {
      delete process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
      expect(await maxTurnsSeenBySpecialist(fixture(REPORT_MAX_TURNS_AND_FAIL))).toBe("32");
    });

    it("honors a valid override within the [8, 128] bounds", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "100";
      expect(await maxTurnsSeenBySpecialist(fixture(REPORT_MAX_TURNS_AND_FAIL))).toBe("100");
    });

    it.each(["7", "129", "abc", "3.5", "-1"])("falls back to the balanced default for out-of-range/invalid value %s", async (invalid) => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = invalid;
      expect(await maxTurnsSeenBySpecialist(fixture(REPORT_MAX_TURNS_AND_FAIL))).toBe("32");
    });

    it("accepts the lower and upper bounds exactly", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "8";
      expect(await maxTurnsSeenBySpecialist(fixture(REPORT_MAX_TURNS_AND_FAIL))).toBe("8");
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "128";
      expect(await maxTurnsSeenBySpecialist(fixture(REPORT_MAX_TURNS_AND_FAIL))).toBe("128");
    });

    it("allocates 16/32/48 turns from Revoy difficulty routing when no override is set", async () => {
      delete process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
      const observed: number[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => {
          observed.push(input.max_turns ?? -1);
          return { ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } };
        },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign", cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      for (const model_tier of ["economical", "balanced", "capable"] as const) {
        await executor.specialize({
          campaign_id: "campaign", node_id: `node-${model_tier}`,
          action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
          prompt: "make the change", worktree_path: process.cwd(), specialist_agent: "seed",
          routing: { difficulty: 0.5, expansion_depth: 1, model_tier, evidence_ref: `fixture:${model_tier}` },
        });
      }
      expect(observed).toEqual([16, 32, 48]);
    });

    it("E-2: consumes the arbiter's turn_budget_estimate as the max-turns ceiling when no env override is set", async () => {
      delete process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
      const observed: number[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => { observed.push(input.max_turns ?? -1); return { ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }; },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign", cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      await executor.specialize({
        campaign_id: "campaign", node_id: "node-direct",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change", worktree_path: process.cwd(), specialist_agent: "seed",
        turn_budget_estimate: 12,
      });
      expect(observed).toEqual([12]);
    });

    it("E-2: ARBOR_CLAUDE_CODE_MAX_TURNS still wins over the arbiter's turn_budget_estimate (unchanged precedence)", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "100";
      const observed: number[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => { observed.push(input.max_turns ?? -1); return { ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }; },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign", cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      await executor.specialize({
        campaign_id: "campaign", node_id: "node-override",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change", worktree_path: process.cwd(), specialist_agent: "seed",
        turn_budget_estimate: 12,
      });
      expect(observed).toEqual([100]);
    });

    it("E-2: an out-of-bounds turn_budget_estimate falls back to the existing model-tier default", async () => {
      delete process.env.ARBOR_CLAUDE_CODE_MAX_TURNS;
      const observed: number[] = [];
      const integration = createClaudeCodeCampaignIntegration({
        run: async (input) => { observed.push(input.max_turns ?? -1); return { ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }; },
      });
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign", cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      await executor.specialize({
        campaign_id: "campaign", node_id: "node-oob",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
        prompt: "make the change", worktree_path: process.cwd(), specialist_agent: "seed",
        turn_budget_estimate: 3, // below SPECIALIST_MAX_TURNS_MIN (8)
      });
      expect(observed).toEqual([32]);
    });

    it("keeps the planner's max turns fixed at 1 regardless of the override", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "100";
      const bin = fixture(REPORT_MAX_TURNS_AND_FAIL);
      const planner = createClaudeCodeTaskPlanner({ cwd: process.cwd(), ...bin, planning_prompt: (input) => `plan:${input.task}` });
      await expect(planner.plan({ draft_id: "draft-one", task: "do the thing", answers: {}, parent_campaign_id: null, evidence_ids: [] }))
        .rejects.toThrow("Claude Code exited 1: 1");
    });

    it("keeps the reviewer/critic max turns fixed at 24 regardless of the override", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "100";
      const bin = fixture(REPORT_MAX_TURNS_AND_FAIL);
      const integration = createClaudeCodeCampaignIntegration(bin);
      const reviewer = integration.createReviewer!({ cwd: process.cwd() } as never);
      await expect(reviewer("design", {} as never)).resolves.toMatchObject({ rationale: "Claude Code exited 1: 24" });
    });

    it("keeps the decomposer (read_only) max turns fixed at 24 regardless of the override", async () => {
      process.env.ARBOR_CLAUDE_CODE_MAX_TURNS = "100";
      const bin = fixture(REPORT_MAX_TURNS_AND_FAIL);
      const integration = createClaudeCodeCampaignIntegration(bin);
      const decomposer = integration.createDecomposer!({ cwd: process.cwd() } as never);
      await expect(decomposer.decompose({ action: { description: "x", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" } } as never))
        .resolves.toMatchObject({ ok: false, reason: "Claude Code exited 1: 24" });
    });
  });

  describe("subprocess hardening (real spawn against a fixture binary)", () => {
    async function argvAndEnvSeenBySpecialist(claude: FixtureCommand): Promise<{ hasSafeMode: boolean; hasSecretToken: boolean; hasPath: boolean }> {
      const integration = createClaudeCodeCampaignIntegration(claude);
      const executor = integration.createExecutor({
        runtime: { nativeSessionRegistry: null, harnessSessions: null } as never,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign", cwd: process.cwd(),
        connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-13T00:00:00.000Z"),
      });
      const result = await executor.specialize({
        campaign_id: "campaign", node_id: "node",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["x"], command_argv: [] } },
        prompt: "make the change", worktree_path: process.cwd(), specialist_agent: "seed",
      });
      const error = (result as { error?: { message: string } }).error;
      const match = error?.message.match(/Claude Code exited 1: (.*)$/s);
      if (!match) throw new Error(`unexpected specialist result: ${JSON.stringify(result)}`);
      return JSON.parse(match[1]);
    }

    it("always passes --safe-mode so the target repo's own CLAUDE.md/skills/plugins/hooks are never discovered", async () => {
      const { hasSafeMode } = await argvAndEnvSeenBySpecialist(fixture(REPORT_ARGV_AND_ENV_AND_FAIL));
      expect(hasSafeMode).toBe(true);
    });

    it("spawns Claude Code with an explicit allowlisted env, not the full parent environment", async () => {
      process.env.ARBOR_TEST_SECRET_TOKEN = "leak-me-not";
      try {
        const { hasSecretToken, hasPath } = await argvAndEnvSeenBySpecialist(fixture(REPORT_ARGV_AND_ENV_AND_FAIL));
        expect(hasSecretToken).toBe(false);
        expect(hasPath).toBe(true);
      } finally {
        delete process.env.ARBOR_TEST_SECRET_TOKEN;
      }
    });
  });
});

describe("OPT-1/OPT-2: pipelined verification and critic model routing", () => {
  it("projects loop transitions to DevTools without forwarding loop payloads", () => {
    const lines: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration();
    const executor = integration.createExecutor({ runtime: { nativeSessionRegistry: null, harnessSessions: null } as never, adapter: { pushDevtoolsLine: (line: unknown) => lines.push(line) } as never, campaign_id: "campaign", cwd: "/repo", connector: createClaudeCodeHarnessConnectorDescriptor() });
    executor.log?.({ type: "node_claimed", node_id: "node-7", campaign_id: "campaign", secret_payload: "must-not-project" } as never);
    expect(lines).toEqual([expect.objectContaining({ event_kind: "loop.node_claimed", campaign_id: "campaign", node_id: "node-7", loop_event: { type: "node_claimed", campaign_id: "campaign", node_id: "node-7" } })]);
    expect(JSON.stringify(lines)).not.toContain("must-not-project");
    executor.log?.({ type: "backtracked", node_id: "child", parent_id: "root", secret_payload: "must-not-project" } as never);
    executor.log?.({ type: "backtracked", node_id: "root", parent_id: null });
    expect(lines[1]).toEqual(expect.objectContaining({
      campaign_id: "campaign", event_kind: "loop.backtracked",
      loop_event: { type: "backtracked", campaign_id: "campaign", node_id: "child", parent_id: "root" },
    }));
    expect(lines[2]).toEqual(expect.objectContaining({
      loop_event: { type: "backtracked", campaign_id: "campaign", node_id: "root", parent_id: null },
    }));
    expect(JSON.stringify(lines)).not.toContain("must-not-project");
  });

  const executorEnv = { runtime: { nativeSessionRegistry: null, harnessSessions: null } as never, adapter: { pushDevtoolsLine: () => {} } as never, campaign_id: "campaign", cwd: "/repo", connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-15T00:00:00.000Z") };

  it("returns from specialize without awaiting verification and hands back the deferred upgrade", async () => {
    let resolveVerify: (v: { provenance: { tag: "verified"; cmd: string; exit: number; stdout_hash: string } }) => void = () => {};
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: {
        verify: () => new Promise((resolve) => { resolveVerify = resolve as never; }),
      } as never,
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
      prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
    });
    // specialize resolved while verification is still pending — the overlap.
    expect(result.provenance).toMatchObject({ tag: "claimed" });
    expect(result.deferred_verification).toBeDefined();
    resolveVerify({ provenance: { tag: "verified", cmd: "node --test", exit: 0, stdout_hash: "sha256:ok" } });
    await expect(result.deferred_verification).resolves.toMatchObject({ provenance: { tag: "verified" } });
  });

  it("classifies a rejecting verification port without throwing or silently erasing the failure", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: { verify: async () => { throw new Error("verifier crashed"); } } as never,
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
      prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
    });
    await expect(result.deferred_verification).resolves.toEqual({ attempted: true, failed: true, code: "verification_exception" });
  });

  it("routes the critic to ARBOR_CLAUDE_CODE_CRITIC_MODEL while the specialist keeps its own model", async () => {
    process.env.ARBOR_CLAUDE_CODE_CRITIC_MODEL = "fixture-haiku";
    try {
      const calls: Array<{ model: string; mode: string }> = [];
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async (input) => {
          calls.push({ model: input.model, mode: input.mode });
          return { ok: true, text: JSON.stringify({ approved: true, rationale: "ok", root_cause: null, measurement_validated: false, checks: [{ name: "correctness", passed: true }, { name: "completeness", passed: true }, { name: "tests", passed: true }, { name: "guardrails", passed: true }, { name: "stability", passed: true }], correctness_ok: true, completeness_ok: true, tests_ok: true, guardrails_enforced: true, stability_ok: true, critic: "lenticel" }), usage: { kind: "unavailable", reason: "fixture" } };
        },
      });
      const executor = integration.createExecutor(executorEnv);
      await executor.specialize({
        campaign_id: "campaign", node_id: "node",
        action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
        prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
      });
      await executor.review?.({ prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never);
      expect(calls.find((c) => c.mode === "specialist")?.model).toBe("fixture-sonnet");
      expect(calls.find((c) => c.mode === "critic")?.model).toBe("fixture-haiku");
    } finally {
      delete process.env.ARBOR_CLAUDE_CODE_CRITIC_MODEL;
    }
  });
});

const validCriticChecks = [
  { name: "root_cause", passed: false, detail: "n/a" },
  { name: "measurement_validation", passed: false, detail: "tests failed" },
  { name: "guardrail_enforcement", passed: true, detail: "in scope" },
  { name: "introspection", passed: true, detail: "consistent" },
  { name: "stability_monitoring", passed: true, detail: "stable" },
];

describe("E-2 (arXiv 2607.13034): worktree-machine-verifier verifyOutcome integration", () => {
  const executorEnv = { runtime: { nativeSessionRegistry: null, harnessSessions: null } as never, adapter: { pushDevtoolsLine: () => {} } as never, campaign_id: "campaign", cwd: "/repo", connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-15T00:00:00.000Z") };

  it("maps a verifyOutcome 'failed' result to the deferred_verification attempted-failure shape", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: {
        verify: async () => null,
        verifyOutcome: async () => ({ outcome: "failed" as const, code: "command_exit_nonzero" as const, exit: 101, diagnostic: "error[E0599]: no method named read_u40" }),
      },
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
      prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
    });
    await expect(result.deferred_verification).resolves.toEqual({ attempted: true, failed: true, code: "command_exit_nonzero", exit: 101, diagnostic: "error[E0599]: no method named read_u40" });
  });

  it("maps a verifyOutcome 'not_attempted' result to null, indistinguishable from 'nothing to verify'", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: {
        verify: async () => null,
        verifyOutcome: async () => ({ outcome: "not_attempted" as const }),
      },
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
      prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
    });
    await expect(result.deferred_verification).resolves.toBeNull();
  });

  it("falls back to legacy verify() (null-collapsing) when the port implements no verifyOutcome", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: "done", usage: { kind: "unavailable", reason: "fixture" } }),
      specialist_verification: { verify: async () => null },
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.specialize({
      campaign_id: "campaign", node_id: "node",
      action: { description: "change", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", high_risk_tool_scope: { write_paths: ["f.txt"], command_argv: [] } },
      prompt: "make the change", worktree_path: "/repo/worktree", specialist_agent: "seed",
    });
    await expect(result.deferred_verification).resolves.toBeNull();
  });
});

describe("E-3 (arXiv 2607.05391): critic confidence merged into the verdict", () => {
  const executorEnv = { runtime: { nativeSessionRegistry: null, harnessSessions: null } as never, adapter: { pushDevtoolsLine: () => {} } as never, campaign_id: "campaign", cwd: "/repo", connector: createClaudeCodeHarnessConnectorDescriptor("2026-08-15T00:00:00.000Z") };

  it("merges a valid self-reported confidence into the CLI critic path's verdict", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: JSON.stringify({ approved: false, rationale: "tests failed", root_cause: "missing mock", measurement_validated: false, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: validCriticChecks, confidence: 0.31 }), usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.review?.({ prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never);
    expect(result?.verdict).toMatchObject({ confidence: 0.31, confidence_source: "self_report" });
  });

  it("an absent confidence leaves the verdict without confidence — no regression from today's shape", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: JSON.stringify({ approved: false, rationale: "tests failed", root_cause: "missing mock", measurement_validated: false, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: validCriticChecks }), usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.review?.({ prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never);
    expect(result?.verdict?.confidence).toBeUndefined();
  });

  it("a malformed confidence (out of range) is dropped, not treated as a transport failure", async () => {
    const integration = createClaudeCodeCampaignIntegration({
      model: "fixture-sonnet",
      run: async () => ({ ok: true, text: JSON.stringify({ approved: false, rationale: "tests failed", root_cause: "missing mock", measurement_validated: false, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: validCriticChecks, confidence: 7 }), usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor(executorEnv);
    const result = await executor.review?.({ prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never);
    expect(result?.verdict).toMatchObject({ approved: false });
    expect(result?.verdict?.confidence).toBeUndefined();
  });

  it("merges confidence into the native critic transport path's verdict too", async () => {
    const nativeCritic: NativeCriticPort = {
      ready: true,
      model_id: "native-fixture",
      call: async (): Promise<NativeCriticCallResult> => ({
        ok: true,
        text: JSON.stringify({ approved: true, rationale: "looks good", root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: validCriticChecks.map((c) => ({ ...c, passed: true })), confidence: 0.95 }),
        usage: { kind: "unavailable", reason: "fixture" },
      }),
    };
    process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
    try {
      const integration = createClaudeCodeCampaignIntegration({
        model: "fixture-sonnet",
        run: async () => ({ ok: true, text: "unused", usage: { kind: "unavailable", reason: "fixture" } }),
        native_critic: nativeCritic,
      });
      const executor = integration.createExecutor(executorEnv);
      const result = await executor.review?.({ prompt: "review", specialist_output: "done", node_id: "node", campaign_id: "campaign" } as never);
      expect(result?.verdict).toMatchObject({ confidence: 0.95, confidence_source: "self_report" });
    } finally {
      delete process.env[ARBOR_CRITIC_TRANSPORT_ENV];
    }
  });
});
