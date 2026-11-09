import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimePortAdapter } from "../src/tui-adapter.js";
import type { Action } from "@arbor/core";
import {
  splitModelId,
  toTokenUsage,
  parseStructuredVerdict,
  classifyOpenCodeServerError,
  createOpenCodeServerLoopExecutor,
  DEFAULT_SPECIALIST_MODEL,
  DEFAULT_CRITIC_MODEL,
} from "../src/opencode-server-executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("splitModelId", () => {
  it("splits provider/model on the first slash", () => {
    expect(splitModelId("openrouter/deepseek/deepseek-v4-flash-0731")).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
    });
  });

  it("splits a simple provider/model pair", () => {
    expect(splitModelId("zai-coding-plan/glm-5.2")).toEqual({
      providerID: "zai-coding-plan",
      modelID: "glm-5.2",
    });
  });

  it("falls back to the whole string for both fields when there is no slash", () => {
    expect(splitModelId("no-slash-model")).toEqual({ providerID: "no-slash-model", modelID: "no-slash-model" });
  });
});

describe("toTokenUsage", () => {
  it("maps opencode's wire tokens onto TokenUsage, folding reasoning into output", () => {
    const usage = toTokenUsage({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } });
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      cached_input_tokens: 30,
      cache_write_input_tokens: 2,
      counter_source: "provider_counter",
    });
  });

  it("handles all-zero usage without fabricating anything", () => {
    const usage = toTokenUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });
});

describe("parseStructuredVerdict", () => {
  const fullApproved = { approved: true, rationale: "looks good", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks: [
    { name: "root_cause", passed: true, detail: "explicit" }, { name: "measurement_validation", passed: true, detail: "clean" },
    { name: "guardrail_enforcement", passed: true, detail: "in scope" }, { name: "introspection", passed: true, detail: "consistent" },
    { name: "stability_monitoring", passed: true, detail: "stable" },
  ] };
  it("accepts a server-validated structured object", () => {
    const v = parseStructuredVerdict(fullApproved, "irrelevant raw text");
    expect(v).toMatchObject({ kind: "verdict", verdict: { ...fullApproved, critic: "lenticel" } });
  });

  it("carries root_cause through when present", () => {
    const v = parseStructuredVerdict({ ...fullApproved, approved: false, rationale: "blocker", root_cause: "flaky", introspection_passed: false }, "raw");
    expect(v).toMatchObject({ kind: "verdict", verdict: { approved: false, rationale: "blocker", root_cause: "flaky" } });
  });

  it("is unparseable (typed, hashed) when structured is undefined", () => {
    const v = parseStructuredVerdict(undefined, "the raw text the model actually produced");
    expect(v.kind).toBe("unparseable");
    if (v.kind === "unparseable") expect(v.raw_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is unparseable when structured is present but missing required fields", () => {
    const v = parseStructuredVerdict({ approved: "yes" }, "raw");
    expect(v.kind).toBe("unparseable");
  });
});

// G-08: the HTTP transport's failure strings (server spawn, HTTP status,
// fetch-level failure) get the same typed classification the subprocess
// transport gets in opencode-executor.test.ts — none of this reached the
// closed NodeError union before.
describe("classifyOpenCodeServerError", () => {
  it("classifies a server-startup timeout", () => {
    const err = classifyOpenCodeServerError("opencode serve did not report listening within 15000ms. Output: ");
    expect(err).toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP 429 as quota_exceeded", () => {
    expect(classifyOpenCodeServerError("HTTP 429: rate limited")).toMatchObject({ kind: "quota_exceeded" });
  });

  it("classifies HTTP 408 as timeout", () => {
    expect(classifyOpenCodeServerError("HTTP 408: request timeout")).toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP 5xx as a recoverable transport_error", () => {
    expect(classifyOpenCodeServerError("HTTP 503: service unavailable")).toMatchObject({ kind: "transport_error", recoverable: true });
  });

  it("classifies other HTTP 4xx as an unrecoverable internal_error", () => {
    expect(classifyOpenCodeServerError("HTTP 400: bad request")).toMatchObject({ kind: "internal_error", recoverable: false });
  });

  it("classifies our own internal timeout (fetch aborted by our timer, not the caller's signal) as timeout", () => {
    expect(classifyOpenCodeServerError("fetch failed: The operation was aborted")).toMatchObject({ kind: "timeout" });
  });

  it("classifies a genuine fetch-layer failure as a recoverable transport_error", () => {
    expect(classifyOpenCodeServerError("fetch failed: connect ECONNREFUSED")).toMatchObject({ kind: "transport_error", recoverable: true });
  });

  it("classifies empty/non-JSON responses as transport_error", () => {
    expect(classifyOpenCodeServerError("empty response body")).toMatchObject({ kind: "transport_error" });
    expect(classifyOpenCodeServerError("non-JSON response: <html>")).toMatchObject({ kind: "transport_error" });
  });

  it("classifies a server spawn failure as internal_error", () => {
    expect(classifyOpenCodeServerError("opencode serve spawn failed: ENOENT")).toMatchObject({ kind: "internal_error" });
  });

  it("returns undefined for a genuine external cancellation — never fabricates an operational error over a real abort", () => {
    expect(classifyOpenCodeServerError("opencode-server-executor call aborted")).toBeUndefined();
  });
});

describe("model defaults (shared with the subprocess transport)", () => {
  it("re-exports the same specialist/critic model defaults", () => {
    expect(DEFAULT_SPECIALIST_MODEL.startsWith("openrouter/")).toBe(true);
    expect(DEFAULT_CRITIC_MODEL).toBe("openrouter/~openai/gpt-mini-latest");
  });
});

// ============================================================
// close() lifecycle — regression coverage for the 2026-08-08 `arbor run
// --transport server` hang: `getServer()` spawns `opencode serve` and hands
// back a `ServerHandle.close()`, but until this fix nothing ever called it.
// A `spawn()`'d child that is never `.kill()`'d is a live libuv handle
// (Node will not empty its event loop while a child process exists and
// hasn't been `unref()`'d), so the process running `arbor run` never exited
// on its own — it has no `process.exit()` call anywhere on this path (see
// cli.ts: `main().then((code) => { process.exitCode = code; })`).
//
// This suite proves the exact mechanism — spawn, then observe whether the
// child is still alive — against a hermetic fixture that behaves like a
// real `opencode serve` (reports "listening", then stays alive until
// killed) WITHOUT spawning the real `opencode` binary. No network, no LLM
// call, no real dependency.
// ============================================================
describe("createOpenCodeServerLoopExecutor: close() releases the spawned server (G-hang regression)", () => {
  const FAKE_SERVE_BIN = join(__dirname, "fixtures/fake-opencode-serve.mjs");

  function fakeAdapter(): RuntimePortAdapter {
    return { pushDevtoolsLine: () => {} } as unknown as RuntimePortAdapter;
  }

  const rootAction: Action = {
    description: "close()-lifecycle probe action",
    estimated_gain: 1,
    estimated_cost: 1,
    category: "testing",
    delegate_to: "seed",
  };

  async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!predicate()) throw new Error(`timed out waiting for: ${description}`);
  }

  /** True while a process with this pid is alive (POSIX signal-0 probe). */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("spawning without calling close() leaves the child alive (demonstrates the defect's precondition)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-serve-lifecycle-"));
    const pidfile = join(dir, "server.pid");
    try {
      const executor = createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "lifecycle-campaign", {
        opencodeBin: FAKE_SERVE_BIN,
        startupTimeoutMs: 5_000,
        timeoutMs: 2_000,
        fetchImpl: (() => Promise.reject(new Error("no HTTP server behind this fixture"))) as unknown as typeof fetch,
      });
      // specialize() is the production trigger for getServer() — same call
      // opencode-server-executor.ts's real specialize/review paths make. The
      // HTTP leg after it fails closed (no real server listens behind the
      // fixture); that's fine, this test only cares whether the CHILD
      // PROCESS is real and alive.
      process.env.FAKE_SERVE_PIDFILE = pidfile;
      const result = await executor.specialize({
        campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
        worktree_path: "", specialist_agent: "seed",
      });
      expect(result.output).toMatch(/^\[opencode-server error\]/); // dispatch failed, as expected — spawn still happened

      await waitFor(() => existsSync(pidfile), 5_000, "fixture to write its pidfile");
      const pid = Number(readFileSync(pidfile, "utf8"));
      expect(isAlive(pid)).toBe(true); // the leak: nobody has released this child

      // Clean up this test's own child — do not leave it running past the test.
      process.kill(pid, "SIGTERM");
      await waitFor(() => !isAlive(pid), 5_000, "cleanup kill to take effect");
    } finally {
      delete process.env.FAKE_SERVE_PIDFILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("close() terminates the real spawned child — the fix's release path actually fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-serve-lifecycle-"));
    const pidfile = join(dir, "server.pid");
    try {
      const executor = createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "lifecycle-campaign", {
        opencodeBin: FAKE_SERVE_BIN,
        startupTimeoutMs: 5_000,
        timeoutMs: 2_000,
        fetchImpl: (() => Promise.reject(new Error("no HTTP server behind this fixture"))) as unknown as typeof fetch,
      });
      process.env.FAKE_SERVE_PIDFILE = pidfile;
      await executor.specialize({
        campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
        worktree_path: "", specialist_agent: "seed",
      });

      await waitFor(() => existsSync(pidfile), 5_000, "fixture to write its pidfile");
      const pid = Number(readFileSync(pidfile, "utf8"));
      expect(isAlive(pid)).toBe(true);

      // This is the exact call demo.ts's runOneCampaign now makes in its
      // `finally` block — the fix for the 2026-08-08 hang.
      await executor.close();

      await waitFor(() => existsSync(`${pidfile}.killed`), 5_000, "fixture's SIGTERM handler to run");
      await waitFor(() => !isAlive(pid), 5_000, "child to actually exit");
      expect(isAlive(pid)).toBe(false);
    } finally {
      delete process.env.FAKE_SERVE_PIDFILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("close() before any specialize()/review() call is a safe no-op (nothing was ever spawned)", async () => {
    const executor = createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "lifecycle-campaign", {
      opencodeBin: FAKE_SERVE_BIN,
    });
    await expect(executor.close()).resolves.toBeUndefined();
  });

  it("close() is a no-op when baseUrl was injected — this executor doesn't own that process's lifecycle", async () => {
    const executor = createOpenCodeServerLoopExecutor(fakeAdapter(), () => {}, "lifecycle-campaign", {
      baseUrl: "http://fake-opencode-serve.invalid",
      fetchImpl: (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch,
    });
    await executor.specialize({
      campaign_id: "c", node_id: "n1", action: rootAction, prompt: "do it",
      worktree_path: "", specialist_agent: "seed",
    });
    await expect(executor.close()).resolves.toBeUndefined();
  });
});
