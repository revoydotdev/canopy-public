import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOpenCodeCampaignIntegration } from "../src/integrations/opencode-campaign.js";
import { repoFlightProviderLaunchContext, type RepoFlightProviderLifecycleHook } from "../src/integrations/repo-flight-provider-hook.js";
import { repoFlightOpenCodeEnrollmentBarrierAvailable, runOpenCode } from "../src/opencode-executor.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-opencode.mjs");

function flightContext(cwd: string) {
  return repoFlightProviderLaunchContext("opencode", {
    mode: "specialist",
    cwd,
    model: "provider/model",
    flight_governance: {
      campaign_id: "campaign-1",
      node_id: "node-1",
      task_id: "task-1",
      write_paths: ["packages/arbor-mcp/src/flight.ts"],
      command_argv: [["bun", "test"]],
    },
  });
}

function recordedPid(context: unknown): number | undefined {
  return typeof context === "object" && context !== null && typeof (context as { pid?: unknown }).pid === "number"
    ? (context as { pid: number }).pid
    : undefined;
}

describe("Repo Flight OpenCode subprocess boundary", () => {
  it("reports the same host barrier fact used by guarded dispatch", () => {
    expect(repoFlightOpenCodeEnrollmentBarrierAvailable()).toBe(process.platform === "linux" && existsSync("/bin/sh") && existsSync("/proc/self/stat"));
  });
  it("admits, enrolls the stopped exact PID, then resumes OpenCode and records terminal facts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "repo-flight-opencode-cwd-"));
    const marker = join(cwd, "enrolled");
    const events: Array<{ readonly kind: string; readonly context: unknown }> = [];
    const hook: RepoFlightProviderLifecycleHook = {
      admit(context) { events.push({ kind: "admit", context }); return { admitted: true }; },
      enroll_child(context) {
        // The child is a stopped `exec` barrier here: if OpenCode had already
        // run, it would have tried to read this marker before we create it.
        expect(existsSync(marker)).toBe(false);
        writeFileSync(marker, "enrolled", "utf8");
        events.push({ kind: "enroll", context });
      },
      terminal(context) { events.push({ kind: "terminal", context }); },
    };
    try {
      const result = await runOpenCode({
        opencodeBin: process.execPath,
        cwd,
        args: ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8'))`],
        timeoutMs: 5_000,
        flight: { hook, context: flightContext(cwd) },
      });
      expect(result).toEqual({ ok: true, stdout: "enrolled" });
      expect(events.map((event) => event.kind)).toEqual(["admit", "enroll", "terminal"]);
      expect(events[1]?.context).toMatchObject({
        provider: "opencode",
        cwd,
        governance: { campaign_id: "campaign-1", node_id: "node-1", task_id: "task-1", write_paths: ["packages/arbor-mcp/src/flight.ts"] },
        pid: expect.any(Number),
      });
      expect(events[2]?.context).toMatchObject({ pid: recordedPid(events[1]?.context), code: 0, signal: null });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed on admission refusal before spawning an OpenCode child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "repo-flight-opencode-refusal-"));
    const marker = join(cwd, "provider-ran");
    const hook: RepoFlightProviderLifecycleHook = { admit: () => ({ admitted: false, reason: "drain is holding the lane" }) };
    try {
      const result = await runOpenCode({
        opencodeBin: process.execPath,
        cwd,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
        flight: { hook, context: flightContext(cwd) },
      });
      expect(result).toMatchObject({ ok: false, error: "OpenCode flight admission refused: drain is holding the lane" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when PID enrollment rejects, without allowing the provider to execute", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "repo-flight-opencode-enrollment-"));
    const marker = join(cwd, "provider-ran");
    const hook: RepoFlightProviderLifecycleHook = {
      admit: () => ({ admitted: true }),
      enroll_child: () => { throw new Error("identity enrollment rejected"); },
    };
    try {
      const result = await runOpenCode({
        opencodeBin: process.execPath,
        cwd,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
        flight: { hook, context: flightContext(cwd) },
      });
      expect(result).toMatchObject({ ok: false, error: "OpenCode flight enrollment refused: identity enrollment rejected" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds campaign node, declared authority, worktree cwd, and provider PID on the real campaign specialist path", async () => {
    const admissions: unknown[] = [];
    const enrollments: unknown[] = [];
    const terminals: unknown[] = [];
    const hook: RepoFlightProviderLifecycleHook = {
      admit(context) { admissions.push(context); return { admitted: true }; },
      enroll_child(context) { enrollments.push(context); },
      terminal(context) { terminals.push(context); },
    };
    const integration = createOpenCodeCampaignIntegration({
      repo_flight_hook: hook,
      executor_options: { opencodeBin: fixture, specialistModel: "provider/model", timeoutMs: 5_000 },
    });
    const cwd = process.cwd();
    const executor = integration.createExecutor({
      runtime: { nativeSessionRegistry: null, harnessSessions: null, recordSessionCompletionUx() {} } as never,
      adapter: { pushDevtoolsLine() {} } as never,
      campaign_id: "campaign-2",
      cwd,
      connector: {} as never,
    });
    const result = await executor.specialize({
      campaign_id: "campaign-2",
      node_id: "node-2",
      action: {
        description: "change",
        estimated_gain: 1,
        estimated_cost: 1,
        category: "code",
        delegate_to: "seed",
        high_risk_tool_scope: { write_paths: ["packages/arbor-mcp/src/flight.ts"], command_argv: [["bun", "test"]] },
      },
      prompt: "change it",
      worktree_path: cwd,
      specialist_agent: "seed",
    });
    expect(result.error).toBeUndefined();
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      provider: "opencode",
      mode: "specialist",
      scope: "read_write",
      cwd,
      governance: {
        campaign_id: "campaign-2",
        node_id: "node-2",
        task_id: "node-2",
        write_paths: ["packages/arbor-mcp/src/flight.ts"],
        command_argv: [["bun", "test"]],
      },
    });
    expect(enrollments[0]).toMatchObject({ pid: expect.any(Number), cwd });
    expect(terminals[0]).toMatchObject({ pid: recordedPid(enrollments[0]), code: 0, signal: null });
  });
});
