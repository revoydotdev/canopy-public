/**
 * 6.6 contract conformance suite (Stage 0,
 * docs/full-harness-ownership-brief.md) — every `LoopExecutor` implementation
 * in this repo must pass the same shared assertions:
 *
 *   1. `token_usage` is either a real `TokenUsage` (non-negative numeric
 *      fields, a real `counter_source`) or a typed `{kind:"unavailable"}`
 *      carrying a non-empty stated reason. Never a hollow zero-token record.
 *   2. A critic verdict either genuinely validated (`measurement_validated
 *      === true`) or fails closed: `approved: false`, never laundered into
 *      approval (G-15). An `unparseable_critic_verdict` root cause must carry
 *      a real sha256 content anchor for the raw response it could not read.
 *   3. `!verified` provenance carries a real `sha256:<64 hex>` `stdout_hash`
 *      — evidence content-addressed, not an unhashed pass/fail boolean.
 *   4. No placeholder text: non-empty output/rationale, and the historical
 *      G-15 "approval-biased fallback" string never reappears.
 *
 * Every implementation that produces a `LoopExecutor` is required to run
 * against this file — the meta-test at the bottom parses `packages/*\/src`
 * with the TypeScript compiler API and fails if a discovered factory isn't
 * registered here (and, symmetrically, if a registered name is no longer
 * discovered at all), so a new implementation shipping without conformance
 * coverage is caught by construction. Discovery recognizes a `function
 * name(...)` declaration (sync or `async`), a `const name = (...) =>` arrow
 * factory (sync or `async`), and a class/object method shorthand `name(...)`
 * — for any of the three whose return type names `LoopExecutor`, whether
 * directly, through `Promise<LoopExecutor>`, or through an intersection type
 * (`LoopExecutor & { close(): Promise<void> }`, the exact shape
 * `createOpenCodeServerLoopExecutor` uses). It is not a full type checker —
 * an adversarially unusual declaration (computed member names, decorators,
 * a re-exported/aliased factory, or a return type that only resolves to
 * `LoopExecutor` after following a local type alias) could still slip past —
 * but parsing the real AST rather than pattern-matching text means it is no
 * longer approximate about the shapes it does claim to handle: no backward
 * paren-balancing, no brittleness about `Promise<T>` vs a bare return type,
 * and — the gap a still-more-recent regex-based version of this scanner
 * provably missed, confirmed by direct test — no blindness to an
 * intersection return type either. See `findLoopExecutorFactoryNamesInText`
 * below and the "registration-gate scanner robustness" suite, which proves
 * each shape against synthetic fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";
import type { Action } from "@arbor/core";
import type { CriticResult, SpecialistResult, LoopExecutor } from "@arbor/opencode";
import { createOpenCodeLoopExecutor } from "../src/opencode-executor.js";
import { createOpenCodeServerLoopExecutor } from "../src/opencode-server-executor.js";
import { createNativeLoopExecutor } from "../src/native-loop-executor.js";
import { createDemoLoopExecutor } from "../src/demo.js";
import type { RuntimePortAdapter, DevtoolsStreamLine } from "../src/tui-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "../../..");
const FAKE_OPENCODE_BIN = join(__dirname, "fixtures/fake-opencode.mjs");

// ============================================================
// SHARED ASSERTION HELPERS — the contract itself.
// ============================================================

function assertTokenUsageContract(usage: SpecialistResult["token_usage"] | CriticResult["token_usage"]): void {
  if ("kind" in usage) {
    expect(usage.kind).toBe("unavailable");
    expect(typeof usage.reason).toBe("string");
    expect(usage.reason.length).toBeGreaterThan(0);
    return;
  }
  expect(typeof usage.input_tokens).toBe("number");
  expect(usage.input_tokens).toBeGreaterThanOrEqual(0);
  expect(typeof usage.output_tokens).toBe("number");
  expect(usage.output_tokens).toBeGreaterThanOrEqual(0);
  expect(typeof usage.cached_input_tokens).toBe("number");
  expect(usage.cached_input_tokens).toBeGreaterThanOrEqual(0);
  expect(typeof usage.cache_write_input_tokens).toBe("number");
  expect(usage.cache_write_input_tokens).toBeGreaterThanOrEqual(0);
  expect(["provider_counter", "character_fallback"]).toContain(usage.counter_source);
}

function assertVerdictContract(result: CriticResult): void {
  expect(typeof result.approved).toBe("boolean");
  expect(typeof result.rationale).toBe("string");
  expect(result.rationale.length).toBeGreaterThan(0);
  // The historical G-15 bug: an unreadable critic response was waved through
  // as approval. That text must never reappear from any implementation.
  expect(result.rationale.toLowerCase()).not.toMatch(/approval-biased fallback/);
  if (result.measurement_validated !== true) {
    // No genuine typed verdict was recovered (parse failure or dispatch
    // failure of any kind) — must fail closed, never approve on absence of
    // evidence.
    expect(result.approved).toBe(false);
  }
  if (result.root_cause === "unparseable_critic_verdict") {
    expect(result.rationale).toMatch(/sha256:[0-9a-f]{64}/);
  }
  assertTokenUsageContract(result.token_usage);
}

function assertVerifiedProvenanceContract(provenance: SpecialistResult["provenance"]): void {
  expect(provenance.tag).toBe("verified");
  if (provenance.tag !== "verified") return;
  expect(typeof provenance.stdout_hash).toBe("string");
  expect(provenance.stdout_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
}

function assertSpecialistResultContract(result: SpecialistResult): void {
  expect(typeof result.output).toBe("string");
  expect(result.output.length).toBeGreaterThan(0);
  expect(["verified", "claimed"]).toContain(result.provenance.tag);
  assertTokenUsageContract(result.token_usage);
}

function fakeAdapter(): RuntimePortAdapter {
  return { pushDevtoolsLine: () => {} } as unknown as RuntimePortAdapter;
}

const rootAction: Action = {
  description: "contract-suite probe action",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "testing",
  delegate_to: "seed",
};

// ============================================================
// IMPLEMENTATION 1 — createOpenCodeLoopExecutor (subprocess transport)
// ============================================================
describe("6.6 contract: createOpenCodeLoopExecutor (subprocess)", () => {
  let worktree: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "arbor-contract-subprocess-"));
    for (const k of ["FAKE_OPENCODE_STDOUT", "FAKE_OPENCODE_STDERR", "FAKE_OPENCODE_EXIT"]) {
      savedEnv[k] = process.env[k];
    }
  });
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function executor(verificationCmd?: string): LoopExecutor {
    return createOpenCodeLoopExecutor(fakeAdapter(), () => {}, "contract-campaign", {
      opencodeBin: FAKE_OPENCODE_BIN,
      timeoutMs: 10_000,
      verificationCmd,
    });
  }

  it("specialize(): token usage is a typed 'unavailable' — the subprocess boundary cannot recover provider usage from stdout", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "Did the thing.";
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect("kind" in result.token_usage).toBe(true);
  });

  it("specialize(): !verified provenance carries a real content-hashed stdout_hash", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "Edited the file.";
    const result = await executor("node -e \"process.stdout.write('verification ran'); process.exit(0)\"").specialize({
      campaign_id: "c", node_id: "n2", action: rootAction, prompt: "do it",
      worktree_path: worktree, specialist_agent: "seed",
    });
    assertVerifiedProvenanceContract(result.provenance);
  });

  it("review(): a clean JSON verdict is typed, not approval-biased", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify({ approved: true, rationale: "gates passed", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [{ name: "root_cause", passed: true, detail: "explicit" }, { name: "measurement_validation", passed: true, detail: "clean" }, { name: "guardrail_enforcement", passed: true, detail: "in scope" }, { name: "introspection", passed: true, detail: "consistent" }, { name: "stability_monitoring", passed: true, detail: "stable" }] });
    const result = await executor().review({
      campaign_id: "c", node_id: "n3", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(true);
    expect(result.measurement_validated).toBe(true);
  });

  it("review(): an unparseable response fails closed with a real content anchor (G-15)", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "not json at all";
    const result = await executor().review({
      campaign_id: "c", node_id: "n4", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(false);
    expect(result.root_cause).toBe("unparseable_critic_verdict");
  });
});

// ============================================================
// IMPLEMENTATION 2 — createOpenCodeServerLoopExecutor (structured transport)
// ============================================================
describe("6.6 contract: createOpenCodeServerLoopExecutor (structured serve transport)", () => {
  let worktree: string;
  let nextSessionStatus = 200;
  let nextMessage: { status: number; body: unknown } = { status: 200, body: null };

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "arbor-contract-server-"));
    nextSessionStatus = 200;
    nextMessage = { status: 200, body: null };
  });
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  const fakeFetch: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/session") && !u.includes("/message") && init?.method === "POST") {
      if (nextSessionStatus !== 200) {
        return new Response("session create failed", { status: nextSessionStatus });
      }
      return new Response(JSON.stringify({ id: "ses_contract_test" }), { status: 200 });
    }
    if (u.includes("/message")) {
      return new Response(nextMessage.body === null ? "server error" : JSON.stringify(nextMessage.body), {
        status: nextMessage.status,
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  function executor(verificationCmd?: string): LoopExecutor {
    return createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "contract-campaign", {
      baseUrl: "http://fake-opencode-serve.invalid",
      fetchImpl: fakeFetch,
      timeoutMs: 10_000,
      verificationCmd,
    });
  }

  it("specialize(): real tokens on the wire become a real TokenUsage, not 'unavailable'", async () => {
    nextMessage = {
      status: 200,
      body: {
        info: { tokens: { input: 120, output: 45, reasoning: 5, cache: { read: 10, write: 0 } }, cost: 0 },
        parts: [{ type: "text", text: "Did the thing." }],
      },
    };
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect("kind" in result.token_usage).toBe(false);
    if (!("kind" in result.token_usage)) {
      expect(result.token_usage.input_tokens).toBe(120);
      // reasoning tokens fold into output_tokens (TokenUsage has no separate slot).
      expect(result.token_usage.output_tokens).toBe(50);
      expect(result.token_usage.cached_input_tokens).toBe(10);
      expect(result.token_usage.counter_source).toBe("provider_counter");
    }
  });

  it("specialize(): a session-create failure is a typed 'unavailable', never a hollow zero-token record", async () => {
    nextSessionStatus = 500;
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n2", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect("kind" in result.token_usage).toBe(true);
  });

  /**
   * G-36: `review()`'s own session-creation-failure branch
   * (`opencode-server-executor.ts`, the `!sessionRes.ok` arm inside `review`).
   * `specialize()`'s equivalent is covered above; `review()`'s never was —
   * before or after G-09's four-gap closure, which did not name it. The two
   * arms return different shapes (a CriticResult, not a SpecialistResult), so
   * covering one says nothing about the other.
   */
  it("review(): a session-create failure fails closed — never an approval, and never a hollow zero-token record", async () => {
    nextSessionStatus = 500;
    const result = await executor().review({
      campaign_id: "c", node_id: "n-review-session", action: rootAction, prompt: "review it",
      worktree_path: "", specialist_agent: "seed", critic_agent: "lenticel",
      specialist_result: { summary: "did the thing" },
    } as never);

    // Fails closed. G-15 established that an unusable critic response must
    // never be laundered into approval "to keep the demo advancing".
    expect(result.approved).toBe(false);
    expect(result.critic_agent).toBe("lenticel");
    expect(result.measurement_validated).toBe(false);
    expect(result.rationale).toMatch(/session creation failed/i);
    // A typed absence, not a fabricated zero-token reading.
    expect("kind" in result.token_usage).toBe(true);
  });

  it("specialize(): !verified provenance carries a real content-hashed stdout_hash", async () => {
    nextMessage = {
      status: 200,
      body: {
        info: { tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        parts: [{ type: "text", text: "Edited the file." }],
      },
    };
    const result = await executor("node -e \"process.stdout.write('verification ran'); process.exit(0)\"").specialize({
      campaign_id: "c", node_id: "n3", action: rootAction, prompt: "do it",
      worktree_path: worktree, specialist_agent: "seed",
    });
    assertVerifiedProvenanceContract(result.provenance);
  });

  it("review(): a server-validated structured verdict is typed, not approval-biased", async () => {
    nextMessage = {
      status: 200,
      body: {
        info: {
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          structured: { approved: true, rationale: "gates passed", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [{ name: "root_cause", passed: true, detail: "explicit" }, { name: "measurement_validation", passed: true, detail: "clean" }, { name: "guardrail_enforcement", passed: true, detail: "in scope" }, { name: "introspection", passed: true, detail: "consistent" }, { name: "stability_monitoring", passed: true, detail: "stable" }] },
        },
        parts: [],
      },
    };
    const result = await executor().review({
      campaign_id: "c", node_id: "n4", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(true);
    expect(result.measurement_validated).toBe(true);
    expect("kind" in result.token_usage).toBe(false);
  });

  it("review(): a missing/invalid structured field fails closed with a real content anchor (G-15) — rare by construction, still handled", async () => {
    nextMessage = {
      status: 200,
      body: {
        info: { tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        parts: [{ type: "text", text: "garbage, no structured field" }],
      },
    };
    const result = await executor().review({
      campaign_id: "c", node_id: "n5", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(false);
    expect(result.root_cause).toBe("unparseable_critic_verdict");
  });

  it("review(): a transport failure fails closed, never approves on absence of evidence", async () => {
    nextMessage = { status: 500, body: {} };
    const result = await executor().review({
      campaign_id: "c", node_id: "n6", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(false);
    expect(result.measurement_validated).toBe(false);
  });

  // G-09: message-send failure specific to specialize() — session creation
  // succeeds, but the /session/{id}/message POST itself fails. review()'s
  // equivalent shape is exercised above ("a transport failure fails closed");
  // specialize() runs different code after the failed dispatch (no worktree
  // diff, a different noUsage reason, a different error surface on
  // `output`), so it needs its own case rather than inheriting review()'s.
  it("specialize(): a message-send failure (session already created) is a typed 'unavailable', not a hollow zero-token record", async () => {
    nextSessionStatus = 200;
    nextMessage = { status: 503, body: {} };
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n7", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect(result.output).toMatch(/^\[opencode-server error\] HTTP 503/);
    expect("kind" in result.token_usage).toBe(true);
    if ("kind" in result.token_usage) {
      expect(result.token_usage.reason).toMatch(/dispatch failed/);
    }
    expect(result.error).toMatchObject({ kind: "transport_error", recoverable: true });
  });

  // G-09: "ok response with no tokens field" — the server answered 200 with
  // real text but `info.tokens` is absent (a genuine shape opencode can
  // return, not merely a malformed one). Must stay a typed 'unavailable',
  // never a fabricated zero-token TokenUsage.
  it("specialize(): an ok response with no tokens field is a typed 'unavailable', not a fabricated zero-token record", async () => {
    nextMessage = {
      status: 200,
      body: {
        info: {},
        parts: [{ type: "text", text: "Did the thing, but the server omitted usage." }],
      },
    };
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n8", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect(result.output).toBe("Did the thing, but the server omitted usage.");
    expect("kind" in result.token_usage).toBe(true);
    if ("kind" in result.token_usage) {
      expect(result.token_usage.reason).toBe("opencode-server-executor: server response carried no tokens field");
    }
  });

  // G-09: success-path worktree-diff branch (`hasWorktree && diff.ok`) — a
  // real git worktree with a real uncommitted change, so `captureWorktreeDiff`
  // returns genuine diff content and the executor pushes a "loop.diff"
  // devtools line. The other server-transport tests pass a worktree_path
  // too, but none of them inspect the pushed devtools lines, so this branch
  // was reached incidentally at best and never actually asserted on.
  it("specialize(): a real worktree diff is captured and pushed on the success path (hasWorktree && diff.ok)", async () => {
    const gitWorktree = mkdtempSync(join(tmpdir(), "arbor-contract-server-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: gitWorktree });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitWorktree });
      execFileSync("git", ["config", "user.name", "test"], { cwd: gitWorktree });
      writeFileSync(join(gitWorktree, "file.txt"), "original\n");
      execFileSync("git", ["add", "file.txt"], { cwd: gitWorktree });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitWorktree });
      writeFileSync(join(gitWorktree, "file.txt"), "original\nmodified\n");

      nextMessage = {
        status: 200,
        body: {
          info: { tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
          parts: [{ type: "text", text: "Edited the file." }],
        },
      };

      const pushedLines: DevtoolsStreamLine[] = [];
      const recordingAdapter = { pushDevtoolsLine: (line: DevtoolsStreamLine) => { pushedLines.push(line); } } as unknown as RuntimePortAdapter;
      const exec = createOpenCodeServerLoopExecutor(recordingAdapter, () => {}, "contract-campaign", {
        baseUrl: "http://fake-opencode-serve.invalid",
        fetchImpl: fakeFetch,
        timeoutMs: 10_000,
      });

      await exec.specialize({
        campaign_id: "c", node_id: "n-diff", action: rootAction, prompt: "do it",
        worktree_path: gitWorktree, specialist_agent: "seed",
      });

      const diffLine = pushedLines.find((l) => l.event_kind === "loop.diff");
      expect(diffLine).toBeDefined();
      const loopEvent = diffLine?.loop_event;
      expect(typeof loopEvent === "object" && loopEvent !== null && (loopEvent as { type?: unknown }).type).toBe("diff");
      const diffEvent = loopEvent as { path: string; additions: number; deletions: number; diff: string };
      expect(diffEvent.path).toContain("file.txt");
      expect(diffEvent.additions).toBeGreaterThan(0);
      expect(diffEvent.diff).toContain("modified");
    } finally {
      rmSync(gitWorktree, { recursive: true, force: true });
    }
  });
});

// ============================================================
// IMPLEMENTATION 2b — createOpenCodeServerLoopExecutor's getServer()-throws
// paths. These need a real (failing) `opencode serve` spawn rather than the
// `baseUrl`-injected fake HTTP transport above, so they live in their own
// block against the same hermetic `FAKE_OPENCODE_BIN` fixture the subprocess
// suite (IMPLEMENTATION 1) already uses: no network, a local child process
// that exits immediately without ever printing "opencode server listening
// on ...", which makes `spawnServer()` reject for real.
// ============================================================
describe("6.6 contract: createOpenCodeServerLoopExecutor — getServer() real-spawn failure paths (G-09)", () => {
  function failingSpawnExecutor(): LoopExecutor {
    return createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "contract-campaign", {
      opencodeBin: FAKE_OPENCODE_BIN,
      startupTimeoutMs: 5_000,
      timeoutMs: 10_000,
    });
  }

  it("specialize(): getServer() throwing (server exits before reporting listening) fails closed before any message is sent", async () => {
    const result = await failingSpawnExecutor().specialize({
      campaign_id: "c", node_id: "n-spawn-1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect(result.output).toMatch(/^\[opencode-server error\]/);
    expect(result.provenance.tag).toBe("claimed");
    expect("kind" in result.token_usage).toBe(true);
    if ("kind" in result.token_usage) {
      expect(result.token_usage.reason).toBe("opencode-server-executor: server failed to start; no message was ever sent");
    }
    expect(result.error).toMatchObject({ kind: "internal_error" });
  }, 10_000);

  it("review(): getServer() throwing fails closed before any message is sent, never approving on absence of evidence", async () => {
    const result = await failingSpawnExecutor().review({
      campaign_id: "c", node_id: "n-spawn-2", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
    expect(result.approved).toBe(false);
    expect(result.measurement_validated).toBe(false);
    expect(result.rationale).toMatch(/before any message was sent/);
    expect(result.root_cause).toBe("internal_error");
  }, 10_000);
});

// ============================================================
// IMPLEMENTATION 3 — createDemoLoopExecutor (deterministic, no network)
// ============================================================
describe("6.6 contract: createDemoLoopExecutor (deterministic demo double)", () => {
  function executor(): LoopExecutor {
    return createDemoLoopExecutor(fakeAdapter(), () => {}, "contract-campaign", 7);
  }

  it("specialize(): token usage is always a typed 'unavailable' — scripted, no provider was ever called", async () => {
    const result = await executor().specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    assertSpecialistResultContract(result);
    expect("kind" in result.token_usage).toBe(true);
  });

  it("review(): the synthetic verdict is always typed — nothing is ever text-parsed, so G-15 cannot apply", async () => {
    const result = await executor().review({
      campaign_id: "c", node_id: "n2", action: rootAction,
      specialist_output: "output", specialist_agent: "seed",
      prompt: "review it", critic_agent: "lenticel",
    });
    assertVerdictContract(result);
  });

  it("specialize(): provenance is always 'claimed' — a scripted double that never runs a command cannot honestly claim 'verified' (G-22)", async () => {
    // The demo executor never runs a real verification command. It used to
    // claim `verified` provenance for "verifiable" DEMO_PLAN_STEPS with a
    // `stdout_hash` of `sha256:${node_id.slice(0,8)}` — not a hash of
    // anything, and not evidence a command ran. `claimed` is the honest tag
    // for scripted/simulated work; this holds across every DEMO_PLAN_STEPS
    // entry (the executor cycles through all 8 on repeated calls), not just
    // the one probed before this fix.
    const exec = executor();
    for (let i = 0; i < 8; i++) {
      const result = await exec.specialize({
        campaign_id: "c", node_id: `n${i}`, action: rootAction, prompt: "do it",
        worktree_path: "", specialist_agent: "seed",
      });
      expect(result.provenance.tag).toBe("claimed");
    }
  });
});

// ============================================================
// IMPLEMENTATION 4 — revoy-native supervision around a subordinate connector.
// ============================================================

describe("6.6 contract: createNativeLoopExecutor", () => {
  const executor = () => createNativeLoopExecutor({
    downstream: {
      async specialize() {
        return { output: "native-supervised output", provenance: { tag: "claimed", claimant: "fixture" }, token_usage: { kind: "unavailable", reason: "fixture has no provider counter" } };
      },
      async review() {
        return { approved: false, rationale: "fixture lacks a measured verdict", token_usage: { kind: "unavailable", reason: "fixture has no provider counter" } };
      },
    },
  });

  it("preserves a conforming specialist result", async () => {
    const result = await executor().specialize({ campaign_id: "c", node_id: "n", action: rootAction, prompt: "do it", worktree_path: "", specialist_agent: "seed" });
    assertSpecialistResultContract(result);
  });

  it("preserves a fail-closed conforming critic result", async () => {
    const result = await executor().review({ campaign_id: "c", node_id: "n", action: rootAction, specialist_output: "output", specialist_agent: "seed", prompt: "review", critic_agent: "lenticel" });
    assertVerdictContract(result);
  });
});

// ============================================================
// META-TEST — every `LoopExecutor` factory in src/ must be registered above.
// ============================================================

/** Names of the factories exercised by the three `describe` blocks above. */
const REGISTERED_LOOP_EXECUTOR_FACTORIES = [
  "createOpenCodeLoopExecutor",
  "createOpenCodeServerLoopExecutor",
  "createDemoLoopExecutor",
  "createNativeLoopExecutor",
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True if a TypeScript return-type annotation node names `LoopExecutor` —
 * directly, through `Promise<LoopExecutor>`, or as a member of an
 * intersection/union (`LoopExecutor & { close(): Promise<void> }`, the exact
 * shape `createOpenCodeServerLoopExecutor` actually uses in production).
 */
function typeMentionsLoopExecutor(t: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(t)) return typeMentionsLoopExecutor(t.type);
  if (ts.isTypeReferenceNode(t)) {
    const name = ts.isIdentifier(t.typeName) ? t.typeName.text : t.typeName.right.text;
    if (name === "LoopExecutor") return true;
    if (name === "Promise" && t.typeArguments && t.typeArguments.length > 0) {
      return typeMentionsLoopExecutor(t.typeArguments[0]);
    }
    return false;
  }
  if (ts.isIntersectionTypeNode(t) || ts.isUnionTypeNode(t)) {
    return t.types.some(typeMentionsLoopExecutor);
  }
  return false;
}

/**
 * Find every declaration in `text` whose return type names `LoopExecutor`
 * (see `typeMentionsLoopExecutor`): a `function name(...): LoopExecutor {}`
 * declaration (sync or `async`, plain or `Promise<LoopExecutor>` return, and
 * — the shape that matters here — an intersection return type such as
 * `LoopExecutor & { close(): Promise<void> }`), a `const name = (...):
 * LoopExecutor => {}` arrow factory, or a class/object method shorthand
 * `name(...): LoopExecutor {}`.
 *
 * This used to be a regex that walked backward from a `): LoopExecutor {`
 * text anchor to a balanced opening paren and then read the identifier in
 * front of it. That version (see git history, commit 281ea2a2) fixed the
 * three shapes this suite's fixtures below prove: arrow factories, `async
 * function` returning `Promise<LoopExecutor>`, and class methods (which a
 * still-earlier, `function`-keyword-only version either misattributed to an
 * unrelated `function` declared earlier in the file, or dropped). But it was
 * still an approximation of a return-type annotation, matched by literal
 * text (`LoopExecutor`/`Promise<LoopExecutor>` immediately followed by
 * `{`/`=> {`) — and it went blind again the moment a real factory's return
 * type stopped being one of those two exact shapes. Confirmed by direct
 * test: `createOpenCodeServerLoopExecutor` in
 * `../src/opencode-server-executor.ts` returns `LoopExecutor & { close():
 * Promise<void> }` (it exposes a `close()` the plain interface doesn't
 * have), and the regex-based scanner found zero factories in that entire
 * file — a currently-registered production factory, invisible to its own
 * registration gate, with the meta-test still green throughout because its
 * only check was `discovered.size > 0` and the other three factories
 * happened to cover that bar.
 *
 * Rather than keep extending the regex for each new return-type shape (union
 * types, generic factories, re-exported aliases — see the top-of-file
 * docstring's list of shapes even this version cannot claim to catch), this
 * parses the file with the TypeScript compiler API (`ts.createSourceFile`,
 * the same approach `scripts/completion-depth.mjs` already uses elsewhere in
 * this repo) and asks the real return-type AST node, recursively, whether it
 * names `LoopExecutor` anywhere in an intersection/union — exact rather than
 * approximate, with no text-anchoring or backward paren-balancing at all. An
 * anonymous `function (...): LoopExecutor {}` (no declared name) is still
 * skipped: it cannot be referenced by `REGISTERED_LOOP_EXECUTOR_FACTORIES`
 * and is not a reusable factory in the sense this suite cares about.
 */
function findLoopExecutorFactoryNamesInText(text: string, fileName = "fixture.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.type && typeMentionsLoopExecutor(node.type)) {
      names.push(node.name.text);
    } else if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      typeMentionsLoopExecutor(node.type)
    ) {
      names.push(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
        init.type &&
        typeMentionsLoopExecutor(init.type)
      ) {
        names.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

/** Scan every `<name>(...): LoopExecutor {`-shaped factory declaration under `roots`. */
function findLoopExecutorFactories(roots: string[] = [
  join(REPO_ROOT, "packages/arbor-mcp/src"),
  join(REPO_ROOT, "packages/arbor-opencode/src"),
]): string[] {
  const names: string[] = [];
  for (const root of roots) {
    for (const file of listTsFiles(root)) {
      names.push(...findLoopExecutorFactoryNamesInText(readFileSync(file, "utf8")));
    }
  }
  return names;
}

describe("6.6 contract: registration gate", () => {
  it("every LoopExecutor factory declared in packages/*/src is registered against this contract suite", () => {
    const discovered = new Set(findLoopExecutorFactories());
    expect(discovered.size).toBeGreaterThan(0); // sanity: the scan itself must find something
    for (const name of discovered) {
      expect(
        REGISTERED_LOOP_EXECUTOR_FACTORIES,
        `LoopExecutor factory '${name}' exists in src/ but is not exercised by this contract suite — ` +
          `add a describe() block above and register its name in REGISTERED_LOOP_EXECUTOR_FACTORIES.`,
      ).toContain(name);
    }
  });

  // `discovered.size > 0` above only proves the scan isn't silently broken —
  // it says nothing about whether it found EVERY registered factory. That
  // was the actual shape of the intersection-type gap this suite's fixtures
  // caught: `createOpenCodeServerLoopExecutor` stayed in
  // `REGISTERED_LOOP_EXECUTOR_FACTORIES` and every one of its own contract
  // tests kept passing while discovery silently produced zero hits for its
  // whole source file — nothing here would have failed without this
  // stronger assertion. Discovery is now exact (an AST return-type check,
  // not a text pattern), so the two sets are asserted equal: a name can only
  // be discovered-but-unregistered (the case above) or
  // registered-but-undiscoverable (a factory renamed/removed from src/ with
  // its registry entry left stale, or — as happened here — a real factory
  // whose declaration shape discovery doesn't yet handle).
  it("the discovered factory set is exactly the registered factory set — not merely a subset", () => {
    const discovered = new Set(findLoopExecutorFactories());
    expect(discovered).toEqual(new Set(REGISTERED_LOOP_EXECUTOR_FACTORIES));
  });
});

// ============================================================
// SCANNER ROBUSTNESS — synthetic fixtures for the three shapes a prior,
// line-based, `function`-keyword-only version of this scanner provably
// missed or misattributed (confirmed by running its regex against these
// exact shapes in a throwaway script — see audit finding 2026-08-04).
// Proves the fix against `findLoopExecutorFactoryNamesInText` directly,
// the same function `findLoopExecutorFactories` (and therefore the
// registration gate above) calls.
// ============================================================
describe("6.6 contract: registration-gate scanner robustness", () => {
  it("still catches the plain function-declaration form (regression guard)", () => {
    const src = [
      "export function createPlainLoopExecutor(",
      "  opts: number,",
      "): LoopExecutor {",
      "  return {} as LoopExecutor;",
      "}",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createPlainLoopExecutor"]);
  });

  it("catches an arrow-function factory assigned to a const — invisible to the prior scanner", () => {
    const src = [
      "export const createArrowLoopExecutor = (opts: number): LoopExecutor => {",
      "  return {} as LoopExecutor;",
      "};",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createArrowLoopExecutor"]);
  });

  it("catches an async arrow-function factory", () => {
    const src = [
      "export const createAsyncArrowLoopExecutor = async (opts: number): Promise<LoopExecutor> => {",
      "  return {} as LoopExecutor;",
      "};",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createAsyncArrowLoopExecutor"]);
  });

  it("catches an async function factory returning Promise<LoopExecutor> — invisible to the prior scanner", () => {
    const src = [
      "export async function createAsyncLoopExecutor(",
      "  opts: number,",
      "): Promise<LoopExecutor> {",
      "  return {} as LoopExecutor;",
      "}",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createAsyncLoopExecutor"]);
  });

  it("catches a class-method factory without misattributing it to an unrelated `function` above it", () => {
    // The prior scanner's backward name-scan required the literal `function`
    // keyword, which a class method never has — it either misattributed the
    // factory's discovery to whatever unrelated `function` happened to
    // appear earlier in the file, or found nothing and dropped it silently.
    const src = [
      "function unrelatedHelper(x: number): number {",
      "  return x + 1;",
      "}",
      "",
      "class ExecutorFactory {",
      "  createMethodLoopExecutor(opts: number): LoopExecutor {",
      "    return {} as LoopExecutor;",
      "  }",
      "}",
    ].join("\n");
    const names = findLoopExecutorFactoryNamesInText(src);
    expect(names).toContain("createMethodLoopExecutor");
    expect(names).not.toContain("unrelatedHelper");
  });

  it("catches an async class-method factory", () => {
    const src = [
      "class ExecutorFactory {",
      "  async createAsyncMethodLoopExecutor(opts: number): Promise<LoopExecutor> {",
      "    return {} as LoopExecutor;",
      "  }",
      "}",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createAsyncMethodLoopExecutor"]);
  });

  it("catches a factory whose return type is an intersection with LoopExecutor — the exact shape createOpenCodeServerLoopExecutor uses, invisible to the prior regex-based scanner", () => {
    // Confirmed by direct test: the regex-based scanner this replaced (git
    // history, commit 281ea2a2) required the text `LoopExecutor` or
    // `Promise<LoopExecutor>` immediately followed by `{`/`=> {`. An
    // intersection return type like this one — real production code in
    // `../src/opencode-server-executor.ts`, which exposes a `close()` the
    // plain `LoopExecutor` interface doesn't have — never matched that
    // pattern at all, so that file's factory produced zero discoveries while
    // `discovered.size > 0` stayed satisfied by the other three files.
    const src = [
      "export function createServerishLoopExecutor(",
      "  opts: number,",
      "): LoopExecutor & { close(): Promise<void> } {",
      "  return {} as LoopExecutor & { close(): Promise<void> };",
      "}",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createServerishLoopExecutor"]);
  });

  it("catches an arrow factory whose return type is an intersection with LoopExecutor", () => {
    const src = [
      "export const createArrowServerishLoopExecutor = (opts: number): LoopExecutor & { close(): Promise<void> } => {",
      "  return {} as LoopExecutor & { close(): Promise<void> };",
      "};",
    ].join("\n");
    expect(findLoopExecutorFactoryNamesInText(src)).toEqual(["createArrowServerishLoopExecutor"]);
  });

  it("catches every shape at once in a single file, in declaration order", () => {
    const src = [
      "export function createPlainLoopExecutor(o: number): LoopExecutor { return {} as LoopExecutor; }",
      "export const createArrowLoopExecutor = (o: number): LoopExecutor => { return {} as LoopExecutor; };",
      "class F { createMethodLoopExecutor(o: number): LoopExecutor { return {} as LoopExecutor; } }",
      "function pad() {}",
    ].join("\n");
    const names = findLoopExecutorFactoryNamesInText(src);
    expect(names).toEqual(
      expect.arrayContaining(["createPlainLoopExecutor", "createArrowLoopExecutor", "createMethodLoopExecutor"]),
    );
    expect(names).not.toContain("pad");
  });
});
