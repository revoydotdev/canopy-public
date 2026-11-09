import { describe, expect, it } from "vitest";
import { checkStatusTransitions, POL_STATUS_TRANSITION } from "../../src/record/transitions.js";
import { classifyLegacyRecord } from "../../src/record/legacy.js";
import type { DecisionStatus } from "../../src/contracts.js";

const AT = "2026-08-05T00:00:00.000Z";

/** A minimal but genuinely parseable ADR, so these run through the real parser. */
function adr(number: number, status: string): string {
  return [
    `# ADR-${String(number).padStart(3, "0")}: A decision about something`,
    "",
    `**Status:** ${status}`,
    "**Date:** 2026-08-01",
    "",
    "## Context",
    "",
    "Some context that makes this a real record rather than a fixture stub.",
    "",
    "## Decision",
    "",
    "The decision itself.",
    "",
    "## Consequences",
    "",
    "What follows from it.",
    "",
  ].join("\n");
}

function scan(...records: readonly { number: number; status: string }[]) {
  return records.map((r) => classifyLegacyRecord(adr(r.number, r.status), `decisions/ADR-${String(r.number).padStart(3, "0")}-x.md`));
}

function baseline(entries: readonly [string, DecisionStatus][]) {
  return new Map<string, DecisionStatus>(entries);
}

describe("POL-05 — the lifecycle rule now actually runs", () => {
  it("FLAGS draft -> accepted, the self-approval skip", () => {
    // The exact edit the rule exists to catch: hand-editing a Status line from
    // Draft straight to Accepted, skipping the reviewable `proposed` moment.
    const findings = checkStatusTransitions(
      baseline([["revoy2:ADR-027", "draft"]]),
      scan({ number: 27, status: "Accepted" }),
      { at: AT },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule_id).toBe(POL_STATUS_TRANSITION);
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].detail).toContain('"draft" -> "accepted"');
    expect(findings[0].waiver_eligible).toBe(false);
  });

  it("ALLOWS draft -> proposed and proposed -> accepted", () => {
    // A check that flags everything is not a check. The legal path must pass.
    expect(checkStatusTransitions(
      baseline([["revoy2:ADR-027", "draft"]]),
      scan({ number: 27, status: "Proposed" }),
      { at: AT },
    )).toEqual([]);

    expect(checkStatusTransitions(
      baseline([["revoy2:ADR-027", "proposed"]]),
      scan({ number: 27, status: "Accepted" }),
      { at: AT },
    )).toEqual([]);
  });

  it("FLAGS resurrection out of a terminal state", () => {
    const findings = checkStatusTransitions(
      baseline([["revoy2:ADR-027", "rejected"]]),
      scan({ number: 27, status: "Accepted" }),
      { at: AT },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('"rejected" -> "accepted"');
  });

  it("FLAGS a new record that arrives already accepted", () => {
    // The same self-approval by a different door: never traversing the
    // lifecycle at all, rather than traversing it illegally.
    const findings = checkStatusTransitions(baseline([]), scan({ number: 99, status: "Accepted" }), { at: AT });
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("never traversed the lifecycle");
    expect(findings[0].remediation).toContain("No agent both proposes and approves");
  });

  it("ALLOWS a new record that arrives as draft or proposed", () => {
    expect(checkStatusTransitions(baseline([]), scan({ number: 99, status: "Draft" }), { at: AT })).toEqual([]);
    expect(checkStatusTransitions(baseline([]), scan({ number: 99, status: "Proposed" }), { at: AT })).toEqual([]);
  });

  it("ignores an unchanged status — a no-op is not a transition", () => {
    expect(checkStatusTransitions(
      baseline([["revoy2:ADR-027", "accepted"]]),
      scan({ number: 27, status: "Accepted" }),
      { at: AT },
    )).toEqual([]);
  });

  it("is deterministic — findings are code-unit ordered, not locale ordered", () => {
    const runs = Array.from({ length: 5 }, () => JSON.stringify(checkStatusTransitions(
      baseline([["revoy2:ADR-002", "draft"], ["revoy2:ADR-001", "draft"]]),
      scan({ number: 2, status: "Accepted" }, { number: 1, status: "Accepted" }),
      { at: AT },
    )));
    expect(new Set(runs).size).toBe(1);
    const findings = checkStatusTransitions(
      baseline([["revoy2:ADR-002", "draft"], ["revoy2:ADR-001", "draft"]]),
      scan({ number: 2, status: "Accepted" }, { number: 1, status: "Accepted" }),
      { at: AT },
    );
    expect(findings.map((f) => ("record_id" in f.subject ? f.subject.record_id : "")))
      .toEqual(["revoy2:ADR-001", "revoy2:ADR-002"]);
  });
});

describe("POL-05 — the real corpus, as it stands", () => {
  it("ADR-027 is Draft against a Draft baseline: no finding, and no false accusation", () => {
    // This branch's own ADR. It is deliberately Draft and unratified; the rule
    // must not fire on it, or the gate would cry wolf on correct behaviour.
    const findings = checkStatusTransitions(
      baseline([["revoy2:ADR-027", "draft"]]),
      scan({ number: 27, status: "Draft" }),
      { at: AT },
    );
    expect(findings).toEqual([]);
  });
});
