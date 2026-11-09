import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  FOI_CORPUS_ID,
  FOI_EVIDENCE_SCHEMA_VERSION,
  FOI_V1_SCENARIOS,
  captureFOIScenarioArtifacts,
  captureFOINativeScenarioArtifacts,
  captureFOINativeRuntimeScenario,
  captureFOIInteractionBenchmark,
  foiScenario,
  materializeFOIScenario,
  validateFOIScenarioEvidence,
  type FOIScenarioId,
} from "@arbor/mcp";
import {
  ORIGINAL_INTERFACE_BASELINE_REVISION,
  captureOriginalInterfaceBaseline,
  captureCurrentLegacyNativeCandidate,
  recordLegacyNativeMatchedPair,
  verifyCurrentLegacyNativeCandidate,
  verifyLegacyNativeMatchedPair,
  verifyOriginalInterfaceBaseline,
} from "./foi-historical-native-baseline.js";

export interface FrontierInterfaceCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly read: (path: string) => string;
  readonly write: (path: string, value: string) => void;
  /** Test-only replacement for the checked-out capture identity. */
  readonly capture_source_identity?: () => FOICaptureSourceIdentity;
  /** Test-only replacement for resolving a committed revision to its Git tree. */
  readonly capture_tree_for_revision?: (revision: string) => string | null;
}

export interface FOICaptureSourceIdentity {
  readonly revision: string;
  readonly tree: string;
  readonly clean: boolean;
}

const defaultIo: FrontierInterfaceCliIo = {
  stdout: (value) => console.log(value),
  stderr: (value) => console.error(value),
  read: (path) => readFileSync(path, "utf8"),
  write: (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, "utf8");
  },
};

function scenarioId(value: string | undefined): FOIScenarioId | null {
  return FOI_V1_SCENARIOS.some((scenario) => scenario.id === value) ? value as FOIScenarioId : null;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleArtifactPath(bundlePath: string, artifactPath: string): string | null {
  if (isAbsolute(artifactPath) || artifactPath.includes("\\") || artifactPath.split("/").includes("..")) return null;
  const base = resolve(dirname(bundlePath));
  const absolute = resolve(base, artifactPath);
  const escaped = relative(base, absolute);
  if (escaped === "" || escaped.startsWith("..") || isAbsolute(escaped)) return null;
  return join(dirname(bundlePath), artifactPath);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function checkedOutCaptureSourceIdentity(): FOICaptureSourceIdentity {
  const command = (args: readonly string[]): string => execFileSync("git", [...args], { encoding: "utf8" }).trim();
  return Object.freeze({
    revision: command(["rev-parse", "HEAD"]),
    tree: command(["rev-parse", "HEAD^{tree}"]),
    clean: command(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
  });
}

function captureTreeForRevision(revision: string, io: FrontierInterfaceCliIo): string | null {
  if (!gitObjectId(revision)) return null;
  if (io.capture_tree_for_revision !== undefined) {
    const tree = io.capture_tree_for_revision(revision);
    return gitObjectId(tree) ? tree : null;
  }
  if (io.capture_source_identity !== undefined) {
    const identity = io.capture_source_identity();
    return identity.revision === revision && gitObjectId(identity.tree) ? identity.tree : null;
  }
  try {
    const tree = execFileSync("git", ["rev-parse", `${revision}^{tree}`], { encoding: "utf8" }).trim();
    return gitObjectId(tree) ? tree : null;
  } catch {
    return null;
  }
}

/**
 * A recorder executes imports from this checkout only. Refuse a supplied
 * historical label or dirty tree rather than binding current output to a
 * baseline revision it did not execute.
 */
function bindNativeCaptureSource(sourceRevision: string, io: FrontierInterfaceCliIo): FOICaptureSourceIdentity {
  const identity = io.capture_source_identity?.() ?? checkedOutCaptureSourceIdentity();
  if (!gitObjectId(identity.revision) || !gitObjectId(identity.tree)) {
    throw new Error("frontier-interface native capture source identity is malformed; capture is refused");
  }
  if (identity.clean !== true) {
    throw new Error("frontier-interface native capture requires a clean working tree; capture is refused rather than binding dirty imports to a revision");
  }
  if (sourceRevision !== identity.revision) {
    throw new Error(`frontier-interface native capture source revision ${sourceRevision} does not match checked-out HEAD ${identity.revision}; historical captures require an actual checkout and are not orchestrated by this command`);
  }
  return Object.freeze({ ...identity });
}

function artifactPathsFromReceipt(receipt: UnknownRecord): string[] | null {
  const artifacts = record(receipt.artifacts) ? receipt.artifacts : null;
  if (artifacts === null) return null;
  const scalar = [artifacts.raw_event_trace, artifacts.input_trace, artifacts.recording];
  const arrays = [artifacts.semantic_snapshots, artifacts.event_boundary_frames, artifacts.sampled_frames];
  if (scalar.some((item) => typeof item !== "string") || arrays.some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))) return null;
  return [...scalar as string[], ...arrays.flat() as string[]];
}

function verifyArtifactBytes(receipt: UnknownRecord, bundlePath: string, io: FrontierInterfaceCliIo): { readonly checked: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const artifacts = record(receipt.artifacts) ? receipt.artifacts : null;
  const artifactPaths = artifactPathsFromReceipt(receipt);
  const checksumRelative = artifacts === null || typeof artifacts.checksums !== "string" ? null : artifacts.checksums;
  if (artifactPaths === null || checksumRelative === null) return { checked: false, errors: ["evidence receipt artifact paths are malformed"] };
  const required = ARTIFACT_REQUIREMENTS.filter((item) => item.id !== "checksums").map((item) => item.path).sort();
  const supplied = [...artifactPaths].sort();
  if (new Set(supplied).size !== supplied.length || JSON.stringify(supplied) !== JSON.stringify(required)) {
    errors.push("evidence receipt artifacts do not exactly match the prepared bundle artifact set");
  }
  const checksumPath = bundleArtifactPath(bundlePath, checksumRelative);
  if (checksumPath === null || checksumRelative !== ARTIFACT_REQUIREMENTS[6]!.path) {
    errors.push("checksums path escapes or differs from the prepared bundle");
    return { checked: false, errors };
  }
  let checksumText: string;
  try {
    checksumText = io.read(checksumPath);
  } catch {
    return { checked: false, errors: [...errors, `cannot read ${checksumRelative}`] };
  }
  const declared = new Map<string, string>();
  for (const line of checksumText.split(/\r?\n/u).filter((item) => item.length > 0)) {
    const match = /^([a-f0-9]{64})  ([^\s].*)$/u.exec(line);
    if (match === null || declared.has(match[2]!)) {
      errors.push("checksums file contains a malformed or duplicate entry");
      continue;
    }
    declared.set(match[2]!, match[1]!);
  }
  for (const artifactPath of supplied) {
    const diskPath = bundleArtifactPath(bundlePath, artifactPath);
    if (diskPath === null) {
      errors.push(`artifact path escapes bundle directory: ${artifactPath}`);
      continue;
    }
    let bytes: string;
    try {
      bytes = io.read(diskPath);
    } catch {
      errors.push(`cannot read artifact ${artifactPath}`);
      continue;
    }
    const expected = declared.get(artifactPath);
    if (expected === undefined) errors.push(`checksums file omits ${artifactPath}`);
    else if (sha256(bytes) !== expected) errors.push(`checksum mismatch for ${artifactPath}`);
  }
  for (const declaredPath of declared.keys()) if (!supplied.includes(declaredPath)) errors.push(`checksums file names unexpected artifact ${declaredPath}`);
  return { checked: errors.length === 0, errors };
}

const ARTIFACT_REQUIREMENTS = Object.freeze([
  Object.freeze({ id: "raw_event_trace", path: "raw-event-trace.ndjson", reason: "ordered native SessionEvent trace" }),
  Object.freeze({ id: "input_trace", path: "input-trace.ndjson", reason: "timestamped operator input trace" }),
  Object.freeze({ id: "semantic_snapshot", path: "semantic-snapshots/final.json", reason: "structured terminal SceneFrame/projection snapshot" }),
  Object.freeze({ id: "event_boundary_frame", path: "frames/boundary-terminal.json", reason: "native event-boundary terminal frame" }),
  Object.freeze({ id: "sampled_frame", path: "frames/sampled-final.json", reason: "evenly sampled native terminal frame" }),
  Object.freeze({ id: "recording", path: "recording.cast", reason: "complete terminal/OpenTUI recording" }),
  Object.freeze({ id: "checksums", path: "checksums.sha256", reason: "checksums binding every recorded artifact" }),
]);

const NATIVE_CORPUS_BUNDLE_TYPE = "foi-v1-native-renderer-corpus";
const NATIVE_CORPUS_SUMMARY_PATH = "corpus-summary.json";
const NATIVE_RUNTIME_RECEIPT_PATH = "runtime-receipt.json";
const NATIVE_RUNTIME_ARTIFACTS = Object.freeze({
  terminal_output: "terminal-output.txt",
  event_trace: "event-trace.ndjson",
  input_trace: "input-trace.ndjson",
  operator_metrics: "operator-metrics.ndjson",
});

type CorpusEvidenceStatus = "pass" | "inconclusive" | "fail";
type FOIManifest = typeof FOI_V1_SCENARIOS[number];
type FOIColorMode = FOIManifest["fixture"]["color_modes"][number];
type FOIViewport = FOIManifest["fixture"]["viewport"];

interface NativeCorpusVariant {
  readonly manifest: FOIManifest;
  readonly viewport: FOIViewport;
  readonly color_mode: FOIColorMode;
}

interface NativeCorpusMatrixRow {
  readonly id: FOIScenarioId;
  readonly viewport: FOIViewport;
  readonly color_mode: FOIColorMode;
  readonly bundle: string;
  readonly source_revision: string;
  readonly evidence_status: CorpusEvidenceStatus;
  readonly verification_valid: boolean;
  readonly artifact_files_checked: boolean;
  readonly can_pass: boolean;
  readonly errors: readonly string[];
}

const BLINDED_COMPARISON_PLAN = "blinded-comparison-plan.json";
const BLINDED_REVIEW_FORM = "blinded-review-form.json";
const BLINDED_REVIEW_AGGREGATE = "blinded-review-aggregate.json";
const BLINDED_MODERATOR_ARTIFACT_MAP = "moderator-artifact-map.json";

const BLINDED_REVIEW_TASKS = Object.freeze([
  Object.freeze({ id: "active-work", scenario: "S06", prompt: "Identify what is currently running and the responsible parent task." }),
  Object.freeze({ id: "failure-parent", scenario: "S09", prompt: "Locate the failed command and identify its parent operation." }),
  Object.freeze({ id: "changed-file", scenario: "S14", prompt: "Find the last changed file and the operation that produced it." }),
  Object.freeze({ id: "blocked-or-slow", scenario: "S11", prompt: "Determine whether the task is blocked or merely slow, and state the safe next action." }),
  Object.freeze({ id: "return-live", scenario: "S16", prompt: "Return to live output without losing the inspected location." }),
  Object.freeze({ id: "copy-command", scenario: "S03", prompt: "Inspect and copy the command without including decorative presentation text." }),
  Object.freeze({ id: "cancel-correct", scenario: "S12", prompt: "Cancel the correct active operation and distinguish acknowledgement from canonical interruption." }),
  Object.freeze({ id: "unresolved-warning", scenario: "S09", prompt: "Find the unresolved warning or diagnostic and its next-action guidance." }),
  Object.freeze({ id: "concurrent-summary", scenario: "S07", prompt: "Summarize what happened during the concurrent sequence without merging session ownership." }),
  Object.freeze({ id: "no-color-meaning", scenario: "S19", prompt: "Identify the failure or gate state with color disabled." }),
]);

interface ComparisonPerformanceReceipt {
  readonly source_revision: string;
  readonly receipt_sha256: string;
  readonly performance_budget_pass: boolean;
}

interface ComparisonSide {
  readonly side: "baseline" | "candidate";
  readonly corpus_path: string;
  readonly performance_path: string;
  readonly source_revision: string;
  readonly corpus_sha256: string;
  readonly corpus_geometry: readonly string[];
  readonly performance: ComparisonPerformanceReceipt;
}

interface BlindedComparisonPlan {
  readonly bundle_type: "foi-v1-native-blinded-comparison-plan";
  readonly bundle_schema_version: 1;
  readonly source_set: "INDEPENDENT-DESIGN";
  readonly historical_opencode_reels_admissible: false;
  readonly valid_inputs: boolean;
  readonly acceptance_can_pass: false;
  readonly comparison_id: string;
  /** Moderator-only seed; participant-facing review forms never contain it. */
  readonly randomization_seed: string;
  readonly randomization_seed_sha256: string;
  /** HMAC requires the moderator binding secret again before aggregation. */
  readonly assignment_binding_hmac_sha256: string;
  readonly baseline: ComparisonSide;
  readonly candidate: ComparisonSide;
  readonly assignments: readonly Readonly<Record<string, unknown>>[];
  readonly errors: readonly string[];
}

interface BlindedObservation {
  readonly participant_id: string;
  readonly case_id: string;
  readonly variant_label: "A" | "B";
  readonly duration_ms: number;
  readonly correct: boolean;
  readonly navigation_actions: number;
  readonly confidence: number;
  readonly workload: number;
  readonly preference: "A" | "B" | "no_preference";
  readonly confusion_notes: string;
}

function numericPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

async function recordNativeBenchmark(sourceRevision: string, trials: number): Promise<Readonly<Record<string, unknown>>> {
  const samples: Array<Readonly<Record<string, unknown>>> = [];
  const interactionSamples = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const id of ["S01", "S16", "S17"] as const) {
      const capture = await captureFOINativeScenarioArtifacts(foiScenario(id));
      samples.push(Object.freeze({
        trial,
        scenario: id,
        observations: capture.observations,
        measurements: capture.measurements,
        performance_budget_pass: capture.performance_pass,
        cleanup_pass: capture.cleanup_pass,
      }));
    }
    interactionSamples.push(Object.freeze({ trial, ...captureFOIInteractionBenchmark(100) }));
  }
  const measured = (key: "event_to_visible_ms" | "input_to_render_ms" | "render_ms"): number[] => samples.flatMap((sample) => {
    const measurements = sample.measurements as UnknownRecord;
    const metric = record(measurements[key]) ? measurements[key] : null;
    return metric?.status === "measured" && typeof metric.value === "number" ? [metric.value] : [];
  });
  const observation = (key: "startup_ms" | "wall_ms" | "cpu_user_us" | "cpu_system_us" | "rss_delta_bytes" | "heap_peak_delta_bytes"): number[] => samples.map((sample) => {
    const observations = sample.observations as UnknownRecord;
    return typeof observations[key] === "number" ? observations[key] : 0;
  });
  const performanceBudgetPass = samples.every((sample) => sample.performance_budget_pass === true && sample.cleanup_pass === true)
    && interactionSamples.every((sample) => sample.search.pass && sample.disclosure.pass);
  return Object.freeze({
    bundle_type: "foi-v1-native-performance-report",
    bundle_schema_version: 1,
    source_revision: sourceRevision,
    execution: Object.freeze({
      trials_per_scenario: trials,
      scenarios: Object.freeze(["S01", "S16", "S17"]),
      native_renderer_commit: true,
      native_session_engine: false,
      provider_or_connector_invoked: false,
    }),
    budgets: Object.freeze({ ordinary_input_p95_ms: 50, event_visible_p95_ms: 100, ordinary_render_p95_ms: 16, stress_render_p95_ms: 50 }),
    aggregate: Object.freeze({
      event_to_visible_p95_ms: numericPercentile(measured("event_to_visible_ms"), 0.95),
      input_to_render_p95_ms: numericPercentile(measured("input_to_render_ms"), 0.95),
      render_p95_ms: numericPercentile(measured("render_ms"), 0.95),
      startup_p95_ms: numericPercentile(observation("startup_ms"), 0.95),
      wall_p95_ms: numericPercentile(observation("wall_ms"), 0.95),
      cpu_user_p95_us: numericPercentile(observation("cpu_user_us"), 0.95),
      cpu_system_p95_us: numericPercentile(observation("cpu_system_us"), 0.95),
      rss_delta_p95_bytes: numericPercentile(observation("rss_delta_bytes"), 0.95),
      heap_peak_delta_p95_bytes: numericPercentile(observation("heap_peak_delta_bytes"), 0.95),
      search_p95_ms: numericPercentile(interactionSamples.map((sample) => sample.search.p95_ms), 0.95),
      disclosure_p95_ms: numericPercentile(interactionSamples.map((sample) => sample.disclosure.p95_ms), 0.95),
    }),
    samples: Object.freeze(samples),
    interaction_samples: Object.freeze(interactionSamples),
    performance_budget_pass: performanceBudgetPass,
    evidence_status: performanceBudgetPass ? "measured" : "fail",
    can_pass: false,
    blocking_reasons: Object.freeze([
      "No revision-matched baseline trials are present in this report.",
      "Native session/RuntimePort timing is proven separately for S01/S12 and is not merged into renderer timings.",
    ]),
  });
}

function nativeCorpusVariants(manifest: FOIManifest): readonly NativeCorpusVariant[] {
  const seen = new Set<string>();
  const viewports: FOIViewport[] = [];
  for (const viewport of [manifest.fixture.viewport, ...(manifest.fixture.resize_trace?.viewports ?? [])]) {
    const key = `${viewport.columns}x${viewport.rows}`;
    if (!seen.has(key)) {
      seen.add(key);
      viewports.push(Object.freeze({ ...viewport }));
    }
  }
  const colorModes = [...new Set(manifest.fixture.color_modes)];
  return Object.freeze(viewports.flatMap((viewport) => colorModes.map((color_mode) => Object.freeze({
    manifest: Object.freeze({ ...manifest, fixture: Object.freeze({ ...manifest.fixture, viewport }) }),
    viewport,
    color_mode,
  }))));
}

function nativeCorpusBundlePath(variant: NativeCorpusVariant): string {
  return `${variant.manifest.id}/${variant.viewport.columns}x${variant.viewport.rows}/${variant.color_mode}/bundle.json`;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function aggregateCorpusStatus(rows: readonly Pick<NativeCorpusMatrixRow, "evidence_status">[]): CorpusEvidenceStatus {
  if (rows.some((row) => row.evidence_status === "fail")) return "fail";
  return rows.every((row) => row.evidence_status === "pass") ? "pass" : "inconclusive";
}

function corpusRowFromBundle(
  variant: NativeCorpusVariant,
  bundle: string,
  sourceRevision: string,
  value: Readonly<Record<string, unknown>>,
  verification: Readonly<Record<string, unknown>>,
  extraErrors: readonly string[] = [],
): NativeCorpusMatrixRow {
  const receipt = record(value.evidence_receipt) ? value.evidence_receipt : null;
  const declaredVerdict = receipt?.verdict;
  const verificationValid = verification.valid === true;
  const canPass = verification.can_pass === true;
  const errors = Object.freeze([...extraErrors, ...strings(verification.errors)]);
  const evidenceStatus: CorpusEvidenceStatus = canPass && declaredVerdict === "pass"
    ? "pass"
    : !verificationValid || declaredVerdict === "fail" || extraErrors.length > 0
      ? "fail"
      : "inconclusive";
  return Object.freeze({
    id: variant.manifest.id,
    viewport: Object.freeze({ ...variant.viewport }),
    color_mode: variant.color_mode,
    bundle,
    source_revision: sourceRevision,
    evidence_status: evidenceStatus,
    verification_valid: verificationValid,
    artifact_files_checked: verification.artifact_files_checked === true,
    can_pass: canPass,
    errors,
  });
}

function nativeCorpusSummary(
  sourceRevision: string,
  rows: readonly NativeCorpusMatrixRow[],
  captureSource: FOICaptureSourceIdentity,
): Readonly<Record<string, unknown>> {
  const evidenceStatus = aggregateCorpusStatus(rows);
  const counts = Object.freeze({
    total: rows.length,
    pass: rows.filter((row) => row.evidence_status === "pass").length,
    inconclusive: rows.filter((row) => row.evidence_status === "inconclusive").length,
    fail: rows.filter((row) => row.evidence_status === "fail").length,
  });
  return Object.freeze({
    bundle_type: NATIVE_CORPUS_BUNDLE_TYPE,
    bundle_schema_version: 1,
    corpus: FOI_CORPUS_ID,
    source_revision: sourceRevision,
    capture_source: Object.freeze({ revision: captureSource.revision, tree: captureSource.tree, clean: captureSource.clean }),
    native_harness_required_for_pass: true,
    provider_or_connector_invoked: false,
    matrix: Object.freeze(rows),
    summary: Object.freeze({
      ...counts,
      evidence_status: evidenceStatus,
      can_pass: evidenceStatus === "pass",
    }),
  });
}

function preparedBundle(manifest: FOIManifest, destination: string, colorMode: FOIColorMode = manifest.fixture.color_modes[0]!): Readonly<Record<string, unknown>> {
  const input = materializeFOIScenario(manifest);
  const attach = input.session_attach as { readonly events?: readonly unknown[] };
  const list = input.session_list as { readonly sessions?: readonly unknown[] };
  const artifacts = Object.freeze(ARTIFACT_REQUIREMENTS.map((artifact) => Object.freeze({
    ...artifact,
    status: "missing" as const,
    produced_by: "native-harness corpus recorder (not registered yet)",
  })));
  const artifactPaths = Object.freeze({
    raw_event_trace: ARTIFACT_REQUIREMENTS[0]!.path,
    input_trace: ARTIFACT_REQUIREMENTS[1]!.path,
    semantic_snapshots: Object.freeze([ARTIFACT_REQUIREMENTS[2]!.path]),
    event_boundary_frames: Object.freeze([ARTIFACT_REQUIREMENTS[3]!.path]),
    sampled_frames: Object.freeze([ARTIFACT_REQUIREMENTS[4]!.path]),
    recording: ARTIFACT_REQUIREMENTS[5]!.path,
    checksums: ARTIFACT_REQUIREMENTS[6]!.path,
  });
  const receiptTemplate = Object.freeze({
    schema_version: FOI_EVIDENCE_SCHEMA_VERSION,
    run_id: `foi-v1-${manifest.id.toLowerCase()}-unmeasured`,
    scenario: Object.freeze({
      id: manifest.id,
      corpus: manifest.corpus,
      seed: manifest.seed,
      simulation: manifest.simulation,
      story: manifest.story,
      viewport: manifest.fixture.viewport,
      color_mode: colorMode,
    }),
    provenance: Object.freeze({
      source_set: "INDEPENDENT-DESIGN" as const,
      source_exposure: "revoy2 fixture contract only; no provider or connector invoked",
      presentation_contract: manifest.presentation_contract,
    }),
    execution: Object.freeze({
      command: Object.freeze(["arbor-eval", "frontier-interface", "prepare", manifest.id, destination]),
      source_revision: "UNRECORDED_BY_TEMPLATE",
      started_at: "UNRECORDED_BY_TEMPLATE",
      finished_at: "UNRECORDED_BY_TEMPLATE",
      virtual_clock: true,
      native_harness: false,
    }),
    artifacts: artifactPaths,
    assertions: Object.freeze(manifest.required_assertions.map((id) => Object.freeze({ id, status: "unmeasured" as const, evidence: `missing:${id}` }))),
    measurements: Object.freeze({
      event_to_visible_ms: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
      input_to_render_ms: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
      render_ms: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
      memory_bytes: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
      queue_high_water: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
      cleanup: Object.freeze({ status: "unmeasured" as const, reason: "native recorder has not run" }),
    }),
    verdict: "inconclusive" as const,
  });
  return Object.freeze({
    bundle_type: "foi-v1-native-harness-preparation",
    bundle_schema_version: 1,
    evidence_status: "unmeasured",
    native_harness_required_for_pass: true,
    provider_or_connector_invoked: false,
    scenario: Object.freeze({
      id: manifest.id,
      corpus: manifest.corpus,
      seed: manifest.seed,
      story: manifest.story,
      presentation_contract: manifest.presentation_contract,
      viewport: manifest.fixture.viewport,
      color_modes: manifest.fixture.color_modes,
    }),
    materialized_input: Object.freeze({
      canonical_event_count: attach.events?.length ?? 0,
      session_count: list.sessions?.length ?? 0,
      virtual_clock: true,
    }),
    missing_artifacts: artifacts,
    receipt_template: receiptTemplate,
    evidence_receipt: null,
    reproduction: Object.freeze({
      prepare_bundle: Object.freeze(["arbor-eval", "frontier-interface", "prepare", manifest.id, destination]),
      verify_bundle: Object.freeze(["arbor-eval", "frontier-interface", "verify-bundle", destination]),
      validate_replaced_receipt: Object.freeze(["arbor-eval", "frontier-interface", "validate", "<recorded-receipt.json>"]),
      native_harness_recording: null,
    }),
    blocking_reason: "No native-harness corpus recorder command is registered. Replace evidence_receipt only after that recorder has produced every listed artifact; this template is not evidence.",
  });
}

function recordedBundle(manifest: typeof FOI_V1_SCENARIOS[number], destination: string, sourceRevision: string): { readonly bundle: Readonly<Record<string, unknown>>; readonly files: Readonly<Record<string, string>> } {
  const prepared = preparedBundle(manifest, destination);
  const capture = captureFOIScenarioArtifacts(manifest, manifest.fixture.color_modes[0]!);
  const files: Record<string, string> = {
    [ARTIFACT_REQUIREMENTS[0]!.path]: capture.raw_event_trace,
    [ARTIFACT_REQUIREMENTS[1]!.path]: capture.input_trace,
    [ARTIFACT_REQUIREMENTS[2]!.path]: capture.semantic_snapshot,
    [ARTIFACT_REQUIREMENTS[3]!.path]: capture.event_boundary_frame,
    [ARTIFACT_REQUIREMENTS[4]!.path]: capture.sampled_frame,
    [ARTIFACT_REQUIREMENTS[5]!.path]: capture.recording,
  };
  files[ARTIFACT_REQUIREMENTS[6]!.path] = Object.entries(files).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join("\n") + "\n";
  const receiptTemplate = prepared.receipt_template as UnknownRecord;
  const assertions = manifest.required_assertions.map((id) => ({
    id,
    status: capture.assertion_status[id] ?? "unmeasured",
    evidence: capture.assertion_status[id] === "pass" ? ARTIFACT_REQUIREMENTS[2]!.path : `unmeasured:${id}`,
  }));
  const receipt = Object.freeze({
    ...receiptTemplate,
    run_id: `foi-v1-${manifest.id.toLowerCase()}-${sourceRevision.slice(0, 12).replace(/[^A-Za-z0-9._-]/gu, "-")}`,
    execution: Object.freeze({
      command: Object.freeze(["arbor-eval", "frontier-interface", "record", manifest.id, destination, sourceRevision]),
      source_revision: sourceRevision,
      started_at: `2026-08-30T00:00:${String(manifest.seed).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-30T00:00:${String(manifest.seed).padStart(2, "0")}.001Z`,
      virtual_clock: true,
      native_harness: false,
    }),
    assertions: Object.freeze(assertions),
    verdict: "inconclusive" as const,
  });
  return {
    files: Object.freeze(files),
    bundle: Object.freeze({
      ...prepared,
      evidence_status: "recorded_inconclusive",
      missing_artifacts: Object.freeze((prepared.missing_artifacts as readonly UnknownRecord[]).map((artifact) => Object.freeze({ ...artifact, status: "present", produced_by: "production operator projection + SceneFrame deterministic capture" }))),
      evidence_receipt: receipt,
      reproduction: Object.freeze({ ...(prepared.reproduction as UnknownRecord), native_harness_recording: null }),
      blocking_reason: "Projection/SceneFrame artifacts are recorded and checksummed, but no native renderer commit observer ran; execution.native_harness remains false and performance/cleanup measurements remain unmeasured.",
    }),
  };
}

async function nativeRecordedBundle(manifest: FOIManifest, destination: string, sourceRevision: string, colorMode: FOIColorMode = manifest.fixture.color_modes[0]!): Promise<{ readonly bundle: Readonly<Record<string, unknown>>; readonly files: Readonly<Record<string, string>> }> {
  const prepared = preparedBundle(manifest, destination, colorMode);
  const startedAt = new Date().toISOString();
  const native = await captureFOINativeScenarioArtifacts(manifest, colorMode);
  const capture = native.artifacts;
  const files: Record<string, string> = {
    [ARTIFACT_REQUIREMENTS[0]!.path]: capture.raw_event_trace,
    [ARTIFACT_REQUIREMENTS[1]!.path]: capture.input_trace,
    [ARTIFACT_REQUIREMENTS[2]!.path]: capture.semantic_snapshot,
    [ARTIFACT_REQUIREMENTS[3]!.path]: capture.event_boundary_frame,
    [ARTIFACT_REQUIREMENTS[4]!.path]: capture.sampled_frame,
    [ARTIFACT_REQUIREMENTS[5]!.path]: capture.recording,
  };
  files[ARTIFACT_REQUIREMENTS[6]!.path] = Object.entries(files).map(([path, bytes]) => `${sha256(bytes)}  ${path}`).join("\n") + "\n";
  const assertions = manifest.required_assertions.map((id) => ({
    id,
    status: capture.assertion_status[id] ?? "unmeasured",
    evidence: capture.assertion_status[id] === "pass" ? ARTIFACT_REQUIREMENTS[3]!.path : `unmeasured:${id}`,
  }));
  const assertionsPass = assertions.every((assertion) => assertion.status === "pass");
  const verdict = !native.cleanup_pass || !native.performance_pass ? "fail" : "inconclusive";
  const receiptTemplate = prepared.receipt_template as UnknownRecord;
  const receipt = Object.freeze({
    ...receiptTemplate,
    run_id: `foi-v1-${manifest.id.toLowerCase()}-${manifest.fixture.viewport.columns}x${manifest.fixture.viewport.rows}-${colorMode}-${sourceRevision.slice(0, 12).replace(/[^A-Za-z0-9._-]/gu, "-")}-native`,
    execution: Object.freeze({
      command: Object.freeze(["arbor-eval", "frontier-interface", "record-native", manifest.id, destination, sourceRevision]),
      source_revision: sourceRevision,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      virtual_clock: true,
      // This lane commits production SceneFrames through OpenTUI's native
      // Zig renderer, but its events are deterministically materialized and
      // never traverse NativeSessionEngine/RuntimePort. Keep the stronger
      // native-harness claim false until the end-to-end lane supplies it.
      native_harness: false,
      native_renderer_commit: true,
    }),
    assertions: Object.freeze(assertions),
    measurements: native.measurements,
    observations: native.observations,
    verdict,
  });
  return {
    files: Object.freeze(files),
    bundle: Object.freeze({
      ...prepared,
      evidence_status: verdict,
      missing_artifacts: Object.freeze((prepared.missing_artifacts as readonly UnknownRecord[]).map((artifact) => Object.freeze({ ...artifact, status: "present", produced_by: "production SceneFrame + OpenTUI native Zig renderer" }))),
      evidence_receipt: receipt,
      reproduction: Object.freeze({
        ...(prepared.reproduction as UnknownRecord),
        native_harness_recording: null,
        native_renderer_recording: Object.freeze(["arbor-eval", "frontier-interface", "record-native", manifest.id, destination, sourceRevision]),
      }),
      blocking_reason: !native.cleanup_pass || !native.performance_pass
        ? "Native renderer performance or cleanup measurement failed its budget."
        : !assertionsPass
          ? "One or more scenario-specific assertions do not yet have a machine evaluator."
          : "Native renderer evidence is complete, but no NativeSessionEngine/RuntimePort round trip ran; native_harness remains false.",
    }),
  };
}

function failedCorpusRow(variant: NativeCorpusVariant, bundle: string, sourceRevision: string, error: unknown): NativeCorpusMatrixRow {
  return Object.freeze({
    id: variant.manifest.id,
    viewport: Object.freeze({ ...variant.viewport }),
    color_mode: variant.color_mode,
    bundle,
    source_revision: sourceRevision,
    evidence_status: "fail",
    verification_valid: false,
    artifact_files_checked: false,
    can_pass: false,
    errors: Object.freeze([error instanceof Error ? error.message : String(error)]),
  });
}

function nativeExecutionErrors(value: Readonly<Record<string, unknown>>, variant: NativeCorpusVariant, sourceRevision: string): readonly string[] {
  const receipt = record(value.evidence_receipt) ? value.evidence_receipt : null;
  const execution = receipt !== null && record(receipt.execution) ? receipt.execution : null;
  const scenario = receipt !== null && record(receipt.scenario) ? receipt.scenario : null;
  const viewport = scenario !== null && record(scenario.viewport) ? scenario.viewport : null;
  const errors: string[] = [];
  if (execution?.native_harness !== false) errors.push("native renderer corpus must not claim native_harness execution");
  if (execution?.native_renderer_commit !== true) errors.push("evidence receipt must record native_renderer_commit: true");
  if (execution?.source_revision !== sourceRevision) errors.push("evidence receipt source_revision does not match the corpus summary");
  if (scenario?.color_mode !== variant.color_mode) errors.push("evidence receipt color_mode does not match the corpus matrix");
  if (viewport?.columns !== variant.viewport.columns || viewport.rows !== variant.viewport.rows) errors.push("evidence receipt viewport does not match the corpus matrix");
  return Object.freeze(errors);
}

async function recordNativeCorpus(destination: string, sourceRevision: string, captureSource: FOICaptureSourceIdentity, io: FrontierInterfaceCliIo): Promise<Readonly<Record<string, unknown>>> {
  const rows: NativeCorpusMatrixRow[] = [];
  for (const manifest of FOI_V1_SCENARIOS) {
    for (const variant of nativeCorpusVariants(manifest)) {
      const bundle = nativeCorpusBundlePath(variant);
      const bundlePath = join(destination, bundle);
      try {
        const recorded = await nativeRecordedBundle(variant.manifest, bundlePath, sourceRevision, variant.color_mode);
        const base = dirname(bundlePath);
        for (const [path, bytes] of Object.entries(recorded.files)) io.write(join(base, path), bytes);
        io.write(bundlePath, `${JSON.stringify(recorded.bundle, null, 2)}\n`);
        const verification = verifyPreparedBundle(recorded.bundle, bundlePath, io);
        rows.push(corpusRowFromBundle(variant, bundle, sourceRevision, recorded.bundle, verification, nativeExecutionErrors(recorded.bundle, variant, sourceRevision)));
      } catch (error) {
        rows.push(failedCorpusRow(variant, bundle, sourceRevision, error));
      }
    }
  }
  return nativeCorpusSummary(sourceRevision, rows, captureSource);
}

function nativeCorpusVerification(destination: string, io: FrontierInterfaceCliIo): Readonly<Record<string, unknown>> {
  let summaryValue: unknown;
  try {
    summaryValue = JSON.parse(io.read(join(destination, NATIVE_CORPUS_SUMMARY_PATH))) as unknown;
  } catch (error) {
    return Object.freeze({
      valid: false,
      can_pass: false,
      evidence_status: "fail" as const,
      matrix: Object.freeze([]),
      errors: Object.freeze([error instanceof Error ? error.message : String(error)]),
    });
  }
  const errors: string[] = [];
  if (!record(summaryValue)) {
    return Object.freeze({ valid: false, can_pass: false, evidence_status: "fail" as const, matrix: Object.freeze([]), errors: Object.freeze(["corpus summary must be an object"]) });
  }
  if (summaryValue.bundle_type !== NATIVE_CORPUS_BUNDLE_TYPE) errors.push("corpus summary bundle_type is invalid");
  if (summaryValue.bundle_schema_version !== 1) errors.push("corpus summary bundle_schema_version must be 1");
  if (summaryValue.corpus !== FOI_CORPUS_ID) errors.push("corpus summary corpus is invalid");
  if (summaryValue.native_harness_required_for_pass !== true) errors.push("corpus summary must require the native harness for pass");
  if (summaryValue.provider_or_connector_invoked !== false) errors.push("corpus summary must not claim a provider or connector invocation");
  const sourceRevision = typeof summaryValue.source_revision === "string" && summaryValue.source_revision.trim().length > 0 ? summaryValue.source_revision : null;
  if (sourceRevision === null) errors.push("corpus summary source_revision is required");

  const rows: NativeCorpusMatrixRow[] = [];
  for (const manifest of FOI_V1_SCENARIOS) {
    for (const variant of nativeCorpusVariants(manifest)) {
      const bundle = nativeCorpusBundlePath(variant);
      const bundlePath = join(destination, bundle);
      try {
        const value = JSON.parse(io.read(bundlePath)) as unknown;
        if (!record(value)) throw new Error("bundle must be an object");
        const verification = verifyPreparedBundle(value, bundlePath, io);
        rows.push(corpusRowFromBundle(variant, bundle, sourceRevision ?? "INVALID", value, verification, sourceRevision === null ? ["corpus summary source_revision is invalid"] : nativeExecutionErrors(value, variant, sourceRevision)));
      } catch (error) {
        rows.push(failedCorpusRow(variant, bundle, sourceRevision ?? "INVALID", error));
      }
    }
  }
  const declaredCaptureSource = record(summaryValue.capture_source) ? summaryValue.capture_source : null;
  if (declaredCaptureSource?.revision !== sourceRevision || !gitObjectId(declaredCaptureSource?.tree) || declaredCaptureSource?.clean !== true) {
    errors.push("corpus summary capture_source must bind the clean checked-out source revision and tree");
  }
  const expectedCaptureTree = sourceRevision === null ? null : captureTreeForRevision(sourceRevision, io);
  if (expectedCaptureTree === null) {
    errors.push("corpus source revision is unavailable for capture-tree verification");
  } else if (declaredCaptureSource?.tree !== expectedCaptureTree) {
    errors.push("corpus summary capture_source tree does not match the declared source revision");
  }
  const captureSource: FOICaptureSourceIdentity = Object.freeze({
    revision: sourceRevision ?? "INVALID",
    tree: typeof declaredCaptureSource?.tree === "string" ? declaredCaptureSource.tree : "INVALID",
    clean: declaredCaptureSource?.clean === true,
  });
  const actual = nativeCorpusSummary(sourceRevision ?? "INVALID", rows, captureSource);
  const declaredRows = Array.isArray(summaryValue.matrix) ? summaryValue.matrix : null;
  if (declaredRows === null || declaredRows.length !== rows.length) {
    errors.push("corpus summary matrix must enumerate every declared S01-S20 viewport and color-mode variant exactly once");
  } else {
    for (const [index, row] of rows.entries()) {
      const declared = declaredRows[index];
      if (!record(declared)
        || declared.id !== row.id
        || !record(declared.viewport)
        || declared.viewport.columns !== row.viewport.columns
        || declared.viewport.rows !== row.viewport.rows
        || declared.color_mode !== row.color_mode
        || declared.bundle !== row.bundle
        || declared.source_revision !== row.source_revision
        || declared.evidence_status !== row.evidence_status
        || declared.verification_valid !== row.verification_valid
        || declared.artifact_files_checked !== row.artifact_files_checked
        || declared.can_pass !== row.can_pass
        || JSON.stringify(declared.errors) !== JSON.stringify(row.errors)) {
        errors.push(`corpus summary matrix row ${row.id} does not match verified bundle evidence`);
      }
    }
  }
  const declaredSummary = record(summaryValue.summary) ? summaryValue.summary : null;
  const actualSummary = actual.summary as UnknownRecord;
  for (const field of ["total", "pass", "inconclusive", "fail", "evidence_status", "can_pass"] as const) {
    if (declaredSummary?.[field] !== actualSummary[field]) errors.push(`corpus summary ${field} does not match the verified matrix`);
  }
  const rowsValid = rows.every((row) => row.verification_valid);
  const valid = errors.length === 0 && rowsValid;
  const evidenceStatus: CorpusEvidenceStatus = valid ? actualSummary.evidence_status as CorpusEvidenceStatus : "fail";
  return Object.freeze({
    valid,
    can_pass: valid && evidenceStatus === "pass",
    evidence_status: evidenceStatus,
    matrix: Object.freeze(rows),
    summary: actualSummary,
    errors: Object.freeze([...errors, ...rows.flatMap((row) => row.errors.map((error) => `${row.id}: ${error}`))]),
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function comparisonGeometry(matrix: unknown): readonly string[] | null {
  if (!Array.isArray(matrix)) return null;
  const entries: string[] = [];
  for (const row of matrix) {
    if (!record(row) || !nonEmptyString(row.id) || !record(row.viewport)
      || !Number.isSafeInteger(row.viewport.columns) || !Number.isSafeInteger(row.viewport.rows)
      || !nonEmptyString(row.color_mode)) return null;
    entries.push(`${row.id}:${row.viewport.columns}x${row.viewport.rows}:${row.color_mode}`);
  }
  return Object.freeze(entries);
}

function containsHistoricalOpenCode(value: unknown): boolean {
  // A native receipt is its own typed evidence surface. Do not reject an
  // unrelated operator prompt that happens to mention another product; reject
  // only declared provenance/execution origins and known historical-reel paths.
  if (!record(value)) return false;
  const provenance = record(value.provenance) ? value.provenance : null;
  const execution = record(value.execution) ? value.execution : null;
  const originFields = [
    value.source_origin,
    value.recording_origin,
    value.historical_artifact,
    provenance?.source_exposure,
    execution?.integration,
    execution?.provider_id,
  ];
  return originFields.some((field) => typeof field === "string" && /opencode|tui-reel-2026-08-29/iu.test(field));
}

function verifyComparisonPerformance(path: string, io: FrontierInterfaceCliIo): { readonly value: ComparisonPerformanceReceipt | null; readonly errors: readonly string[] } {
  const errors: string[] = [];
  let text: string;
  let report: unknown;
  try {
    text = io.read(path);
    report = JSON.parse(text) as unknown;
  } catch (error) {
    return Object.freeze({ value: null, errors: Object.freeze([error instanceof Error ? error.message : String(error)]) });
  }
  if (!record(report)) return Object.freeze({ value: null, errors: Object.freeze(["performance receipt must be an object"]) });
  if (containsHistoricalOpenCode(report) || /opencode|tui-reel-2026-08-29/iu.test(path)) errors.push("historical OpenCode reel evidence is never admissible for a native comparison");
  if (report.bundle_type !== "foi-v1-native-performance-report") errors.push("performance receipt bundle_type is invalid");
  if (report.bundle_schema_version !== 1) errors.push("performance receipt bundle_schema_version must be 1");
  if (!nonEmptyString(report.source_revision)) errors.push("performance receipt source_revision is required");
  const execution = record(report.execution) ? report.execution : null;
  if (execution?.native_renderer_commit !== true || execution.native_session_engine !== false || execution.provider_or_connector_invoked !== false) {
    errors.push("performance receipt must be a native-renderer-only, no-provider/no-connector measurement");
  }
  if (!Array.isArray(report.samples) || report.samples.length === 0 || !Array.isArray(report.interaction_samples) || report.interaction_samples.length === 0) {
    errors.push("performance receipt must contain native and interaction samples");
  }
  if (!record(report.aggregate) || typeof report.performance_budget_pass !== "boolean" || (report.evidence_status !== "measured" && report.evidence_status !== "fail")) {
    errors.push("performance receipt lacks a measured aggregate or explicit budget verdict");
  }
  return Object.freeze({
    value: errors.length === 0 ? Object.freeze({
      source_revision: report.source_revision as string,
      receipt_sha256: sha256(text),
      performance_budget_pass: report.performance_budget_pass as boolean,
    }) : null,
    errors: Object.freeze(errors),
  });
}

function comparisonSide(
  side: "baseline" | "candidate",
  corpusPath: string,
  performancePath: string,
  io: FrontierInterfaceCliIo,
): { readonly side: ComparisonSide | null; readonly errors: readonly string[] } {
  const errors: string[] = [];
  let corpusText: string | null = null;
  let corpus: unknown = null;
  try {
    corpusText = io.read(join(corpusPath, NATIVE_CORPUS_SUMMARY_PATH));
    corpus = JSON.parse(corpusText) as unknown;
  } catch (error) {
    errors.push(`${side} corpus summary: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verification = nativeCorpusVerification(corpusPath, io);
  if (verification.valid !== true) errors.push(...strings(verification.errors).map((error) => `${side} corpus: ${error}`));
  if (corpus !== null && (containsHistoricalOpenCode(corpus) || /opencode|tui-reel-2026-08-29/iu.test(corpusPath))) errors.push(`${side} corpus uses inadmissible historical OpenCode reel evidence`);
  const geometry = comparisonGeometry(verification.matrix);
  if (geometry === null || geometry.length === 0) errors.push(`${side} corpus does not expose a valid verified scenario geometry matrix`);
  const sourceRevision = nonEmptyString((corpus as UnknownRecord | null)?.source_revision) ? (corpus as UnknownRecord).source_revision as string : null;
  if (sourceRevision === null) errors.push(`${side} corpus source_revision is required`);
  const performance = verifyComparisonPerformance(performancePath, io);
  errors.push(...performance.errors.map((error) => `${side} performance: ${error}`));
  if (sourceRevision !== null && performance.value !== null && performance.value.source_revision !== sourceRevision) {
    errors.push(`${side} corpus and performance source_revision differ`);
  }
  if (errors.length > 0 || corpusText === null || sourceRevision === null || geometry === null || performance.value === null) {
    return Object.freeze({ side: null, errors: Object.freeze(errors) });
  }
  return Object.freeze({
    side: Object.freeze({
      side,
      corpus_path: corpusPath,
      performance_path: performancePath,
      source_revision: sourceRevision,
      corpus_sha256: sha256(corpusText),
      corpus_geometry: geometry,
      performance: performance.value,
    }),
    errors: Object.freeze([]),
  });
}

function deterministicAssignments(seed: string, baseline: ComparisonSide, candidate: ComparisonSide): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(BLINDED_REVIEW_TASKS.map((task) => {
    const digest = sha256(`${seed}\u0000${task.id}\u0000${baseline.source_revision}\u0000${candidate.source_revision}`);
    const baselineLabel = Number.parseInt(digest.slice(0, 2), 16) % 2 === 0 ? "A" : "B";
    return Object.freeze({
      case_id: `foi-review-${task.id}`,
      task_id: task.id,
      scenario: task.scenario,
      prompt: task.prompt,
      baseline_label: baselineLabel,
      candidate_label: baselineLabel === "A" ? "B" : "A",
    });
  }));
}

function blindedReviewForm(plan: BlindedComparisonPlan): Readonly<Record<string, unknown>> {
  return Object.freeze({
    bundle_type: "foi-v1-native-blinded-review-form",
    bundle_schema_version: 1,
    comparison_id: plan.comparison_id,
    source_set: "INDEPENDENT-DESIGN",
    historical_opencode_reels_admissible: false,
    observation_status: "pending",
    instructions: Object.freeze([
      "Present only the randomized A/B recordings or artifacts named by the moderator.",
      "Do not disclose baseline/candidate identity before observations are locked.",
      "Record one observation per participant, case, and shown label.",
      "No observation or malformed observation is not evidence of improvement.",
    ]),
    cases: Object.freeze(plan.assignments.map((assignment) => Object.freeze({
      case_id: assignment.case_id,
      task_id: assignment.task_id,
      scenario: assignment.scenario,
      prompt: assignment.prompt,
      labels: Object.freeze([assignment.baseline_label, assignment.candidate_label]),
    }))),
    observation_schema: Object.freeze({
      required: Object.freeze(["participant_id", "case_id", "variant_label", "duration_ms", "correct", "navigation_actions", "confidence", "workload", "preference", "confusion_notes"]),
      variant_label: Object.freeze(["A", "B"]),
      preference: Object.freeze(["A", "B", "no_preference"]),
      confidence_and_workload_range: Object.freeze([1, 5]),
    }),
  });
}

function assignmentBinding(
  moderatorBindingSecret: string,
  seed: string,
  comparisonId: string,
  baseline: ComparisonSide,
  candidate: ComparisonSide,
  assignments: readonly Readonly<Record<string, unknown>>[],
): string {
  const bound = JSON.stringify({
    seed,
    comparison_id: comparisonId,
    baseline: { source_revision: baseline.source_revision, corpus_sha256: baseline.corpus_sha256, performance_sha256: baseline.performance.receipt_sha256 },
    candidate: { source_revision: candidate.source_revision, corpus_sha256: candidate.corpus_sha256, performance_sha256: candidate.performance.receipt_sha256 },
    assignments,
  });
  return createHmac("sha256", moderatorBindingSecret).update(bound, "utf8").digest("hex");
}

function buildBlindedComparisonPlan(
  seed: string,
  moderatorBindingSecret: string,
  baseline: ComparisonSide | null,
  candidate: ComparisonSide | null,
  errors: readonly string[],
): BlindedComparisonPlan {
  const placeholder = (side: "baseline" | "candidate"): ComparisonSide => Object.freeze({
    side,
    corpus_path: "UNAVAILABLE",
    performance_path: "UNAVAILABLE",
    source_revision: "UNAVAILABLE",
    corpus_sha256: "UNAVAILABLE",
    corpus_geometry: Object.freeze([]),
    performance: Object.freeze({ source_revision: "UNAVAILABLE", receipt_sha256: "UNAVAILABLE", performance_budget_pass: false }),
  });
  const comparisonId = sha256(`${seed}\u0000${baseline?.source_revision ?? "invalid"}\u0000${candidate?.source_revision ?? "invalid"}`).slice(0, 24);
  const completeErrors = [...errors];
  if (baseline !== null && candidate !== null) {
    if (baseline.source_revision === candidate.source_revision) completeErrors.push("baseline and candidate must bind different explicit source revisions");
    if (JSON.stringify(baseline.corpus_geometry) !== JSON.stringify(candidate.corpus_geometry)) completeErrors.push("baseline and candidate corpus scenario geometry differ");
  }
  const valid = baseline !== null && candidate !== null && completeErrors.length === 0;
  const safeBaseline = baseline ?? placeholder("baseline");
  const safeCandidate = candidate ?? placeholder("candidate");
  const assignments = valid ? deterministicAssignments(seed, safeBaseline, safeCandidate) : Object.freeze([]);
  return Object.freeze({
    bundle_type: "foi-v1-native-blinded-comparison-plan",
    bundle_schema_version: 1,
    source_set: "INDEPENDENT-DESIGN",
    historical_opencode_reels_admissible: false,
    valid_inputs: valid,
    acceptance_can_pass: false,
    comparison_id: comparisonId,
    randomization_seed: seed,
    randomization_seed_sha256: sha256(seed),
    assignment_binding_hmac_sha256: assignmentBinding(moderatorBindingSecret, seed, comparisonId, safeBaseline, safeCandidate, assignments),
    baseline: safeBaseline,
    candidate: safeCandidate,
    assignments,
    errors: Object.freeze(completeErrors),
  });
}

function moderatorArtifactMap(plan: BlindedComparisonPlan): Readonly<Record<string, unknown>> {
  const artifactFor = (side: ComparisonSide) => Object.freeze({
    source_revision: side.source_revision,
    corpus_path: side.corpus_path,
    corpus_sha256: side.corpus_sha256,
    performance_path: side.performance_path,
    performance_receipt_sha256: side.performance.receipt_sha256,
  });
  return Object.freeze({
    bundle_type: "foi-v1-native-blinded-moderator-artifact-map",
    bundle_schema_version: 1,
    comparison_id: plan.comparison_id,
    assignment_binding_hmac_sha256: plan.assignment_binding_hmac_sha256,
    access: "moderator-only",
    historical_opencode_reels_admissible: false,
    cases: Object.freeze(plan.assignments.map((assignment) => Object.freeze({
      case_id: assignment.case_id,
      artifacts: Object.freeze({
        [assignment.baseline_label as string]: Object.freeze({ treatment: "baseline", ...artifactFor(plan.baseline) }),
        [assignment.candidate_label as string]: Object.freeze({ treatment: "candidate", ...artifactFor(plan.candidate) }),
      }),
    }))),
  });
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ordinalFive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 5;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function aggregateBlindedObservations(plan: BlindedComparisonPlan, value: unknown): { readonly aggregate: Readonly<Record<string, unknown>> | null; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (!Array.isArray(value) || value.length === 0) return Object.freeze({ aggregate: null, errors: Object.freeze(["blinded comparison has no observations; aggregate evidence is intentionally not produced"]) });
  const cases = new Map(plan.assignments.map((assignment) => [assignment.case_id, assignment]));
  const normalized: BlindedObservation[] = [];
  for (const [index, observation] of value.entries()) {
    if (!record(observation)) { errors.push(`observation ${index} must be an object`); continue; }
    const participantId = nonEmptyString(observation.participant_id) ? observation.participant_id : null;
    const caseId = nonEmptyString(observation.case_id) ? observation.case_id : null;
    const knownCase = caseId === null ? undefined : cases.get(caseId);
    const variantLabel = observation.variant_label === "A" || observation.variant_label === "B" ? observation.variant_label : null;
    const durationMs = finiteNonNegative(observation.duration_ms) ? observation.duration_ms : null;
    const correct = observation.correct === true || observation.correct === false ? observation.correct : null;
    const navigationActions = nonNegativeInteger(observation.navigation_actions) ? observation.navigation_actions : null;
    const confidence = ordinalFive(observation.confidence) ? observation.confidence : null;
    const workload = ordinalFive(observation.workload) ? observation.workload : null;
    const preference = observation.preference === "A" || observation.preference === "B" || observation.preference === "no_preference" ? observation.preference : null;
    if (participantId === null || knownCase === undefined || variantLabel === null || ![knownCase.baseline_label, knownCase.candidate_label].includes(variantLabel)
      || durationMs === null || correct === null || navigationActions === null || confidence === null || workload === null || preference === null
      || typeof observation.confusion_notes !== "string"
      || "treatment" in observation || "baseline" in observation || "candidate" in observation) {
      errors.push(`observation ${index} violates the blinded review schema`);
      continue;
    }
    normalized.push(Object.freeze({
      participant_id: participantId,
      case_id: caseId!,
      variant_label: variantLabel,
      duration_ms: durationMs,
      correct,
      navigation_actions: navigationActions,
      confidence,
      workload,
      preference,
      confusion_notes: observation.confusion_notes,
    }));
  }
  if (errors.length > 0 || normalized.length === 0) return Object.freeze({ aggregate: null, errors: Object.freeze(errors.length > 0 ? errors : ["no valid blinded observations were supplied"]) });
  const byLabel = (["A", "B"] as const).map((label) => {
    const rows = normalized.filter((observation) => observation.variant_label === label);
    const correct = rows.filter((observation) => observation.correct === true).length;
    return Object.freeze({
      label,
      observations: rows.length,
      correct_rate: rows.length === 0 ? null : correct / rows.length,
      median_duration_ms: median(rows.map((observation) => observation.duration_ms)),
      median_navigation_actions: median(rows.map((observation) => observation.navigation_actions)),
      mean_confidence: rows.length === 0 ? null : rows.reduce((total, observation) => total + observation.confidence, 0) / rows.length,
      mean_workload: rows.length === 0 ? null : rows.reduce((total, observation) => total + observation.workload, 0) / rows.length,
    });
  });
  return Object.freeze({
    aggregate: Object.freeze({
      bundle_type: "foi-v1-native-blinded-review-aggregate",
      bundle_schema_version: 1,
      comparison_id: plan.comparison_id,
      source_set: "INDEPENDENT-DESIGN",
      historical_opencode_reels_admissible: false,
      observation_count: normalized.length,
      observations_complete_for_all_cases: plan.assignments.every((assignment) => normalized.some((observation) => observation.case_id === assignment.case_id)),
      blinded_label_summary: Object.freeze(byLabel),
      raw_observations: Object.freeze(normalized),
      acceptance_can_pass: false,
      blocking_reasons: Object.freeze(["Human observations are aggregated under blinded labels only; they do not by themselves clear the full FOI acceptance rubric."]),
    }),
    errors: Object.freeze([]),
  });
}

function prepareBlindedComparison(
  destination: string,
  baselineCorpus: string,
  baselinePerformance: string,
  candidateCorpus: string,
  candidatePerformance: string,
  seed: string,
  moderatorBindingSecret: string,
  io: FrontierInterfaceCliIo,
): BlindedComparisonPlan {
  const baseline = comparisonSide("baseline", baselineCorpus, baselinePerformance, io);
  const candidate = comparisonSide("candidate", candidateCorpus, candidatePerformance, io);
  const plan = buildBlindedComparisonPlan(seed, moderatorBindingSecret, baseline.side, candidate.side, [...baseline.errors, ...candidate.errors]);
  if (!plan.valid_inputs) return plan;
  io.write(join(destination, BLINDED_COMPARISON_PLAN), `${JSON.stringify(plan, null, 2)}\n`);
  io.write(join(destination, BLINDED_REVIEW_FORM), `${JSON.stringify(blindedReviewForm(plan), null, 2)}\n`);
  io.write(join(destination, BLINDED_MODERATOR_ARTIFACT_MAP), `${JSON.stringify(moderatorArtifactMap(plan), null, 2)}\n`);
  return plan;
}

function aggregateBlindedComparison(
  planPath: string,
  observationsPath: string,
  destination: string,
  moderatorBindingSecret: string,
  io: FrontierInterfaceCliIo,
): { readonly aggregate: Readonly<Record<string, unknown>> | null; readonly errors: readonly string[] } {
  let planValue: unknown;
  let observations: unknown;
  try {
    planValue = JSON.parse(io.read(planPath)) as unknown;
    observations = JSON.parse(io.read(observationsPath)) as unknown;
  } catch (error) {
    return Object.freeze({ aggregate: null, errors: Object.freeze([error instanceof Error ? error.message : String(error)]) });
  }
  if (!record(planValue) || planValue.bundle_type !== "foi-v1-native-blinded-comparison-plan" || planValue.bundle_schema_version !== 1
    || planValue.valid_inputs !== true || planValue.historical_opencode_reels_admissible !== false || !Array.isArray(planValue.assignments)
    || !record(planValue.baseline) || !record(planValue.candidate)) {
    return Object.freeze({ aggregate: null, errors: Object.freeze(["blinded comparison plan is malformed or was not admitted from verified native inputs"]) });
  }
  const baseline = comparisonSide("baseline", String(planValue.baseline.corpus_path), String(planValue.baseline.performance_path), io);
  const candidate = comparisonSide("candidate", String(planValue.candidate.corpus_path), String(planValue.candidate.performance_path), io);
  if (!nonEmptyString(planValue.randomization_seed) || sha256(planValue.randomization_seed) !== planValue.randomization_seed_sha256) {
    return Object.freeze({ aggregate: null, errors: Object.freeze(["comparison plan randomization seed binding is invalid"]) });
  }
  const expected = buildBlindedComparisonPlan(planValue.randomization_seed, moderatorBindingSecret, baseline.side, candidate.side, [...baseline.errors, ...candidate.errors]);
  const plannedBaselinePerformance = record(planValue.baseline.performance) ? planValue.baseline.performance : null;
  const plannedCandidatePerformance = record(planValue.candidate.performance) ? planValue.candidate.performance : null;
  const changed = baseline.side === null || candidate.side === null
    || baseline.side.source_revision !== planValue.baseline.source_revision
    || candidate.side.source_revision !== planValue.candidate.source_revision
    || baseline.side.corpus_sha256 !== planValue.baseline.corpus_sha256
    || candidate.side.corpus_sha256 !== planValue.candidate.corpus_sha256
    || plannedBaselinePerformance?.receipt_sha256 !== baseline.side?.performance.receipt_sha256
    || plannedCandidatePerformance?.receipt_sha256 !== candidate.side?.performance.receipt_sha256;
  if (!expected.valid_inputs || changed
    || planValue.comparison_id !== expected.comparison_id
    || JSON.stringify(planValue.assignments) !== JSON.stringify(expected.assignments)
    || planValue.assignment_binding_hmac_sha256 !== expected.assignment_binding_hmac_sha256) {
    return Object.freeze({ aggregate: null, errors: Object.freeze(["comparison inputs changed, are invalid, or no longer match the admitted revision-bound plan"]) });
  }
  const plan = planValue as unknown as BlindedComparisonPlan;
  const result = aggregateBlindedObservations(plan, observations);
  if (result.aggregate !== null) io.write(join(destination, BLINDED_REVIEW_AGGREGATE), `${JSON.stringify(result.aggregate, null, 2)}\n`);
  return result;
}

function nativeRuntimeVerification(destination: string, io: FrontierInterfaceCliIo): Readonly<Record<string, unknown>> {
  const errors: string[] = [];
  let receipt: unknown;
  try {
    receipt = JSON.parse(io.read(join(destination, NATIVE_RUNTIME_RECEIPT_PATH))) as unknown;
  } catch (error) {
    return Object.freeze({ valid: false, can_pass: false, evidence_status: "fail", errors: Object.freeze([error instanceof Error ? error.message : String(error)]) });
  }
  if (!record(receipt)) return Object.freeze({ valid: false, can_pass: false, evidence_status: "fail", errors: Object.freeze(["runtime receipt must be an object"]) });
  if (receipt.bundle_type !== "foi-v1-native-runtime-roundtrip") errors.push("runtime receipt bundle_type is invalid");
  if (receipt.bundle_schema_version !== 1) errors.push("runtime receipt bundle_schema_version must be 1");
  const scenario = typeof receipt.scenario === "string" ? scenarioId(receipt.scenario) : null;
  if (scenario === null) errors.push("runtime receipt scenario must be one of S01..S20");
  if (receipt.source_revision === undefined || typeof receipt.source_revision !== "string" || receipt.source_revision.trim().length === 0) errors.push("runtime receipt source_revision is required");
  if (receipt.evidence_status !== "pass" && receipt.evidence_status !== "inconclusive") errors.push("runtime receipt evidence_status must be pass or inconclusive");
  const executorRoundTrip = scenario === "S01" || scenario === "S12";
  const expectedScope = executorRoundTrip ? "native-runtime-roundtrip-only" : "native-runtime-transport-only";
  if (scenario !== null && receipt.acceptance_scope !== expectedScope) errors.push(`runtime receipt acceptance_scope must be ${expectedScope}`);
  const execution = record(receipt.execution) ? receipt.execution : null;
  const expectsEngine = scenario !== "S20";
  if (scenario !== null && execution?.native_session_engine !== expectsEngine) errors.push(`runtime receipt native_session_engine must be ${String(expectsEngine)} for ${scenario}`);
  if (execution?.runtime_port !== true || execution.launchable_tui !== true) errors.push("runtime receipt does not prove the RuntimePort-to-launchable-TUI path");
  if (execution?.native_renderer_commit !== false) errors.push("runtime receipt must not claim a native renderer commit");
  if (execution?.provider_or_connector_invoked !== false) errors.push("runtime receipt must not claim provider or connector execution");
  const expectedDriver = scenario === "S20" ? "runtime-empty-state" : executorRoundTrip ? "native-agent-executor" : "native-session-fixture";
  if (scenario !== null && execution?.driver !== expectedDriver) errors.push(`runtime receipt driver must be ${expectedDriver}`);
  if (execution?.deterministic_model_simulation !== executorRoundTrip) errors.push(`runtime receipt deterministic_model_simulation must be ${String(executorRoundTrip)}`);
  const semanticLosses = Array.isArray(receipt.semantic_losses) ? receipt.semantic_losses : null;
  if (semanticLosses === null || semanticLosses.some((loss) => !record(loss) || !nonEmptyString(loss.id) || !nonEmptyString(loss.detail))) {
    errors.push("runtime receipt semantic_losses must disclose each bounded fixture-to-runtime projection loss");
  }
  if (!executorRoundTrip && scenario !== "S20" && semanticLosses !== null && semanticLosses.length === 0) {
    errors.push("fixture runtime receipt must disclose at least one semantic loss rather than promoting transport evidence");
  }
  const checksums = record(receipt.artifact_sha256) ? receipt.artifact_sha256 : null;
  for (const [id, path] of Object.entries(NATIVE_RUNTIME_ARTIFACTS)) {
    let bytes: string;
    try { bytes = io.read(join(destination, path)); }
    catch { errors.push(`cannot read runtime artifact ${path}`); continue; }
    if (checksums?.[id] !== sha256(bytes)) errors.push(`checksum mismatch for runtime artifact ${path}`);
  }
  const valid = errors.length === 0;
  const canPass = valid && executorRoundTrip && receipt.evidence_status === "pass";
  return Object.freeze({
    valid,
    can_pass: canPass,
    evidence_status: valid ? receipt.evidence_status : "fail",
    acceptance_scope: scenario === null ? null : expectedScope,
    full_corpus_can_pass: false,
    errors: Object.freeze(errors),
  });
}

async function recordNativeRuntimeRoundTrip(
  scenario: FOIScenarioId,
  destination: string,
  sourceRevision: string,
  io: FrontierInterfaceCliIo,
): Promise<Readonly<Record<string, unknown>>> {
  const workspace = mkdtempSync(join(tmpdir(), `foi-${scenario.toLowerCase()}-runtime-`));
  try {
    const capture = await captureFOINativeRuntimeScenario(scenario, workspace);
    const artifactBytes: Readonly<Record<string, string>> = Object.freeze({
      terminal_output: capture.artifacts.terminal_output,
      event_trace: capture.artifacts.event_trace,
      input_trace: capture.artifacts.input_trace,
      operator_metrics: capture.artifacts.operator_metrics,
    });
    for (const [id, path] of Object.entries(NATIVE_RUNTIME_ARTIFACTS)) io.write(join(destination, path), artifactBytes[id]!);
    const receipt = Object.freeze({
      bundle_type: "foi-v1-native-runtime-roundtrip",
      bundle_schema_version: 1,
      scenario,
      source_revision: sourceRevision,
      evidence_status: capture.verdict,
      acceptance_scope: capture.acceptance_scope,
      full_corpus_can_pass: false,
      execution: capture.execution,
      assertions: capture.assertions,
      semantic_losses: capture.semantic_losses,
      measurements: capture.measurements,
      artifacts: NATIVE_RUNTIME_ARTIFACTS,
      artifact_sha256: Object.freeze(Object.fromEntries(Object.entries(artifactBytes).map(([id, bytes]) => [id, sha256(bytes)]))),
    });
    io.write(join(destination, NATIVE_RUNTIME_RECEIPT_PATH), `${JSON.stringify(receipt, null, 2)}\n`);
    return nativeRuntimeVerification(destination, io);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function verifyPreparedBundle(value: unknown, bundlePath: string, io: FrontierInterfaceCliIo): Readonly<Record<string, unknown>> {
  const errors: string[] = [];
  if (!record(value)) {
    return Object.freeze({ valid: false, can_pass: false, evidence_present: false, errors: Object.freeze(["prepared bundle must be an object"]) });
  }
  if (value.bundle_type !== "foi-v1-native-harness-preparation") errors.push("bundle_type is invalid");
  if (value.bundle_schema_version !== 1) errors.push("bundle_schema_version must be 1");
  if (value.native_harness_required_for_pass !== true) errors.push("bundle must require the native harness for a pass");
  if (value.provider_or_connector_invoked !== false) errors.push("prepared bundle must not claim a provider or connector invocation");
  const scenario = record(value.scenario) ? value.scenario : null;
  const id = scenario?.id;
  const manifest = typeof id === "string" ? scenarioId(id) : null;
  if (scenario === null || manifest === null || scenario.corpus !== FOI_CORPUS_ID || scenario.seed !== foiScenario(manifest).seed) {
    errors.push("bundle scenario does not bind an immutable foi-v1 manifest");
  }
  const missing = Array.isArray(value.missing_artifacts) ? value.missing_artifacts : null;
  if (missing === null || missing.length !== ARTIFACT_REQUIREMENTS.length || missing.some((artifact, index) => {
    const requirement = ARTIFACT_REQUIREMENTS[index]!;
    return !record(artifact) || artifact.id !== requirement.id || artifact.path !== requirement.path || (artifact.status !== "missing" && artifact.status !== "present");
  })) {
    errors.push("bundle must enumerate every still-missing artifact");
  }
  const evidence = value.evidence_receipt;
  if (evidence === null || evidence === undefined) {
    return Object.freeze({
      valid: errors.length === 0,
      can_pass: false,
      evidence_present: false,
      missing_artifact_count: missing?.length ?? 0,
      errors: Object.freeze([...errors, "evidence_receipt is missing; the prepared bundle is intentionally non-passing"]),
    });
  }
  const evidenceValidation = validateFOIScenarioEvidence(evidence);
  const receiptScenario = record(evidence) && record(evidence.scenario) ? evidence.scenario : null;
  if (manifest !== null && (receiptScenario?.id !== manifest || receiptScenario.corpus !== FOI_CORPUS_ID || receiptScenario.seed !== foiScenario(manifest).seed)) {
    errors.push("evidence_receipt scenario does not match prepared bundle");
  }
  const artifactVerification = record(evidence) ? verifyArtifactBytes(evidence, bundlePath, io) : { checked: false, errors: ["evidence_receipt must be an object"] };
  const allArtifactsPresent = missing?.every((artifact) => record(artifact) && artifact.status === "present") === true;
  const receiptDeclaresPass = record(evidence) && evidence.verdict === "pass";
  if (!allArtifactsPresent) errors.push("prepared bundle still marks one or more artifacts missing");
  return Object.freeze({
    valid: errors.length === 0 && evidenceValidation.valid,
    can_pass: errors.length === 0 && evidenceValidation.can_pass && artifactVerification.checked && allArtifactsPresent && receiptDeclaresPass,
    evidence_receipt_can_pass: evidenceValidation.can_pass,
    evidence_present: true,
    artifact_files_checked: artifactVerification.checked,
    blocking_reason: !receiptDeclaresPass
      ? "evidence receipt verdict must be pass"
      : artifactVerification.checked && allArtifactsPresent ? null : "artifact bytes, checksums, and present-status declarations must all verify",
    errors: Object.freeze([...errors, ...evidenceValidation.errors, ...artifactVerification.errors]),
  });
}

/** Bun-only native recorder command; kept async so the existing pure CLI API remains synchronous. */
export async function runFrontierInterfaceNativeCli(argv: readonly string[], io: FrontierInterfaceCliIo = defaultIo): Promise<number> {
  if (argv[0] === "record-current-legacy-native-candidate") {
    const destination = argv[1];
    const sourceRevision = argv[2];
    if (destination === undefined || sourceRevision === undefined) {
      io.stderr("frontier-interface record-current-legacy-native-candidate requires a destination directory and the clean checked-out source revision");
      return 2;
    }
    try {
      const receipt = captureCurrentLegacyNativeCandidate({ destination, sourceRevision });
      const verification = verifyCurrentLegacyNativeCandidate(destination);
      io.stdout(JSON.stringify({ receipt, verification }, null, 2));
      return verification.valid ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (argv[0] === "record-original-interface-baseline") {
    const destination = argv[1];
    const revision = argv[2] ?? ORIGINAL_INTERFACE_BASELINE_REVISION;
    if (destination === undefined) {
      io.stderr("frontier-interface record-original-interface-baseline requires a destination directory and accepts only the declared f74b50548c0f23af959802e0bef88a4810bfc71f revision");
      return 2;
    }
    try {
      const receipt = captureOriginalInterfaceBaseline({ destination, revision });
      const verification = verifyOriginalInterfaceBaseline(destination);
      io.stdout(JSON.stringify({ receipt, verification }, null, 2));
      return verification.valid ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (argv[0] === "benchmark-native") {
    const destination = argv[1];
    const sourceRevision = argv[2];
    const trials = Number(argv[3] ?? "3");
    if (destination === undefined || sourceRevision === undefined || sourceRevision.trim().length === 0 || !Number.isSafeInteger(trials) || trials < 1 || trials > 10) {
      io.stderr("frontier-interface benchmark-native requires a destination JSON path, explicit source revision, and optional trial count 1..10");
      return 2;
    }
    try {
      const report = await recordNativeBenchmark(sourceRevision, trials);
      io.write(destination, `${JSON.stringify(report, null, 2)}\n`);
      io.stdout(JSON.stringify({ report: destination, evidence_status: report.evidence_status, performance_budget_pass: report.performance_budget_pass, can_pass: false }, null, 2));
      return report.evidence_status === "fail" ? 1 : 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (argv[0] === "record-runtime-roundtrip") {
    const scenario = scenarioId(argv[1]);
    const destination = argv[2];
    const sourceRevision = argv[3];
    if (scenario === null || destination === undefined || sourceRevision === undefined || sourceRevision.trim().length === 0) {
      io.stderr("frontier-interface record-runtime-roundtrip requires S01..S20, a destination directory, and an explicit source revision");
      return 2;
    }
    try {
      const verification = await recordNativeRuntimeRoundTrip(scenario, destination, sourceRevision, io);
      io.stdout(JSON.stringify(verification, null, 2));
      return verification.can_pass === true ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (argv[0] === "record-native-corpus") {
    const destination = argv[1];
    const sourceRevision = argv[2];
    if (destination === undefined || sourceRevision === undefined || sourceRevision.trim().length === 0) {
      io.stderr("frontier-interface record-native-corpus requires a destination directory and an explicit source revision");
      return 2;
    }
    try {
      const captureSource = bindNativeCaptureSource(sourceRevision, io);
      const summary = await recordNativeCorpus(destination, sourceRevision, captureSource, io);
      io.write(join(destination, NATIVE_CORPUS_SUMMARY_PATH), `${JSON.stringify(summary, null, 2)}\n`);
      const verification = nativeCorpusVerification(destination, io);
      io.stdout(JSON.stringify(verification, null, 2));
      return verification.can_pass === true ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const id = scenarioId(argv[1]);
  const destination = argv[2];
  const sourceRevision = argv[3];
  if (argv[0] !== "record-native" || id === null || destination === undefined || sourceRevision === undefined || sourceRevision.trim().length === 0) {
    io.stderr("frontier-interface record-native requires S01..S20, a bundle path, and an explicit source revision");
    return 2;
  }
  try {
    const recorded = await nativeRecordedBundle(foiScenario(id), destination, sourceRevision);
    const base = dirname(destination);
    for (const [path, bytes] of Object.entries(recorded.files)) io.write(join(base, path), bytes);
    io.write(destination, `${JSON.stringify(recorded.bundle, null, 2)}\n`);
    const verdict = (recorded.bundle.evidence_receipt as UnknownRecord).verdict;
    io.stdout(JSON.stringify({ scenario: id, bundle: destination, evidence_status: verdict, artifact_count: ARTIFACT_REQUIREMENTS.length, can_pass: verdict === "pass" }, null, 2));
    return verdict === "fail" ? 1 : 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/**
 * Reachable planning/validation entrypoint for the native FOI evidence lane.
 * It never upgrades a fixture projection into run evidence: `plan` emits only
 * deterministic inputs, while `validate` checks a separately recorded receipt.
 */
export function runFrontierInterfaceCli(argv: readonly string[], io: FrontierInterfaceCliIo = defaultIo): number {
  const command = argv[0] ?? "plan";
  if (command === "plan") {
    const requested = argv[1];
    const selected = requested === undefined ? FOI_V1_SCENARIOS : (() => {
      const id = scenarioId(requested);
      return id === null ? null : [foiScenario(id)];
    })();
    if (selected === null) {
      io.stderr(`unknown foi-v1 scenario '${requested}'`);
      return 2;
    }
    io.stdout(JSON.stringify({
      corpus: FOI_CORPUS_ID,
      evidence_schema_version: FOI_EVIDENCE_SCHEMA_VERSION,
      evidence_status: "planned",
      native_harness_required_for_pass: true,
      scenarios: selected.map((manifest) => {
        const input = materializeFOIScenario(manifest);
        const attach = input.session_attach as { readonly events?: readonly unknown[] };
        const list = input.session_list as { readonly sessions?: readonly unknown[] };
        return {
          id: manifest.id,
          seed: manifest.seed,
          story: manifest.story,
          required_assertions: manifest.required_assertions,
          canonical_event_count: attach.events?.length ?? 0,
          session_count: list.sessions?.length ?? 0,
          viewport: manifest.fixture.viewport,
          color_modes: manifest.fixture.color_modes,
        };
      }),
    }, null, 2));
    return 0;
  }
  if (command === "prepare-blinded-comparison") {
    const [destination, baselineCorpus, baselinePerformance, candidateCorpus, candidatePerformance, seed, moderatorBindingSecret] = argv.slice(1);
    if ([destination, baselineCorpus, baselinePerformance, candidateCorpus, candidatePerformance, seed, moderatorBindingSecret].some((value) => !nonEmptyString(value))) {
      io.stderr("frontier-interface prepare-blinded-comparison requires <destination-dir> <baseline-corpus-dir> <baseline-performance.json> <candidate-corpus-dir> <candidate-performance.json> <deterministic-seed> <moderator-binding-secret>");
      return 2;
    }
    const plan = prepareBlindedComparison(destination!, baselineCorpus!, baselinePerformance!, candidateCorpus!, candidatePerformance!, seed!, moderatorBindingSecret!, io);
    io.stdout(JSON.stringify({
      comparison_plan: plan.valid_inputs ? join(destination!, BLINDED_COMPARISON_PLAN) : null,
      review_form: plan.valid_inputs ? join(destination!, BLINDED_REVIEW_FORM) : null,
      moderator_artifact_map: plan.valid_inputs ? join(destination!, BLINDED_MODERATOR_ARTIFACT_MAP) : null,
      valid_inputs: plan.valid_inputs,
      blinded_observations_present: false,
      acceptance_can_pass: false,
      historical_opencode_reels_admissible: false,
      errors: plan.errors,
    }, null, 2));
    // The plan deliberately creates no aggregate and cannot be accepted until
    // observations are supplied through the separate aggregate command.
    return 1;
  }
  if (command === "aggregate-blinded-comparison") {
    const [planPath, observationsPath, destination, moderatorBindingSecret] = argv.slice(1);
    if ([planPath, observationsPath, destination, moderatorBindingSecret].some((value) => !nonEmptyString(value))) {
      io.stderr("frontier-interface aggregate-blinded-comparison requires <comparison-plan.json> <observations.json> <destination-dir> <moderator-binding-secret>");
      return 2;
    }
    const result = aggregateBlindedComparison(planPath!, observationsPath!, destination!, moderatorBindingSecret!, io);
    io.stdout(JSON.stringify({
      aggregate: result.aggregate === null ? null : join(destination!, BLINDED_REVIEW_AGGREGATE),
      observations_aggregated: result.aggregate === null ? 0 : result.aggregate.observation_count,
      acceptance_can_pass: false,
      errors: result.errors,
    }, null, 2));
    return result.aggregate === null ? 1 : 0;
  }
  if (command === "validate") {
    const path = argv[1];
    if (path === undefined) {
      io.stderr("frontier-interface validate requires an evidence receipt path");
      return 2;
    }
    try {
      const validation = validateFOIScenarioEvidence(JSON.parse(io.read(path)) as unknown);
      io.stdout(JSON.stringify(validation, null, 2));
      return validation.valid ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "prepare") {
    const id = scenarioId(argv[1]);
    const destination = argv[2];
    if (id === null || destination === undefined) {
      io.stderr("frontier-interface prepare requires S01..S20 and a bundle path");
      return 2;
    }
    const bundle = preparedBundle(foiScenario(id), destination);
    try {
      io.write(destination, `${JSON.stringify(bundle, null, 2)}\n`);
      io.stdout(JSON.stringify({
        evidence_status: "unmeasured",
        scenario: id,
        bundle: destination,
        missing_artifact_count: ARTIFACT_REQUIREMENTS.length,
        can_pass: false,
      }, null, 2));
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "record") {
    const id = scenarioId(argv[1]);
    const destination = argv[2];
    const sourceRevision = argv[3];
    if (id === null || destination === undefined || sourceRevision === undefined || sourceRevision.trim().length === 0) {
      io.stderr("frontier-interface record requires S01..S20, a bundle path, and an explicit source revision");
      return 2;
    }
    try {
      const recorded = recordedBundle(foiScenario(id), destination, sourceRevision);
      const base = dirname(destination);
      for (const [path, bytes] of Object.entries(recorded.files)) io.write(join(base, path), bytes);
      io.write(destination, `${JSON.stringify(recorded.bundle, null, 2)}\n`);
      io.stdout(JSON.stringify({ scenario: id, bundle: destination, evidence_status: "recorded_inconclusive", artifact_count: ARTIFACT_REQUIREMENTS.length, can_pass: false }, null, 2));
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "verify-bundle") {
    const path = argv[1];
    if (path === undefined) {
      io.stderr("frontier-interface verify-bundle requires a prepared bundle path");
      return 2;
    }
    try {
      const verification = verifyPreparedBundle(JSON.parse(io.read(path)) as unknown, path, io);
      io.stdout(JSON.stringify(verification, null, 2));
      return verification.can_pass === true ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "verify-native-corpus") {
    const destination = argv[1];
    if (destination === undefined) {
      io.stderr("frontier-interface verify-native-corpus requires a destination directory");
      return 2;
    }
    const verification = nativeCorpusVerification(destination, io);
    io.stdout(JSON.stringify(verification, null, 2));
    return verification.can_pass === true ? 0 : 1;
  }
  if (command === "verify-runtime-roundtrip") {
    const destination = argv[1];
    if (destination === undefined) {
      io.stderr("frontier-interface verify-runtime-roundtrip requires a destination directory");
      return 2;
    }
    const verification = nativeRuntimeVerification(destination, io);
    io.stdout(JSON.stringify(verification, null, 2));
    return verification.can_pass === true ? 0 : 1;
  }
  if (command === "verify-original-interface-baseline") {
    const destination = argv[1];
    if (destination === undefined) {
      io.stderr("frontier-interface verify-original-interface-baseline requires a destination directory");
      return 2;
    }
    const verification = verifyOriginalInterfaceBaseline(destination);
    io.stdout(JSON.stringify(verification, null, 2));
    return verification.valid ? 0 : 1;
  }
  if (command === "verify-current-legacy-native-candidate") {
    const destination = argv[1];
    if (destination === undefined) {
      io.stderr("frontier-interface verify-current-legacy-native-candidate requires a destination directory");
      return 2;
    }
    const verification = verifyCurrentLegacyNativeCandidate(destination);
    io.stdout(JSON.stringify(verification, null, 2));
    return verification.valid ? 0 : 1;
  }
  if (command === "record-legacy-native-matched-pair") {
    const destination = argv[1];
    const baseline = argv[2];
    const candidate = argv[3];
    if (destination === undefined || baseline === undefined || candidate === undefined) {
      io.stderr("frontier-interface record-legacy-native-matched-pair requires a destination directory, baseline directory, and candidate directory");
      return 2;
    }
    try {
      const receipt = recordLegacyNativeMatchedPair({ destination, baseline, candidate });
      const verification = verifyLegacyNativeMatchedPair(destination);
      io.stdout(JSON.stringify({ receipt, verification }, null, 2));
      return verification.valid ? 0 : 1;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "verify-legacy-native-matched-pair") {
    const destination = argv[1];
    if (destination === undefined) {
      io.stderr("frontier-interface verify-legacy-native-matched-pair requires a destination directory");
      return 2;
    }
    const verification = verifyLegacyNativeMatchedPair(destination);
    io.stdout(JSON.stringify(verification, null, 2));
    return verification.valid ? 0 : 1;
  }
  io.stderr("usage: arbor-eval frontier-interface plan [S01..S20] | prepare <S01..S20> <bundle.json> | record <S01..S20> <bundle.json> <source-revision> | record-native <S01..S20> <bundle.json> <source-revision> | record-native-corpus <destination-dir> <source-revision> | record-runtime-roundtrip <S01..S20> <destination-dir> <source-revision> | record-original-interface-baseline <destination-dir> [f74b50548c0f23af959802e0bef88a4810bfc71f] | record-current-legacy-native-candidate <destination-dir> <clean-source-revision> | record-legacy-native-matched-pair <destination-dir> <baseline-dir> <candidate-dir> | benchmark-native <destination.json> <source-revision> [trials] | prepare-blinded-comparison <destination-dir> <baseline-corpus-dir> <baseline-performance.json> <candidate-corpus-dir> <candidate-performance.json> <seed> <moderator-binding-secret> | aggregate-blinded-comparison <comparison-plan.json> <observations.json> <destination-dir> <moderator-binding-secret> | verify-native-corpus <destination-dir> | verify-runtime-roundtrip <destination-dir> | verify-original-interface-baseline <destination-dir> | verify-current-legacy-native-candidate <destination-dir> | verify-legacy-native-matched-pair <destination-dir> | validate <receipt.json> | verify-bundle <bundle.json>");
  return 2;
}
