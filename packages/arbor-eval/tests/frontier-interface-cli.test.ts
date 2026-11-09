import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FOI_V1_SCENARIOS, foiScenario } from "@arbor/tui";
import { runFrontierInterfaceCli, type FrontierInterfaceCliIo } from "../src/frontier-interface-cli.js";

const temporary: string[] = [];
const BASELINE_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASELINE_TREE = "cccccccccccccccccccccccccccccccccccccccc";
const CANDIDATE_TREE = "dddddddddddddddddddddddddddddddddddddddd";
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function io(
  files: Readonly<Record<string, string>> = {},
  captureTrees: Readonly<Record<string, string>> = {},
): { port: FrontierInterfaceCliIo; out: string[]; err: string[]; writes: Map<string, string> } {
  const out: string[] = [];
  const err: string[] = [];
  const writes = new Map<string, string>();
  return {
    out,
    err,
    writes,
    port: {
      stdout: (value) => out.push(value),
      stderr: (value) => err.push(value),
      read: (path) => {
        const value = writes.get(path) ?? files[path];
        if (value === undefined) throw new Error(`missing fixture ${path}`);
        return value;
      },
      write: (path, value) => writes.set(path, value),
      capture_tree_for_revision: (revision) => captureTrees[revision] ?? null,
    },
  };
}

describe("frontier-interface evaluation CLI", () => {
  it("emits a planned, never-passing deterministic scenario input", () => {
    const capture = io();
    expect(runFrontierInterfaceCli(["plan", "S07"], capture.port)).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({
      corpus: "foi-v1",
      evidence_status: "planned",
      native_harness_required_for_pass: true,
      scenarios: [{ id: "S07", session_count: 2 }],
    });
  });

  it("rejects unknown scenarios and malformed evidence without fabricating a result", () => {
    const unknown = io();
    expect(runFrontierInterfaceCli(["plan", "S99"], unknown.port)).toBe(2);
    expect(unknown.err[0]).toContain("unknown foi-v1 scenario");

    const malformed = io({ "bad.json": "{}" });
    expect(runFrontierInterfaceCli(["validate", "bad.json"], malformed.port)).toBe(1);
    expect(JSON.parse(malformed.out[0]!)).toMatchObject({ valid: false, can_pass: false });
  });

  it("materializes an explicitly non-passing native-harness evidence handoff and reports its missing boundary", () => {
    const capture = io();
    expect(runFrontierInterfaceCli(["prepare", "S07", "artifacts/s07.bundle.json"], capture.port)).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({
      scenario: "S07",
      evidence_status: "unmeasured",
      missing_artifact_count: 7,
      can_pass: false,
    });

    const bundle = JSON.parse(capture.writes.get("artifacts/s07.bundle.json")!);
    expect(bundle).toMatchObject({
      bundle_type: "foi-v1-native-harness-preparation",
      evidence_status: "unmeasured",
      native_harness_required_for_pass: true,
      provider_or_connector_invoked: false,
      scenario: { id: "S07", corpus: "foi-v1", seed: 7 },
      materialized_input: { session_count: 2, virtual_clock: true },
      evidence_receipt: null,
      receipt_template: {
        verdict: "inconclusive",
        execution: { native_harness: false },
      },
    });
    expect(bundle.missing_artifacts).toHaveLength(7);
    expect(bundle.missing_artifacts.every((artifact: { status: string }) => artifact.status === "missing")).toBe(true);
    expect(bundle.blocking_reason).toContain("No native-harness corpus recorder command is registered");

    const verification = io({ "artifacts/s07.bundle.json": capture.writes.get("artifacts/s07.bundle.json")! });
    expect(runFrontierInterfaceCli(["verify-bundle", "artifacts/s07.bundle.json"], verification.port)).toBe(1);
    expect(JSON.parse(verification.out[0]!)).toMatchObject({
      valid: true,
      can_pass: false,
      evidence_present: false,
      missing_artifact_count: 7,
    });

    const receiptOnlyPass = structuredClone(bundle);
    receiptOnlyPass.evidence_receipt = receiptOnlyPass.receipt_template;
    receiptOnlyPass.evidence_receipt.execution = {
      ...receiptOnlyPass.evidence_receipt.execution,
      source_revision: "source-revision",
      started_at: "2026-08-30T00:00:00.000Z",
      finished_at: "2026-08-30T00:00:01.000Z",
      native_harness: true,
    };
    receiptOnlyPass.evidence_receipt.assertions = receiptOnlyPass.evidence_receipt.assertions.map((assertion: { id: string }) => ({
      ...assertion,
      status: "pass",
      evidence: `checks/${assertion.id}.json`,
    }));
    receiptOnlyPass.evidence_receipt.measurements = {
      event_to_visible_ms: { status: "measured", value: 1, unit: "ms" },
      input_to_render_ms: { status: "measured", value: 1, unit: "ms" },
      render_ms: { status: "measured", value: 1, unit: "ms" },
      memory_bytes: { status: "measured", value: 1, unit: "bytes" },
      queue_high_water: { status: "measured", value: 1, unit: "count" },
      cleanup: { status: "measured", subscriptions: 0, timers: 0, subprocesses: 0, handles: 0, terminal_mode_residue: 0 },
    };
    receiptOnlyPass.evidence_receipt.verdict = "pass";
    const receiptOnlyVerification = io({ "artifacts/s07.bundle.json": JSON.stringify(receiptOnlyPass) });
    expect(runFrontierInterfaceCli(["verify-bundle", "artifacts/s07.bundle.json"], receiptOnlyVerification.port)).toBe(1);
    expect(JSON.parse(receiptOnlyVerification.out[0]!)).toMatchObject({
      can_pass: false,
      evidence_receipt_can_pass: true,
      artifact_files_checked: false,
    });

    const recorded = structuredClone(receiptOnlyPass);
    recorded.missing_artifacts = recorded.missing_artifacts.map((artifact: Record<string, unknown>) => ({ ...artifact, status: "present" }));
    const artifactBytes: Record<string, string> = {
      "raw-event-trace.ndjson": '{"sequence":1}\n',
      "input-trace.ndjson": '{"at":0,"input":"start"}\n',
      "semantic-snapshots/final.json": '{"screen":"live-session"}\n',
      "frames/boundary-terminal.json": '{"rows":["done"]}\n',
      "frames/sampled-final.json": '{"rows":["done"]}\n',
      "recording.cast": '{"version":2,"width":100,"height":30}\n',
    };
    const checksums = Object.entries(artifactBytes)
      .map(([path, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${path}`)
      .join("\n") + "\n";
    const verifiedFiles: Record<string, string> = {
      "artifacts/s07.bundle.json": JSON.stringify(recorded),
      "artifacts/checksums.sha256": checksums,
      ...Object.fromEntries(Object.entries(artifactBytes).map(([path, bytes]) => [`artifacts/${path}`, bytes])),
    };
    const recordedVerification = io(verifiedFiles);
    expect(runFrontierInterfaceCli(["verify-bundle", "artifacts/s07.bundle.json"], recordedVerification.port)).toBe(0);
    expect(JSON.parse(recordedVerification.out[0]!)).toMatchObject({
      valid: true,
      can_pass: true,
      evidence_receipt_can_pass: true,
      artifact_files_checked: true,
      blocking_reason: null,
      errors: [],
    });

    const tamperedFiles = { ...verifiedFiles, "artifacts/recording.cast": "tampered\n" };
    const tamperedVerification = io(tamperedFiles);
    expect(runFrontierInterfaceCli(["verify-bundle", "artifacts/s07.bundle.json"], tamperedVerification.port)).toBe(1);
    expect(JSON.parse(tamperedVerification.out[0]!).errors).toContain("checksum mismatch for recording.cast");
  });

  it("records and checksums the real production projection without claiming a native renderer commit", () => {
    const capture = io();
    expect(runFrontierInterfaceCli(["record", "S06", "artifacts/s06.bundle.json", "abc123"], capture.port)).toBe(0);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ scenario: "S06", evidence_status: "recorded_inconclusive", artifact_count: 7, can_pass: false });
    const bundle = JSON.parse(capture.writes.get("artifacts/s06.bundle.json")!);
    expect(bundle).toMatchObject({
      evidence_status: "recorded_inconclusive",
      evidence_receipt: { execution: { source_revision: "abc123", native_harness: false }, verdict: "inconclusive" },
    });
    expect(bundle.missing_artifacts.every((artifact: { status: string }) => artifact.status === "present")).toBe(true);
    expect(capture.writes.get("artifacts/semantic-snapshots/final.json")).toContain('"parent_id": "agent-1"');

    const verified = io(Object.fromEntries(capture.writes));
    expect(runFrontierInterfaceCli(["verify-bundle", "artifacts/s06.bundle.json"], verified.port)).toBe(1);
    expect(JSON.parse(verified.out[0]!)).toMatchObject({
      valid: true,
      can_pass: false,
      artifact_files_checked: true,
      evidence_receipt_can_pass: false,
    });
  });

  it("binds native baseline/candidate evidence to blinded moderator assignments and refuses missing or tampered observations", () => {
    const root = mkdtempSync(join(tmpdir(), "foi-blinded-comparison-"));
    temporary.push(root);
    const baselineCorpus = join(root, "baseline-corpus");
    const candidateCorpus = join(root, "candidate-corpus");
    const baselinePerformance = join(root, "baseline-performance.json");
    const candidatePerformance = join(root, "candidate-performance.json");
    writeComparisonCorpus(baselineCorpus, BASELINE_REVISION, BASELINE_TREE);
    writeComparisonCorpus(candidateCorpus, CANDIDATE_REVISION, CANDIDATE_TREE);
    writeComparisonPerformance(baselinePerformance, BASELINE_REVISION);
    writeComparisonPerformance(candidatePerformance, CANDIDATE_REVISION);
    const capture = io(Object.fromEntries(readTree(root)), {
      [BASELINE_REVISION]: BASELINE_TREE,
      [CANDIDATE_REVISION]: CANDIDATE_TREE,
    });
    const destination = join(root, "review");

    expect(runFrontierInterfaceCli([
      "prepare-blinded-comparison", destination, baselineCorpus, baselinePerformance, candidateCorpus, candidatePerformance, "seed-1", "moderator-secret",
    ], capture.port)).toBe(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({
      valid_inputs: true,
      blinded_observations_present: false,
      acceptance_can_pass: false,
      moderator_artifact_map: join(destination, "moderator-artifact-map.json"),
    });
    const plan = JSON.parse(capture.writes.get(join(destination, "blinded-comparison-plan.json"))!);
    const form = JSON.parse(capture.writes.get(join(destination, "blinded-review-form.json"))!);
    const moderatorMap = JSON.parse(capture.writes.get(join(destination, "moderator-artifact-map.json"))!);
    expect(form).toMatchObject({ observation_status: "pending", historical_opencode_reels_admissible: false });
    expect(JSON.stringify(form)).not.toContain(BASELINE_REVISION);
    expect(JSON.stringify(form)).not.toContain(CANDIDATE_REVISION);
    expect(moderatorMap.cases[0].artifacts).toEqual(expect.objectContaining({
      A: expect.objectContaining({ treatment: expect.any(String) }),
      B: expect.objectContaining({ treatment: expect.any(String) }),
    }));

    const noObservationsPath = join(root, "none.json");
    capture.writes.set(noObservationsPath, "[]\n");
    capture.out.length = 0;
    expect(runFrontierInterfaceCli(["aggregate-blinded-comparison", join(destination, "blinded-comparison-plan.json"), noObservationsPath, join(root, "aggregate-none"), "moderator-secret"], capture.port)).toBe(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ aggregate: null, acceptance_can_pass: false });

    const assignment = plan.assignments[0];
    const observationsPath = join(root, "observations.json");
    capture.writes.set(observationsPath, `${JSON.stringify([{
      participant_id: "participant-001",
      case_id: assignment.case_id,
      variant_label: assignment.baseline_label,
      duration_ms: 950,
      correct: true,
      navigation_actions: 2,
      confidence: 4,
      workload: 2,
      preference: assignment.baseline_label,
      confusion_notes: "",
    }])}\n`);
    capture.out.length = 0;
    expect(runFrontierInterfaceCli(["aggregate-blinded-comparison", join(destination, "blinded-comparison-plan.json"), observationsPath, join(root, "aggregate"), "moderator-secret"], capture.port)).toBe(0);
    const aggregate = JSON.parse(capture.writes.get(join(root, "aggregate", "blinded-review-aggregate.json"))!);
    expect(aggregate).toMatchObject({ observation_count: 1, acceptance_can_pass: false, historical_opencode_reels_admissible: false });

    const tamperedAssignments = structuredClone(plan);
    tamperedAssignments.assignments[0].baseline_label = tamperedAssignments.assignments[0].candidate_label;
    const tamperedPlanPath = join(root, "tampered-assignment.json");
    capture.writes.set(tamperedPlanPath, `${JSON.stringify(tamperedAssignments)}\n`);
    capture.out.length = 0;
    expect(runFrontierInterfaceCli(["aggregate-blinded-comparison", tamperedPlanPath, observationsPath, join(root, "aggregate-tampered"), "moderator-secret"], capture.port)).toBe(1);
    expect(JSON.parse(capture.out[0]!).errors[0]).toContain("comparison inputs changed");

    const tamperedComparisonId = structuredClone(plan);
    tamperedComparisonId.comparison_id = "tampered";
    const tamperedIdPath = join(root, "tampered-id.json");
    capture.writes.set(tamperedIdPath, `${JSON.stringify(tamperedComparisonId)}\n`);
    capture.out.length = 0;
    expect(runFrontierInterfaceCli(["aggregate-blinded-comparison", tamperedIdPath, observationsPath, join(root, "aggregate-tampered-id"), "moderator-secret"], capture.port)).toBe(1);
    expect(JSON.parse(capture.out[0]!).errors[0]).toContain("comparison inputs changed");
  });

  it("does not admit a historical OpenCode reel path as native baseline evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "foi-opencode-rejection-"));
    temporary.push(root);
    const baselineCorpus = join(root, "opencode-tui-reel-2026-08-29");
    const candidateCorpus = join(root, "candidate-corpus");
    const baselinePerformance = join(root, "baseline-performance.json");
    const candidatePerformance = join(root, "candidate-performance.json");
    writeComparisonCorpus(baselineCorpus, BASELINE_REVISION, BASELINE_TREE);
    writeComparisonCorpus(candidateCorpus, CANDIDATE_REVISION, CANDIDATE_TREE);
    writeComparisonPerformance(baselinePerformance, BASELINE_REVISION);
    writeComparisonPerformance(candidatePerformance, CANDIDATE_REVISION);
    const capture = io(Object.fromEntries(readTree(root)), {
      [BASELINE_REVISION]: BASELINE_TREE,
      [CANDIDATE_REVISION]: CANDIDATE_TREE,
    });
    expect(runFrontierInterfaceCli([
      "prepare-blinded-comparison", join(root, "review"), baselineCorpus, baselinePerformance, candidateCorpus, candidatePerformance, "seed", "moderator-secret",
    ], capture.port)).toBe(1);
    expect(JSON.parse(capture.out[0]!)).toMatchObject({ valid_inputs: false, comparison_plan: null });
    expect(JSON.parse(capture.out[0]!).errors.join("\n")).toContain("OpenCode reel");
  });
});

function readTree(root: string): readonly [string, string][] {
  const files: [string, string][] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push([path, readFileSync(path, "utf8")]);
    }
  };
  walk(root);
  return files;
}

function writeComparisonCorpus(root: string, revision: string, tree: string): void {
  const matrix = comparisonVariants().map((variant) => {
    const manifest = foiScenario(variant.id as never);
    const base = join(root, variant.id, `${variant.viewport.columns}x${variant.viewport.rows}`, variant.color_mode);
    const artifactFiles: Record<string, string> = {
      "raw-event-trace.ndjson": "{}\n",
      "input-trace.ndjson": "{}\n",
      "semantic-snapshots/final.json": "{}\n",
      "frames/boundary-terminal.json": "{}\n",
      "frames/sampled-final.json": "{}\n",
      "recording.cast": "{}\n",
    };
    const checksums = Object.entries(artifactFiles).map(([path, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${path}`).join("\n") + "\n";
    for (const [path, bytes] of Object.entries({ ...artifactFiles, "checksums.sha256": checksums })) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), bytes, "utf8");
    }
    const receipt = {
      schema_version: 1,
      run_id: `fixture-${variant.id}-${variant.viewport.columns}-${variant.color_mode}`,
      scenario: { id: manifest.id, corpus: manifest.corpus, seed: manifest.seed, simulation: manifest.simulation, story: manifest.story, viewport: variant.viewport, color_mode: variant.color_mode },
      provenance: { source_set: "INDEPENDENT-DESIGN", source_exposure: "fixture", presentation_contract: manifest.presentation_contract },
      execution: { command: ["fixture"], source_revision: revision, started_at: "2026-08-30T00:00:00.000Z", finished_at: "2026-08-30T00:00:01.000Z", virtual_clock: true, native_harness: false, native_renderer_commit: true },
      artifacts: { raw_event_trace: "raw-event-trace.ndjson", input_trace: "input-trace.ndjson", semantic_snapshots: ["semantic-snapshots/final.json"], event_boundary_frames: ["frames/boundary-terminal.json"], sampled_frames: ["frames/sampled-final.json"], recording: "recording.cast", checksums: "checksums.sha256" },
      assertions: manifest.required_assertions.map((id) => ({ id, status: "pass", evidence: "frames/boundary-terminal.json" })),
      measurements: { event_to_visible_ms: { status: "measured", value: 1, unit: "ms" }, input_to_render_ms: { status: "measured", value: 1, unit: "ms" }, render_ms: { status: "measured", value: 1, unit: "ms" }, memory_bytes: { status: "measured", value: 1, unit: "bytes" }, queue_high_water: { status: "measured", value: 1, unit: "count" }, cleanup: { status: "measured", subscriptions: 0, timers: 0, subprocesses: 0, handles: 0, terminal_mode_residue: 0 } },
      verdict: "inconclusive",
    };
    const bundle = {
      bundle_type: "foi-v1-native-harness-preparation",
      bundle_schema_version: 1,
      native_harness_required_for_pass: true,
      provider_or_connector_invoked: false,
      scenario: { id: manifest.id, corpus: manifest.corpus, seed: manifest.seed },
      missing_artifacts: [
        ["raw_event_trace", "raw-event-trace.ndjson"], ["input_trace", "input-trace.ndjson"], ["semantic_snapshot", "semantic-snapshots/final.json"], ["event_boundary_frame", "frames/boundary-terminal.json"], ["sampled_frame", "frames/sampled-final.json"], ["recording", "recording.cast"], ["checksums", "checksums.sha256"],
      ].map(([id, path]) => ({ id, path, status: "present" })),
      evidence_receipt: receipt,
    };
    writeFileSync(join(base, "bundle.json"), `${JSON.stringify(bundle)}\n`, "utf8");
    return { ...variant, source_revision: revision, evidence_status: "inconclusive", verification_valid: true, artifact_files_checked: true, can_pass: false, errors: [] };
  });
  writeFileSync(join(root, "corpus-summary.json"), `${JSON.stringify({
    bundle_type: "foi-v1-native-renderer-corpus", bundle_schema_version: 1, corpus: "foi-v1", source_revision: revision,
    capture_source: { revision, tree, clean: true },
    native_harness_required_for_pass: true, provider_or_connector_invoked: false, matrix,
    summary: { total: matrix.length, pass: 0, inconclusive: matrix.length, fail: 0, evidence_status: "inconclusive", can_pass: false },
  })}\n`, "utf8");
}

function comparisonVariants(): readonly { readonly id: string; readonly viewport: { readonly columns: number; readonly rows: number }; readonly color_mode: string; readonly bundle: string }[] {
  return FOI_V1_SCENARIOS.flatMap((manifest) => {
    const seen = new Set<string>();
    const viewports = [manifest.fixture.viewport, ...(manifest.fixture.resize_trace?.viewports ?? [])].filter((viewport) => {
      const key = `${viewport.columns}x${viewport.rows}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return viewports.flatMap((viewport) => manifest.fixture.color_modes.map((color_mode) => ({
      id: manifest.id,
      viewport,
      color_mode,
      bundle: `${manifest.id}/${viewport.columns}x${viewport.rows}/${color_mode}/bundle.json`,
    })));
  });
}

function writeComparisonPerformance(path: string, revision: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    bundle_type: "foi-v1-native-performance-report", bundle_schema_version: 1, source_revision: revision,
    execution: { native_renderer_commit: true, native_session_engine: false, provider_or_connector_invoked: false },
    aggregate: { event_to_visible_p95_ms: 1 }, samples: [{}], interaction_samples: [{}], performance_budget_pass: true, evidence_status: "measured",
  })}\n`, "utf8");
}
