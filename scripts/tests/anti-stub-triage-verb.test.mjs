/**
 * scripts/tests/anti-stub-triage-verb.test.mjs — teeth for anti-stub.mjs's
 * `--triage <rule>::<file>::<symbol> --verdict <v> --reason "..." [--expires
 * <ISO>]` verb (mirrors completion-depth.mjs's `--triage` surface — see that
 * script's own header and scripts/anti-stub.mjs's runTriageVerb).
 *
 * Drives the real script as a subprocess against a throwaway copy of the
 * real triage.json (REVOY2_ANTI_STUB_TRIAGE_PATH), the same isolation
 * pattern scripts/tests/anti-stub-triage-expiry.test.mjs already uses via
 * `--triage <path>` — except the verb writes through this env var instead,
 * since `--triage`'s own argument slot is the finding key in verb mode (see
 * anti-stub.mjs's TRIAGE_VERB disambiguation).
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "anti-stub.mjs");
const REAL_TRIAGE_PATH = join(REPO_ROOT, "scripts", "anti-stub", "triage.json");

// A finding key genuinely present in this repository's live scan today —
// verified real (not fabricated) by scripts/anti-stub/triage.json's own
// existing entry for it.
const REAL_KEY = "rule1::packages/arbor-mcp/src/manager.ts::persistInterruption";

function withTriageCopy(fn) {
  const dir = mkdtempSync(join(tmpdir(), "anti-stub-triage-verb-"));
  const copyPath = join(dir, "triage.json");
  try {
    const original = JSON.parse(readFileSync(REAL_TRIAGE_PATH, "utf8"));
    // Drop the real entry for REAL_KEY so it starts UNTRIAGED in this fixture.
    original.entries = original.entries.filter(
      (e) => !(e.rule === "rule1" && e.file === "packages/arbor-mcp/src/manager.ts" && e.symbol === "persistInterruption"),
    );
    writeFileSync(copyPath, JSON.stringify(original, null, 2));
    return fn(copyPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runTriage(args, copyPath) {
  return spawnSync("bun", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, REVOY2_ANTI_STUB_TRIAGE_PATH: copyPath },
  });
}

describe("anti-stub.mjs --triage verb", () => {
  it("missing --verdict/--reason -> usage, exit 2", () => {
    const result = withTriageCopy((copyPath) => runTriage(["--triage", REAL_KEY, "--verdict", "false_positive"], copyPath));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage: anti-stub\.mjs --triage/);
  });

  it("unknown verdict -> exit 2", () => {
    const result = withTriageCopy((copyPath) =>
      runTriage(["--triage", REAL_KEY, "--verdict", "not_a_real_verdict", "--reason", "x"], copyPath));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/invalid verdict/);
  });

  it("unknown id -> exit 2 (no current finding carries that key)", () => {
    const result = withTriageCopy((copyPath) =>
      runTriage(["--triage", "rule1::packages/does/not/exist.ts::nope", "--verdict", "false_positive", "--reason", "x"], copyPath));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no current finding with key/);
  });

  it("writes a false_positive verdict for a real untriaged finding", () => {
    withTriageCopy((copyPath) => {
      const result = runTriage(["--triage", REAL_KEY, "--verdict", "false_positive", "--reason", "test verdict"], copyPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/false_positive/);
      const written = JSON.parse(readFileSync(copyPath, "utf8"));
      const entry = written.entries.find((e) => e.symbol === "persistInterruption");
      expect(entry).toMatchObject({ rule: "rule1", verdict: "false_positive", reason: "test verdict" });
      expect(entry.expires).toBeUndefined();
    });
  });

  it("an accepted_tradeoff without --expires is rejected (matches the shared waiver schema)", () => {
    withTriageCopy((copyPath) => {
      const result = runTriage(["--triage", REAL_KEY, "--verdict", "accepted_tradeoff", "--reason", "test"], copyPath);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/invalid entry/);
    });
  });

  it("re-triaging an already-triaged key renews the entry instead of duplicating it", () => {
    withTriageCopy((copyPath) => {
      const first = runTriage(["--triage", REAL_KEY, "--verdict", "false_positive", "--reason", "first"], copyPath);
      expect(first.status).toBe(0);
      const second = runTriage(
        ["--triage", REAL_KEY, "--verdict", "accepted_tradeoff", "--reason", "second", "--expires", "2027-01-01"],
        copyPath,
      );
      expect(second.status).toBe(0);
      const written = JSON.parse(readFileSync(copyPath, "utf8"));
      const matches = written.entries.filter((e) => e.symbol === "persistInterruption");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ verdict: "accepted_tradeoff", reason: "second", expires: "2027-01-01" });
    });
  });

  it("the pre-existing --triage <path> override (no --verdict) is unaffected", () => {
    // scripts/tests/anti-stub-triage-expiry.test.mjs already covers this path
    // in depth; this is a smoke check that the dual-purpose flag still
    // dispatches to the override branch when --verdict is absent.
    const result = spawnSync("bun", [SCRIPT, "--triage", REAL_TRIAGE_PATH, "--blocking"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/0 untriaged/);
  });
});
