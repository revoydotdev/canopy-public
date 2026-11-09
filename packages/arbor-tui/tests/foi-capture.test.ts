import { describe, expect, it } from "vitest";
import { captureFOIScenarioArtifacts } from "../src/foi-capture.js";
import { foiScenario } from "../src/foi-scenario-contract.js";
import { clearRegisteredScreens, getScreen } from "../src/screens/screen.js";

describe("FOI deterministic artifact capture", () => {
  it("uses the production projection and SceneFrame while keeping native presentation authority unclaimed", () => {
    const capture = captureFOIScenarioArtifacts(foiScenario("S06"));
    const semantic = JSON.parse(capture.semantic_snapshot);
    expect(semantic.scene.panes[0]).toMatchObject({ title: "FOI S06" });
    expect(semantic.view.document).toEqual(expect.arrayContaining([
      expect.objectContaining({ parent_id: "agent-1" }),
      expect.objectContaining({ parent_id: "command-1" }),
    ]));
    expect(capture.assertion_status).toMatchObject({ "projection-contract": "pass", parentage: "pass" });
    expect(capture.recording.split("\n")[0]).toContain('"version":2');
  });

  it("retains the complete raw stress trace while bounding rendered frames", () => {
    const capture = captureFOIScenarioArtifacts(foiScenario("S16"), "truecolor");
    expect(capture.raw_event_trace.trim().split("\n")).toHaveLength(10_000);
    expect(capture.rendered_frame_count).toBeLessThanOrEqual(32);
    expect(capture.retained_event_count).toBeLessThanOrEqual(2_000);
    expect(capture.assertion_status["retention-bound"]).toBe("pass");
    expect(capture.assertion_status["selected-anchor"]).toBe("pass");
    expect(capture.assertion_status["return-to-live"]).toBe("pass");
    expect(capture.input_trace).toContain('"input":"end_return_to_live"');
  });

  it("labels planned deterministic frames as distinct from canonical runtime observation", () => {
    const boundary = JSON.parse(captureFOIScenarioArtifacts(foiScenario("S01")).event_boundary_frame);
    expect(boundary.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        origin: expect.objectContaining({
          kind: "deterministic_fixture_materialization",
          canonical_event_observed_at_ms: null,
        }),
      }),
    ]));
  });

  it("restores the exact screen registry after capture", () => {
    clearRegisteredScreens();
    expect(() => getScreen("live-session")).toThrow(/not registered/u);
    captureFOIScenarioArtifacts(foiScenario("S01"));
    expect(() => getScreen("live-session")).toThrow(/not registered/u);
  });

  it("awards scenario assertions only from projected and rendered facts", () => {
    expect(captureFOIScenarioArtifacts(foiScenario("S01")).assertion_status).toMatchObject({
      "final-answer-visible": "pass",
      "successful-terminal": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S02")).assertion_status).toMatchObject({
      "stream-order": "pass",
      "bounded-retention": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S03")).assertion_status).toMatchObject({
      "command-invocation": "pass",
      "multiline-output": "pass",
      "successful-terminal": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S04")).assertion_status).toMatchObject({
      "command-series": "pass",
      "result-pairing": "pass",
      "successful-terminal": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S06")).assertion_status).toMatchObject({
      parentage: "pass",
      "narrow-breadcrumb": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S07")).assertion_status).toMatchObject({
      "source-identity": "pass",
      "concurrency-no-false-merge": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S08")).assertion_status).toMatchObject({
      "honest-progress": "pass",
      "active-terminal-transition": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S09")).assertion_status).toMatchObject({
      "failure-not-success": "pass",
      "diagnostic-disclosure": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S10")).assertion_status).toMatchObject({
      "retry-linkage": "pass",
      "previous-attempt-retained": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S11")).assertion_status).toMatchObject({
      "gate-authority": "pass",
      "denied-not-success": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S12")).assertion_status).toMatchObject({
      "interrupt-requested-not-settled": "pass",
      "canonical-interrupted-terminal": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S13")).assertion_status).toMatchObject({
      "degraded-distinct-from-recovered": "pass",
      "replay-deduplication": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S14")).assertion_status).toMatchObject({
      "artifact-summary": "pass",
      "artifact-inspection": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S15")).assertion_status).toMatchObject({
      "diff-summary": "pass",
      "bounded-detail": "pass",
      "retrieval-route": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S16")).assertion_status).toMatchObject({
      "retention-bound": "pass",
      "selected-anchor": "pass",
      "return-to-live": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S05")).assertion_status["channel-distinction"]).toBe("pass");
    expect(captureFOIScenarioArtifacts(foiScenario("S20")).assertion_status).toMatchObject({
      "honest-empty-state": "pass",
      "degraded-not-active": "pass",
      "recovery-action": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S17")).assertion_status).toMatchObject({
      "resize-preserves-anchor": "pass",
      "no-duplicate-events": "pass",
    });
    expect(captureFOIScenarioArtifacts(foiScenario("S18")).assertion_status).toMatchObject({
      "narrow-layout": "pass",
      "standard-layout": "pass",
      "wide-layout": "pass",
    });
    for (const mode of ["truecolor", "ansi256", "reduced", "no_color"] as const) {
      const capture = captureFOIScenarioArtifacts(foiScenario("S19"), mode);
      expect(capture.assertion_status).toMatchObject({
        "text-glyph-redundancy": "pass",
        "no-color-meaning": "pass",
      });
      const semantic = JSON.parse(capture.semantic_snapshot);
      expect(semantic.color_accessibility.text_equivalent_without_sgr).toBe(true);
      expect(semantic.color_accessibility.no_color_scene.rows.join("\n")).not.toContain("\u001b[");
    }
  });

  it("records first-run, disconnected, and degraded states without presenting any as active", () => {
    const capture = captureFOIScenarioArtifacts(foiScenario("S20"));
    const semantic = JSON.parse(capture.semantic_snapshot);
    expect(semantic.availability_states.first_run.join("\n")).toContain("Awaiting live session projection");
    expect(semantic.availability_states.disconnected.join("\n")).toContain("reopen Live Session to refresh");
    expect(semantic.availability_states.partially_degraded.join("\n")).toContain("canonical activity cannot be confirmed");
    expect(capture.input_trace).toContain('"input":"runtime_disconnected"');
  });

  it("drives the declared resize storm and records each responsive composition", () => {
    const storm = captureFOIScenarioArtifacts(foiScenario("S17"));
    const stormSemantic = JSON.parse(storm.semantic_snapshot);
    expect(stormSemantic.responsive_interaction.transition_count).toBe(100);
    expect(storm.input_trace.match(/"input":"resize"/gu)).toHaveLength(100);
    expect(stormSemantic.responsive_interaction.anchor_after.anchor_id).toBe(stormSemantic.responsive_interaction.anchor_before.anchor_id);

    const layouts = JSON.parse(captureFOIScenarioArtifacts(foiScenario("S18")).semantic_snapshot);
    expect(layouts.responsive_interaction.rendered_viewports).toEqual([
      { width: 60, height: 20 },
      { width: 100, height: 30 },
      { width: 160, height: 48 },
    ]);
  });
});
