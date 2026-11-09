import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runHistoricalCommand } from "./foi-historical-process.js";

/**
 * The last revision of the original interface before the FOI scenario
 * recorder existed.  This is deliberately a commit identity, rather than a
 * moving branch label: an original-interface capture is evidence about this
 * source tree, not an alias for whatever happens to be checked out today.
 */
export const ORIGINAL_INTERFACE_BASELINE_REVISION = "f74b50548c0f23af959802e0bef88a4810bfc71f";

export const ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE = "foi-original-interface-native-baseline";
export const CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE = "foi-current-legacy-native-candidate";
export const LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE = "foi-legacy-native-matched-pair";
const BASELINE_SCHEMA_VERSION = 1;
const BASELINE_PATH = "original-interface-baseline.json";
const CANDIDATE_PATH = "current-legacy-native-candidate.json";
const MATCHED_PAIR_PATH = "legacy-native-matched-pair.json";
const NATIVE_FRAME_PATH = "legacy-native-frame.txt";
const CHECKSUMS_PATH = "checksums.sha256";
const LEGACY_NATIVE_PROTOCOL_ID = "foi-legacy-native-opentui-frame-v1";
const LEGACY_NATIVE_PROBE_TEXT = "revision-bound legacy native OpenTUI boundary";

export interface OriginalInterfaceBaselineCaptureInput {
  /** Directory that will receive only this bounded baseline artifact. */
  readonly destination: string;
  /** Defaults to the only declared original-interface baseline revision. */
  readonly revision?: string;
  /** Repository whose object database supplies the detached historical tree. */
  readonly repository?: string;
}

export interface OriginalInterfaceBaselineVerification {
  readonly valid: boolean;
  /** An original-interface frame is not a substitute for the later FOI corpus. */
  readonly can_pass: false;
  readonly evidence_status: "measured" | "fail";
  readonly acceptance_scope: "revision-bound-original-interface-native-frame";
  readonly errors: readonly string[];
}

export interface CurrentLegacyNativeCandidateCaptureInput {
  /** Directory that will receive only this bounded candidate artifact. */
  readonly destination: string;
  /** Required and must name this clean checkout's exact HEAD. */
  readonly sourceRevision: string;
  /** Repository whose clean HEAD supplies the detached current candidate tree. */
  readonly repository?: string;
}

export interface CurrentLegacyNativeCandidateVerification {
  readonly valid: boolean;
  readonly can_pass: false;
  readonly evidence_status: "measured" | "fail";
  readonly acceptance_scope: "revision-bound-current-legacy-native-frame";
  readonly errors: readonly string[];
}

export interface LegacyNativeMatchedPairInput {
  readonly destination: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly repository?: string;
}

export interface LegacyNativeMatchedPairVerification {
  readonly valid: boolean;
  readonly can_pass: false;
  readonly evidence_status: "measured" | "fail";
  readonly acceptance_scope: "matched-legacy-native-protocol-admission-only";
  readonly errors: readonly string[];
}

interface GitIdentity {
  readonly revision: string;
  readonly tree: string;
  readonly clean: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function git(repository: string, args: readonly string[]): string {
  return runHistoricalCommand("git", args, repository);
}

function objectId(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

function repositoryRoot(repository: string | undefined): string {
  const requested = resolve(repository ?? process.cwd());
  return git(requested, ["rev-parse", "--show-toplevel"]);
}

function identityAt(repository: string): GitIdentity {
  const revision = git(repository, ["rev-parse", "HEAD"]);
  const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
  if (!objectId(revision) || !objectId(tree)) throw new Error("historical worktree returned an invalid git object identity");
  return Object.freeze({
    revision,
    tree,
    clean: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]) === "",
  });
}

function declaredHistoricalIdentity(repository: string, requestedRevision: string): GitIdentity {
  const revision = git(repository, ["rev-parse", `${requestedRevision}^{commit}`]);
  if (revision !== ORIGINAL_INTERFACE_BASELINE_REVISION) {
    throw new Error(`original-interface baseline is pinned to ${ORIGINAL_INTERFACE_BASELINE_REVISION}; refusing ${requestedRevision}`);
  }
  const tree = git(repository, ["rev-parse", `${revision}^{tree}`]);
  if (!objectId(tree)) throw new Error("declared historical baseline tree is unavailable");
  return Object.freeze({ revision, tree, clean: true });
}

/**
 * Evaluated by Bun *inside the detached historical worktree*.  It has no
 * imports from the current checkout: every application import is relative to
 * the historical tree.  The test renderer is the native OpenTUI boundary, not
 * an ANSI or fixture projection pretending to be the old executable.
 */
const LEGACY_NATIVE_PROBE = String.raw`
import { createTestRenderer } from "@opentui/core/testing";
import { createNavigation, initialModel, renderScene, TerminalPainter } from "./packages/arbor-tui/src/index.ts";
import { OpenTuiRenderer } from "./packages/arbor-tui/src/opentui-renderer.ts";

const projection = {
  app: initialModel(),
  output: "revision-bound legacy native OpenTUI boundary",
  navigation: createNavigation(
    { id: "legacy-native", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "output", title: "Legacy native" }] },
    { columns: 100, rows: 30 },
  ),
};
const scene = renderScene(projection);
let text = "";
new TerminalPainter().paint(scene, { write: (value) => { text = value; } });
const setup = await createTestRenderer({ width: 100, height: 30 });
try {
  const adapter = new OpenTuiRenderer({ renderer: setup.renderer });
  await adapter.enter();
  await adapter.render({ text, scene });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  adapter.restore();
  console.log(JSON.stringify({
    protocol_id: "foi-legacy-native-opentui-frame-v1",
    protocol_version: 1,
    renderer_boundary: "legacy-opentui-native-test-renderer",
    native_renderer: true,
    viewport: { columns: 100, rows: 30 },
    projection: "initial-model-static-output",
    frame,
  }));
} finally {
  setup.renderer.destroy();
}
`;

function runLegacyNativeProbe(worktree: string): Readonly<Record<string, unknown>> {
  let stdout: string;
  try {
    // Installation is part of historical execution. node_modules is ignored by
    // Git, and the identity check below still rejects tracked or untracked
    // source changes. We never use modules resolved from the current tree.
    runHistoricalCommand("bun", ["install", "--frozen-lockfile"], worktree);
    stdout = runHistoricalCommand("bun", ["--eval", LEGACY_NATIVE_PROBE], worktree);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`historical native probe failed: ${detail}`);
  }
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("probe result is not an object");
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(`historical native probe emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validProbe(value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & { readonly frame: string } {
  const viewport = value.viewport;
  return value.protocol_id === LEGACY_NATIVE_PROTOCOL_ID
    && value.protocol_version === 1
    && value.renderer_boundary === "legacy-opentui-native-test-renderer"
    && value.native_renderer === true
    && typeof value.frame === "string"
    && value.frame.includes(LEGACY_NATIVE_PROBE_TEXT)
    && typeof viewport === "object" && viewport !== null
    && (viewport as Record<string, unknown>).columns === 100
    && (viewport as Record<string, unknown>).rows === 30;
}

/**
 * Executes the declared f74 source in a disposable detached worktree and
 * records one explicit native OpenTUI frame. It never runs current imports
 * under a historical label and intentionally does not synthesize FOI S01-S20
 * evidence, which the historical tree could not have produced.
 */
export function captureOriginalInterfaceBaseline(input: OriginalInterfaceBaselineCaptureInput): Readonly<Record<string, unknown>> {
  const repository = repositoryRoot(input.repository);
  const declared = declaredHistoricalIdentity(repository, input.revision ?? ORIGINAL_INTERFACE_BASELINE_REVISION);
  const destination = resolve(input.destination);
  const worktree = mkdtempSync(join(tmpdir(), "revoy2-original-interface-"));
  // git worktree requires that the directory not already exist; this path was
  // just created by us and is the only recursive deletion in this module.
  rmSync(worktree, { recursive: true, force: true });
  let added = false;
  try {
    runHistoricalCommand("git", ["worktree", "add", "--detach", "--quiet", worktree, declared.revision], repository);
    added = true;
    const before = identityAt(worktree);
    if (before.revision !== declared.revision || before.tree !== declared.tree || !before.clean) {
      throw new Error("isolated historical worktree identity is not the declared clean source tree");
    }
    const probe = runLegacyNativeProbe(worktree);
    const after = identityAt(worktree);
    if (after.revision !== before.revision || after.tree !== before.tree || !after.clean) {
      throw new Error("historical probe changed the source identity; capture is refused");
    }
    if (!validProbe(probe)) throw new Error("historical native probe did not prove the declared OpenTUI boundary");
    const frame = probe.frame;
    const receipt = Object.freeze({
      bundle_type: ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE,
      bundle_schema_version: BASELINE_SCHEMA_VERSION,
      source_revision: declared.revision,
      capture_source: Object.freeze({ ...after, detached_worktree: true }),
      execution: Object.freeze({
        driver: "current-eval-driver-historical-native-probe",
        original_interface_executed: true,
        isolated_worktree: true,
        native_renderer_commit: true,
        renderer_boundary: probe.renderer_boundary,
        provider_or_connector_invoked: false,
      }),
      protocol: Object.freeze({
        id: probe.protocol_id,
        version: probe.protocol_version,
        projection: probe.projection,
        viewport: probe.viewport,
      }),
      artifacts: Object.freeze({ native_frame: NATIVE_FRAME_PATH, checksums: CHECKSUMS_PATH }),
      evidence_status: "measured" as const,
      acceptance_scope: "revision-bound-original-interface-native-frame" as const,
      comparison_admission: "eligible only for a matched legacy-native protocol pair; no FOI-v1 scenario or blinded comparison claim",
      can_pass: false,
      blocking_reasons: Object.freeze([
        "The f74 source predates the FOI-v1 recorder and cannot truthfully emit S01-S20 corpus evidence.",
        "A paired candidate must separately execute this exact legacy-native protocol before a protocol-only admission receipt can be formed.",
      ]),
    });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, NATIVE_FRAME_PATH), frame, "utf8");
    writeFileSync(join(destination, CHECKSUMS_PATH), `${sha256(frame)}  ${NATIVE_FRAME_PATH}\n`, "utf8");
    writeFileSync(join(destination, BASELINE_PATH), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    if (added) runHistoricalCommand("git", ["worktree", "remove", "--force", worktree], repository);
    else rmSync(worktree, { recursive: true, force: true });
  }
}

function readRecord(path: string): Readonly<Record<string, unknown>> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function protocolIsExact(value: unknown): boolean {
  const protocol = nestedRecord(value);
  const viewport = nestedRecord(protocol?.viewport);
  return protocol?.id === LEGACY_NATIVE_PROTOCOL_ID
    && protocol.version === 1
    && protocol.projection === "initial-model-static-output"
    && viewport?.columns === 100
    && viewport.rows === 30;
}

function exactLegacyExecution(value: unknown): boolean {
  const execution = nestedRecord(value);
  return execution?.isolated_worktree === true
    && execution.native_renderer_commit === true
    && execution.renderer_boundary === "legacy-opentui-native-test-renderer"
    && execution.provider_or_connector_invoked === false;
}

function verifyFrameArtifact(destination: string, errors: string[]): void {
  let frame = "";
  try { frame = readFileSync(join(destination, NATIVE_FRAME_PATH), "utf8"); } catch { errors.push("legacy-native frame is missing"); }
  if (!frame.includes(LEGACY_NATIVE_PROBE_TEXT)) errors.push("legacy-native frame lacks the declared shared probe output");
  try {
    const checksum = readFileSync(join(destination, CHECKSUMS_PATH), "utf8");
    if (checksum !== `${sha256(frame)}  ${NATIVE_FRAME_PATH}\n`) errors.push("legacy-native frame checksum is invalid");
  } catch { errors.push("legacy-native checksum is missing"); }
}

/** Independently admits the legacy artifact without promoting it to an FOI pass. */
export function verifyOriginalInterfaceBaseline(destinationInput: string, repository?: string): OriginalInterfaceBaselineVerification {
  const errors: string[] = [];
  const destination = resolve(destinationInput);
  const receipt = readRecord(join(destination, BASELINE_PATH));
  if (receipt === null) errors.push("original-interface baseline receipt is missing or malformed");
  const source = receipt?.capture_source;
  const artifacts = receipt?.artifacts;
  const sourceRecord = nestedRecord(source);
  const artifactsRecord = nestedRecord(artifacts);
  if (receipt?.bundle_type !== ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE || receipt?.bundle_schema_version !== BASELINE_SCHEMA_VERSION) errors.push("original-interface baseline bundle type or schema is invalid");
  if (receipt?.source_revision !== ORIGINAL_INTERFACE_BASELINE_REVISION) errors.push("original-interface baseline source revision is invalid");
  if (sourceRecord?.revision !== ORIGINAL_INTERFACE_BASELINE_REVISION || !objectId(String(sourceRecord?.tree ?? "")) || sourceRecord?.clean !== true || sourceRecord?.detached_worktree !== true) {
    errors.push("original-interface baseline must bind a clean detached historical source identity");
  }
  if (artifactsRecord?.native_frame !== NATIVE_FRAME_PATH || artifactsRecord?.checksums !== CHECKSUMS_PATH) errors.push("original-interface baseline artifact paths are invalid");
  if (receipt?.evidence_status !== "measured" || receipt?.acceptance_scope !== "revision-bound-original-interface-native-frame" || receipt?.can_pass !== false) errors.push("original-interface baseline acceptance scope is invalid");
  if (!protocolIsExact(receipt?.protocol)) errors.push("original-interface baseline does not use the exact shared legacy-native protocol");
  if (!exactLegacyExecution(receipt?.execution) || nestedRecord(receipt?.execution)?.original_interface_executed !== true) errors.push("original-interface baseline execution facts are invalid");
  verifyFrameArtifact(destination, errors);
  try {
    const root = repositoryRoot(repository);
    const expectedTree = git(root, ["rev-parse", `${ORIGINAL_INTERFACE_BASELINE_REVISION}^{tree}`]);
    if (sourceRecord?.tree !== expectedTree) errors.push("original-interface baseline tree does not match the declared historical revision");
  } catch (error) {
    errors.push(`original-interface historical tree cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({
    valid: errors.length === 0,
    can_pass: false,
    evidence_status: errors.length === 0 ? "measured" : "fail",
    acceptance_scope: "revision-bound-original-interface-native-frame",
    errors: Object.freeze(errors),
  });
}

function declaredCurrentIdentity(repository: string, sourceRevision: string): GitIdentity {
  const identity = identityAt(repository);
  if (!identity.clean) throw new Error("current legacy-native candidate capture requires a clean checkout; capture is refused rather than binding dirty imports to a revision");
  if (!objectId(sourceRevision) || sourceRevision !== identity.revision) {
    throw new Error(`current legacy-native candidate source revision ${sourceRevision} does not match clean checked-out HEAD ${identity.revision}`);
  }
  return identity;
}

/**
 * Captures the current candidate from a clean HEAD through the same detached
 * worktree, Bun command, projection, viewport, and native OpenTUI protocol as
 * the f74 baseline. The candidate has its own bundle type and is never an
 * alias for either the FOI-v1 corpus or the historical source.
 */
export function captureCurrentLegacyNativeCandidate(input: CurrentLegacyNativeCandidateCaptureInput): Readonly<Record<string, unknown>> {
  const repository = repositoryRoot(input.repository);
  const declared = declaredCurrentIdentity(repository, input.sourceRevision);
  if (declared.revision === ORIGINAL_INTERFACE_BASELINE_REVISION) throw new Error("current legacy-native candidate must not reuse the original-interface baseline revision");
  const destination = resolve(input.destination);
  const worktree = mkdtempSync(join(tmpdir(), "revoy2-current-legacy-native-"));
  rmSync(worktree, { recursive: true, force: true });
  let added = false;
  try {
    runHistoricalCommand("git", ["worktree", "add", "--detach", "--quiet", worktree, declared.revision], repository);
    added = true;
    const before = identityAt(worktree);
    if (before.revision !== declared.revision || before.tree !== declared.tree || !before.clean) {
      throw new Error("isolated current candidate worktree identity is not the declared clean source tree");
    }
    const probe = runLegacyNativeProbe(worktree);
    const after = identityAt(worktree);
    if (after.revision !== before.revision || after.tree !== before.tree || !after.clean) {
      throw new Error("current candidate probe changed the source identity; capture is refused");
    }
    if (!validProbe(probe)) throw new Error("current candidate did not prove the exact shared legacy-native OpenTUI boundary");
    const frame = probe.frame;
    const receipt = Object.freeze({
      bundle_type: CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE,
      bundle_schema_version: BASELINE_SCHEMA_VERSION,
      source_revision: declared.revision,
      capture_source: Object.freeze({ ...after, detached_worktree: true }),
      execution: Object.freeze({
        driver: "current-eval-driver-current-native-probe",
        current_candidate_executed: true,
        isolated_worktree: true,
        native_renderer_commit: true,
        renderer_boundary: probe.renderer_boundary,
        provider_or_connector_invoked: false,
      }),
      protocol: Object.freeze({
        id: probe.protocol_id,
        version: probe.protocol_version,
        projection: probe.projection,
        viewport: probe.viewport,
      }),
      artifacts: Object.freeze({ native_frame: NATIVE_FRAME_PATH, checksums: CHECKSUMS_PATH }),
      evidence_status: "measured" as const,
      acceptance_scope: "revision-bound-current-legacy-native-frame" as const,
      comparison_admission: "eligible only for a matched legacy-native protocol pair; no FOI-v1 scenario, performance, human-review, or release claim",
      can_pass: false,
      blocking_reasons: Object.freeze([
        "The bounded candidate probe does not produce FOI-v1 S01-S20 corpus evidence.",
        "A matched legacy-native pair proves protocol correspondence only, not a user-facing quality improvement.",
      ]),
    });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, NATIVE_FRAME_PATH), frame, "utf8");
    writeFileSync(join(destination, CHECKSUMS_PATH), `${sha256(frame)}  ${NATIVE_FRAME_PATH}\n`, "utf8");
    writeFileSync(join(destination, CANDIDATE_PATH), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    if (added) runHistoricalCommand("git", ["worktree", "remove", "--force", worktree], repository);
    else rmSync(worktree, { recursive: true, force: true });
  }
}

/** Verifies current candidate identity, its exact protocol, and its native frame bytes. */
export function verifyCurrentLegacyNativeCandidate(destinationInput: string, repository?: string): CurrentLegacyNativeCandidateVerification {
  const errors: string[] = [];
  const destination = resolve(destinationInput);
  const receipt = readRecord(join(destination, CANDIDATE_PATH));
  if (receipt === null) errors.push("current legacy-native candidate receipt is missing or malformed");
  const source = nestedRecord(receipt?.capture_source);
  const artifacts = nestedRecord(receipt?.artifacts);
  const sourceRevision = typeof receipt?.source_revision === "string" ? receipt.source_revision : "";
  if (receipt?.bundle_type !== CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE || receipt?.bundle_schema_version !== BASELINE_SCHEMA_VERSION) errors.push("current legacy-native candidate bundle type or schema is invalid");
  if (!objectId(sourceRevision) || sourceRevision === ORIGINAL_INTERFACE_BASELINE_REVISION) errors.push("current legacy-native candidate source revision is invalid");
  if (source?.revision !== sourceRevision || !objectId(String(source?.tree ?? "")) || source?.clean !== true || source?.detached_worktree !== true) errors.push("current legacy-native candidate must bind a clean detached source identity");
  if (artifacts?.native_frame !== NATIVE_FRAME_PATH || artifacts?.checksums !== CHECKSUMS_PATH) errors.push("current legacy-native candidate artifact paths are invalid");
  if (receipt?.evidence_status !== "measured" || receipt?.acceptance_scope !== "revision-bound-current-legacy-native-frame" || receipt?.can_pass !== false) errors.push("current legacy-native candidate acceptance scope is invalid");
  if (!protocolIsExact(receipt?.protocol)) errors.push("current legacy-native candidate does not use the exact shared legacy-native protocol");
  if (!exactLegacyExecution(receipt?.execution) || nestedRecord(receipt?.execution)?.current_candidate_executed !== true) errors.push("current legacy-native candidate execution facts are invalid");
  verifyFrameArtifact(destination, errors);
  try {
    const root = repositoryRoot(repository);
    const expectedTree = git(root, ["rev-parse", `${sourceRevision}^{tree}`]);
    if (source?.tree !== expectedTree) errors.push("current legacy-native candidate tree does not match the declared source revision");
  } catch (error) {
    errors.push(`current legacy-native candidate tree cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({
    valid: errors.length === 0,
    can_pass: false,
    evidence_status: errors.length === 0 ? "measured" : "fail",
    acceptance_scope: "revision-bound-current-legacy-native-frame",
    errors: Object.freeze(errors),
  });
}

function pairSource(receipt: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
  const source = nestedRecord(receipt?.capture_source);
  const revision = typeof receipt?.source_revision === "string" ? receipt.source_revision : null;
  if (source === null || revision === null || !objectId(revision) || !objectId(String(source.tree ?? ""))) return null;
  return Object.freeze({ revision, tree: source.tree });
}

/**
 * Writes the sole admissible comparison surface for this tranche. Its shared
 * facts are limited to the identical native protocol and boundary; it neither
 * compares rendered quality nor enters FOI-v1/blinded acceptance.
 */
export function recordLegacyNativeMatchedPair(input: LegacyNativeMatchedPairInput): Readonly<Record<string, unknown>> {
  const repository = repositoryRoot(input.repository);
  const baselinePath = resolve(input.baseline);
  const candidatePath = resolve(input.candidate);
  const baselineVerification = verifyOriginalInterfaceBaseline(baselinePath, repository);
  const candidateVerification = verifyCurrentLegacyNativeCandidate(candidatePath, repository);
  if (!baselineVerification.valid || !candidateVerification.valid) {
    throw new Error(`legacy-native pair requires independently valid baseline and candidate evidence: ${[...baselineVerification.errors, ...candidateVerification.errors].join("; ")}`);
  }
  const baselineReceipt = readRecord(join(baselinePath, BASELINE_PATH));
  const candidateReceipt = readRecord(join(candidatePath, CANDIDATE_PATH));
  const baselineSource = pairSource(baselineReceipt);
  const candidateSource = pairSource(candidateReceipt);
  if (baselineSource === null || candidateSource === null) throw new Error("legacy-native pair source identities are malformed");
  if (baselineSource.revision === candidateSource.revision || baselineSource.tree === candidateSource.tree) throw new Error("legacy-native pair requires distinct baseline and candidate source identities");
  if (!protocolIsExact(baselineReceipt?.protocol) || !protocolIsExact(candidateReceipt?.protocol)) throw new Error("legacy-native pair protocol is not exact on both sides");
  const receipt = Object.freeze({
    bundle_type: LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE,
    bundle_schema_version: BASELINE_SCHEMA_VERSION,
    baseline: Object.freeze({ artifact_directory: baselinePath, source: baselineSource, receipt_sha256: sha256(readFileSync(join(baselinePath, BASELINE_PATH), "utf8")) }),
    candidate: Object.freeze({ artifact_directory: candidatePath, source: candidateSource, receipt_sha256: sha256(readFileSync(join(candidatePath, CANDIDATE_PATH), "utf8")) }),
    shared_facts: Object.freeze({
      protocol: Object.freeze({ id: LEGACY_NATIVE_PROTOCOL_ID, version: 1, projection: "initial-model-static-output", viewport: Object.freeze({ columns: 100, rows: 30 }) }),
      native_renderer_boundary: "legacy-opentui-native-test-renderer",
      native_renderer_commit: true,
      provider_or_connector_invoked: false,
    }),
    evidence_status: "measured" as const,
    acceptance_scope: "matched-legacy-native-protocol-admission-only" as const,
    comparison_claim: "Both declared source trees executed the same bounded native OpenTUI probe. No visual-quality, FOI-v1 corpus, performance, human-review, or release conclusion is asserted.",
    can_pass: false,
    blocking_reasons: Object.freeze([
      "The matched frame protocol has one static projection only and does not cover FOI-v1 S01-S20.",
      "No matched performance distribution, blinded observation, or human task outcome is present.",
    ]),
  });
  const destination = resolve(input.destination);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, MATCHED_PAIR_PATH), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

/** Re-checks both source artifacts and the deliberately narrow pair receipt. */
export function verifyLegacyNativeMatchedPair(destinationInput: string, repository?: string): LegacyNativeMatchedPairVerification {
  const errors: string[] = [];
  const receipt = readRecord(join(resolve(destinationInput), MATCHED_PAIR_PATH));
  if (receipt === null) errors.push("legacy-native matched-pair receipt is missing or malformed");
  const baseline = nestedRecord(receipt?.baseline);
  const candidate = nestedRecord(receipt?.candidate);
  if (receipt?.bundle_type !== LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE || receipt?.bundle_schema_version !== BASELINE_SCHEMA_VERSION) errors.push("legacy-native matched-pair bundle type or schema is invalid");
  if (receipt?.evidence_status !== "measured" || receipt?.acceptance_scope !== "matched-legacy-native-protocol-admission-only" || receipt?.can_pass !== false) errors.push("legacy-native matched-pair acceptance scope is invalid");
  const baselineDirectory = typeof baseline?.artifact_directory === "string" ? baseline.artifact_directory : null;
  const candidateDirectory = typeof candidate?.artifact_directory === "string" ? candidate.artifact_directory : null;
  if (baselineDirectory === null || candidateDirectory === null) errors.push("legacy-native matched-pair artifact directories are invalid");
  else {
    const baselineVerification = verifyOriginalInterfaceBaseline(baselineDirectory, repository);
    const candidateVerification = verifyCurrentLegacyNativeCandidate(candidateDirectory, repository);
    if (!baselineVerification.valid) errors.push(...baselineVerification.errors.map((error) => `baseline: ${error}`));
    if (!candidateVerification.valid) errors.push(...candidateVerification.errors.map((error) => `candidate: ${error}`));
    const baselineReceipt = readRecord(join(baselineDirectory, BASELINE_PATH));
    const candidateReceipt = readRecord(join(candidateDirectory, CANDIDATE_PATH));
    const baselineSource = pairSource(baselineReceipt);
    const candidateSource = pairSource(candidateReceipt);
    if (baselineSource === null || candidateSource === null || baselineSource.revision === candidateSource.revision || baselineSource.tree === candidateSource.tree) errors.push("legacy-native matched pair must bind two distinct verified source identities");
    if (baseline?.receipt_sha256 !== (baselineReceipt === null ? null : sha256(readFileSync(join(baselineDirectory, BASELINE_PATH), "utf8")))) errors.push("legacy-native matched-pair baseline receipt hash is invalid");
    if (candidate?.receipt_sha256 !== (candidateReceipt === null ? null : sha256(readFileSync(join(candidateDirectory, CANDIDATE_PATH), "utf8")))) errors.push("legacy-native matched-pair candidate receipt hash is invalid");
  }
  const sharedFacts = nestedRecord(receipt?.shared_facts);
  if (!protocolIsExact(sharedFacts?.protocol) || sharedFacts?.native_renderer_boundary !== "legacy-opentui-native-test-renderer" || sharedFacts?.native_renderer_commit !== true || sharedFacts?.provider_or_connector_invoked !== false) errors.push("legacy-native matched-pair shared facts are invalid");
  return Object.freeze({
    valid: errors.length === 0,
    can_pass: false,
    evidence_status: errors.length === 0 ? "measured" : "fail",
    acceptance_scope: "matched-legacy-native-protocol-admission-only",
    errors: Object.freeze(errors),
  });
}
