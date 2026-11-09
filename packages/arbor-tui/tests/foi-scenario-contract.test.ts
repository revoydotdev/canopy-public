import { describe, expect, it } from "vitest";
import { buildOperatorViewModel } from "../src/operator-view-model.js";
import { FOI_CORPUS_ID, FOI_EVIDENCE_SCHEMA_VERSION, FOI_V1_SCENARIOS, foiScenario, materializeFOIScenario, validateFOIScenarioEvidence, type FOIScenarioEvidence } from "../src/foi-scenario-contract.js";

function passEvidence(id: Parameters<typeof foiScenario>[0]): FOIScenarioEvidence {
  const manifest = foiScenario(id);
  return {
    schema_version: FOI_EVIDENCE_SCHEMA_VERSION,
    run_id: `run-${id.toLowerCase()}`,
    scenario: { id, corpus: FOI_CORPUS_ID, seed: manifest.seed, simulation: manifest.simulation, story: manifest.story, viewport: manifest.fixture.viewport, color_mode: manifest.fixture.color_modes[0]! },
    provenance: { source_set: "INDEPENDENT-DESIGN", source_exposure: "revoy2 and user brief only", presentation_contract: manifest.presentation_contract },
    execution: { command: ["bun", "run", "foi", id], source_revision: "abc123", started_at: "2026-08-30T00:00:00.000Z", finished_at: "2026-08-30T00:00:01.000Z", virtual_clock: true, native_harness: true },
    artifacts: {
      raw_event_trace: "trace/events.jsonl",
      input_trace: "trace/input.jsonl",
      semantic_snapshots: ["frames/final.json"],
      event_boundary_frames: ["frames/boundary.json"],
      sampled_frames: ["frames/sample.json"],
      recording: "recording/session.cast",
      checksums: "checksums.sha256",
    },
    assertions: manifest.required_assertions.map((assertion) => ({ id: assertion, status: "pass", evidence: `checks/${assertion}.json` })),
    measurements: {
      event_to_visible_ms: { status: "measured", value: 10, unit: "ms" },
      input_to_render_ms: { status: "measured", value: 10, unit: "ms" },
      render_ms: { status: "measured", value: 10, unit: "ms" },
      memory_bytes: { status: "measured", value: 1024, unit: "bytes" },
      queue_high_water: { status: "measured", value: 1, unit: "count" },
      cleanup: { status: "measured", subscriptions: 0, timers: 0, subprocesses: 0, handles: 0, terminal_mode_residue: 0 },
    },
    verdict: "pass",
  };
}

describe("foi-v1 scenario contract", () => {
  it("defines exactly S01-S20 with fixed deterministic inputs", () => {
    expect(FOI_V1_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10",
      "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S19", "S20",
    ]);
    expect(FOI_V1_SCENARIOS.every((scenario) => scenario.corpus === FOI_CORPUS_ID && scenario.simulation && Object.isFrozen(scenario))).toBe(true);
    expect(FOI_V1_SCENARIOS.map((scenario) => scenario.seed)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(foiScenario("S16").fixture.events.reduce((total, event) => total + event.repeat, 0)).toBe(10_000);
    expect(foiScenario("S19").fixture.color_modes).toEqual(["truecolor", "ansi256", "reduced", "no_color"]);
  });

  it("materializes every scenario through the existing production projection boundary", () => {
    for (const scenario of FOI_V1_SCENARIOS) {
      const input = materializeFOIScenario(scenario);
      const view = buildOperatorViewModel(input);
      expect(view.freshness.evaluated_at_ms).toBe(scenario.seed * 1_000);
      expect(view.document.length).toBeLessThanOrEqual(2_000);
      expect(view.document.every((row) => row.source === "canonical_session" || row.source === "devtools")).toBe(true);
    }
    expect(materializeFOIScenario(foiScenario("S20")).session_attach).toMatchObject({ events: [] });
    expect(buildOperatorViewModel(materializeFOIScenario(foiScenario("S07"))).background).toMatchObject([
      { session_id: "foi-s07-b", node_id: "foi-node-s07-b", lifecycle: "active" },
    ]);
    expect(buildOperatorViewModel(materializeFOIScenario(foiScenario("S06"))).document).toEqual(expect.arrayContaining([
      expect.objectContaining({ parent_id: "agent-1" }),
      expect.objectContaining({ parent_id: "command-1" }),
    ]));
  });

  it("binds S03 multiline output and S04 command/result series through explicit canonical identities", () => {
    const s03 = buildOperatorViewModel(materializeFOIScenario(foiScenario("S03")));
    const output = s03.document.find((row) => row.command?.role === "result")?.command?.output;
    expect(output).toMatchObject({
      channel: "stdout", line_count: 12,
      lines: expect.arrayContaining(["deterministic output line 01", "deterministic output line 12"]),
    });

    const s04 = buildOperatorViewModel(materializeFOIScenario(foiScenario("S04")));
    expect(s04.document.filter((row) => row.command?.role === "invocation")).toHaveLength(40);
    expect(s04.document.filter((row) => row.command?.role === "result" && row.command.paired_event_id !== null)).toHaveLength(40);
    expect(s04.command_groups).toEqual([expect.objectContaining({
      id: "s04-command-series", command_count: 40, paired_count: 40, unpaired_count: 0, completed_count: 40,
    })]);
    expect(s04.document.find((row) => row.command?.ordinal === 40 && row.command.role === "result")).toMatchObject({
      parent_id: "s04-command-40", summary: "40/40 done: shell",
    });
  });

  it("accepts a complete, bound, native-harness pass receipt", () => {
    const result = validateFOIScenarioEvidence(passEvidence("S06"));
    expect(result).toEqual({ valid: true, can_pass: true, errors: [] });
  });

  it("allows an honestly inconclusive receipt but never lets planned or unmeasured evidence pass", () => {
    const planned = passEvidence("S12");
    const evidence: FOIScenarioEvidence = {
      ...planned,
      assertions: planned.assertions.map((item, index) => index === 0 ? { ...item, status: "planned" as const } : item),
      measurements: { ...planned.measurements, render_ms: { status: "unmeasured", reason: "capture interrupted" } },
      verdict: "inconclusive",
    };
    const inconclusive = validateFOIScenarioEvidence(evidence);
    expect(inconclusive.valid).toBe(true);
    expect(inconclusive.can_pass).toBe(false);

    const attemptedPass = validateFOIScenarioEvidence({ ...evidence, verdict: "pass" });
    expect(attemptedPass.valid).toBe(false);
    expect(attemptedPass.can_pass).toBe(false);
    expect(attemptedPass.errors).toContain("pass verdict requires every required assertion and measurement to pass from the native harness");
  });

  it("rejects unsafe artifact paths, missing required assertions, and fixture-only pass claims", () => {
    const receipt = passEvidence("S09");
    const result = validateFOIScenarioEvidence({
      ...receipt,
      execution: { ...receipt.execution, native_harness: false },
      artifacts: { ...receipt.artifacts, recording: "../outside/session.cast" },
      assertions: receipt.assertions.slice(1),
    });
    expect(result.valid).toBe(false);
    expect(result.can_pass).toBe(false);
    expect(result.errors).toContain("artifacts.recording must be a bounded relative path");
    expect(result.errors).toContain("required assertion projection-contract is missing");
  });

  it("binds receipts to declared viewport and color variants", () => {
    const receipt = passEvidence("S01");
    const result = validateFOIScenarioEvidence({
      ...receipt,
      scenario: { ...receipt.scenario, viewport: { columns: 60, rows: 20 }, color_mode: "no_color" },
      verdict: "inconclusive",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("scenario.viewport is not a manifest variant");
    expect(result.errors).toContain("scenario.color_mode is not a manifest variant");
  });
});
