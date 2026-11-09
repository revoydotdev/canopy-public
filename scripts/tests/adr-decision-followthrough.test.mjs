import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionFollowthrough } from "../adr-decision-followthrough.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODAY = "2026-08-24";

let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = undefined; });

/** Build a scratch repo with a decisions/ dir holding the given ADR files and interview ledger. */
function fixture(adrs, interviews) {
  scratch = mkdtempSync(join(tmpdir(), "adr-followthrough-"));
  const dir = join(scratch, "decisions");
  mkdirSync(dir, { recursive: true });
  for (const [id, status] of Object.entries(adrs)) {
    const num = id.replace("ADR-", "");
    writeFileSync(join(dir, `${id}-slug.md`), `# ${id}: Title\n\n**Status:** ${status}\n**Date:** 2026-08-01\n\n## Context\nbody\n`);
    void num;
  }
  writeFileSync(join(dir, "interviews.jsonl"), interviews.map((r) => JSON.stringify(r)).join("\n") + (interviews.length ? "\n" : ""));
  return scratch;
}

describe("gate:adr-decision-followthrough — coverage does not clear a decided-but-Proposed ADR", () => {
  it("FAILS when an interview decided an ADR that is still Proposed", () => {
    const repo = fixture(
      { "ADR-900": "Proposed" },
      [{ held_at: "2026-08-20T00:00:00Z", covered: ["ADR-900"], outcomes: { "ADR-900": "accept it" } }],
    );
    const report = decisionFollowthrough(repo, TODAY);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.id)).toEqual(["ADR-900"]);
    expect(report.violations[0].status).toBe("proposed");
  });

  it("PASSES once the decided ADR reaches a terminal status — Accepted", () => {
    const repo = fixture(
      { "ADR-900": "Accepted" },
      [{ held_at: "2026-08-20T00:00:00Z", covered: ["ADR-900"], outcomes: { "ADR-900": "accept it" } }],
    );
    expect(decisionFollowthrough(repo, TODAY).ok).toBe(true);
  });

  it("PASSES when a redlight carried the ADR to Rejected/Superseded", () => {
    const repo = fixture(
      { "ADR-900": "Superseded", "ADR-901": "Rejected" },
      [{ held_at: "2026-08-20T00:00:00Z", covered: ["ADR-900", "ADR-901"], outcomes: {} }],
    );
    const report = decisionFollowthrough(repo, TODAY);
    expect(report.ok).toBe(true);
    expect(report.carried.map((c) => c.id).sort()).toEqual(["ADR-900", "ADR-901"]);
  });

  it("EXEMPTS a proposed ADR that the latest interview deferred into the future", () => {
    const repo = fixture(
      { "ADR-900": "Proposed" },
      [{ held_at: "2026-08-20T00:00:00Z", covered: ["ADR-900"], outcomes: {}, deferred_to: { "ADR-900": "2026-12-31" } }],
    );
    const report = decisionFollowthrough(repo, TODAY);
    expect(report.ok).toBe(true);
    expect(report.deferred.map((d) => d.id)).toEqual(["ADR-900"]);
  });

  it("an EXPIRED deferral is no longer a follow-through concern — it un-covers the ADR, which the hook/queue re-surface as awaiting a fresh interview", () => {
    const repo = fixture(
      { "ADR-900": "Proposed" },
      [{ held_at: "2026-08-20T00:00:00Z", covered: ["ADR-900"], outcomes: {}, deferred_to: { "ADR-900": "2026-08-22" } }],
    );
    // coverageIndex drops the expired deferral, so the ADR is not "decided" any
    // more; this gate only enforces follow-through on a standing decision.
    const report = decisionFollowthrough(repo, TODAY);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.deferred).toEqual([]);
  });

  it("does not flag an un-interviewed Proposed ADR — authoring never blocks", () => {
    const repo = fixture({ "ADR-900": "Proposed" }, []);
    expect(decisionFollowthrough(repo, TODAY).ok).toBe(true);
  });

  it("agrees with itself on the real, committed decisions/ (may legitimately pass or fail, but never throws)", () => {
    expect(() => decisionFollowthrough(REPO_ROOT, TODAY)).not.toThrow();
  });
});
