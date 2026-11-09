/**
 * scripts/tests/closed-enum-hygiene-waivers.test.mjs — the waiver escape
 * valve added for governance-walk item 8: closed-enum-hygiene had no way to
 * accept a known vocabulary drift as a dated decision, unlike its siblings
 * (reachability's allowlist, branch-accounting's dispositions, anti-stub's
 * triage, tui-catalog-parity's waivers) — all wired through the shared
 * scripts/lib/waiver-store.mjs primitive. This exercises that same
 * primitive here: a valid, unexpired {check,value} entry waives a
 * violation; an expired or malformed one does not.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { partitionAgainstWaivers } from "../closed-enum-hygiene.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "closed-enum-hygiene.mjs");

const TODAY = "2026-08-24";

describe("closed-enum-hygiene: waiver partitioning (unit)", () => {
  const violation = { value: "Implemented", file: "decisions/ADR-999-example.md", reason: "not a DecisionStatus member" };

  it("blocks a violation with no matching waiver entry", () => {
    const result = partitionAgainstWaivers("adrStatusVocabulary", [violation], TODAY, []);
    expect(result.blocking).toEqual([violation]);
    expect(result.waived).toEqual([]);
  });

  it("waives a violation with a valid, unexpired matching entry", () => {
    const entry = { check: "adrStatusVocabulary", value: "Implemented", reason: "grandfathered pending a doc pass", expires: "2099-01-01" };
    const result = partitionAgainstWaivers("adrStatusVocabulary", [violation], TODAY, [entry]);
    expect(result.blocking).toEqual([]);
    expect(result.waived).toEqual([{ violation, entry }]);
  });

  it("does NOT waive — and blocks — an expired entry", () => {
    const entry = { check: "adrStatusVocabulary", value: "Implemented", reason: "grandfathered", expires: "2020-01-01" };
    const result = partitionAgainstWaivers("adrStatusVocabulary", [violation], TODAY, [entry]);
    expect(result.blocking).toEqual([]);
    expect(result.waived).toEqual([]);
    expect(result.expired).toEqual([{ violation, entry }]);
  });

  it("does NOT waive — and blocks — a malformed entry (missing reason)", () => {
    const entry = { check: "adrStatusVocabulary", value: "Implemented", expires: "2099-01-01" };
    const result = partitionAgainstWaivers("adrStatusVocabulary", [violation], TODAY, [entry]);
    expect(result.blocking).toEqual([]);
    expect(result.malformed.length).toBe(1);
    expect(result.malformed[0].violation).toEqual(violation);
  });

  it("does not cross-waive between checks — same value, different check, no match", () => {
    const entry = { check: "severityVocabulary", value: "Implemented", reason: "wrong check", expires: "2099-01-01" };
    const result = partitionAgainstWaivers("adrStatusVocabulary", [violation], TODAY, [entry]);
    expect(result.blocking).toEqual([violation]);
  });

  it("never waives a violation with no `value` (an extraction-error placeholder)", () => {
    const errorViolation = { reason: "could not extract Severity from contracts.ts: type not found" };
    const entry = { check: "severityVocabulary", value: undefined, reason: "n/a", expires: "2099-01-01" };
    const result = partitionAgainstWaivers("severityVocabulary", [errorViolation], TODAY, [entry]);
    expect(result.blocking).toEqual([errorViolation]);
  });
});

describe("closed-enum-hygiene gate: waiver CRUD end-to-end", () => {
  function writeWaiverStore(dir, entries) {
    const path = join(dir, "waivers.json");
    writeFileSync(path, JSON.stringify({ entries }, null, 2));
    return path;
  }

  it("the real gate passes today with an empty waiver store (baseline, unaffected by this change)", () => {
    const dir = mkdtempSync(join(tmpdir(), "closed-enum-waivers-"));
    try {
      const waiversPath = writeWaiverStore(dir, []);
      const result = spawnSync("bun", [SCRIPT, "--waivers", waiversPath, "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.totalUnwaived).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a malformed waiver store file fails the gate closed, rather than silently reading as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "closed-enum-waivers-"));
    try {
      const waiversPath = join(dir, "waivers.json");
      writeFileSync(waiversPath, "{ not json");
      const result = spawnSync("bun", [SCRIPT, "--waivers", waiversPath, "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(report.waiverFileError).toMatch(/unparseable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the waiver CRUD CLI (`bun run waiver`) round-trips an entry against this store", () => {
    const dir = mkdtempSync(join(tmpdir(), "closed-enum-waivers-cli-"));
    try {
      const waiversPath = writeWaiverStore(dir, []);
      const waiverScript = join(REPO_ROOT, "scripts", "lib", "waiver-store.mjs");
      const entry = JSON.stringify({ check: "severityVocabulary", value: "example_member", reason: "test waiver", expires: "2099-01-01" });

      const add = spawnSync("bun", [waiverScript, "add", "closed-enum-hygiene", waiversPath, entry], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(add.status).toBe(0);

      const list = spawnSync("bun", [waiverScript, "list", "closed-enum-hygiene", waiversPath], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(list.status).toBe(0);
      const listed = JSON.parse(list.stdout);
      expect(listed).toHaveLength(1);
      expect(listed[0].value).toBe("example_member");

      const remove = spawnSync(
        "bun",
        [waiverScript, "remove", "closed-enum-hygiene", waiversPath, JSON.stringify({ check: "severityVocabulary", value: "example_member" })],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(remove.status).toBe(0);

      const listAfter = spawnSync("bun", [waiverScript, "list", "closed-enum-hygiene", waiversPath], { cwd: REPO_ROOT, encoding: "utf8" });
      expect(JSON.parse(listAfter.stdout)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
