import { describe, expect, it } from "vitest";
import { captureFOIScenarioArtifacts } from "../src/foi-capture.js";
import { foiScenario, type FOIColorMode, type FOIScenarioId, type FOIScenarioManifest } from "../src/foi-scenario-contract.js";

describe("FOI evidence evaluator negative controls", () => {
  it("does not award unrelated scenario claims from an availability-only capture", () => {
    const allAssertionIds = Array.from(new Set(
      Array.from({ length: 20 }, (_, index) => foiScenario(`S${String(index + 1).padStart(2, "0")}` as FOIScenarioId).required_assertions).flat(),
    ));
    const availability = foiScenario("S20");
    const probe: FOIScenarioManifest = {
      ...availability,
      required_assertions: [...allAssertionIds, "unknown-assertion-negative-control"],
    };

    const status = captureFOIScenarioArtifacts(probe).assertion_status;
    expect(status).toMatchObject({
      "projection-contract": "pass",
      "semantic-snapshot": "pass",
      "event-boundary-frame": "pass",
      "honest-empty-state": "pass",
      "degraded-not-active": "pass",
      "recovery-action": "pass",
    });
    for (const unrelated of [
      "final-answer-visible", "successful-terminal", "command-invocation", "multiline-output",
      "command-series", "result-pairing", "channel-distinction", "parentage", "gate-authority",
      "interrupt-requested-not-settled", "retry-linkage", "selected-anchor", "resize-preserves-anchor",
      "text-glyph-redundancy", "artifact-summary", "diff-summary", "unknown-assertion-negative-control",
    ]) {
      expect(status[unrelated], unrelated).toBe("unmeasured");
    }
  });

  it("rejects an undeclared color variant before producing evidence", () => {
    expect(() => captureFOIScenarioArtifacts(foiScenario("S01"), "unsupported" as FOIColorMode)).toThrow(
      "unsupported is not a color variant for S01",
    );
  });
});
