import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canaryObservationStatus, classifyCanaryResult, parseObservedCount, runCensus } from "../guard-canaries.mjs";
import { GREEN_GATE_STATUSES, GATE_STATUSES, auditExecutionProfile, isGreenGateStatus, parseGateObservedCount } from "../enforcement-control-plane.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE_PATH = join(REPO_ROOT, "scripts", "execution-profile.json");
const CLI = join(REPO_ROOT, "scripts", "guard-canaries.mjs");

/**
 * A runner that classified everything `proven` would satisfy every happy-path
 * assertion in the census and still prove nothing, because "proven" and
 * "unproven" are only distinguishable by a case that must NOT be proven. The
 * negative control below is the reason these tests exist: a gate whose body is
 * `process.exit(0)` sails through every fixture, and a harness that reports
 * such a gate green is worse than no harness.
 *
 * The real corpus supplied that control for a while — `gate:adr-status` exited 0
 * on all three paths, so it read `unproven` — until todo 5 gave it real exit
 * codes. A property pinned to a live defect stops being a property the day
 * someone fixes the defect, so the control is now the scratch gate below, which
 * cannot be "fixed" into proving anything and does not rot when real code moves.
 */
describe("guard canary classification", () => {
  it("reports a gate that PASSES its own canary as unproven, never as proven", () => {
    const verdict = classifyCanaryResult({
      declared: { expected_failure_reason: "boom" },
      exit_code: 0,
      output: "everything is fine",
      expected_failure_reason: "boom",
    });
    expect(verdict.classification).toBe("unproven");
    expect(verdict.expected_reason_matched).toBe(false);
  });

  it("reports a gate that failed for the declared reason as proven", () => {
    const verdict = classifyCanaryResult({
      declared: { expected_failure_reason: "incomplete/stub section" },
      exit_code: 1,
      output: "1 record with an incomplete/stub section\nFAIL",
      expected_failure_reason: "incomplete/stub section",
    });
    expect(verdict.classification).toBe("proven");
    expect(verdict.expected_reason_matched).toBe(true);
  });

  // The distinction the milestone's own brief asks about: a canary that fails
  // for a different reason is a fact about the CANARY, not about the gate, and
  // counting it as proven would launder a broken fixture into a green gate.
  it("distinguishes a canary that failed for an undeclared reason", () => {
    const verdict = classifyCanaryResult({
      declared: { expected_failure_reason: "incomplete/stub section" },
      exit_code: 1,
      output: "ENOENT: no such file or directory",
      expected_failure_reason: "incomplete/stub section",
    });
    expect(verdict.classification).toBe("misfired");
    expect(verdict.classification).not.toBe("proven");
  });

  it("reports a gate with no declared canary as unmigrated rather than proven", () => {
    const verdict = classifyCanaryResult({ declared: null, exit_code: null, output: "" });
    expect(verdict.classification).toBe("unmigrated");
  });
});

describe("observed_count and the third state", () => {
  it("parses a gate's self-reported observation count", () => {
    expect(parseObservedCount("gate:x — 4 ADR(s) checked\nobserved_count: 4\nPASS")).toBe(4);
    expect(parseObservedCount("PASS")).toBeNull();
    // The control plane and the canary runner must not hold two parsers that
    // can drift, so the runner's parser IS the control plane's.
    expect(parseObservedCount).toBe(parseGateObservedCount);
  });

  it("never aggregates unresolved as green", () => {
    expect(GREEN_GATE_STATUSES).not.toContain("unresolved");
    expect(GATE_STATUSES).toContain("unresolved");
    expect(isGreenGateStatus("unresolved")).toBe(false);
    expect(isGreenGateStatus("passed")).toBe(true);
    expect(isGreenGateStatus("cached")).toBe(true);
  });

  it("treats an input smaller than the declared minimum as unresolved, not passed", () => {
    expect(canaryObservationStatus({ observes: { min: 1 } }, "observed_count: 0\nPASS")).toBe("unresolved");
    // A gate that declared the expectation and then reported nothing has
    // observed zero, not "unknown but fine".
    expect(canaryObservationStatus({ observes: { min: 1 } }, "PASS")).toBe("unresolved");
    expect(canaryObservationStatus({ observes: { min: 1 } }, "observed_count: 1\nPASS")).toBeNull();
    // A gate that never declared an expectation is not silently downgraded.
    expect(canaryObservationStatus({}, "PASS")).toBeNull();
  });
});

describe("the execution profile accepts the canary and observes blocks", () => {
  it("validates the live profile with the new fields present", () => {
    const registry = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    expect(auditExecutionProfile(registry, packageJson)).toEqual([]);
  });

  it("rejects a canary that declares no expected reason", () => {
    const registry = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    registry.gates["gate:adr-sections"].canary = { fixture: "adr-sections/stub-obligation" };
    const problems = auditExecutionProfile(registry, packageJson);
    expect(problems.some((problem) => problem.includes("gate:adr-sections") && problem.includes("expected_failure_reason"))).toBe(true);
  });

  /**
   * `command` and `env` were the two canary keys the validator ignored while
   * policing the other five. Each test below is a mutation the validator was
   * demonstrated to accept, so each is a test that would have failed before the
   * validator learned these keys — none of them asserts a rule that already held.
   */
  const mutations = {
    "a canary that overrides the spawn path with a raw argv": (canary) => {
      canary.command = ["sh", "-c", "echo 'incomplete/stub section'; exit 1"];
      return "must not declare command";
    },
    "a canary whose env is an array rather than an object": (canary) => {
      canary.env = ["REPO_ROOT=/tmp"];
      return "canary env must be an object";
    },
    "a canary whose env key is not a POSIX identifier": (canary) => {
      canary.env = { "REPO ROOT": "/tmp" };
      return "is not a POSIX environment variable name";
    },
    "a canary whose env value coerces silently": (canary) => {
      canary.env = { REPO_ROOT: null };
      return "must be a string, number, or boolean, not null";
    },
    "a canary whose env value is a nested object": (canary) => {
      canary.env = { REPO_ROOT: { path: "/tmp" } };
      return "must be a string, number, or boolean, not object";
    },
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    it(`rejects ${label}`, () => {
      const registry = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
      const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
      const canary = registry.gates["gate:adr-sections"].canary;
      const expected = mutate(canary);
      const problems = auditExecutionProfile(registry, packageJson)
        .filter((problem) => problem.startsWith("gate:adr-sections canary"));
      expect(problems.some((problem) => problem.includes(expected))).toBe(true);
    });
  }

  // The legitimate shape must survive, or the rules above are only refusing
  // everything. `gate:language-census` is a real entry that sets `env` and
  // nothing else, and the git-scope keys are load-bearing for two other real
  // entries, so the whole live profile is the positive case.
  it("accepts the live profile's four declared env overlays unchanged", () => {
    const registry = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    const declared = Object.entries(registry.gates)
      .filter(([, entry]) => entry.canary?.env !== undefined)
      .map(([name]) => name);
    expect(declared.length).toBeGreaterThan(0);
    expect(auditExecutionProfile(registry, packageJson)).toEqual([]);
  });
});

/**
 * Defect 1: the runner, not the profile, owns the spawn path. A canary that
 * declares `command` used to run that command INSTEAD of the gate and be
 * reported `proven` with the gate never executed — the census publishing a green
 * proof for a gate it never touched.
 *
 * This asserts the refusal at the runner level as well as the validator level,
 * because they are different entries: `runCensus` accepts any `profilePath`, so
 * a scratch or hand-edited profile reaches the runner without ever being
 * validated. A validator that catches a malformed profile is not sufficient if
 * the runner will execute one anyway.
 */
describe("the runner owns the spawn path", () => {
  it("refuses a canary that declares a command instead of running it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "revoy2-guard-command-"));
    try {
      const { gates } = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
      const profilePath = join(scratch, "execution-profile.json");
      writeFileSync(profilePath, JSON.stringify({
        schema_version: 1,
        profile_version: "command-override",
        gates: {
          // The payload from the audit: it prints the declared reason and exits
          // 1, which is exactly what `proven` requires — and runs no gate.
          "gate:adr-sections": {
            ...gates["gate:adr-sections"],
            canary: {
              ...gates["gate:adr-sections"].canary,
              command: ["sh", "-c", "echo 'incomplete/stub section'; exit 1"],
            },
          },
        },
      }, null, 2));

      const census = await runCensus({ repo: REPO_ROOT, profilePath, only: ["gate:adr-sections"] });
      const row = census.gates[0];
      // `misfired` rather than `unproven`: the gate never ran, so it cannot have
      // passed its canary, and a block WAS declared, so it is not `unmigrated`.
      expect(row.classification).toBe("misfired");
      expect(row.classification).not.toBe("proven");
      // Nothing spawned, so nothing can be counted as observed.
      expect(row.exit_code).toBeNull();
      expect(row.reason).toContain("command");
      expect(census.ok).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the runner's own negative control", () => {
  it("reports a scratch gate whose body is process.exit(0) as unproven", () => {
    // Runs the shipped CLI, not an in-process reimplementation, so the control
    // exercises the same path `bun run guard:canaries` does.
    const output = execFileSync("bun", [CLI, "--self-test"], { cwd: REPO_ROOT, encoding: "utf-8" });
    expect(output).toContain("unproven");
    expect(output).toContain("PASS — a gate that cannot fail is reported unproven");
  });
});

/**
 * A one-gate profile whose body is `process.exit(0)`, declared against a real
 * fixture. It is the negative control the census needs and it cannot rot: no
 * amount of fixing real gates makes this one able to fail.
 *
 * Mirrors `selfTest()` in scripts/guard-canaries.mjs, but as a value the test
 * can drive rather than a subprocess it can only read the exit code of.
 *
 * Note there is no `command` in the canary block: the scratch gate is supplied
 * through `internalCommands`, the runner channel a profile cannot reach. That is
 * the same shape the shipped `--self-test` uses, so this helper would itself be a
 * false-green generator if the runner regressed to honouring a profile key.
 */
const CONTROL_GATE = "gate:control-always-passes";

function scratchProfileWithExitZeroGate() {
  const scratch = mkdtempSync(join(tmpdir(), "revoy2-guard-cannotfail-"));
  const gateBody = join(scratch, "always-passes.mjs");
  writeFileSync(gateBody, "#!/usr/bin/env node\n// The defect under test: a gate body that cannot fail.\nprocess.exit(0);\n");
  const { gates } = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
  const profilePath = join(scratch, "execution-profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify(
      {
        schema_version: 1,
        profile_version: "cannot-fail-control",
        gates: {
          [CONTROL_GATE]: {
            ...gates["gate:adr-sections"],
            canary: {
              fixture: "adr-sections/stub-obligation",
              expected_failure_reason: "incomplete/stub section",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return { profilePath, internalCommands: { [CONTROL_GATE]: ["bun", gateBody] } };
}

describe("the live census", () => {
  let census;
  let scratchProfile;
  afterEach(() => {
    if (census?.scratch) rmSync(census.scratch, { recursive: true, force: true });
    if (scratchProfile) {
      rmSync(dirname(scratchProfile.profilePath), { recursive: true, force: true });
      scratchProfile = null;
    }
  });

  // The full census spawns one subprocess per gate that has a canary, so its
  // cost scales with the migration: ~2s at 4 migrated gates, ~15s at 31. The
  // suite default (15s) is below that, and a timeout here would read as a
  // broken census rather than as an outgrown budget. This is a real cost of the
  // mechanism, not a test artefact — `bun run guard:canaries` is equally slow,
  // and the fix for that is fewer canaries or a faster gate, not a bigger
  // number here.
  it("lists every gate in the profile, with none absent", async () => {
    census = await runCensus({ repo: REPO_ROOT });
    const registry = JSON.parse(readFileSync(PROFILE_PATH, "utf-8"));
    const expected = Object.keys(registry.gates).sort();
    expect(census.gate_count).toBe(expected.length);
    expect(census.gates.map((row) => row.gate).sort()).toEqual(expected);
    // Every row carries exactly one classification; a row with none would be
    // the "skipped gate" this milestone exists to make impossible.
    for (const row of census.gates) {
      expect(["proven", "unproven", "misfired", "unmigrated"]).toContain(row.classification);
    }
  }, 120_000);

  // This asserted `gate:adr-status` is `unproven`, which was true when this
  // milestone landed and the gate still exited 0 on every path. Todo 5 gave it
  // real exit codes, so the defect is fixed and the assertion inverted.
  //
  // The property worth keeping is NOT "adr-status is broken" — that was a
  // fact about the code at one commit, and asserting it would make the test
  // fail the moment the bug was fixed, which is precisely backwards for a
  // repository whose stated purpose is proving gates can fail. The property is
  // that the harness tells the two states apart: a gate that fails its own
  // canary reads `proven`, a gate that sails through it reads `unproven`. Both
  // directions are asserted below, the second against a scratch gate that can
  // only ever exit 0.
  it("classifies a fixed gate as proven and a cannot-fail gate as unproven", async () => {
    census = await runCensus({ repo: REPO_ROOT, only: ["gate:adr-status"] });
    expect(census.gates[0].classification).toBe("proven");

    scratchProfile = scratchProfileWithExitZeroGate();
    const cannotFail = await runCensus({
      repo: REPO_ROOT,
      profilePath: scratchProfile.profilePath,
      internalCommands: scratchProfile.internalCommands,
    });
    expect(cannotFail.gates[0].classification).toBe("unproven");
    expect(cannotFail.ok).toBe(false);
  });

  it("proves at least one gate CAN fail, so the census is not uniformly negative", async () => {
    census = await runCensus({ repo: REPO_ROOT, only: ["gate:adr-sections", "gate:adr-citations", "gate:adr-trace"] });
    expect(census.counts.proven).toBe(3);
    expect(census.counts.unproven).toBe(0);
    expect(census.counts.misfired).toBe(0);
  });
});
