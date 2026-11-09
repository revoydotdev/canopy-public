import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_HARNESS_CONNECTOR_ID, createCodexCampaignIntegration, createCodexCodeRunner, createCodexHarnessConnectorDescriptor, createCodexTaskPlanner } from "../src/integrations/codex-campaign.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticPort } from "../src/native-critic-transport.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "arbor-codex-fixture-"));
  directories.push(directory);
  const script = join(directory, "codex-fixture.mjs");
  writeFileSync(script, body, { mode: 0o700 });
  return { directory, codex_bin: process.execPath, codex_args: [script, "--"] };
}

function call(overrides: Partial<{ signal: AbortSignal; mode: "specialist" | "read_only" | "planner" | "critic"; prompt: string }> = {}) {
  return { cwd: process.cwd(), prompt: "return structured result", model: "gpt-fixture", mode: "specialist" as const, ...overrides };
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`fixture readiness file did not appear: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Codex CLI campaign integration", () => {
  it("uses documented argv-only JSONL exec, observes session/usage, and declares the Codex connector", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const observed = { argv: process.argv.slice(2), secret: process.env.UNRELATED_SECRET ?? null, prompt: fs.readFileSync(0, "utf8") };
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-codex-1" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 5, cached_input_tokens: 1, cache_write_input_tokens: 0 } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(observed) } }) + "\\n");
    `);
    process.env.UNRELATED_SECRET = "must-not-cross";
    try {
      const result = await createCodexCodeRunner(bin)(call());
      expect(result).toMatchObject({ ok: true, session_id: "thread-codex-1", usage: { input_tokens: 3, output_tokens: 5, counter_source: "provider_counter" } });
      const observed = JSON.parse((result as Extract<typeof result, { ok: true }>).text);
      expect(observed.argv).toEqual(expect.arrayContaining(["exec", "--json", "--strict-config", "--ignore-user-config", "--ignore-rules", "--approve-for-me", "--model", "gpt-fixture", "-"]));
      expect(observed.argv).not.toContain("--sandbox");
      expect(observed.secret).toBeNull();
      expect(observed.prompt).toContain("return structured result");
      const descriptor = createCodexHarnessConnectorDescriptor("2026-08-22T00:00:00.000Z");
      expect(descriptor.connector_id).toBe(CODEX_HARNESS_CONNECTOR_ID);
      expect(descriptor.connector_id).not.toBe("claude-code-plugin");
    } finally { delete process.env.UNRELATED_SECRET; }
  });

  it("places all exec policy switches before resume and omits an unconfigured model", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-codex-resume" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ argv: process.argv.slice(2), prompt: fs.readFileSync(0, "utf8") }) } }) + "\\n");
    `);
    const result = await createCodexCodeRunner(bin)({ ...call({ mode: "read_only" }), model: "default", session_id: "resume-thread" });
    expect(result).toMatchObject({ ok: true, session_id: "thread-codex-resume" });
    const argv = JSON.parse((result as Extract<typeof result, { ok: true }>).text).argv as string[];
    expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("resume"));
    expect(argv).toContain("read-only");
    expect(argv).not.toContain("--approve-for-me");
    expect(argv).not.toContain("--model");
    expect(argv.slice(argv.indexOf("resume"))).toEqual(["resume", "resume-thread", "-"]);
  });

  it("rejects malformed JSONL and nonzero exits without a Claude/OpenCode fallback", async () => {
    const malformed = await createCodexCodeRunner(fixture(`process.stdout.write("not-json\\n")`))(call());
    expect(malformed).toMatchObject({ ok: false, error: "Codex emitted malformed JSONL" });
    const nonzero = await createCodexCodeRunner(fixture(`process.stderr.write("real codex failure"); process.exit(7)`))(call());
    expect(nonzero).toMatchObject({ ok: false, error: "Codex exited 7: real codex failure" });
  });

  it("contains an early child exit without surfacing a secondary stdin EPIPE", async () => {
    const bin = fixture(`
      process.stderr.write("argument policy rejected\\n");
      process.exit(2);
    `);
    const result = await createCodexCodeRunner(bin)(call({ prompt: "x".repeat(1_000_000) }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("argument policy rejected") });
    expect(JSON.stringify(result)).not.toContain("EPIPE");
  });

  it("cancels and times out a real child process without retaining it", async () => {
    const blocking = fixture(`setInterval(() => {}, 1000)`);
    const timedOut = await createCodexCodeRunner({ ...blocking, timeout_ms: 20 })(call());
    expect(timedOut).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
    const controller = new AbortController();
    const pending = createCodexCodeRunner({ ...blocking, timeout_ms: 5_000 })(call({ signal: controller.signal }));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: "Codex execution was cancelled" });
  });

  it("fails closed before spawn on flight admission refusal, including a read-only planner scope", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "started"), "unexpected");
    `);
    const admissions: unknown[] = [];
    const result = await createCodexCodeRunner({
      ...bin,
      repo_flight_hook: { admit: (context) => { admissions.push(context); return { admitted: false, reason: "flight is holding this lane" }; } },
    })(call({ mode: "planner" }));
    expect(result).toMatchObject({ ok: false, error: "Codex flight admission refused: flight is holding this lane" });
    expect(admissions).toEqual([expect.objectContaining({ provider: "codex", mode: "planner", scope: "read_only" })]);
    expect(existsSync(join(bin.directory, "started"))).toBe(false);
  });

  it("enrolls the actual child PID before writing the prompt and reports its terminal exit", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      let prompt = "";
      process.stdin.on("data", (chunk) => { prompt += chunk; });
      process.stdin.on("end", () => {
        fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "prompt"), prompt);
        process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "complete" } }) + "\\n");
      });
    `);
    const events: Array<Record<string, unknown>> = [];
    const promptFile = join(bin.directory, "prompt");
    const result = await createCodexCodeRunner({
        ...bin,
        repo_flight_hook: {
          enroll_child: (context) => { events.push({ type: "enroll", ...context }); },
          terminal: (context) => { events.push({ type: "terminal", ...context }); },
        },
      })(call({ prompt: "only-after-pid-enrollment" }));
    expect(result).toMatchObject({ ok: true, text: "complete" });
    expect(events[0]).toMatchObject({ type: "enroll", provider: "codex", scope: "read_write", pid: expect.any(Number), launch_id: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[1]).toMatchObject({ type: "terminal", code: 0, signal: null, pid: events[0]?.pid, launch_id: events[0]?.launch_id });
    expect(readFileSync(promptFile, "utf8")).toContain("only-after-pid-enrollment");
  });

  it("kills a child and withholds its prompt when post-spawn flight enrollment refuses", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      let prompt = "";
      process.stdin.on("data", (chunk) => { prompt += chunk; });
      process.stdin.on("end", () => fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "prompt"), prompt));
      setInterval(() => {}, 1_000);
    `);
    const promptFile = join(bin.directory, "prompt");
    const result = await createCodexCodeRunner({
        ...bin,
        repo_flight_hook: { enroll_child: () => { throw new Error("identity enrollment failed"); } },
      })(call({ prompt: "must-never-reach-provider" }));
    expect(result).toMatchObject({ ok: false, error: "Codex flight enrollment refused: identity enrollment failed" });
    expect(existsSync(promptFile)).toBe(false);
  });

  it("treats terminal hook refusal as failure even when Codex emitted a complete response", async () => {
    const bin = fixture(`
      process.stdin.resume();
      process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "complete" } }) + "\\n"));
    `);
    const result = await createCodexCodeRunner({
      ...bin,
      repo_flight_hook: { terminal: () => { throw new Error("terminal receipt was rejected"); } },
    })(call());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("terminal receipt was rejected") });
  });

  it("escalates a SIGTERM-resistant child to SIGKILL before settling", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "pid"), String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
    `);
    const controller = new AbortController();
    const pending = createCodexCodeRunner({ ...bin, timeout_ms: 5_000 })(call({ signal: controller.signal }));
    const pidFile = join(bin.directory, "pid");
    await waitForFile(pidFile);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: "Codex execution was cancelled" });
    const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("uses the common governed plan/action parser rather than an unregistered fallback", async () => {
    const bin = fixture(`
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-codex-2" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "changed files" } }) + "\\n");
    `);
    const integration = createCodexCampaignIntegration(bin);
    const executor = integration.createExecutor({ runtime: { nativeSessionRegistry: null, harnessSessions: null } as never, adapter: { pushDevtoolsLine: () => {} } as never, campaign_id: "campaign", cwd: process.cwd(), connector: createCodexHarnessConnectorDescriptor() });
    await expect(executor.specialize({ campaign_id: "campaign", node_id: "node", action: { description: "change", category: "code" }, high_risk_tool_scope: ["file.write"], prompt: "change", worktree_path: process.cwd(), specialist_agent: "seed" } as never)).resolves.toMatchObject({ output: "changed files", model_identity: "codex/default" });
  });

  it("binds Codex reviewers to authored acceptance evidence instead of provider-sandbox diagnostics", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "review-prompt"), fs.readFileSync(0, "utf8"));
      const verdict = { approved: true, rationale: "focused machine check passed", root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [{ name: "root_cause", passed: true, detail: "none" }, { name: "measurement_validation", passed: true, detail: "focused check" }, { name: "guardrail_enforcement", passed: true, detail: "held" }, { name: "introspection", passed: true, detail: "bounded" }, { name: "stability_monitoring", passed: true, detail: "authored scope" }] };
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } }) + "\\n");
    `);
    const integration = createCodexCampaignIntegration(bin);
    const reviewer = integration.createReviewer!({ cwd: process.cwd() } as never);
    await expect(reviewer("stability", {
      action_category: "testing",
      high_stakes: false,
      description: "Run the focused soak test",
      specialist_output: "full suite hit spawnSync git EPERM inside provider sandbox",
      verification_note: "independent machine verification passed: bun test scripts/live-provider-soak.test.mjs",
    } as never)).resolves.toMatchObject({ approved: true, model_identity: "codex/default" });
    const prompt = readFileSync(join(bin.directory, "review-prompt"), "utf8");
    expect(prompt).toContain("Provider-sandbox EPERM");
    expect(prompt).toContain("Do not require a repository-wide test command unless that command is explicitly part");
    expect(prompt).toContain("when it is explicitly authored, its failure remains blocking");
  });

  it("repairs one semantically invalid complete plan in the same Codex session", async () => {
    const bin = fixture(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const dir = path.dirname(url.fileURLToPath(import.meta.url));
      const countPath = path.join(dir, "count");
      const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
      fs.writeFileSync(countPath, String(count));
      const prompt = fs.readFileSync(0, "utf8");
      fs.appendFileSync(path.join(dir, "calls"), JSON.stringify({ argv: process.argv.slice(2), prompt }) + "\\n");
      const action = { description: "Implement fixture", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed", constraints: [], execution_role: "implementer", skill_id: null, skill_version: null, high_risk_tool_scope: null, decomposition_depth: null, depends_on: null };
      const proposal = { summary: "Implement fixture", assumptions: [], questions: [], root_action: action, actions: [action], acceptance_checks: ["fixture passes"], acceptance_mapping: count === 1 ? [] : [{ criterion: "fixture passes", action_descriptions: ["Implement fixture"] }], risk_notes: [] };
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-codex-plan" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(proposal) } }) + "\\n");
    `);
    const planner = createCodexTaskPlanner({ ...bin, cwd: process.cwd(), planning_prompt: (input) => `plan:${input.task}` });
    const result = await planner.plan({ draft_id: "draft-codex", task: "Implement fixture", answers: {}, parent_campaign_id: null, evidence_ids: [] });
    expect(result).toMatchObject({ model_identity: "codex/default", session_id: "thread-codex-plan" });
    expect(JSON.parse(result.raw_proposal).acceptance_mapping).toEqual([{ criterion: "fixture passes", action_descriptions: ["Implement fixture"] }]);
    expect(JSON.parse(result.raw_proposal).actions[0].execution_role).toBeUndefined();
    const calls = readFileSync(join(bin.directory, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).toContain("thread-codex-plan");
    expect(calls[1].prompt).toContain("Validator feedback:");
  });

  it("PERF: threads options.native_critic into the shared claude-code-campaign critic fast path, never invoking the Codex CLI", async () => {
    const savedTransport = process.env[ARBOR_CRITIC_TRANSPORT_ENV];
    process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
    try {
      const bin = fixture(`
        const fs = await import("node:fs");
        const path = await import("node:path");
        const url = await import("node:url");
        fs.writeFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "cli-invoked"), "1");
        process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "should never be reached" } }) + "\\n");
      `);
      const native_critic: NativeCriticPort = {
        ready: true,
        model_id: "gpt-fixture",
        async call() {
          const verdict = { approved: true, rationale: "native approved", root_cause: null, measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [{ name: "root_cause", passed: true, detail: "none" }, { name: "measurement_validation", passed: true, detail: "ok" }, { name: "guardrail_enforcement", passed: true, detail: "ok" }, { name: "introspection", passed: true, detail: "ok" }, { name: "stability_monitoring", passed: true, detail: "ok" }] };
          return { ok: true, text: JSON.stringify(verdict), usage: { kind: "unavailable" as const, reason: "fixture" } };
        },
      };
      const integration = createCodexCampaignIntegration({ ...bin, native_critic });
      const reviewer = integration.createReviewer!({ cwd: process.cwd() } as never);
      await expect(reviewer("stability", { action_category: "testing", high_stakes: false, description: "probe" } as never))
        .resolves.toMatchObject({ approved: true, model_identity: "native/gpt-fixture" });
      expect(existsSync(join(bin.directory, "cli-invoked"))).toBe(false);
    } finally {
      if (savedTransport === undefined) delete process.env[ARBOR_CRITIC_TRANSPORT_ENV];
      else process.env[ARBOR_CRITIC_TRANSPORT_ENV] = savedTransport;
    }
  });
});
