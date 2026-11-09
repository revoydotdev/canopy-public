import { describe, expect, it } from "vitest";
import { executeRepoFlightDualAuthorityTransaction, type RepoFlightAuthorityLease } from "../src/repo-flight-dual-authority.js";

function lease(authority: RepoFlightAuthorityLease["authority"], events: string[], releaseThrows = false): RepoFlightAuthorityLease {
  events.push(`acquire:${authority}`);
  return { authority, receipt_id: `${authority}:receipt`, release: () => { events.push(`release:${authority}`); if (releaseThrows) throw new Error(`${authority} release failed`); } };
}

describe("Flight and legacy dual-authority transaction", () => {
  it("acquires Flight before legacy and releases in reverse order", () => {
    const events: string[] = [];
    const result = executeRepoFlightDualAuthorityTransaction({ acquire_flight: () => ({ ok: true, lease: lease("flight", events) }), acquire_legacy: () => ({ ok: true, lease: lease("legacy", events) }), operate: () => { events.push("publish"); return "published"; } });
    expect(result).toMatchObject({ ok: true, published: true, value: "published", flight_receipt_id: "flight:receipt", legacy_receipt_id: "legacy:receipt" });
    expect(events).toEqual(["acquire:flight", "acquire:legacy", "publish", "release:legacy", "release:flight"]);
  });

  it("never asks for legacy authority after Flight refuses and preserves non-publication evidence", () => {
    const events: string[] = [];
    const result = executeRepoFlightDualAuthorityTransaction({ acquire_flight: () => ({ ok: false, reason: "warrant expired" }), acquire_legacy: () => { events.push("legacy-called"); return { ok: true, lease: lease("legacy", events) }; }, operate: () => "impossible" });
    expect(result).toEqual({ ok: false, published: false, evidence_preserved: true, refused_by: "flight", reason: "warrant expired", flight_receipt_id: null, legacy_receipt_id: null });
    expect(events).toEqual([]);
  });

  it("releases Flight when legacy or publication fails and reports release ambiguity", () => {
    const legacyEvents: string[] = [];
    expect(executeRepoFlightDualAuthorityTransaction({ acquire_flight: () => ({ ok: true, lease: lease("flight", legacyEvents) }), acquire_legacy: () => ({ ok: false, reason: "legacy lease held" }), operate: () => "impossible" })).toMatchObject({ ok: false, refused_by: "legacy", evidence_preserved: true });
    expect(legacyEvents).toEqual(["acquire:flight", "release:flight"]);
    const operationEvents: string[] = [];
    expect(executeRepoFlightDualAuthorityTransaction({ acquire_flight: () => ({ ok: true, lease: lease("flight", operationEvents) }), acquire_legacy: () => ({ ok: true, lease: lease("legacy", operationEvents, true) }), operate: () => { throw new Error("publication crashed"); } })).toMatchObject({ ok: false, refused_by: "release", published: false, evidence_preserved: true });
    expect(operationEvents).toEqual(["acquire:flight", "acquire:legacy", "release:legacy", "release:flight"]);
  });
});
