/**
 * scripts/tests/anti-stub-triage-expiry.test.mjs — verdicts have a shelf life.
 *
 * WHY THIS EXISTS. Every other waiver store in this repository dates its
 * exemptions: `scripts/reachability/allowlist.json` states the principle
 * outright ("a decision with a shelf life, not a permanent exemption"),
 * `scripts/branch-accounting/dispositions.json` carries an expiry, and
 * `.visual-intelligence/findings/triage.jsonl` carries `triage_expires`.
 * anti-stub's TRIAGE table did not either, until it was migrated onto the
 * shared `scripts/lib/waiver-store.mjs` primitive (same schema, validator,
 * and CRUD surface reachability.mjs's allowlist and branch-accounting.mjs's
 * dispositions now share) and its data moved out of an inline JS array
 * literal into `scripts/anti-stub/triage.json` — the waiver store itself.
 *
 * Only `accepted_tradeoff` is dated. A `false_positive` says the heuristic is
 * simply wrong at that site, which does not rot; re-dating it would manufacture
 * recurring work with no decision to make. This is encoded once, in
 * `WAIVER_SCHEMAS["anti-stub"].requiresExpiry` (scripts/lib/waiver-store.mjs),
 * not duplicated here.
 *
 * These tests drive the real script against a real mutated copy of
 * triage.json rather than unit-testing a predicate, because the property
 * that matters is the GATE's observable behavior: a lapsed verdict must
 * actually fail `--blocking`.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "anti-stub.mjs");
const TRIAGE_PATH = join(REPO_ROOT, "scripts", "anti-stub", "triage.json");

/**
 * Run the real gate against a mutated copy of the real triage store, via
 * `--triage <path>` — the same override seam reachability.mjs's
 * `--allowlist` and branch-accounting.mjs's `--dispositions` use for their
 * own fixture tests. Everything else (source files scanned, rule findings)
 * stays real, so the only variable under test is the triage data itself.
 */
function runWithMutatedTriage(mutate) {
  const copy = join(tmpdir(), `anti-stub-triage-expiry-probe-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const original = JSON.parse(readFileSync(TRIAGE_PATH, "utf8"));
    writeFileSync(copy, JSON.stringify(mutate(original), null, 2));
    return spawnSync("bun", [SCRIPT, "--triage", copy, "--blocking"], { cwd: REPO_ROOT, encoding: "utf8" });
  } finally {
    rmSync(copy, { force: true });
  }
}

describe("anti-stub TRIAGE verdicts carry a shelf life", () => {
  it("the real table passes today — every accepted_tradeoff is dated and in date", () => {
    const result = spawnSync("bun", [SCRIPT, "--blocking"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/0 untriaged/);
  });

  it("a LAPSED accepted_tradeoff reads as untriaged and fails --blocking", () => {
    // The whole point: an expiry nobody enforces is decoration.
    const result = runWithMutatedTriage((doc) => ({
      ...doc,
      entries: doc.entries.map((e) => (e.expires === "2026-11-16" ? { ...e, expires: "2020-01-01" } : e)),
    }));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/untriaged/i);
  });

  it("an accepted_tradeoff with NO expires is a configuration error, not a silent pass", () => {
    // Guards the back door: without this, a new tradeoff could skip the deadline
    // simply by omitting the field.
    const result = runWithMutatedTriage((doc) => ({
      ...doc,
      entries: doc.entries.map((e) => {
        if (e.verdict !== "accepted_tradeoff") return e;
        const { expires, ...rest } = e;
        return rest;
      }),
    }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/invalid|expires/i);
  });

  it("false_positive verdicts are NOT required to carry an expiry", () => {
    // A false positive says the heuristic is wrong at that site. That does not
    // rot, and dating it would create recurring work with no decision in it.
    const doc = JSON.parse(readFileSync(TRIAGE_PATH, "utf8"));
    const falsePositives = doc.entries.filter((e) => e.verdict === "false_positive");
    expect(falsePositives.length).toBeGreaterThan(0);
    // None of them carry an `expires` field.
    expect(falsePositives.every((e) => e.expires === undefined)).toBe(true);
  });
});
