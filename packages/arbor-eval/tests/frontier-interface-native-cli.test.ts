/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFrontierInterfaceCli, runFrontierInterfaceNativeCli, type FrontierInterfaceCliIo, type FOICaptureSourceIdentity } from "../src/frontier-interface-cli.js";
import { captureFOINativeScenarioArtifacts, foiScenario } from "@arbor/tui";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const TEST_CAPTURE_REVISION = "a".repeat(40);
const TEST_CAPTURE_TREE = "b".repeat(40);

function diskIo(out: string[], err: string[], captureSource?: FOICaptureSourceIdentity): FrontierInterfaceCliIo {
  return {
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
    read: (path) => readFileSync(path, "utf8"),
    write: (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, "utf8"); },
    ...(captureSource === undefined ? {} : { capture_source_identity: () => captureSource }),
  };
}

function expectedVariant(id: string, columns: number, rows: number, color_mode: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id,
    viewport: Object.freeze({ columns, rows }),
    color_mode,
    bundle: `${id}/${columns}x${rows}/${color_mode}/bundle.json`,
    source_revision: TEST_CAPTURE_REVISION,
  });
}

const EXPECTED_NATIVE_CORPUS_VARIANTS = Object.freeze([
  ...["S01", "S02", "S03", "S04"].map((id) => expectedVariant(id, 100, 30, "truecolor")),
  ...["truecolor", "ansi256", "reduced", "no_color"].map((color) => expectedVariant("S05", 100, 30, color)),
  expectedVariant("S06", 60, 20, "truecolor"),
  ...["S07", "S08"].map((id) => expectedVariant(id, 100, 30, "truecolor")),
  ...["truecolor", "ansi256", "reduced", "no_color"].map((color) => expectedVariant("S09", 100, 30, color)),
  expectedVariant("S10", 100, 30, "truecolor"),
  ...["truecolor", "ansi256", "reduced", "no_color"].map((color) => expectedVariant("S11", 100, 30, color)),
  ...["S12", "S13", "S14", "S15", "S16"].map((id) => expectedVariant(id, 100, 30, "truecolor")),
  ...[[100, 30], [60, 20], [160, 48]].map(([columns, rows]) => expectedVariant("S17", columns!, rows!, "truecolor")),
  ...[[60, 20], [100, 30], [160, 48]].map(([columns, rows]) => expectedVariant("S18", columns!, rows!, "truecolor")),
  ...["truecolor", "ansi256", "reduced", "no_color"].map((color) => expectedVariant("S19", 100, 30, color)),
  expectedVariant("S20", 100, 30, "truecolor"),
]);

describe("frontier-interface native recorder", () => {
  test("writes an honest native performance report with per-sample resource observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "foi-native-benchmark-"));
    temporary.push(root);
    const reportPath = join(root, "performance.json");
    const out: string[] = [];
    const err: string[] = [];
    const io = diskIo(out, err);

    expect(await runFrontierInterfaceNativeCli(["benchmark-native", reportPath, "benchmark-source-revision", "1"], io)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toMatchObject({ report: reportPath, evidence_status: "measured", performance_budget_pass: true, can_pass: false });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      bundle_type: "foi-v1-native-performance-report",
      source_revision: "benchmark-source-revision",
      execution: { trials_per_scenario: 1, scenarios: ["S01", "S16", "S17"], native_renderer_commit: true, native_session_engine: false, provider_or_connector_invoked: false },
      performance_budget_pass: true,
      evidence_status: "measured",
      can_pass: false,
    });
    expect(report.samples).toHaveLength(3);
    expect(report.interaction_samples).toHaveLength(1);
    expect(report.interaction_samples[0]).toMatchObject({ search: { samples: 100, pass: true }, disclosure: { samples: 100, diff_lines: 1000, pass: true } });
    expect(report.samples.every((sample: { observations: { native_commit_count: number; planned_frame_count: number; native_input_commit: unknown } }) => sample.observations.native_commit_count === sample.observations.planned_frame_count + (sample.observations.native_input_commit === null ? 0 : 1))).toBe(true);
    expect(report.blocking_reasons).toContain("No revision-matched baseline trials are present in this report.");
  }, 30_000);

  test("records and independently verifies scoped S01/S12 real native-runtime round trips", async () => {
    for (const scenario of ["S01", "S12"] as const) {
      const root = mkdtempSync(join(tmpdir(), `foi-runtime-${scenario.toLowerCase()}-`));
      temporary.push(root);
      const out: string[] = [];
      const err: string[] = [];
      const io = diskIo(out, err);

      expect(await runFrontierInterfaceNativeCli(["record-runtime-roundtrip", scenario, root, "runtime-source-revision"], io)).toBe(0);
      expect(err).toEqual([]);
      expect(JSON.parse(out[0]!)).toMatchObject({
        valid: true,
        can_pass: true,
        evidence_status: "pass",
        acceptance_scope: "native-runtime-roundtrip-only",
        full_corpus_can_pass: false,
      });
      const receipt = JSON.parse(readFileSync(join(root, "runtime-receipt.json"), "utf8"));
      expect(receipt).toMatchObject({
        bundle_type: "foi-v1-native-runtime-roundtrip",
        scenario,
        source_revision: "runtime-source-revision",
        evidence_status: "pass",
        acceptance_scope: "native-runtime-roundtrip-only",
        full_corpus_can_pass: false,
        execution: {
          native_session_engine: true,
          runtime_port: true,
          launchable_tui: true,
          native_renderer_commit: false,
          provider_or_connector_invoked: false,
        },
        measurements: { cleanup_settled: true },
      });
      expect(receipt.assertions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "canonical-terminal-transition", status: "pass" }),
        expect.objectContaining({ id: "resource-settlement", status: "pass" }),
      ]));
      if (scenario === "S12") expect(receipt.assertions).toContainEqual(expect.objectContaining({ id: "cancellation-propagation", status: "pass" }));

      out.length = 0;
      expect(runFrontierInterfaceCli(["verify-runtime-roundtrip", root], io)).toBe(0);
      expect(JSON.parse(out[0]!)).toMatchObject({ valid: true, can_pass: true, full_corpus_can_pass: false });

      writeFileSync(join(root, "event-trace.ndjson"), "tampered\n", "utf8");
      out.length = 0;
      expect(runFrontierInterfaceCli(["verify-runtime-roundtrip", root], io)).toBe(1);
      expect(JSON.parse(out[0]!)).toMatchObject({ valid: false, can_pass: false, evidence_status: "fail" });
    }
  }, 30_000);

  test("records S02-S20 transport evidence without promoting fixture or empty-state runs", async () => {
    for (const scenario of ["S06", "S20"] as const) {
      const root = mkdtempSync(join(tmpdir(), `foi-runtime-${scenario.toLowerCase()}-`));
      temporary.push(root);
      const out: string[] = [];
      const err: string[] = [];
      const io = diskIo(out, err);

      expect(await runFrontierInterfaceNativeCli(["record-runtime-roundtrip", scenario, root, "runtime-source-revision"], io)).toBe(1);
      expect(err).toEqual([]);
      expect(JSON.parse(out[0]!)).toMatchObject({
        valid: true,
        can_pass: false,
        acceptance_scope: "native-runtime-transport-only",
        full_corpus_can_pass: false,
      });
      const receipt = JSON.parse(readFileSync(join(root, "runtime-receipt.json"), "utf8"));
      expect(receipt).toMatchObject({
        scenario,
        acceptance_scope: "native-runtime-transport-only",
        full_corpus_can_pass: false,
        execution: {
          native_session_engine: scenario !== "S20",
          deterministic_model_simulation: false,
          runtime_port: true,
          launchable_tui: true,
          native_renderer_commit: false,
          provider_or_connector_invoked: false,
          driver: scenario === "S20" ? "runtime-empty-state" : "native-session-fixture",
        },
      });
      expect(receipt.measurements.runtime_to_visible_ms).toBeGreaterThanOrEqual(0);
      expect(receipt.semantic_losses).toEqual(expect.any(Array));
      if (scenario === "S06") {
        expect(receipt.semantic_losses).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "tool_content_and_relationships_redacted" }),
          expect.objectContaining({ id: "fixture_devtools_not_driven" }),
        ]));
      }
      if (scenario === "S20") expect(receipt.semantic_losses).toEqual([]);

      out.length = 0;
      expect(runFrontierInterfaceCli(["verify-runtime-roundtrip", root], io)).toBe(1);
      expect(JSON.parse(out[0]!)).toMatchObject({ valid: true, can_pass: false, acceptance_scope: "native-runtime-transport-only" });
    }
  }, 30_000);

  test("records S01 native renderer commits without promoting them to native-harness evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "foi-native-cli-"));
    temporary.push(root);
    const bundlePath = join(root, "s01.bundle.json");
    const out: string[] = [];
    const err: string[] = [];
    const io = diskIo(out, err);

    expect(await runFrontierInterfaceNativeCli(["record-native", "S01", bundlePath, "native-source-revision"], io)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toMatchObject({ scenario: "S01", evidence_status: "inconclusive", can_pass: false });
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    expect(bundle.evidence_receipt).toMatchObject({
      execution: { native_harness: false, native_renderer_commit: true, source_revision: "native-source-revision" },
      measurements: {
        event_to_visible_ms: { status: "unmeasured" },
        render_ms: { status: "measured", unit: "ms" },
        cleanup: { status: "measured", subscriptions: 0, timers: 0, subprocesses: 0, handles: 0, terminal_mode_residue: 0 },
      },
      observations: {
        startup_ms: expect.any(Number),
        wall_ms: expect.any(Number),
        cpu_user_us: expect.any(Number),
        cpu_system_us: expect.any(Number),
        rss_delta_bytes: expect.any(Number),
        native_commit_count: expect.any(Number),
        native_commit_trace: expect.arrayContaining([
          expect.objectContaining({
            origin: expect.objectContaining({
              kind: "deterministic_fixture_materialization",
              canonical_event_observed_at_ms: null,
            }),
            planned_frame_to_native_commit_ms: expect.any(Number),
          }),
        ]),
      },
      verdict: "inconclusive",
    });
    expect(readFileSync(join(root, "frames/boundary-terminal.json"), "utf8")).toContain("@opentui/core/native-zig");

    out.length = 0;
    expect(runFrontierInterfaceCli(["verify-bundle", bundlePath], io)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      valid: true,
      can_pass: false,
      artifact_files_checked: true,
      errors: [
        "measurements.event_to_visible_ms is unmeasured, not measured",
        "measurements.input_to_render_ms is unmeasured, not measured",
      ],
    });
  });

  test("records a real measurement receipt for the bounded long-transcript scenario", async () => {
    const capture = await captureFOINativeScenarioArtifacts(foiScenario("S16"));
    expect(capture.artifacts.assertion_status["retention-bound"]).toBe("pass");
    expect(capture.artifacts.assertion_status["measurement-receipt"]).toBe("unmeasured");
    expect(capture.measurements.event_to_visible_ms).toMatchObject({ status: "unmeasured" });
    expect(capture.observations.native_commit_trace).toHaveLength(capture.observations.planned_frame_count);
    expect(capture.measurements.queue_high_water).toMatchObject({ status: "measured", unit: "count" });
    expect(capture.observations.native_commit_count).toBe(capture.observations.planned_frame_count);
    expect(capture.observations.wall_ms).toBeGreaterThanOrEqual(capture.observations.startup_ms);
  });

  test("pairs accepted OpenTUI test-key receipt with its committed native frame without upgrading fixture input metrics", async () => {
    const capture = await captureFOINativeScenarioArtifacts(foiScenario("S01"));
    const receipt = capture.observations.native_input_commit;
    expect(receipt?.source).toBe("opentui_test_keyhandler_injection");
    expect(receipt?.accepted_key).toBe("x");
    expect(receipt?.rendered_marker).toBe("native input received: x");
    expect(receipt?.rendered_terminal_frame.includes("native input received: x")).toBe(true);
    expect(receipt?.rendered_marker_visible).toBe(true);
    expect(receipt?.planned_frame_index).toBe(capture.observations.planned_frame_count);
    expect(typeof receipt?.input_received_at_monotonic_ms).toBe("number");
    expect(typeof receipt?.native_committed_at_monotonic_ms).toBe("number");
    expect(typeof receipt?.input_receipt_to_native_commit_ms).toBe("number");
    if (receipt === null) throw new Error("S01 did not provide the native input probe receipt");
    expect(Number.isFinite(receipt.input_received_at_monotonic_ms)).toBe(true);
    expect(Number.isFinite(receipt.native_committed_at_monotonic_ms)).toBe(true);
    expect(receipt.native_committed_at_monotonic_ms >= receipt.input_received_at_monotonic_ms).toBe(true);
    expect(Math.abs(receipt.input_receipt_to_native_commit_ms - (receipt.native_committed_at_monotonic_ms - receipt.input_received_at_monotonic_ms)) < 1e-6).toBe(true);
    expect(capture.observations.native_commit_count).toBe(capture.observations.planned_frame_count + 1);
    // The supplemental event is a measured adapter probe, not an input in
    // S01's virtual scenario manifest and not an OS/terminal-arrival sample.
    expect(capture.measurements.input_to_render_ms).toMatchObject({ status: "unmeasured" });
  });

  test("records, verifies, and summarizes every declared S01-S20 viewport and color-mode variant without upgrading inconclusive evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "foi-native-corpus-cli-"));
    temporary.push(root);
    const out: string[] = [];
    const err: string[] = [];
    const io = diskIo(out, err, { revision: TEST_CAPTURE_REVISION, tree: TEST_CAPTURE_TREE, clean: true });
    const summaryPath = join(root, "corpus-summary.json");

    const recordExit = await runFrontierInterfaceNativeCli(["record-native-corpus", root, TEST_CAPTURE_REVISION], io);
    expect(err).toEqual([]);
    const verification = JSON.parse(out[0]!);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    expect(summary).toMatchObject({
      bundle_type: "foi-v1-native-renderer-corpus",
      corpus: "foi-v1",
      source_revision: TEST_CAPTURE_REVISION,
      capture_source: { revision: TEST_CAPTURE_REVISION, tree: TEST_CAPTURE_TREE, clean: true },
      native_harness_required_for_pass: true,
      provider_or_connector_invoked: false,
      summary: { total: 36 },
    });
    expect(summary.matrix.map((row: { id: string; viewport: { columns: number; rows: number }; color_mode: string; bundle: string; source_revision: string }) => ({
      id: row.id,
      viewport: row.viewport,
      color_mode: row.color_mode,
      bundle: row.bundle,
      source_revision: row.source_revision,
    }))).toEqual(EXPECTED_NATIVE_CORPUS_VARIANTS);
    expect(summary.matrix.every((row: { artifact_files_checked: boolean }) => row.artifact_files_checked)).toBe(true);
    expect(summary.matrix.every((row: { evidence_status: string }) => ["pass", "inconclusive", "fail"].includes(row.evidence_status))).toBe(true);
    expect(summary.matrix.every((row: { can_pass: boolean }) => row.can_pass === false)).toBe(true);
    expect(summary.summary.pass + summary.summary.inconclusive + summary.summary.fail).toBe(EXPECTED_NATIVE_CORPUS_VARIANTS.length);
    expect(JSON.parse(readFileSync(join(root, "S18", "160x48", "truecolor", "bundle.json"), "utf8")).evidence_receipt.scenario).toMatchObject({
      id: "S18",
      viewport: { columns: 160, rows: 48 },
      color_mode: "truecolor",
    });
    expect(verification).toMatchObject({ valid: true, matrix: summary.matrix, summary: summary.summary });
    expect(recordExit).toBe(verification.can_pass ? 0 : 1);

    out.length = 0;
    const verifyExit = runFrontierInterfaceCli(["verify-native-corpus", root], io);
    expect(JSON.parse(out[0]!)).toMatchObject({ valid: true, matrix: summary.matrix, summary: summary.summary });
    expect(verifyExit).toBe(verification.can_pass ? 0 : 1);

    writeFileSync(join(root, "S01", "100x30", "truecolor", "recording.cast"), "tampered\n", "utf8");
    out.length = 0;
    expect(runFrontierInterfaceCli(["verify-native-corpus", root], io)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ valid: false, can_pass: false, evidence_status: "fail" });

    const restored = JSON.parse(readFileSync(summaryPath, "utf8"));
    restored.capture_source.tree = "c".repeat(40);
    writeFileSync(summaryPath, `${JSON.stringify(restored, null, 2)}\n`, "utf8");
    out.length = 0;
    expect(runFrontierInterfaceCli(["verify-native-corpus", root], io)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ valid: false, can_pass: false, evidence_status: "fail" });
    expect(out[0]).toMatch(/capture_source tree does not match/i);
  }, 120_000);

  test("refuses dirty or mismatched source labels before recording a native corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "foi-native-corpus-binding-"));
    temporary.push(root);
    const out: string[] = [];
    const err: string[] = [];
    const mismatched = diskIo(out, err, { revision: TEST_CAPTURE_REVISION, tree: TEST_CAPTURE_TREE, clean: true });
    expect(await runFrontierInterfaceNativeCli(["record-native-corpus", root, "c".repeat(40)], mismatched)).toBe(2);
    expect(err.join("\n")).toMatch(/does not match checked-out HEAD/i);
    expect(() => readFileSync(join(root, "corpus-summary.json"), "utf8")).toThrow();

    err.length = 0;
    const dirty = diskIo(out, err, { revision: TEST_CAPTURE_REVISION, tree: TEST_CAPTURE_TREE, clean: false });
    expect(await runFrontierInterfaceNativeCli(["record-native-corpus", root, TEST_CAPTURE_REVISION], dirty)).toBe(2);
    expect(err.join("\n")).toMatch(/clean working tree/i);
  });
});
