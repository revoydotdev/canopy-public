import { describe, expect, it } from "vitest";
import {
  ARBITER_DECISION_CONTRACT,
  classifyGovernanceTier,
  createHeuristicArbiterIntakePort,
  incorporatePlannerWritePaths,
  parseArbiterDecisionOutput,
  validateArbiterDecisionOutput,
  type ArbiterIntakePort,
} from "../src/arbiter-intake.js";

const clock = () => "2026-08-15T00:00:00.000Z";

describe("arbiter decision contract parsing", () => {
  it("records planner-authored write paths into the arbiter blast radius without inventing runtime authority", () => {
    const decision = {
      tier: "governed" as const, rationale: "needs decomposition", blast_radius: { reversibility: "unknown" as const },
      source: "arbiter" as const, decided_at: "T", turn_budget_estimate: 32,
    };
    const enriched = incorporatePlannerWritePaths(decision, [
      { high_risk_tool_scope: { write_paths: ["src/actual.ts", "tests/actual.test.ts"], command_argv: [] } },
    ]);
    expect(enriched.blast_radius.write_paths).toEqual(["src/actual.ts", "tests/actual.test.ts"]);
    expect(enriched.rationale).toContain("planner-declared write paths");
  });

  it("accepts a well-formed decision", () => {
    const raw = JSON.stringify({ tier: "direct", rationale: "narrow fix", category: "maintenance", blast_radius: { reversibility: "reversible", write_paths: ["src/x.ts"], command_argv: [["npm", "test"]] } });
    const parsed = parseArbiterDecisionOutput(raw);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "direct", category: "maintenance" } });
    expect(ARBITER_DECISION_CONTRACT.validate(JSON.parse(raw))).toEqual({ valid: true });
  });

  it("rejects malformed JSON", () => {
    expect(parseArbiterDecisionOutput("not json")).toMatchObject({ ok: false });
  });

  it("rejects an unknown tier value (closed enum)", () => {
    expect(validateArbiterDecisionOutput({ tier: "yolo", rationale: "x", category: "x", blast_radius: { reversibility: "unknown" } })).toMatchObject({ ok: false });
  });

  it("rejects a missing rationale", () => {
    expect(validateArbiterDecisionOutput({ tier: "direct", category: "x", blast_radius: { reversibility: "unknown" } })).toMatchObject({ ok: false });
  });

  it("rejects an invalid reversibility value", () => {
    expect(validateArbiterDecisionOutput({ tier: "direct", rationale: "x", category: "x", blast_radius: { reversibility: "maybe" } })).toMatchObject({ ok: false });
  });
});

describe("classifyGovernanceTier — honest fallback to governed", () => {
  it("falls back to governed when no port is configured", async () => {
    const result = await classifyGovernanceTier(null, { task: "do something", evidence_ids: [] }, clock);
    expect(result.decision).toMatchObject({ tier: "governed", source: "arbiter" });
    expect(result.category).toBeNull();
  });

  it("falls back to governed when the port throws (transport failure)", async () => {
    const port: ArbiterIntakePort = { classify: async () => { throw new Error("provider 503"); } };
    const result = await classifyGovernanceTier(port, { task: "do something", evidence_ids: [] }, clock);
    expect(result.decision.tier).toBe("governed");
    expect(result.decision.rationale).toContain("provider 503");
  });

  it("falls back to governed when the port returns malformed output", async () => {
    const port: ArbiterIntakePort = { classify: async () => ({ raw_decision: "not json", session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "n/a" } }) };
    const result = await classifyGovernanceTier(port, { task: "do something", evidence_ids: [] }, clock);
    expect(result.decision.tier).toBe("governed");
    expect(result.decision.rationale).toContain("failed validation");
  });

  it("passes through a well-formed direct decision", async () => {
    const port: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "direct", rationale: "narrow fix", category: "maintenance", blast_radius: { reversibility: "reversible" } }), session_id: "s1", model_identity: "m1", usage: { kind: "unavailable", reason: "test" } }) };
    const result = await classifyGovernanceTier(port, { task: "fix the typo", evidence_ids: [] }, clock);
    expect(result.decision).toMatchObject({ tier: "direct", rationale: "narrow fix", source: "arbiter", decided_at: "2026-08-15T00:00:00.000Z" });
    expect(result.category).toBe("maintenance");
  });
});

describe("createHeuristicArbiterIntakePort — real, cheap, zero-cost classification", () => {
  const port = createHeuristicArbiterIntakePort();

  it("classifies a short, narrow-verb task that names its file as direct", async () => {
    const result = await port.classify({ task: "fix the typo in docs/guide.md", evidence_ids: [] });
    expect(result.usage).toEqual({ kind: "unavailable", reason: "heuristic classification performs no model call" });
    const parsed = parseArbiterDecisionOutput(result.raw_decision);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "direct" } });
  });

  it("escalates a short mutating task that names no concrete file to governed (authority underivable)", async () => {
    // Bench regression: without a derivable write scope the specialist
    // dispatches read-only, so 'direct' here would be a tier that cannot
    // succeed. Only the governed planner can author the missing scope.
    const result = await port.classify({ task: "fix the typo in the README", evidence_ids: [] });
    const parsed = parseArbiterDecisionOutput(result.raw_decision);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "governed" } });
  });

  it("classifies a task naming a risk keyword as governed, even if short", async () => {
    const result = await port.classify({ task: "fix the production deploy script", evidence_ids: [] });
    const parsed = parseArbiterDecisionOutput(result.raw_decision);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "governed" } });
  });

  it("classifies an ambiguous non-mutating task as reviewed", async () => {
    const result = await port.classify({ task: "investigate why the nightly report job has been slower this week and summarize likely causes", evidence_ids: [] });
    const parsed = parseArbiterDecisionOutput(result.raw_decision);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "reviewed" } });
  });

  it("escalates an ambiguous mutating task naming no file to governed", async () => {
    const result = await port.classify({ task: "implement a new caching layer for the API responses across services", evidence_ids: [] });
    const parsed = parseArbiterDecisionOutput(result.raw_decision);
    expect(parsed).toMatchObject({ ok: true, value: { tier: "governed" } });
  });

  it.each(["Make the mobile menu accessible", "Improve the onboarding flow", "Ensure login works", "Build a settings screen"])("treats general editing language as mutating instead of a scope-less reviewed report: %s", async (task) => {
    const result = await port.classify({ task, evidence_ids: [] });
    expect(parseArbiterDecisionOutput(result.raw_decision)).toMatchObject({ ok: true, value: { tier: "governed" } });
  });

  it("threads the caller abort signal through classification", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const signalPort: ArbiterIntakePort = { classify: async (input) => {
      observed = input.signal;
      return { raw_decision: JSON.stringify({ tier: "governed", rationale: "test", category: "test", blast_radius: { reversibility: "unknown" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } };
    } };
    await classifyGovernanceTier(signalPort, { task: "Build it", evidence_ids: [], signal: controller.signal }, clock);
    expect(observed).toBe(controller.signal);
  });
});

describe("extractDeclaredScope + authority derivation (bench regression: reviewed tier dispatched read-only)", () => {
  const port = createHeuristicArbiterIntakePort();
  const benchTask = "Add one unit test to test/decorator.test.js asserting that fastify.decorate() throws an error with code FST_ERR_DEC_ALREADY_PRESENT when the same decorator name is registered twice, following the file's existing conventions. Verify by running: node --test test/decorator.test.js";

  it("extracts literally-named paths and verify commands from task text", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope(benchTask);
    expect(scope.write_paths).toEqual(["test/decorator.test.js"]);
    expect(scope.command_argv).toEqual([["node", "--test", "test/decorator.test.js"]]);
  });

  it("grants derived write authority to a mutating non-governed task that names its file", async () => {
    const result = await port.classify({ task: benchTask, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { tier: string; blast_radius: { write_paths?: string[]; command_argv?: string[][] } };
    expect(decision.tier).not.toBe("governed");
    expect(decision.blast_radius.write_paths).toEqual(["test/decorator.test.js"]);
    expect(decision.blast_radius.command_argv).toEqual([["node", "--test", "test/decorator.test.js"]]);
  });

  it("treats repair as mutation and mines bracketed framework routes", async () => {
    const task = "Repair only apps/web/src/lib/portfolio.ts, apps/web/src/lib/trpc.ts, apps/web/src/pages/index.astro, and apps/web/src/pages/projects/[slug].astro. Acceptance: run: npm run build";
    const result = await port.classify({ task, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { tier: string; blast_radius: { write_paths?: string[]; command_argv?: string[][] } };
    expect(decision.tier).not.toBe("governed");
    expect(decision.blast_radius.write_paths).toEqual([
      "apps/web/src/lib/portfolio.ts",
      "apps/web/src/lib/trpc.ts",
      "apps/web/src/pages/index.astro",
      "apps/web/src/pages/projects/[slug].astro",
    ]);
    expect(decision.blast_radius.command_argv).toEqual([["npm", "run", "build"]]);
  });

  it("escalates a mutating task that names no concrete file to governed (no derivable authority)", async () => {
    const result = await port.classify({ task: "Update the retry behavior so transient failures back off exponentially before giving up", evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { tier: string };
    expect(decision.tier).toBe("governed");
  });

  it("extracts a bare repo-root data file (ab3 T6: package.json) without matching method calls", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope("Add an npm script named test:decorator to package.json that runs: node --test test/decorator.test.js. Verify by running: npm run test:decorator");
    expect(scope.write_paths).toContain("package.json");
    expect(scope.write_paths).toContain("test/decorator.test.js");
    // S7 regression guard: a sentence-ending period ends a mined command —
    // trailing prose ("… . Verify by running: …") must never reach the argv.
    expect(scope.command_argv).toEqual([["npm", "run", "test:decorator"]]);
    const dirty = extractDeclaredScope("Fix it. Verify by running: node --test test/a.test.js. Then summarize what changed.");
    expect(dirty.command_argv).toEqual([["node", "--test", "test/a.test.js"]]);
    // Method calls and identifiers must never read as files.
    const none = extractDeclaredScope("assert that fastify.decorate() throws and config.get returns a value");
    expect(none.write_paths).toEqual([]);
  });

  it("mines a compound verification command declared with && into two separate argvs (2026-08-24 BENCH 4)", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope("Add cost-attribution tests to docs/native-doctor.md. Verify with: bunx tsc --noEmit -p docs && bunx vitest run docs/native-doctor.test.ts");
    expect(scope.command_argv).toEqual([
      ["bunx", "tsc", "--noEmit", "-p", "docs"],
      ["bunx", "vitest", "run", "docs/native-doctor.test.ts"],
    ]);
  });

  it("mines compound commands joined by ; and by ||", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const semi = extractDeclaredScope("Fix the flake. Check with: npm run lint ; npm test");
    expect(semi.command_argv).toEqual([["npm", "run", "lint"], ["npm", "test"]]);
    const pipe = extractDeclaredScope("Fix the flake. Verify using: npm run build || npm run build:fallback");
    expect(pipe.command_argv).toEqual([["npm", "run", "build"], ["npm", "run", "build:fallback"]]);
  });

  it("mines a newline-separated list of verification commands", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope("Add the guard. Verify with:\nbunx tsc --noEmit\nbunx vitest run test/guard.test.ts\n\nThen report back.");
    expect(scope.command_argv).toEqual([
      ["bunx", "tsc", "--noEmit"],
      ["bunx", "vitest", "run", "test/guard.test.ts"],
    ]);
  });

  it.each([
    ["verify with: npm run build", [["npm", "run", "build"]]],
    ["verify using: npm run build", [["npm", "run", "build"]]],
    ["check with: npm run build", [["npm", "run", "build"]]],
    ["to verify run npm run build", [["npm", "run", "build"]]],
    ["build with: npm run build", [["npm", "run", "build"]]],
    ["test with: npm run build", [["npm", "run", "build"]]],
  ])("mines the declared command from the phrasing %j (2026-08-24 BENCH 4: not just run:/running:)", async (suffix, expected) => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope(`Fix the bug in lib/x.js. ${suffix}`);
    expect(scope.command_argv).toEqual(expected);
  });

  it("leaves a read-only lookup without write authority", async () => {
    const result = await port.classify({ task: "Without modifying any file, list every distinct FST_ERR_ error code referenced in lib/content-type-parser.js, giving each code once with one representative line number.", evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { tier: string; blast_radius: { write_paths?: string[] } };
    expect(decision.tier).not.toBe("governed");
    expect(decision.blast_radius.write_paths ?? []).toEqual([]);
  });
});

describe("Y-2: structural scope widening for mined scopes naming a test file (ab3 bench T2)", () => {
  const benchTask = "Add one unit test to test/decorator.test.js asserting that fastify.decorate() throws an error with code FST_ERR_DEC_ALREADY_PRESENT when the same decorator name is registered twice, following the file's existing conventions. Verify by running: node --test test/decorator.test.js";

  it("widens to include a test file's direct non-test imports when a resolver is supplied", async () => {
    const port = createHeuristicArbiterIntakePort({ structural_paths: (path) => path === "test/decorator.test.js" ? ["lib/decorator.js"] : [] });
    const result = await port.classify({ task: benchTask, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { blast_radius: { write_paths?: string[] } };
    expect(decision.blast_radius.write_paths).toEqual(["test/decorator.test.js", "lib/decorator.js"]);
  });

  it("leaves write_paths unchanged when no resolver is supplied", async () => {
    const port = createHeuristicArbiterIntakePort();
    const result = await port.classify({ task: benchTask, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { blast_radius: { write_paths?: string[] } };
    expect(decision.blast_radius.write_paths).toEqual(["test/decorator.test.js"]);
  });

  it("leaves write_paths unchanged when the resolver throws", async () => {
    const port = createHeuristicArbiterIntakePort({ structural_paths: () => { throw new Error("index unavailable"); } });
    const result = await port.classify({ task: benchTask, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { blast_radius: { write_paths?: string[] } };
    expect(decision.blast_radius.write_paths).toEqual(["test/decorator.test.js"]);
  });

  it("never widens a non-test mined path, dedupes, and bounds total additions to 8", async () => {
    const port = createHeuristicArbiterIntakePort({
      structural_paths: (path) => path === "test/decorator.test.js"
        ? Array.from({ length: 12 }, (_, i) => `lib/mod${i}.js`)
        : ["lib/should-never-widen.js"],
    });
    // A task that names a plain (non-test) file must never trigger widening.
    const plain = await port.classify({ task: "Update package.json to add a script.", evidence_ids: [] });
    const plainDecision = JSON.parse(plain.raw_decision) as { blast_radius: { write_paths?: string[] } };
    expect(plainDecision.blast_radius.write_paths ?? []).not.toContain("lib/should-never-widen.js");

    const result = await port.classify({ task: benchTask, evidence_ids: [] });
    const decision = JSON.parse(result.raw_decision) as { blast_radius: { write_paths?: string[] } };
    // 1 declared + at most 8 added = 9, deduped, no test-like path re-added.
    expect(decision.blast_radius.write_paths).toHaveLength(9);
    expect(new Set(decision.blast_radius.write_paths)).toEqual(new Set(decision.blast_radius.write_paths));
  });
});

describe("E-2 (arXiv 2607.13034): turn_budget_estimate is derived per tier", () => {
  it("direct tier gets the small (12) estimate", async () => {
    const port: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "direct", rationale: "narrow fix", category: "maintenance", blast_radius: { reversibility: "reversible" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const result = await classifyGovernanceTier(port, { task: "x", evidence_ids: [] }, clock);
    expect(result.decision.turn_budget_estimate).toBe(12);
  });

  it("reviewed tier gets the mid (16) estimate", async () => {
    const port: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "reviewed", rationale: "ambiguous scope", category: "general", blast_radius: { reversibility: "reversible" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const result = await classifyGovernanceTier(port, { task: "x", evidence_ids: [] }, clock);
    expect(result.decision.turn_budget_estimate).toBe(16);
  });

  it("governed tier keeps the existing flat (32) default, including on every fallback path", async () => {
    const port: ArbiterIntakePort = { classify: async () => ({ raw_decision: JSON.stringify({ tier: "governed", rationale: "risky", category: "high-risk", blast_radius: { reversibility: "unknown" } }), session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const explicit = await classifyGovernanceTier(port, { task: "x", evidence_ids: [] }, clock);
    expect(explicit.decision.turn_budget_estimate).toBe(32);

    const noPort = await classifyGovernanceTier(null, { task: "x", evidence_ids: [] }, clock);
    expect(noPort.decision.turn_budget_estimate).toBe(32);

    const throwingPort: ArbiterIntakePort = { classify: async () => { throw new Error("503"); } };
    const errored = await classifyGovernanceTier(throwingPort, { task: "x", evidence_ids: [] }, clock);
    expect(errored.decision.turn_budget_estimate).toBe(32);

    const malformedPort: ArbiterIntakePort = { classify: async () => ({ raw_decision: "not json", session_id: null, model_identity: null, usage: { kind: "unavailable", reason: "test" } }) };
    const malformed = await classifyGovernanceTier(malformedPort, { task: "x", evidence_ids: [] }, clock);
    expect(malformed.decision.turn_budget_estimate).toBe(32);
  });

  it("the heuristic port's own decisions carry the correct per-tier estimate end to end", async () => {
    const heuristicPort = createHeuristicArbiterIntakePort();
    const direct = await classifyGovernanceTier(heuristicPort, { task: "fix the typo in docs/guide.md", evidence_ids: [] }, clock);
    expect(direct.decision).toMatchObject({ tier: "direct", turn_budget_estimate: 12 });
  });
});

describe("extractDeclaredScope — bare-name regex does not split hyphenated path segments (bench v4 A5)", () => {
  it("a slash-qualified hyphenated file yields one path, never its hyphen tail as a phantom bare file", async () => {
    const { extractDeclaredScope } = await import("../src/arbiter-intake.js");
    const scope = extractDeclaredScope("Write a new guide at docs/Guides/Decorators-Quickstart.md documenting the API.");
    expect(scope.write_paths).toEqual(["docs/Guides/Decorators-Quickstart.md"]);
  });
});

describe("extractDeclaredScope — exact write allowlists", () => {
  it("does not turn read-only fixtures and verification inputs into write authority", async () => {
    const { extractDeclaredScope, extractExactWritePaths } = await import("../src/arbiter-intake.js");
    const task = "Create exactly index.html, styles.css, app.js, and README.md; do not modify tests/site.test.mjs or package.json. Verify with: node --test tests/site.test.mjs.";
    expect(extractExactWritePaths(task)).toEqual(["index.html", "styles.css", "app.js", "README.md"]);
    expect(extractDeclaredScope(task)).toEqual({
      write_paths: ["index.html", "styles.css", "app.js", "README.md"],
      command_argv: [["node", "--test", "tests/site.test.mjs"]],
    });
  });
});
