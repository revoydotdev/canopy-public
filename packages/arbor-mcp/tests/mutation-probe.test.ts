/**
 * X-2 (ADR-069, diff∪sibling mutation probe): behavior tests for
 * `probeMutations` and its supporting pure mutation-operator/site-selection
 * seams. Mirrors `test-amplifier.test.ts`'s fixture style -- a fake
 * `MachineVerificationCommandPort` injected, no real process spawn, no real
 * filesystem I/O (in-memory `read_file`/`write_file`).
 */
import { describe, expect, it } from "vitest";
import type { MachineVerificationCommandPort, MachineVerificationCommandResult } from "../src/worktree-machine-verifier.js";
import type { AmplifierModelPort } from "../src/test-amplifier.js";
import {
  ARBOR_MUTATION_HARDEN_ENV,
  ARBOR_MUTATION_PROBE_ENV,
  MUTATION_HARDEN_BUDGET_MS,
  MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES,
  MUTATION_PROBE_MAX_MUTANTS,
  MUTATION_PROBE_MAX_SURVIVORS,
  MUTATION_PROBE_TOTAL_BUDGET_MS,
  booleanNegationMutation,
  comparisonFlipMutation,
  earlyReturnRemovalMutation,
  killerTestPromptFor,
  numericConstantMutation,
  probeMutations,
  selectCandidateSites,
  truncateKillerSource,
  type MutationSite,
  type ProbeMutationsInput,
} from "../src/mutation-probe.js";

function exitedResult(exit: number): MachineVerificationCommandResult {
  return { kind: "exited", exit, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}

function fakeFiles(initial: Record<string, string>): {
  files: Record<string, string>;
  writeLog: { path: string; content: string }[];
  read_file: (path: string) => string;
  write_file: (path: string, content: string) => void;
} {
  const files = { ...initial };
  const writeLog: { path: string; content: string }[] = [];
  return {
    files,
    writeLog,
    read_file: (path: string) => {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      return files[path]!;
    },
    write_file: (path: string, content: string) => {
      writeLog.push({ path, content });
      files[path] = content;
    },
  };
}

function baseInput(overrides: Partial<ProbeMutationsInput> = {}): ProbeMutationsInput {
  const fs = fakeFiles({ "a.ts": "if (x < 10) {\n  return true;\n}\n" });
  return {
    worktree_path: "/wt",
    diff_changed_lines: [{ file: "a.ts", line: 1 }],
    sibling_flagged_sites: [],
    command_port: { async run() { return exitedResult(1); } },
    acceptance_command: () => ({ argv: ["true"], network: "enforced_denied" }),
    env: { [ARBOR_MUTATION_PROBE_ENV]: "on" },
    read_file: fs.read_file,
    write_file: fs.write_file,
    ...overrides,
  };
}

describe("probeMutations — disabled by default", () => {
  it("returns [] and never touches the filesystem or command port when the env flag is unset", async () => {
    let commandCalls = 0;
    let writeCalls = 0;
    const findings = await probeMutations(baseInput({
      env: {},
      command_port: { async run() { commandCalls += 1; return exitedResult(0); } },
      write_file: () => { writeCalls += 1; },
    }));
    expect(findings).toEqual([]);
    expect(commandCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });

  it("returns [] when the env flag is set to something other than \"on\"", async () => {
    const findings = await probeMutations(baseInput({ env: { [ARBOR_MUTATION_PROBE_ENV]: "true" } }));
    expect(findings).toEqual([]);
  });
});

describe("comparisonFlipMutation", () => {
  it("flips === to !==, longest-token-first", () => {
    const result = comparisonFlipMutation("if (a === b) return;");
    expect(result?.mutated).toBe("if (a !== b) return;");
    expect(result?.description).toContain("===");
    expect(result?.description).toContain("!==");
  });
  it("flips <= to < without mistaking it for bare <", () => {
    const result = comparisonFlipMutation("if (a <= b) return;");
    expect(result?.mutated).toBe("if (a < b) return;");
  });
  it("flips bare < to <=", () => {
    const result = comparisonFlipMutation("if (a < b) return;");
    expect(result?.mutated).toBe("if (a <= b) return;");
  });
  it("returns null when no comparison operator is present", () => {
    expect(comparisonFlipMutation("const x = 1;")).toBeNull();
  });
});

describe("booleanNegationMutation", () => {
  it("negates a single-line if condition", () => {
    const result = booleanNegationMutation("if (ready) {");
    expect(result?.mutated).toBe("if (!(ready)) {");
  });
  it("returns null for a non-if line", () => {
    expect(booleanNegationMutation("const ready = true;")).toBeNull();
  });
});

describe("numericConstantMutation", () => {
  it("increments the first standalone integer literal", () => {
    const result = numericConstantMutation("const MAX = 10;");
    expect(result?.mutated).toBe("const MAX = 11;");
  });
  it("returns null when there is no numeric literal", () => {
    expect(numericConstantMutation("const s = \"none\";")).toBeNull();
  });
});

describe("earlyReturnRemovalMutation", () => {
  it("blanks a return statement, preserving line count", () => {
    const result = earlyReturnRemovalMutation("  return true;");
    expect(result?.mutated).toBe("");
  });
  it("returns null for a non-return line", () => {
    expect(earlyReturnRemovalMutation("const x = 1;")).toBeNull();
  });
});

describe("selectCandidateSites", () => {
  it("dedupes the diff∪sibling union by (file, line), diff sites first", () => {
    const diff: MutationSite[] = [{ file: "a.ts", line: 1 }, { file: "b.ts", line: 2 }];
    const sibling: MutationSite[] = [{ file: "a.ts", line: 1 }, { file: "c.ts", line: 3 }];
    expect(selectCandidateSites(diff, sibling)).toEqual([
      { file: "a.ts", line: 1 },
      { file: "b.ts", line: 2 },
      { file: "c.ts", line: 3 },
    ]);
  });
});

describe("probeMutations — mutant lifecycle", () => {
  it("produces no finding when the acceptance command kills the mutant (non-zero exit)", async () => {
    const findings = await probeMutations(baseInput({
      command_port: { async run() { return exitedResult(1); } },
    }));
    expect(findings).toEqual([]);
  });

  it("produces a survivor finding when the acceptance command still exits 0 with the mutant in place", async () => {
    const findings = await probeMutations(baseInput({
      command_port: { async run() { return exitedResult(0); } },
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ site: { file: "a.ts", line: 1 }, survived: true });
    expect(findings[0]?.mutant_description).toContain("comparison flip");
  });

  it("produces no finding when the command never reaches a real exit (e.g. timed out)", async () => {
    const findings = await probeMutations(baseInput({
      command_port: { async run() { return { kind: "timed_out", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } },
    }));
    expect(findings).toEqual([]);
  });

  it("restores the original file bytes byte-identically after a killed mutant", async () => {
    const original = "if (x < 10) {\n  return true;\n}\n";
    const fs = fakeFiles({ "a.ts": original });
    await probeMutations(baseInput({
      diff_changed_lines: [{ file: "a.ts", line: 1 }],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: { async run() { return exitedResult(1); } },
    }));
    expect(fs.files["a.ts"]).toBe(original);
    // Mutant was written then restored -- two writes for the one site.
    expect(fs.writeLog.map((entry) => entry.content)).toContain(original);
  });

  it("restores the original file bytes byte-identically even when the command port throws", async () => {
    const original = "if (x < 10) {\n  return true;\n}\n";
    const fs = fakeFiles({ "a.ts": original });
    const findings = await probeMutations(baseInput({
      diff_changed_lines: [{ file: "a.ts", line: 1 }],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: { async run() { throw new Error("port exploded"); } },
    }));
    expect(findings).toEqual([]);
    expect(fs.files["a.ts"]).toBe(original);
  });

  it("restores the original file bytes byte-identically for a survivor too", async () => {
    const original = "if (x < 10) {\n  return true;\n}\n";
    const fs = fakeFiles({ "a.ts": original });
    await probeMutations(baseInput({
      diff_changed_lines: [{ file: "a.ts", line: 1 }],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: { async run() { return exitedResult(0); } },
    }));
    expect(fs.files["a.ts"]).toBe(original);
  });

  it("skips a site with no applicable mutation operator and produces no finding for it", async () => {
    const fs = fakeFiles({ "a.ts": "const s = \"no mutation here\";\n" });
    const findings = await probeMutations(baseInput({
      diff_changed_lines: [{ file: "a.ts", line: 1 }],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: { async run() { return exitedResult(0); } },
    }));
    expect(findings).toEqual([]);
  });

  it("caps total mutants at MUTATION_PROBE_MAX_MUTANTS across many candidate sites", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `if (x < ${i}) return;`);
    const fs = fakeFiles({ "a.ts": lines.join("\n") });
    const sites: MutationSite[] = lines.map((_, i) => ({ file: "a.ts", line: i + 1 }));
    let calls = 0;
    await probeMutations(baseInput({
      diff_changed_lines: sites,
      sibling_flagged_sites: [],
      read_file: fs.read_file,
      write_file: fs.write_file,
      // Never survives, so the run never stops early on the survivor cap --
      // isolates the mutant-count cap specifically.
      command_port: { async run() { calls += 1; return exitedResult(1); } },
    }));
    expect(calls).toBe(MUTATION_PROBE_MAX_MUTANTS);
  });

  it("stops after MUTATION_PROBE_MAX_SURVIVORS survivors even with more candidate mutants available", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `if (x < ${i}) return;`);
    const fs = fakeFiles({ "a.ts": lines.join("\n") });
    const sites: MutationSite[] = lines.map((_, i) => ({ file: "a.ts", line: i + 1 }));
    let calls = 0;
    const findings = await probeMutations(baseInput({
      diff_changed_lines: sites,
      sibling_flagged_sites: [],
      read_file: fs.read_file,
      write_file: fs.write_file,
      command_port: { async run() { calls += 1; return exitedResult(0); } },
    }));
    expect(findings).toHaveLength(MUTATION_PROBE_MAX_SURVIVORS);
    expect(calls).toBe(MUTATION_PROBE_MAX_SURVIVORS);
  });

  it("stops dispatching once the total time budget is exhausted", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `if (x < ${i}) return;`);
    const fs = fakeFiles({ "a.ts": lines.join("\n") });
    const sites: MutationSite[] = lines.map((_, i) => ({ file: "a.ts", line: i + 1 }));
    let calls = 0;
    // Clock: 0 for the first three reads (start-time, iter-1 loop check,
    // iter-1 remaining-budget calc), then jumps past the total budget --
    // iter-1 dispatches, iter-2's loop check then breaks before dispatching.
    let callIndex = 0;
    await probeMutations(baseInput({
      diff_changed_lines: sites,
      sibling_flagged_sites: [],
      read_file: fs.read_file,
      write_file: fs.write_file,
      now: () => { const value = callIndex < 3 ? 0 : MUTATION_PROBE_TOTAL_BUDGET_MS; callIndex += 1; return value; },
      command_port: { async run() { calls += 1; return exitedResult(1); } },
    }));
    expect(calls).toBe(1);
  });
});

function readyModelPort(text: string): AmplifierModelPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    ready: true,
    calls,
    async call(prompt: string) {
      calls.push(prompt);
      return { ok: true, text };
    },
  };
}

const ORIGINAL_A_TS = "if (x < 10) {\n  return true;\n}\n";

/**
 * A command port distinguishing the base probe's `accept` command (always
 * exit `0`, so the mutant survives) from a killer test's `kill` command,
 * whose exit code depends on the CURRENT bytes of `a.ts` in the fake
 * filesystem at call time -- exit `0` (passes) when `a.ts` holds its
 * original content, exit `1` (fails) when it holds the mutant.
 */
function rigorousCommandPort(fs: { files: Record<string, string> }): { port: MachineVerificationCommandPort; killerCalls: number } {
  let killerCalls = 0;
  return {
    killerCalls,
    port: {
      async run(request) {
        if (request.argv[0] === "accept") return exitedResult(0);
        killerCalls += 1;
        return exitedResult(fs.files["a.ts"] === ORIGINAL_A_TS ? 0 : 1);
      },
    },
  };
}

function hardenInput(overrides: Partial<ProbeMutationsInput> = {}): { input: ProbeMutationsInput; fs: ReturnType<typeof fakeFiles> } {
  const fs = fakeFiles({ "a.ts": ORIGINAL_A_TS });
  const input = baseInput({
    diff_changed_lines: [{ file: "a.ts", line: 1 }],
    read_file: fs.read_file,
    write_file: fs.write_file,
    acceptance_command: () => ({ argv: ["accept"], network: "enforced_denied" as const }),
    env: { [ARBOR_MUTATION_PROBE_ENV]: "on", [ARBOR_MUTATION_HARDEN_ENV]: "on" },
    command_port: { async run(request) { return exitedResult(request.argv[0] === "accept" ? 0 : 1); } },
    harden_model_port: readyModelPort("describe(\"killer\", () => { it(\"kills the mutant\", () => {}); });"),
    run_killer_test: (testFilePath: string) => ({ argv: ["kill", testFilePath], network: "enforced_denied" as const }),
    ...overrides,
  });
  return { input, fs };
}

describe("probeMutations — PM-2 (ADR-071, X) CoHarden-lite hardening", () => {
  it("upgrades a survivor to hardened with killer_test_source when the generated test passes on real code and fails on the mutant", async () => {
    const { input, fs } = hardenInput();
    const { port } = rigorousCommandPort(fs);
    const findings = await probeMutations({ ...input, command_port: port });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ survived: true, hardened: true });
    expect(findings[0]?.killer_test_source).toContain("kills the mutant");
    // Restoration remains a hard requirement even through hardening.
    expect(fs.files["a.ts"]).toBe(ORIGINAL_A_TS);
  });

  it("discards hardening (plain survivor, no hardened field) when the generated test kills neither real nor mutant code", async () => {
    const { input, fs } = hardenInput({
      run_killer_test: (testFilePath: string) => ({ argv: ["always-pass", testFilePath], network: "enforced_denied" as const }),
    });
    const findings = await probeMutations({
      ...input,
      command_port: {
        async run(request) {
          if (request.argv[0] === "accept") return exitedResult(0);
          return exitedResult(0); // killer test passes against everything -- never catches the mutant.
        },
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ site: { file: "a.ts", line: 1 }, mutant_description: expect.stringContaining("comparison flip"), survived: true });
    expect(findings[0]?.hardened).toBeUndefined();
    expect(fs.files["a.ts"]).toBe(ORIGINAL_A_TS);
  });

  it("discards hardening when the generated test fails even against real code (leg 1)", async () => {
    const { input, fs } = hardenInput();
    const findings = await probeMutations({
      ...input,
      command_port: {
        async run(request) {
          if (request.argv[0] === "accept") return exitedResult(0);
          return exitedResult(1); // killer test fails against real code -- not rigorous, no leg 2 ever needed.
        },
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.hardened).toBeUndefined();
    expect(fs.files["a.ts"]).toBe(ORIGINAL_A_TS);
  });

  it("restores the site file byte-identically even when hardening's leg-2 command port throws", async () => {
    const { input, fs } = hardenInput();
    let leg = 0;
    const findings = await probeMutations({
      ...input,
      command_port: {
        async run(request) {
          if (request.argv[0] === "accept") return exitedResult(0);
          leg += 1;
          if (leg === 1) return exitedResult(0); // leg 1 (real code) passes
          throw new Error("killer command port exploded on leg 2");
        },
      },
    });
    expect(findings[0]?.hardened).toBeUndefined();
    expect(fs.files["a.ts"]).toBe(ORIGINAL_A_TS);
  });

  it("performs zero model or killer-test calls when ARBOR_MUTATION_HARDEN is unset (probe still on)", async () => {
    const { input, fs } = hardenInput({ env: { [ARBOR_MUTATION_PROBE_ENV]: "on" } });
    const modelPort = input.harden_model_port as ReturnType<typeof readyModelPort>;
    const { port } = rigorousCommandPort(fs);
    let acceptCalls = 0;
    const findings = await probeMutations({
      ...input,
      command_port: {
        async run(request) {
          if (request.argv[0] === "accept") { acceptCalls += 1; return exitedResult(0); }
          return port.run(request);
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.hardened).toBeUndefined();
    expect(modelPort.calls).toHaveLength(0);
    expect(acceptCalls).toBe(1);
  });

  it("performs zero model or killer-test calls when the harden model port is absent", async () => {
    const { input } = hardenInput({ harden_model_port: undefined });
    const findings = await probeMutations(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.hardened).toBeUndefined();
  });

  it("performs zero model or killer-test calls when the harden model port is not ready", async () => {
    const { input, fs } = hardenInput({
      harden_model_port: { ready: false, async call() { return { ok: false, error: "not ready" }; } },
    });
    const { port } = rigorousCommandPort(fs);
    let killerCalls = 0;
    const findings = await probeMutations({
      ...input,
      command_port: {
        async run(request) {
          if (request.argv[0] !== "accept") killerCalls += 1;
          return port.run(request);
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.hardened).toBeUndefined();
    expect(killerCalls).toBe(0);
  });

  it("truncates a generated killer test's source over the byte cap, marking the truncation", () => {
    const long = "x".repeat(MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES + 500);
    const truncated = truncateKillerSource(long);
    expect(Buffer.byteLength(truncated, "utf-8")).toBeLessThanOrEqual(MUTATION_HARDEN_KILLER_SOURCE_MAX_BYTES);
    expect(truncated).toContain("[truncated]");
  });

  it("leaves a killer source under the byte cap unchanged", () => {
    const short = "const x = 1;";
    expect(truncateKillerSource(short)).toBe(short);
  });

  it("killerTestPromptFor names the mutant's file, line, and description", () => {
    const prompt = killerTestPromptFor({ file: "a.ts", line: 1 }, "comparison flip: \"<\" -> \"<=\"");
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("line: 1");
    expect(prompt).toContain("comparison flip");
  });

  it("calls the harden model port with the killer-test prompt for each survivor, and deletes the generated test file afterward", async () => {
    const { input, fs } = hardenInput();
    const { port } = rigorousCommandPort(fs);
    const deleted: string[] = [];
    const findings = await probeMutations({
      ...input,
      command_port: port,
      delete_file: (path: string) => { deleted.push(path); },
    });
    const modelPort = input.harden_model_port as ReturnType<typeof readyModelPort>;
    expect(modelPort.calls).toHaveLength(1);
    expect(modelPort.calls[0]).toContain("comparison flip");
    expect(findings[0]?.hardened).toBe(true);
    expect(deleted).toHaveLength(1);
  });

  it("stops dispatching further hardening once MUTATION_HARDEN_BUDGET_MS is exhausted", async () => {
    // Two candidate survivor sites, both surviving the base probe. The
    // clock is gated on the probe phase's own `accept` dispatches (not a
    // raw call count, so this stays robust to incidental now()-call-count
    // changes elsewhere): it reads 0 throughout the probe phase, 0 once
    // more for hardening's own deadline computation, then jumps past the
    // harden deadline for every call after that -- so the very first
    // per-survivor loop check already sees the budget exhausted and the
    // harden model port is never called at all.
    const lines = ["if (x < 1) return;", "if (x < 2) return;"];
    const fs = fakeFiles({ "a.ts": lines.join("\n") });
    const sites: MutationSite[] = lines.map((_, i) => ({ file: "a.ts", line: i + 1 }));
    let modelCalls = 0;
    let acceptCalls = 0;
    let postProbeCalls = 0;
    const input = baseInput({
      diff_changed_lines: sites,
      sibling_flagged_sites: [],
      read_file: fs.read_file,
      write_file: fs.write_file,
      acceptance_command: () => ({ argv: ["accept"], network: "enforced_denied" as const }),
      env: { [ARBOR_MUTATION_PROBE_ENV]: "on", [ARBOR_MUTATION_HARDEN_ENV]: "on" },
      command_port: {
        async run(request) {
          if (request.argv[0] === "accept") { acceptCalls += 1; return exitedResult(0); }
          return exitedResult(1);
        },
      },
      harden_model_port: { ready: true, async call() { modelCalls += 1; return { ok: true, text: "const x = 1;" }; } },
      run_killer_test: (testFilePath: string) => ({ argv: ["kill", testFilePath], network: "enforced_denied" as const }),
      now: () => {
        if (acceptCalls < sites.length) return 0;
        postProbeCalls += 1;
        return postProbeCalls === 1 ? 0 : MUTATION_HARDEN_BUDGET_MS + 1;
      },
    });
    const findings = await probeMutations(input);
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.hardened === undefined)).toBe(true);
    expect(modelCalls).toBe(0);
  });
});
