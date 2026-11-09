import { NATIVE_CRITIC_MALFORMED_VERDICT } from "../src/native-critic-contract.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "@arbor/core";
import type { RuntimePortAdapter } from "../src/tui-adapter.js";
import {
  buildOpenCodeArgs,
  parseCriticVerdict,
  stripAnsi,
  classifyOpenCodeError,
  resolveConfiguredModel,
  createOpenCodeLoopExecutor,
  createOpenCodePanelReviewer,
  DEFAULT_SPECIALIST_MODEL,
  DEFAULT_CRITIC_MODEL,
  runOpenCode,
  runStagedVerification,
} from "../src/opencode-executor.js";
import { ARBOR_CRITIC_TRANSPORT_ENV, type NativeCriticCallResult, type NativeCriticPort } from "../src/native-critic-transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_OPENCODE_BIN = join(__dirname, "fixtures/fake-opencode.mjs");
const FULL_APPROVED = { approved: true, rationale: "looks good", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [
  { name: "root_cause", passed: true, detail: "explicit" }, { name: "measurement_validation", passed: true, detail: "clean" },
  { name: "guardrail_enforcement", passed: true, detail: "in scope" }, { name: "introspection", passed: true, detail: "consistent" },
  { name: "stability_monitoring", passed: true, detail: "stable" },
] };

describe("buildOpenCodeArgs", () => {
  it("builds the opencode run invocation with model + prompt file + instruction", () => {
    const args = buildOpenCodeArgs({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      worktree: "/tmp/wt",
      promptFile: "/tmp/prompt.txt",
      instruction: "Do the task",
      opencodeBin: "opencode",
    });
    expect(args).toEqual([
      "run", "-m", "openrouter/deepseek/deepseek-v4-flash-0731",
      "--dir", "/tmp/wt", "-f", "/tmp/prompt.txt", "--", "Do the task",
    ]);
  });

  it("omits --dir when no worktree is provided", () => {
    const args = buildOpenCodeArgs({
      model: "zai-coding-plan/glm-5.2",
      worktree: undefined,
      promptFile: "/tmp/p.txt",
      instruction: "Review",
      opencodeBin: "opencode",
    });
    expect(args).toContain("-f");
    expect(args).not.toContain("--dir");
  });

  it("includes --agent when provided", () => {
    const args = buildOpenCodeArgs({
      model: "m",
      worktree: undefined,
      promptFile: "/tmp/p.txt",
      instruction: "x",
      opencodeBin: "opencode",
      agent: "seed",
    });
    expect(args).toContain("--agent");
    expect(args).toContain("seed");
  });

  it("includes --auto when auto is true (worktree-backed specialist)", () => {
    const args = buildOpenCodeArgs({
      model: "m",
      worktree: "/tmp/wt",
      promptFile: "/tmp/p.txt",
      instruction: "edit files",
      opencodeBin: "opencode",
      auto: true,
    });
    expect(args).toContain("--auto");
    expect(args).toContain("--dir");
    expect(args).toContain("/tmp/wt");
  });

  it("omits --auto when auto is undefined (non-mutating analysis)", () => {
    const args = buildOpenCodeArgs({
      model: "m",
      worktree: undefined,
      promptFile: "/tmp/p.txt",
      instruction: "analyze",
      opencodeBin: "opencode",
    });
    expect(args).not.toContain("--auto");
  });

  it("supports plugin-isolated planning without granting mutation authority", () => {
    const args = buildOpenCodeArgs({
      model: "openrouter/~deepseek/deepseek-v4-flash-latest",
      worktree: undefined,
      promptFile: "/tmp/p.txt",
      instruction: "plan",
      opencodeBin: "opencode",
      pure: true,
      format: "json",
    });
    expect(args).toContain("--pure");
    expect(args).toEqual(expect.arrayContaining(["--format", "json"]));
    expect(args).not.toContain("--auto");
    expect(args).not.toContain("--dir");
  });
});

describe("parseCriticVerdict", () => {
  it("parses a clean JSON verdict", () => {
    const v = parseCriticVerdict(JSON.stringify(FULL_APPROVED));
    expect(v).toMatchObject({ kind: "verdict", verdict: { ...FULL_APPROVED, critic: "lenticel" } });
  });

  it("parses a rejection with root_cause", () => {
    const v = parseCriticVerdict(JSON.stringify({ ...FULL_APPROVED, approved: false, rationale: "blocker", root_cause: "flaky", introspection_passed: false }));
    expect(v).toMatchObject({ kind: "verdict", verdict: { approved: false, rationale: "blocker", root_cause: "flaky" } });
  });

  it("tolerates ANSI + surrounding prose", () => {
    const v = parseCriticVerdict(`\u001b[0m\u001b[32mHere:\n${JSON.stringify({ ...FULL_APPROVED, rationale: "ok" })}\u001b[0m`);
    expect(v).toMatchObject({ kind: "verdict", verdict: { approved: true, rationale: "ok" } });
  });

  // G-15: an unparseable response is a typed absence of evidence, never null
  // laundered into approval — it carries a content hash so the failure is
  // still anchored to real evidence.
  it("returns a typed unparseable result (never null, never approval) for non-JSON / missing fields", () => {
    expect(parseCriticVerdict("approved true")).toMatchObject({ kind: "unparseable" });
    expect(parseCriticVerdict('{"approved":"yes"}')).toMatchObject({ kind: "unparseable" });
    expect(parseCriticVerdict("")).toMatchObject({ kind: "unparseable" });
    const v = parseCriticVerdict("not json");
    expect(v.kind).toBe("unparseable");
    if (v.kind === "unparseable") expect(v.raw_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // ADR-184: template text in a well-shaped verdict is malformed output, never a review outcome.
  it("classifies a placeholder rationale, root_cause or check detail as malformed, naming the field", () => {
    const rationale = parseCriticVerdict(JSON.stringify({ ...FULL_APPROVED, rationale: "<rationale>" }));
    expect(rationale).toMatchObject({ kind: "malformed", field: "rationale" });
    if (rationale.kind === "malformed") expect(rationale.raw_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const rootCause = parseCriticVerdict(JSON.stringify({ ...FULL_APPROVED, approved: false, rationale: "blocker", root_cause: "required non-empty on rejection", introspection_passed: false }));
    expect(rootCause).toMatchObject({ kind: "malformed", field: "root_cause" });
    const detail = parseCriticVerdict(JSON.stringify({ ...FULL_APPROVED, checks: FULL_APPROVED.checks.map((c, i) => (i === 0 ? { ...c, detail: "TBD" } : c)) }));
    expect(detail).toMatchObject({ kind: "malformed", field: `checks[${FULL_APPROVED.checks[0]!.name}].detail` });
  });

  it("does not mistake a short genuine finding for a template", () => {
    expect(parseCriticVerdict(JSON.stringify({ ...FULL_APPROVED, rationale: "not applicable: docs only" }))).toMatchObject({ kind: "verdict" });
  });
});

describe("stripAnsi", () => {
  it("removes ANSI color sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
});

describe("runOpenCode configuration isolation", () => {
  it("gives the child a temporary config directory and removes it after exit", async () => {
    const result = await runOpenCode({
      opencodeBin: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OPENCODE_CONFIG_DIR || '')"],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdout).toContain("arbor-opencode-config-");
    expect(existsSync(result.stdout)).toBe(false);
  });
});

// D4 (ADR-087 dogfood, 2026-08-24): `--verification-cmd` becomes repeatable
// -- each occurrence is one ordered, fail-fast stage, threaded to
// `runStagedVerification` (the same ordered/fail-fast/per-stage-budget
// semantics as `WorktreeMachineVerifier.runPlan`, adapted to the plain
// shell-string contract `--verification-cmd` already has). A single-entry
// list must reproduce the pre-D4 single-command call exactly.
describe("runStagedVerification (D4 staged --verification-cmd)", () => {
  it("a single stage behaves exactly like the pre-D4 single-command call: ok on exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-staged-verify-"));
    try {
      const result = await runStagedVerification(["true"], dir, 5_000);
      expect(result.ok).toBe(true);
      expect(result.combinedCmd).toBe("true");
      expect(result.stageResults).toHaveLength(1);
      expect(result.stageResults[0]).toMatchObject({ display: "true", exit: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs multiple stages in order and stops at the first failure (fail-fast)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-staged-verify-"));
    const marker = join(dir, "stage1-ran");
    try {
      const result = await runStagedVerification(
        [`node -e "require('fs').writeFileSync('${marker}', '1')"`, "false", "node -e \"process.exit(0)\""],
        dir,
        5_000,
      );
      expect(result.ok).toBe(false);
      // Stage 1 ran (proof of ordering), stage 2 failed, stage 3 never attempted.
      expect(existsSync(marker)).toBe(true);
      expect(result.stageResults).toHaveLength(2);
      expect(result.stageResults[0].exit).toBe(0);
      expect(result.stageResults[1].exit).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all stages passing yields ok:true with every stage recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-staged-verify-"));
    try {
      const result = await runStagedVerification(["true", "true", "true"], dir, 5_000);
      expect(result.ok).toBe(true);
      expect(result.stageResults).toHaveLength(3);
      expect(result.stageResults.every((s) => s.exit === 0)).toBe(true);
      expect(result.combinedCmd).toBe("true && true && true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// G-08: `runOpenCode`'s failure strings are the only signal the subprocess
// transport ever gets — before this, every one of them collapsed into
// `[opencode error] ...` text with no typed classification. These assert the
// closed `NodeError` union is genuinely constructed, not just declared.
describe("classifyOpenCodeError", () => {
  it("classifies a timeout", () => {
    const err = classifyOpenCodeError("opencode run timed out after 120000ms", false);
    expect(err).toMatchObject({ kind: "timeout" });
  });

  it("classifies a spawn failure as an unrecoverable internal_error", () => {
    const err = classifyOpenCodeError("opencode spawn failed: ENOENT", false);
    expect(err).toMatchObject({ kind: "internal_error", recoverable: false });
  });

  it("classifies a rate-limited non-zero exit as quota_exceeded", () => {
    const err = classifyOpenCodeError("opencode run exited 1: 429 Too Many Requests: rate limit exceeded", false);
    expect(err).toMatchObject({ kind: "quota_exceeded" });
  });

  it("classifies a network-shaped non-zero exit as a recoverable transport_error", () => {
    const err = classifyOpenCodeError("opencode run exited 1: connect ECONNREFUSED 127.0.0.1:443", false);
    expect(err).toMatchObject({ kind: "transport_error", recoverable: true });
  });

  it("classifies an unrecognized non-zero exit as internal_error", () => {
    const err = classifyOpenCodeError("opencode run exited 2: unexpected panic", false);
    expect(err).toMatchObject({ kind: "internal_error" });
  });

  it("returns undefined for a genuine external cancellation — never fabricates an operational error over a real abort", () => {
    expect(classifyOpenCodeError("opencode run aborted", true)).toBeUndefined();
    expect(classifyOpenCodeError("opencode run aborted", false)).toBeUndefined();
  });

  it("carries the real message and a claimed provenance, never a placeholder", () => {
    const err = classifyOpenCodeError("opencode run timed out after 5000ms", false);
    expect(err).toMatchObject({ message: "opencode run timed out after 5000ms", provenance: { tag: "claimed", claimant: "opencode-executor" } });
  });
});

describe("model defaults", () => {
  it("specialist defaults to an openrouter deepseek model (reuses OpenRouter key)", () => {
    expect(DEFAULT_SPECIALIST_MODEL.startsWith("openrouter/")).toBe(true);
  });
  it("critic defaults to a stable OpenRouter alias", () => {
    expect(DEFAULT_CRITIC_MODEL).toBe("openrouter/~openai/gpt-mini-latest");
  });
});

describe("G-33 (narrowed, wave 3): resolveConfiguredModel — arbor.jsonc's agents.*.model reaches the executor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arbor-executor-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a real arbor.jsonc override wins over the fallback", () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { seed: { model: "openrouter/configured-model" } } }), "utf8");
    expect(resolveConfiguredModel("seed", dir, DEFAULT_SPECIALIST_MODEL)).toBe("openrouter/configured-model");
  });

  it("the 'auto' sentinel is not treated as a real override", () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { seed: { model: "auto" } } }), "utf8");
    expect(resolveConfiguredModel("seed", dir, DEFAULT_SPECIALIST_MODEL)).toBe(DEFAULT_SPECIALIST_MODEL);
  });

  it("no arbor.jsonc on disk is a no-op — falls back to the given default", () => {
    expect(resolveConfiguredModel("seed", dir, DEFAULT_SPECIALIST_MODEL)).toBe(DEFAULT_SPECIALIST_MODEL);
  });

  it("an override only applies to the agent it names — an untouched agent keeps its default", () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { seed: { model: "openrouter/configured-model" } } }), "utf8");
    expect(resolveConfiguredModel("lenticel", dir, DEFAULT_CRITIC_MODEL)).toBe(DEFAULT_CRITIC_MODEL);
  });
});

describe("G-33 (narrowed, wave 3): createOpenCodeLoopExecutor threads the resolved model into the live dispatch — the actual production campaign runner", () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arbor-executor-live-config-"));
    for (const k of ["FAKE_OPENCODE_STDOUT", "FAKE_OPENCODE_STDERR", "FAKE_OPENCODE_EXIT"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify({ ...FULL_APPROVED, rationale: "ok" });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function capturingAdapter(): { adapter: RuntimePortAdapter; lines: Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = [];
    return {
      lines,
      adapter: {
        pushDevtoolsLine: (line: unknown) => { lines.push(line as Record<string, unknown>); },
      } as unknown as RuntimePortAdapter,
    };
  }

  const rootAction: Action = {
    description: "probe action",
    estimated_gain: 1,
    estimated_cost: 1,
    category: "testing",
    delegate_to: "seed",
  };

  it("specialize(): a real arbor.jsonc agents.<specialist_agent>.model override reaches the actual opencode dispatch (inference_trace.model)", async () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { seed: { model: "openrouter/from-config" } } }), "utf8");
    const { adapter, lines } = capturingAdapter();
    const executor = createOpenCodeLoopExecutor(adapter, () => {}, "c", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      configDir: dir,
    });
    await executor.specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    const trace = lines.find((l) => l.event_kind === "loop.inference_trace");
    expect((trace?.loop_event as Record<string, unknown>)?.model).toBe("openrouter/from-config");
  });

  it("specialize(): without a configured override, the built-in DEFAULT_SPECIALIST_MODEL still governs (no regression)", async () => {
    const { adapter, lines } = capturingAdapter();
    const executor = createOpenCodeLoopExecutor(adapter, () => {}, "c", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      configDir: dir,
    });
    await executor.specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    const trace = lines.find((l) => l.event_kind === "loop.inference_trace");
    expect((trace?.loop_event as Record<string, unknown>)?.model).toBe(DEFAULT_SPECIALIST_MODEL);
  });

  it("specialize(): an explicit options.specialistModel still wins over a real arbor.jsonc override", async () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { seed: { model: "openrouter/from-config" } } }), "utf8");
    const { adapter, lines } = capturingAdapter();
    const executor = createOpenCodeLoopExecutor(adapter, () => {}, "c", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      configDir: dir,
      specialistModel: "openrouter/explicit-flag",
    });
    await executor.specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    const trace = lines.find((l) => l.event_kind === "loop.inference_trace");
    expect((trace?.loop_event as Record<string, unknown>)?.model).toBe("openrouter/explicit-flag");
  });

  it("review(): a real arbor.jsonc agents.lenticel.model override reaches the critic dispatch", async () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { lenticel: { model: "zai-coding-plan/from-config" } } }), "utf8");
    const { adapter, lines } = capturingAdapter();
    const executor = createOpenCodeLoopExecutor(adapter, () => {}, "c", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      configDir: dir,
    });
    await executor.review({
      campaign_id: "c", node_id: "n1", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    const trace = lines.find((l) => l.event_kind === "loop.inference_trace");
    expect((trace?.loop_event as Record<string, unknown>)?.model).toBe("zai-coding-plan/from-config");
  });

  it("panel reviewer: production's shared reviewer dispatches with the configured Lenticel model and fails through the same strict parser", async () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { lenticel: { model: "zai-coding-plan/panel-config" } } }), "utf8");
    const { adapter, lines } = capturingAdapter();
    const reviewer = createOpenCodePanelReviewer(adapter, "c", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      configDir: dir,
    });
    await expect(reviewer("lenticel", {
      action_category: "testing", high_stakes: false, description: "probe action",
    })).resolves.toMatchObject({ approved: true, rationale: "ok" });
    const call = lines.find((line) => line.event_kind === "loop.tool_call");
    expect((call?.loop_event as Record<string, unknown>)?.tool).toBe("opencode.panel_review");
    expect((call?.loop_event as Record<string, unknown>)?.args).toContain("zai-coding-plan/panel-config");
  });

  it("panel reviewer: domain roles use the integration-qualified critic model rather than an abstract catalog hint", async () => {
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ agents: { lenticel: { model: "openrouter/domain-reviewer" } } }), "utf8");
    const { adapter, lines } = capturingAdapter();
    const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir });
    await expect(reviewer("security", { action_category: "security", high_stakes: true, description: "validate input" }))
      .resolves.toMatchObject({ approved: true });
    const call = lines.find((line) => line.event_kind === "loop.tool_call");
    expect((call?.loop_event as Record<string, unknown>)?.args).toContain("openrouter/domain-reviewer");
    expect((call?.loop_event as Record<string, unknown>)?.args).not.toContain("anthropic/claude-opus-4");
  });

  describe("PERF: native critic transport (ARBOR_CRITIC_TRANSPORT=native), mirroring the claude-code connector's critic tests", () => {
    const nativeApproved = { ...FULL_APPROVED, rationale: "native approved" };
    const cliVerdict = { ...FULL_APPROVED, approved: false, rationale: "should never be reached", root_cause: "cli path used" };
    const cliApproved = { approved: false, rationale: "should never be reached", root_cause: "cli path used" };
    const savedTransportEnv: { value?: string } = {};

    beforeEach(() => {
      savedTransportEnv.value = process.env[ARBOR_CRITIC_TRANSPORT_ENV];
      process.env.FAKE_OPENCODE_STDOUT = JSON.stringify(cliVerdict);
    });
    afterEach(() => {
      if (savedTransportEnv.value === undefined) delete process.env[ARBOR_CRITIC_TRANSPORT_ENV];
      else process.env[ARBOR_CRITIC_TRANSPORT_ENV] = savedTransportEnv.value;
    });

    function fakeNativeCritic(result: NativeCriticCallResult, modelId = "gpt-fixture"): NativeCriticPort {
      return { ready: true, model_id: modelId, async call() { return result; } };
    }
    const ctx = { action_category: "testing", high_stakes: false, description: "probe action" };

    it("uses the native transport when the env is set and the port is ready, never invoking the opencode CLI", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const { adapter, lines } = capturingAdapter();
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(nativeApproved), usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } });
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject({ approved: true, rationale: "native approved" });
      const call = lines.find((line) => line.event_kind === "loop.tool_call");
      expect((call?.loop_event as Record<string, unknown>)?.args).toContain("native/gpt-fixture");
    });

    it("does not use the native transport when the env is unset, even if a ready port is injected", async () => {
      const { adapter } = capturingAdapter();
      const native_critic = fakeNativeCritic({ ok: true, text: JSON.stringify(nativeApproved), usage: { kind: "unavailable", reason: "fixture" } });
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject(cliApproved);
    });

    it("falls back to the CLI critic path when the port reports not ready", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const { adapter } = capturingAdapter();
      const notReadyPort: NativeCriticPort = { ready: false, model_id: null, async call() { throw new Error("must not be called"); } };
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic: notReadyPort });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject(cliApproved);
    });

    it("falls back to the CLI critic path when the native call errors, never failing the review", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const { adapter } = capturingAdapter();
      const native_critic = fakeNativeCritic({ ok: false, error: "native transport exploded", usage: { kind: "unavailable", reason: "native transport exploded" } });
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject(cliApproved);
    });

    it("parses the native verdict text through parseCriticVerdict; a malformed response is an unparseable_critic_verdict rejection, not a fallback", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const { adapter } = capturingAdapter();
      const native_critic = fakeNativeCritic({ ok: true, text: "not json at all", usage: { kind: "unavailable", reason: "fixture" } });
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject({ approved: false, root_cause: "unparseable_critic_verdict" });
    });

    it("a template-only native verdict is malformed_critic_verdict carrying an error (parks, not a rejection)", async () => {
      process.env[ARBOR_CRITIC_TRANSPORT_ENV] = "native";
      const { adapter } = capturingAdapter();
      const text = JSON.stringify({ ...FULL_APPROVED, rationale: "placeholder" });
      const native_critic = fakeNativeCritic({ ok: true, text, usage: { kind: "unavailable", reason: "fixture" } });
      const reviewer = createOpenCodePanelReviewer(adapter, "c", { opencodeBin: FAKE_OPENCODE_BIN, timeoutMs: 10_000, configDir: dir, native_critic });
      const result = await reviewer("lenticel", ctx);
      expect(result).toMatchObject({ approved: false, root_cause: NATIVE_CRITIC_MALFORMED_VERDICT, error: { kind: "internal_error", recoverable: false } });
      expect(result.verdict).toBeUndefined();
    });
  });
});

describe("parseCriticVerdict — optional completeness check (bench v4 regression)", () => {
  const base = {
    approved: true, rationale: "solid", measurement_validated: true, guardrails_enforced: true,
    introspection_passed: true, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "ok" },
      { name: "measurement_validation", passed: true, detail: "ok" },
      { name: "guardrail_enforcement", passed: true, detail: "ok" },
      { name: "introspection", passed: true, detail: "ok" },
      { name: "stability_monitoring", passed: true, detail: "ok" },
    ],
  };

  it("accepts a six-check verdict carrying the invited completeness check (gemini complied; the verdict must not be discarded)", () => {
    const withCompleteness = { ...base, checks: [...base.checks, { name: "completeness", passed: true, detail: "all sites addressed" }] };
    const parsed = parseCriticVerdict(JSON.stringify(withCompleteness));
    expect(parsed.kind).toBe("verdict");
    if (parsed.kind === "verdict") expect(parsed.verdict.checks).toHaveLength(6);
  });

  it("still requires all five canonical mandates — completeness cannot substitute for one", () => {
    const missing = { ...base, checks: [...base.checks.slice(0, 4), { name: "completeness", passed: true, detail: "x" }] };
    expect(parseCriticVerdict(JSON.stringify(missing)).kind).toBe("unparseable");
  });

  it("rejects an unknown sixth check name", () => {
    const unknown = { ...base, checks: [...base.checks, { name: "vibes", passed: true, detail: "x" }] };
    expect(parseCriticVerdict(JSON.stringify(unknown)).kind).toBe("unparseable");
  });
});
