import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DISCHARGE_CATALOG } from "../lib/discharge-catalog.mjs";

const TMP = [];
function repoWithAntiStub(entries) {
  const repo = mkdtempSync(join(tmpdir(), "revoy2-discharge-"));
  TMP.push(repo);
  mkdirSync(join(repo, "scripts", "anti-stub"), { recursive: true });
  writeFileSync(join(repo, "scripts", "anti-stub", "triage.json"), JSON.stringify({ version: 1, entries }));
  return repo;
}
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

const ITEM = "anti-stub:rule4_weak @ pkg/src/worktree.ts";
const entry = (symbol, expires) => ({
  rule: "rule4_weak",
  file: "pkg/src/worktree.ts",
  symbol,
  verdict: "accepted_tradeoff",
  reason: "r",
  ...(expires ? { expires } : {}),
});

describe("discharge-catalog: waiver ids that are shared by several entries", () => {
  const renew = DISCHARGE_CATALOG.waiver["renew with a new expiry"].predicate;
  const remove = DISCHARGE_CATALOG.waiver["delete the exemption"].predicate;

  it("discharges a renewal even when an undated sibling with the same rule @ file id comes first", () => {
    const repo = repoWithAntiStub([entry("parseLeaseFile"), entry("(anonymous/arrow)", "2027-01-01")]);
    expect(renew(repo, { itemId: ITEM, interviewDate: "2026-10-01" })).toBe(true);
  });

  it("does not discharge a renewal while any dated entry under the id is still on or before the interview date", () => {
    const repo = repoWithAntiStub([entry("a", "2027-01-01"), entry("b", "2026-10-01")]);
    expect(renew(repo, { itemId: ITEM, interviewDate: "2026-10-01" })).toBe(false);
  });

  it("does not discharge a renewal when only undated entries carry the id", () => {
    const repo = repoWithAntiStub([entry("parseLeaseFile")]);
    expect(renew(repo, { itemId: ITEM, interviewDate: "2026-10-01" })).toBe(false);
  });

  it("treats a deleted dated waiver as discharged even though undated siblings remain", () => {
    const repo = repoWithAntiStub([entry("parseLeaseFile")]);
    expect(remove(repo, { itemId: ITEM })).toBe(true);
    const still = repoWithAntiStub([entry("parseLeaseFile"), entry("x", "2027-01-01")]);
    expect(remove(still, { itemId: ITEM })).toBe(false);
  });
});

describe("discharge-catalog: the hazard kind", () => {
  function repoWithHazard({ status, reason }) {
    const repo = mkdtempSync(join(tmpdir(), "revoy2-discharge-hazard-"));
    TMP.push(repo);
    mkdirSync(join(repo, "decisions"), { recursive: true });
    mkdirSync(join(repo, "scripts", "reachability"), { recursive: true });
    writeFileSync(join(repo, "decisions", "ADR-907-fixture.md"), `# ADR-907: Fixture\n\n**Status:** ${status}\n**Date:** 2026-08-01\n`);
    writeFileSync(join(repo, "scripts", "reachability", "allowlist.json"),
      JSON.stringify({ version: 1, entries: [{ symbol: "x", file: "a.ts", expires: "2026-12-01", reason }] }));
    return repo;
  }
  const hazard = DISCHARGE_CATALOG.hazard;
  const ctx = { itemId: "hazard:ADR-907", interviewDate: "2026-10-07" };

  it("declares exactly the three answers the question pack offers, one of them date-only", () => {
    expect(Object.keys(hazard)).toEqual(["re-ground the commitments", "accept the cited record", "defer with a date"]);
    expect(hazard["defer with a date"]).toEqual({ discharge: null });
  });

  it("'re-ground the commitments' holds only once no dated commitment cites the record, or it governs", () => {
    const predicate = hazard["re-ground the commitments"].predicate;
    expect(predicate(repoWithHazard({ status: "Rejected", reason: "rests on ADR-907" }), ctx)).toBe(false);
    expect(predicate(repoWithHazard({ status: "Rejected", reason: "rests on nothing withdrawn" }), ctx)).toBe(true);
    expect(predicate(repoWithHazard({ status: "Accepted", reason: "rests on ADR-907" }), ctx)).toBe(true);
  });

  it("'accept the cited record' holds only when the record is Accepted", () => {
    const predicate = hazard["accept the cited record"].predicate;
    expect(predicate(repoWithHazard({ status: "Proposed", reason: "rests on ADR-907" }), ctx)).toBe(false);
    expect(predicate(repoWithHazard({ status: "Accepted", reason: "rests on ADR-907" }), ctx)).toBe(true);
  });
});
