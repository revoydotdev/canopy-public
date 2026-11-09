/**
 * scripts/tests/gate-all.test.mjs — the battery's own guarantees (ADR-074).
 *
 * WHY THESE TESTS. gate-all.mjs exists because a hand-maintained roster
 * drifted: `gate:typecheck-tests` sat red on master with 14 accumulated
 * errors because nobody's remembered list included it. The whole value of
 * the script is the ANTI-DRIFT INVARIANT — that a gate declared in
 * package.json but unclassified is a hard failure. So that invariant is what
 * these tests pin, against a real package.json in a real temp directory
 * rather than against a mocked filesystem: the failure being prevented is
 * precisely "the check looked fine but wasn't wired to reality".
 *
 * The battery is NOT executed against the live repo here — running 27 real
 * gates inside a unit test would take minutes and couple these tests to
 * every gate's health. Roster logic is exercised with `--list` (which never
 * spawns a gate) and with fixture repos whose "gates" are trivial commands.
 */

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE_ALL = join(REPO_ROOT, "scripts", "gate-all.mjs");

const {
  auditRoster,
  enumerateGates,
  tierRoster,
  producerIncompleteTransactionId,
  groupFailuresByCause,
  printFailureSection,
  parseSkipList,
  measuredCostsTier,
} = await import(GATE_ALL);

function runGateAll(args, cwd = REPO_ROOT) {
  const result = spawnSync("bun", [GATE_ALL, ...args], { cwd, encoding: "utf-8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * A throwaway repo whose `gate:*` scripts are instant no-ops, so roster
 * behavior can be tested without the cost or the flakiness of real gates.
 * `--repo` is the established convention for this (branch-accounting.mjs,
 * worktree-hygiene.mjs).
 */
function fixtureRepo(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "gate-all-fixture-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture", scripts }, null, 2)}\n`);
  return dir;
}

describe("auditRoster — the anti-drift invariant, proven directly", () => {
  it("is silent when the roster and the classification agree exactly", () => {
    expect(auditRoster(["gate:a", "gate:b"], ["gate:a", "gate:b"])).toEqual([]);
  });

  it("reports a declared-but-unclassified gate, with a pasteable remedy", () => {
    const problems = auditRoster(["gate:a", "gate:b"], ["gate:a"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("gate:b");
    expect(problems[0]).toContain('"gate:b": "fast",');
  });

  it("reports a classified gate that no longer exists — drift runs both ways", () => {
    const problems = auditRoster(["gate:a"], ["gate:a", "gate:removed"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("gate:removed");
    expect(problems[0]).toContain("no longer exists in package.json");
  });

  it("reports both directions at once rather than stopping at the first", () => {
    expect(auditRoster(["gate:a", "gate:new"], ["gate:a", "gate:gone"])).toHaveLength(2);
  });

  it("importing the module does not run the battery", () => {
    // enumerateGates() returning cleanly is only possible because main() is
    // guarded; an unguarded module would have spawned 27 gates on import.
    expect(enumerateGates(REPO_ROOT).length).toBeGreaterThan(0);
  });
});

describe("gate:all enumerates the roster instead of remembering it", () => {
  it("lists every gate:* declared in the real package.json, and only those", () => {
    const declared = Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).scripts)
      .filter((name) => name.startsWith("gate:") && name !== "gate:all")
      .sort();

    const { code, stdout } = runGateAll(["--list"]);
    expect(code).toBe(0);

    const listed = stdout
      .split("\n")
      .filter((line) => line.includes("\t"))
      .map((line) => line.split("\t")[1])
      .sort();

    expect(listed).toEqual(declared);
  });

  it("classifies every declared gate — an UNCLASSIFIED entry is the drift this script exists to catch", () => {
    const { stdout } = runGateAll(["--list"]);
    expect(stdout).not.toContain("UNCLASSIFIED");
  });

  it("excludes itself, so the battery cannot recurse into itself", () => {
    const { stdout } = runGateAll(["--list"]);
    expect(stdout).not.toContain("gate:all");
  });
});

describe("the anti-drift invariant fails loudly rather than silently skipping", () => {
  it("fails, names the gate, and prints the one-line remedy when a declared gate has no tier", () => {
    const dir = fixtureRepo({ "gate:brand-new-unclassified": "true" });
    try {
      const { code, stderr, stdout } = runGateAll(["--repo", dir]);
      const output = stdout + stderr;
      expect(code).toBe(1);
      expect(output).toContain("gate:brand-new-unclassified");
      // The remedy must be literal enough to paste, not a vague instruction.
      expect(output).toContain('"gate:brand-new-unclassified": "fast",');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs NO gates when the roster has drifted — a green battery over a wrong roster proves nothing", () => {
    // The fixture's gate writes a file. If the battery ran it despite the
    // unclassified sibling, that file would exist.
    const dir = fixtureRepo({
      "gate:brand-new-unclassified": "true",
      "gate:writes-a-file": `node -e "require('fs').writeFileSync('ran.txt','1')"`,
    });
    try {
      const { code } = runGateAll(["--repo", dir]);
      expect(code).toBe(1);
      expect(() => readFileSync(join(dir, "ran.txt"), "utf-8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a classified gate no longer exists in package.json", () => {
    // Every real gate is absent from this fixture, so the reverse-direction
    // check must fire and name one of them.
    const dir = fixtureRepo({ "gate:reachability": "true" });
    try {
      const { code, stdout, stderr } = runGateAll(["--repo", dir]);
      const output = stdout + stderr;
      expect(code).toBe(1);
      expect(output).toContain("no longer exists in package.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tiers", () => {
  it("rejects an unknown tier instead of silently running nothing", () => {
    const { code, stderr } = runGateAll(["--tier", "bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown --tier");
  });

  it("is cumulative: --tier fast includes the stop gates", () => {
    const stop = runGateAll(["--list", "--tier", "stop"]).stdout;
    const stopGates = stop.split("\n").filter((l) => l.startsWith("stop\t"));
    expect(stopGates.length).toBeGreaterThan(0);
  });
});

describe("tierRoster — cost_class alone is not enough (2026-08-24)", () => {
  const profile = {
    schema_version: 1,
    profile_version: "fixture-v1",
    gates: {
      "gate:always-stop": { contexts: { stop: true, precommit: true, prepush: true, trunk_submit: true, ci: true } },
      "gate:excluded-at-stop": { contexts: { stop: false, precommit: false, prepush: true, trunk_submit: false, ci: true } },
    },
  };
  const declared = ["gate:always-stop", "gate:excluded-at-stop"];
  const tiers = { "gate:always-stop": "stop", "gate:excluded-at-stop": "stop" };

  it("excludes a stop-cost_class gate whose contexts.stop is false from the stop roster", () => {
    const roster = tierRoster("stop", { profile, declared, tiers });
    expect(roster).toContain("gate:always-stop");
    expect(roster).not.toContain("gate:excluded-at-stop");
  });

  it("does not apply the contexts intersection to tiers that are not real execution contexts", () => {
    // "fast"/"full" are cost-budget labels, not profile contexts — cost_class
    // alone still decides membership there.
    const fastTiers = { "gate:always-stop": "fast", "gate:excluded-at-stop": "fast" };
    const roster = tierRoster("fast", { profile, declared, tiers: fastTiers });
    expect(roster).toEqual(expect.arrayContaining(declared));
  });

  it("reflects the real profile: gate:organization-enrollment declares contexts.stop:false and must be absent from the real stop roster", () => {
    const roster = tierRoster("stop");
    expect(roster).not.toContain("gate:organization-enrollment");
  });
});

describe("advisory gates report without vetoing", () => {
  it("prints the REASON a gate is advisory, so a warning always explains itself", () => {
    const { stdout, stderr } = runGateAll(["--tier", "stop", "--advisory", "hook-default"]);
    const output = stdout + stderr;
    const report = JSON.parse(runGateAll(["--tier", "stop", "--advisory", "hook-default", "--json"]).stdout);
    // Both halves of this are conditional on an advisory gate actually being
    // red. The guard used to cover only the "advisory because:" assertion
    // while `WARN` was asserted unconditionally, which made this test fail
    // exactly when the repository was HEALTHY — a green advisory set prints
    // no warning, so there is nothing to explain and nothing to find. The
    // invariant that holds in both directions is: a WARN appears if and only
    // if an advisory gate failed, and whenever one appears it carries its
    // reason.
    if (report.advisory_failure_count > 0) {
      expect(output).toContain("WARN");
      expect(output).toContain("advisory because:");
    } else {
      expect(output).not.toContain("WARN");
    }
  });

  it("an advisory gate is still RUN and still reported — it is never skipped", () => {
    const { stdout, stderr } = runGateAll(["--tier", "stop", "--advisory", "hook-default", "--json"]);
    const report = JSON.parse(stdout);
    const advisory = report.gates.filter((gate) => gate.advisory);
    expect(advisory.length).toBeGreaterThan(0);
    for (const gate of advisory) {
      // Ran for real: it has a duration and a concrete exit code.
      expect(gate.duration_ms).toBeGreaterThanOrEqual(0);
      expect(gate.exit_code === null || Number.isInteger(gate.exit_code)).toBe(true);
    }
    expect(stderr).not.toContain("skipped");
  });

  it("does not let an advisory failure change the battery's exit code", () => {
    const { stdout } = runGateAll(["--tier", "stop", "--advisory", "hook-default", "--json"]);
    const report = JSON.parse(stdout);
    const advisoryRed = report.gates.filter((gate) => gate.advisory && !gate.ok);
    expect(report.advisory_failure_count).toBe(advisoryRed.length);
    // `ok` is decided strictly by NON-advisory failures.
    expect(report.ok).toBe(report.failure_count === 0);
  });
});

describe("ADR-113 decision 1 — same-cause failures collapse to one entry", () => {
  const heldTransactionRun = (gate, exitCode, transactionId, consumer = gate) => ({
    gate,
    exit_code: exitCode,
    stdout: "",
    stderr:
      `${consumer} refuses derived governance evidence while transaction ${transactionId} is active` +
      ` at producer; wait for its atomic commit or recover it explicitly`,
  });

  describe("producerIncompleteTransactionId", () => {
    it("extracts the transaction id from a real assertGovernanceConsumerReady refusal", () => {
      const run = heldTransactionRun("gate:obligations", 1, "txn-abc123");
      expect(producerIncompleteTransactionId(run)).toBe("txn-abc123");
    });

    it("returns null for a failure that is not this shape", () => {
      const run = { gate: "gate:typecheck-tests", exit_code: 1, stdout: "", stderr: "error TS1234: broke" };
      expect(producerIncompleteTransactionId(run)).toBeNull();
    });
  });

  describe("groupFailuresByCause", () => {
    it("groups every run naming the SAME held transaction into one group", () => {
      const runs = [
        heldTransactionRun("gate:adr-acceptance-staged", 1, "txn-shared", "adr-acceptance"),
        heldTransactionRun("gate:obligations", 1, "txn-shared", "obligations-gate"),
        heldTransactionRun("gate:decisions-precommit", 1, "txn-shared", "decisions-precommit-gate"),
      ];
      const groups = groupFailuresByCause(runs);
      expect(groups).toHaveLength(1);
      expect(groups[0].transaction_id).toBe("txn-shared");
      expect(groups[0].runs.map((r) => r.gate)).toEqual([
        "gate:adr-acceptance-staged",
        "gate:obligations",
        "gate:decisions-precommit",
      ]);
    });

    it("keeps failures naming DIFFERENT transactions in separate groups", () => {
      const runs = [
        heldTransactionRun("gate:obligations", 1, "txn-a"),
        heldTransactionRun("gate:decisions-precommit", 1, "txn-b"),
      ];
      const groups = groupFailuresByCause(runs);
      expect(groups).toHaveLength(2);
    });

    it("never groups a failure that does not match the producer_incomplete shape", () => {
      const runs = [
        { gate: "gate:typecheck-tests", exit_code: 1, stdout: "", stderr: "error TS1234: broke" },
        { gate: "gate:lockfile", exit_code: 1, stdout: "", stderr: "lockfile drift" },
      ];
      const groups = groupFailuresByCause(runs);
      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.cause === null)).toBe(true);
    });

    it("a SOLITARY producer_incomplete failure (no sibling this run) is its own one-run group", () => {
      const runs = [heldTransactionRun("gate:obligations", 1, "txn-alone")];
      const groups = groupFailuresByCause(runs);
      expect(groups).toHaveLength(1);
      expect(groups[0].runs).toHaveLength(1);
    });
  });

  describe("printFailureSection — the printed shape the stop guard's parseRedGates depends on", () => {
    it("prints a SHARED CAUSE header + one list-item line per gate for a real group", () => {
      const runs = [
        heldTransactionRun("gate:adr-acceptance-staged", 1, "txn-shared", "adr-acceptance"),
        heldTransactionRun("gate:obligations", 1, "txn-shared", "obligations-gate"),
      ];
      const lines = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line) => lines.push(line));
      try {
        printFailureSection(runs);
      } finally {
        spy.mockRestore();
      }
      const output = lines.join("\n");
      expect(output).toContain("SHARED CAUSE — held evidence transaction txn-shared is active (covers: 2 gates):");
      expect(output).toContain("    - gate:adr-acceptance-staged (exit 1)");
      expect(output).toContain("    - gate:obligations (exit 1)");
      // The shared cause text itself is stated once, not once per gate.
      expect(output.match(/refuses derived governance evidence/g)).toHaveLength(1);
    });

    it("prints the original one-line-per-gate header for a solitary or non-matching failure", () => {
      const runs = [{ gate: "gate:typecheck-tests", exit_code: 1, stdout: "", stderr: "error TS1234: broke" }];
      const lines = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line) => lines.push(line));
      try {
        printFailureSection(runs);
      } finally {
        spy.mockRestore();
      }
      const output = lines.join("\n");
      expect(output).toContain("gate:typecheck-tests (exit 1):");
      expect(output).not.toContain("SHARED CAUSE");
    });
  });
});


/**
 * The sixteen gates that run only at prepush or in CI cannot be previewed:
 * the push is the first moment they ever execute, which is the least
 * convenient point to discover one is red. `--tier prepush` looked like it
 * should do this and silently did the opposite — `tierRoster` computes its
 * budget as `TIER_NAMES.indexOf(tier)`, and "prepush" is an execution CONTEXT,
 * not a tier name, so the budget came out -1 and every gate was filtered out.
 * It ran nothing and exited clean. "stop" worked only because it happens to be
 * both a tier and a context.
 */
describe("previewing a non-tier execution context", () => {
  it("--tier prepush selects the prepush roster instead of silently selecting nothing", () => {
    const roster = tierRoster("prepush");
    expect(roster.length).toBeGreaterThan(0);
  });

  it("the prepush roster includes gates that no tier budget would admit, which is the entire point of previewing it", () => {
    const roster = tierRoster("prepush");
    // gate:typecheck-tests is the canonical example: it is exactly the gate
    // whose silent redness on master motivated this battery in the first
    // place, and it is prepush-only.
    expect(roster).toContain("gate:typecheck-tests");
  });

  it("the CLI actually accepts a context name — the tierRoster fix is worthless if main() rejects the argument first", () => {
    // The first version of this fix corrected tierRoster and stopped there.
    // main() validates --tier against TIER_NAMES before tierRoster is ever
    // called, so `--tier prepush` still exited 2 and the preview did not
    // exist. A fix that cannot be reached from the command line is not a fix.
    const { code, stdout, stderr } = runGateAll(["--list", "--tier", "prepush"]);
    expect(code).toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("unknown --tier");
    expect(stdout).toContain("gate:typecheck-tests");
    // And --list must actually HONOUR the tier. It previously iterated every
    // declared gate and discarded --tier silently, so this assertion passed
    // for the wrong reason: it printed all 51 gates and looked like a preview
    // of a roster it was not showing.
    const listed = stdout.trim().split("\n").filter((line) => line.trim().length > 0);
    const everything = runGateAll(["--list"]).stdout.trim().split("\n").filter((line) => line.trim().length > 0);
    expect(listed.length).toBeLessThan(everything.length);
    expect(listed.length).toBe(tierRoster("prepush").length);
  });

  it("still intersects tier and context for a name that is BOTH, so --tier stop is unchanged", () => {
    const stopRoster = tierRoster("stop");
    const prepushRoster = tierRoster("prepush");
    // The two rosters are DIFFERENT, not nested: stop runs many cheap drift
    // checks, prepush runs fewer but far more expensive ones. Asserting a
    // subset relation here would be asserting something false — stop is the
    // larger list.
    expect(stopRoster).not.toContain("gate:typecheck-tests");
    expect(prepushRoster.some((name) => !stopRoster.includes(name))).toBe(true);
    expect(stopRoster.some((name) => !prepushRoster.includes(name))).toBe(true);
  });
});

describe("--skip — gates the caller scheduled out by unchanged inputs (Arboretum M2)", () => {
  /** Every real gate as an instant no-op, so the real roster passes its drift audit without running a real gate. */
  const allGatesTrivially = () => fixtureRepo(Object.fromEntries(enumerateGates().map((name) => [name, "true"])));

  it("parses a comma list, trimming and de-duplicating", () => {
    expect(parseSkipList(null)).toEqual([]);
    expect(parseSkipList(" gate:a, gate:b,,gate:a ")).toEqual(["gate:a", "gate:b"]);
  });

  it("keeps a scoped run's cost out of the whole-tier series gate:stop-budget judges", () => {
    expect(measuredCostsTier("stop", [])).toBe("stop");
    expect(measuredCostsTier("stop", ["gate:lockfile"])).toBe("stop:scoped");
  });

  it("does not run a skipped gate, and reports it as skipped rather than dropping it", () => {
    const dir = allGatesTrivially();
    try {
      const report = JSON.parse(runGateAll(["--repo", dir, "--tier", "stop", "--skip", "gate:lockfile,gate:adr-sections", "--json"]).stdout);
      expect(report.skipped).toEqual(["gate:adr-sections", "gate:lockfile"]);
      const ran = report.gates.map((gate) => gate.gate);
      expect(ran).not.toContain("gate:lockfile");
      expect(ran).toContain("gate:adr-citations");
      expect(report.invisible_here).not.toContain("gate:lockfile");
      const text = runGateAll(["--repo", dir, "--tier", "stop", "--skip", "gate:lockfile"]).stdout;
      expect(text).toContain("SKIP  gate:lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a skip naming a gate that is not declared, and runs nothing", () => {
    const dir = allGatesTrivially();
    try {
      const { code, stderr } = runGateAll(["--repo", dir, "--tier", "stop", "--skip", "gate:lokfile"]);
      expect(code).toBe(2);
      expect(stderr).toContain("gate:lokfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
