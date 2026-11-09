import { describe, expect, it } from "vitest";
import { FOI_CORPUS_ID, FOI_EVIDENCE_SCHEMA_VERSION, foiScenario, validateFOIScenarioEvidence } from "../src/foi-scenario-contract.js";

function validReceipt(): Record<string, unknown> {
  const manifest = foiScenario("S01");
  return {
    schema_version: FOI_EVIDENCE_SCHEMA_VERSION,
    run_id: "run-s01",
    scenario: {
      id: "S01", corpus: FOI_CORPUS_ID, seed: manifest.seed, simulation: true, story: manifest.story,
      viewport: manifest.fixture.viewport, color_mode: "truecolor",
    },
    provenance: {
      source_set: "INDEPENDENT-DESIGN", source_exposure: "revoy2 and user brief",
      presentation_contract: manifest.presentation_contract,
    },
    execution: {
      command: ["bun", "run", "foi"], source_revision: "abc123", started_at: "start", finished_at: "finish",
      virtual_clock: true, native_harness: true,
    },
    artifacts: {
      raw_event_trace: "trace/events.jsonl", input_trace: "trace/input.jsonl",
      semantic_snapshots: ["frames/final.json"], event_boundary_frames: ["frames/boundary.json"],
      sampled_frames: ["frames/sample.json"], recording: "recording/session.cast", checksums: "checksums.sha256",
    },
    assertions: manifest.required_assertions.map((id) => ({ id, status: "pass", evidence: `checks/${id}.json` })),
    measurements: {
      event_to_visible_ms: { status: "measured", value: 1, unit: "ms" },
      input_to_render_ms: { status: "measured", value: 1, unit: "ms" },
      render_ms: { status: "measured", value: 1, unit: "ms" },
      memory_bytes: { status: "measured", value: 1, unit: "bytes" },
      queue_high_water: { status: "measured", value: 1, unit: "count" },
      cleanup: { status: "measured", subscriptions: 0, timers: 0, subprocesses: 0, handles: 0, terminal_mode_residue: 0 },
    },
    verdict: "pass",
  };
}

describe("FOI untrusted evidence validation edges", () => {
  it("rejects non-object and unknown-scenario receipts without throwing", () => {
    expect(validateFOIScenarioEvidence(null)).toEqual({ valid: false, can_pass: false, errors: ["evidence receipt must be an object"] });
    const receipt = validReceipt();
    const result = validateFOIScenarioEvidence({
      ...receipt, schema_version: 2, run_id: " bad id ", scenario: { id: "S99" }, provenance: null,
      execution: null, artifacts: null, assertions: null, measurements: null, verdict: "unknown",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "schema_version must be 1", "run_id is invalid", "scenario must name an foi-v1 S01-S20 manifest entry",
      "provenance must record INDEPENDENT-DESIGN and bounded source exposure", "execution is missing",
      "artifacts is missing", "assertions must contain 1-64 bounded entries", "measurements is missing", "verdict is invalid",
    ]));
  });

  it("rejects identity, viewport, color, provenance, and execution drift independently", () => {
    const receipt = validReceipt();
    const scenario = receipt.scenario as Record<string, unknown>;
    const provenance = receipt.provenance as Record<string, unknown>;
    const execution = receipt.execution as Record<string, unknown>;
    const result = validateFOIScenarioEvidence({
      ...receipt,
      scenario: {
        ...scenario, corpus: "other", seed: 99, simulation: false, story: "rewritten",
        viewport: { columns: 0.5, rows: 0 }, color_mode: "monochrome",
      },
      provenance: { ...provenance, source_set: "UNKNOWN", source_exposure: "" , presentation_contract: "other" },
      execution: { ...execution, command: ["", 4], source_revision: "", started_at: "", finished_at: "", virtual_clock: false },
      verdict: "inconclusive",
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      "scenario.corpus must be foi-v1", "scenario identity does not match its immutable manifest",
      "scenario.viewport must contain positive safe integers", "scenario.color_mode is invalid",
      "provenance must record INDEPENDENT-DESIGN and bounded source exposure",
      "provenance.presentation_contract does not match the manifest",
      "execution.command must contain 1-64 bounded strings", "execution revision and timestamps are required",
      "execution.virtual_clock must be true for foi-v1",
    ]));
  });

  it("rejects every unsafe artifact path family and malformed artifact list", () => {
    const receipt = validReceipt();
    const result = validateFOIScenarioEvidence({
      ...receipt,
      artifacts: {
        raw_event_trace: "/absolute.jsonl", input_trace: "trace\\input.jsonl", recording: "../outside.cast",
        checksums: "", semantic_snapshots: [], event_boundary_frames: ["frames/../escape.json"],
        sampled_frames: Array.from({ length: 65 }, () => "frames/sample.json"),
      },
      verdict: "inconclusive",
    });
    expect(result.errors.filter((error) => error.startsWith("artifacts."))).toHaveLength(7);
  });

  it("rejects malformed, duplicate, non-passing, and missing assertions", () => {
    const receipt = validReceipt();
    const result = validateFOIScenarioEvidence({
      ...receipt,
      assertions: [
        null,
        { id: "projection-contract", status: "pass", evidence: "checks/one.json" },
        { id: "projection-contract", status: "planned", evidence: "checks/two.json" },
        { id: "bad", status: "mystery", evidence: "" },
      ],
      verdict: "inconclusive",
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      "assertion is malformed", "assertion projection-contract is duplicated",
      "assertion projection-contract is planned, not pass", "required assertion final-answer-visible is missing",
    ]));
  });

  it("rejects absent, unmeasured, non-finite, negative, and wrongly-unitized metrics", () => {
    const receipt = validReceipt();
    const result = validateFOIScenarioEvidence({
      ...receipt,
      measurements: {
        event_to_visible_ms: null,
        input_to_render_ms: { status: "planned" },
        render_ms: { status: "measured", value: Number.NaN, unit: "ms" },
        memory_bytes: { status: "measured", value: -1, unit: "bytes" },
        queue_high_water: { status: "measured", value: 1, unit: "seconds" },
        cleanup: null,
      },
      verdict: "inconclusive",
    });
    expect(result.can_pass).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "measurements.event_to_visible_ms measurement is missing",
      "measurements.input_to_render_ms is planned, not measured",
      "measurements.render_ms measured value is invalid",
      "measurements.memory_bytes measured value is invalid",
      "measurements.queue_high_water measured value is invalid",
      "measurements.cleanup is unmeasured, not measured",
    ]));
  });

  it("distinguishes invalid cleanup values from observed non-zero residue", () => {
    const receipt = validReceipt();
    const measurements = receipt.measurements as Record<string, unknown>;
    const result = validateFOIScenarioEvidence({
      ...receipt,
      measurements: {
        ...measurements,
        cleanup: { status: "measured", subscriptions: -1, timers: 1.5, subprocesses: 1, handles: 2, terminal_mode_residue: null },
      },
      verdict: "pass",
    });
    expect(result.valid).toBe(false);
    expect(result.can_pass).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "measurements.cleanup.subscriptions is invalid", "measurements.cleanup.timers is invalid",
      "measurements.cleanup.subprocesses is 1, not zero", "measurements.cleanup.handles is 2, not zero",
      "measurements.cleanup.terminal_mode_residue is invalid",
      "pass verdict requires every required assertion and measurement to pass from the native harness",
    ]));
  });
});
