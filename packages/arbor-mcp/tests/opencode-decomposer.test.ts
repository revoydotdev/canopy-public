import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "@arbor/core";
import {
  parseDecompositionResponse,
  createOpenCodeDecomposer,
  DEFAULT_DECOMPOSER_MODEL,
  type DecompositionRequest,
} from "../src/opencode-decomposer.js";
import { DEFAULT_CRITIC_MODEL } from "../src/opencode-executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_OPENCODE_BIN = join(__dirname, "fixtures/fake-opencode.mjs");

const bigAction: Action = {
  description: "Bring repo-wide branch coverage to >=85%",
  estimated_gain: 40,
  estimated_cost: 900,
  category: "quality",
  delegate_to: "heartwood",
};

const validChildrenJson = JSON.stringify([
  { description: "Add tests for packages/arbor-kb/src/sqlite.ts error paths", estimated_gain: 15, estimated_cost: 200, category: "quality", delegate_to: "heartwood", constraints: ["MUST run npx vitest run"] },
  { description: "Add tests for packages/arbor-audit/src/index.ts error paths", estimated_gain: 15, estimated_cost: 200, category: "quality", delegate_to: "heartwood" },
]);

describe("DEFAULT_DECOMPOSER_MODEL", () => {
  it("defaults to the critic model — decomposition is a judgment call, not code-writing", () => {
    expect(DEFAULT_DECOMPOSER_MODEL).toBe(DEFAULT_CRITIC_MODEL);
  });
});

describe("parseDecompositionResponse", () => {
  it("parses a valid JSON array of children", () => {
    const parsed = parseDecompositionResponse(validChildrenJson);
    expect(parsed.kind).toBe("children");
    if (parsed.kind !== "children") throw new Error("unreachable");
    expect(parsed.children).toHaveLength(2);
    expect(parsed.children[0]).toMatchObject({
      description: "Add tests for packages/arbor-kb/src/sqlite.ts error paths",
      estimated_gain: 15,
      estimated_cost: 200,
      category: "quality",
      delegate_to: "heartwood",
      constraints: ["MUST run npx vitest run"],
    });
    // A child with no constraints field must not gain a fabricated one.
    expect(parsed.children[1]).not.toHaveProperty("constraints");
  });

  it("returns unparseable for pure prose with no brackets at all", () => {
    const parsed = parseDecompositionResponse("I think this action should be split into two parts, roughly.");
    expect(parsed.kind).toBe("unparseable");
    if (parsed.kind !== "unparseable") throw new Error("unreachable");
    expect(parsed.detail).toContain("no JSON array found");
  });

  it("returns unparseable for a single object instead of an array (no top-level brackets)", () => {
    const singleObject = JSON.stringify({ description: "just one action", estimated_gain: 5, estimated_cost: 5, category: "quality", delegate_to: "seed" });
    const parsed = parseDecompositionResponse(singleObject);
    expect(parsed.kind).toBe("unparseable");
    if (parsed.kind !== "unparseable") throw new Error("unreachable");
    expect(parsed.detail).toContain("no JSON array found");
  });

  it("returns unparseable for truncated JSON (opening bracket, no closing bracket)", () => {
    const truncated = '[{"description":"add tests","estimated_gain":10,"estimated_cost":100,"category":"quality","delegate_to":"seed"';
    const parsed = parseDecompositionResponse(truncated);
    expect(parsed.kind).toBe("unparseable");
    if (parsed.kind !== "unparseable") throw new Error("unreachable");
    expect(parsed.detail).toMatch(/closing bracket|truncated/);
  });

  it("returns unparseable when the scraped text is not valid JSON", () => {
    const parsed = parseDecompositionResponse("[this is not json]");
    expect(parsed.kind).toBe("unparseable");
    if (parsed.kind !== "unparseable") throw new Error("unreachable");
    expect(parsed.detail).toContain("did not parse as JSON");
  });

  it("returns unparseable when an array element is missing a required field", () => {
    const missingField = JSON.stringify([{ description: "add tests", estimated_gain: 10, estimated_cost: 100, category: "quality" /* no delegate_to */ }]);
    const parsed = parseDecompositionResponse(missingField);
    expect(parsed.kind).toBe("unparseable");
    if (parsed.kind !== "unparseable") throw new Error("unreachable");
    expect(parsed.detail).toContain("not a valid Action");
  });

  it("returns unparseable when an array element has a mistyped field", () => {
    const mistyped = JSON.stringify([{ description: "add tests", estimated_gain: "a lot", estimated_cost: 100, category: "quality", delegate_to: "seed" }]);
    const parsed = parseDecompositionResponse(mistyped);
    expect(parsed.kind).toBe("unparseable");
  });

  it("returns unparseable when constraints is present but not an array of strings", () => {
    const badConstraints = JSON.stringify([{ description: "add tests", estimated_gain: 10, estimated_cost: 100, category: "quality", delegate_to: "seed", constraints: "MUST do it" }]);
    const parsed = parseDecompositionResponse(badConstraints);
    expect(parsed.kind).toBe("unparseable");
  });

  it("parses a genuinely empty array (the prompt's honest 'cannot decompose' escape hatch)", () => {
    const parsed = parseDecompositionResponse("[]");
    expect(parsed.kind).toBe("children");
    if (parsed.kind !== "children") throw new Error("unreachable");
    expect(parsed.children).toHaveLength(0);
  });

  it("scrapes the array out of surrounding prose (model ignored the 'nothing else' instruction but still emitted valid JSON)", () => {
    const wrapped = `Sure, here are the children:\n${validChildrenJson}\nLet me know if you want more detail.`;
    const parsed = parseDecompositionResponse(wrapped);
    expect(parsed.kind).toBe("children");
    if (parsed.kind !== "children") throw new Error("unreachable");
    expect(parsed.children).toHaveLength(2);
  });
});

describe("createOpenCodeDecomposer", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "arbor-decomposer-config-"));
    for (const k of ["FAKE_OPENCODE_STDOUT", "FAKE_OPENCODE_STDERR", "FAKE_OPENCODE_EXIT", "FAKE_OPENCODE_SLEEP_MS"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function baseRequest(overrides: Partial<DecompositionRequest> = {}): DecompositionRequest {
    return {
      campaign_id: "camp1",
      node_id: "node1",
      action: bigAction,
      reason: "timeout",
      depth: 1,
      ...overrides,
    };
  }

  it("returns ok:true with parsed children on a well-formed response", async () => {
    process.env.FAKE_OPENCODE_STDOUT = validChildrenJson;
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.delegate_to).toBe("heartwood");
  });

  it("never fabricates children: prose response yields ok:false, not an invented child", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "I would split this into a couple of pieces but let me explain my reasoning first...";
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unparseable");
  });

  it("never fabricates children: a truncated response yields ok:false", async () => {
    process.env.FAKE_OPENCODE_STDOUT = '[{"description":"add tests","estimated_gain":10,"estimated_cost":100,"category":"quality","delegate_to":"seed"';
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unparseable");
  });

  it("never fabricates children: a single object instead of an array yields ok:false", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify({ description: "just do the whole thing", estimated_gain: 40, estimated_cost: 900, category: "quality", delegate_to: "heartwood" });
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(false);
  });

  it("reports zero children as a typed failure rather than a vacuous success", async () => {
    process.env.FAKE_OPENCODE_STDOUT = "[]";
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("zero children");
  });

  it("classifies a non-zero opencode exit into a typed failure reason", async () => {
    process.env.FAKE_OPENCODE_EXIT = "1";
    process.env.FAKE_OPENCODE_STDERR = "rate limit exceeded (429)";
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("quota_exceeded");
  });

  it("fails fast on an already-aborted signal without waiting for the subprocess", async () => {
    const controller = new AbortController();
    controller.abort();
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 10_000 });
    const start = Date.now();
    const result = await decomposer.decompose(baseRequest({ signal: controller.signal }));
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("aborted");
  });

  it("reports a mid-flight abort as a typed failure, not a hang or a fabricated result", async () => {
    process.env.FAKE_OPENCODE_SLEEP_MS = "30000";
    const controller = new AbortController();
    const decomposer = createOpenCodeDecomposer({ opencodeBin: FAKE_OPENCODE_BIN, configDir, timeoutMs: 60_000 });
    const promise = decomposer.decompose(baseRequest({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("abort");
  }, 10_000);

  it("respects an explicit options.model over any configured default", async () => {
    writeFileSync(join(configDir, "arbor.jsonc"), JSON.stringify({ agents: { cambium: { model: "zai-coding-plan/from-config" } } }), "utf8");
    process.env.FAKE_OPENCODE_STDOUT = validChildrenJson;
    const decomposer = createOpenCodeDecomposer({
      opencodeBin: FAKE_OPENCODE_BIN,
      configDir,
      timeoutMs: 10_000,
      model: "openrouter/explicit-decomposer-model",
    });
    // The fake binary doesn't echo argv, so this asserts the call still
    // succeeds end-to-end with an explicit model set (no throw / no
    // resolution error) — model precedence itself is covered directly by
    // opencode-executor.test.ts's resolveConfiguredModel suite, which this
    // module reuses unmodified.
    const result = await decomposer.decompose(baseRequest());
    expect(result.ok).toBe(true);
  });
});
