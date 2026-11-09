import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE,
  ORIGINAL_INTERFACE_BASELINE_REVISION,
  CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE,
  LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE,
  captureOriginalInterfaceBaseline,
  captureCurrentLegacyNativeCandidate,
  recordLegacyNativeMatchedPair,
  verifyOriginalInterfaceBaseline,
  verifyCurrentLegacyNativeCandidate,
  verifyLegacyNativeMatchedPair,
} from "../src/foi-historical-native-baseline.js";
import { runFrontierInterfaceCli } from "../src/frontier-interface-cli.js";

const temporary: string[] = [];
const temporaryWorktrees: string[] = [];
const NATIVE_FRAME_PATH = "legacy-native-frame.txt";
afterEach(() => {
  for (const path of temporaryWorktrees.splice(0)) execFileSync("git", ["worktree", "remove", "--force", path], { cwd: process.cwd(), stdio: "ignore" });
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function cleanHeadWorktree(): string {
  const path = mkdtempSync(join(tmpdir(), "foi-current-legacy-source-"));
  rmSync(path, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", path, "HEAD"], { cwd: process.cwd(), stdio: "ignore" });
  temporaryWorktrees.push(path);
  return path;
}

function revisionAt(path: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
}

describe("revision-bound original-interface baseline", () => {
  test("executes f74 in a fresh detached worktree through the historical native OpenTUI boundary", () => {
    const destination = mkdtempSync(join(tmpdir(), "foi-original-interface-baseline-"));
    temporary.push(destination);

    const receipt = captureOriginalInterfaceBaseline({ destination, repository: process.cwd() });

    expect(receipt).toMatchObject({
      bundle_type: ORIGINAL_INTERFACE_BASELINE_BUNDLE_TYPE,
      source_revision: ORIGINAL_INTERFACE_BASELINE_REVISION,
      capture_source: { revision: ORIGINAL_INTERFACE_BASELINE_REVISION, clean: true, detached_worktree: true },
      execution: {
        driver: "current-eval-driver-historical-native-probe",
        original_interface_executed: true,
        isolated_worktree: true,
        native_renderer_commit: true,
        renderer_boundary: "legacy-opentui-native-test-renderer",
        provider_or_connector_invoked: false,
      },
      protocol: { id: "foi-legacy-native-opentui-frame-v1", version: 1, projection: "initial-model-static-output", viewport: { columns: 100, rows: 30 } },
      evidence_status: "measured",
      acceptance_scope: "revision-bound-original-interface-native-frame",
      can_pass: false,
    });
    expect(readFileSync(join(destination, NATIVE_FRAME_PATH), "utf8")).toContain("revision-bound legacy native OpenTUI boundary");
    expect(verifyOriginalInterfaceBaseline(destination, process.cwd())).toEqual(expect.objectContaining({ valid: true, can_pass: false, evidence_status: "measured", errors: [] }));
    const output: string[] = [];
    const errors: string[] = [];
    expect(runFrontierInterfaceCli(["verify-original-interface-baseline", destination], {
      stdout: (value) => output.push(value), stderr: (value) => errors.push(value),
      read: () => "", write: () => {},
    })).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ valid: true, can_pass: false, evidence_status: "measured" });

    writeFileSync(join(destination, NATIVE_FRAME_PATH), "tampered\n", "utf8");
    expect(verifyOriginalInterfaceBaseline(destination, process.cwd())).toEqual(expect.objectContaining({ valid: false, can_pass: false, evidence_status: "fail" }));
  }, 30_000);

  test("refuses an arbitrary historical label instead of silently changing the original interface baseline", () => {
    const destination = mkdtempSync(join(tmpdir(), "foi-original-interface-reject-"));
    temporary.push(destination);
    expect(() => captureOriginalInterfaceBaseline({ destination, revision: "HEAD", repository: process.cwd() }))
      .toThrow(`original-interface baseline is pinned to ${ORIGINAL_INTERFACE_BASELINE_REVISION}`);
  });

  test("captures a distinct clean current candidate through the identical protocol and admits only its matched facts", () => {
    const repository = cleanHeadWorktree();
    const baseline = mkdtempSync(join(tmpdir(), "foi-legacy-baseline-"));
    const candidate = mkdtempSync(join(tmpdir(), "foi-legacy-candidate-"));
    const pair = mkdtempSync(join(tmpdir(), "foi-legacy-pair-"));
    temporary.push(baseline, candidate, pair);

    const baselineReceipt = captureOriginalInterfaceBaseline({ destination: baseline, repository });
    const candidateReceipt = captureCurrentLegacyNativeCandidate({ destination: candidate, sourceRevision: revisionAt(repository), repository });
    expect(candidateReceipt).toMatchObject({
      bundle_type: CURRENT_LEGACY_NATIVE_CANDIDATE_BUNDLE_TYPE,
      source_revision: revisionAt(repository),
      capture_source: { revision: revisionAt(repository), clean: true, detached_worktree: true },
      execution: { current_candidate_executed: true, isolated_worktree: true, native_renderer_commit: true, renderer_boundary: "legacy-opentui-native-test-renderer", provider_or_connector_invoked: false },
      protocol: baselineReceipt.protocol,
      evidence_status: "measured",
      acceptance_scope: "revision-bound-current-legacy-native-frame",
      can_pass: false,
    });
    expect(verifyCurrentLegacyNativeCandidate(candidate, repository)).toEqual(expect.objectContaining({ valid: true, can_pass: false, evidence_status: "measured", errors: [] }));

    const paired = recordLegacyNativeMatchedPair({ destination: pair, baseline, candidate, repository });
    expect(paired).toMatchObject({
      bundle_type: LEGACY_NATIVE_MATCHED_PAIR_BUNDLE_TYPE,
      baseline: { source: { revision: ORIGINAL_INTERFACE_BASELINE_REVISION } },
      candidate: { source: { revision: revisionAt(repository) } },
      shared_facts: { protocol: baselineReceipt.protocol, native_renderer_commit: true, provider_or_connector_invoked: false },
      acceptance_scope: "matched-legacy-native-protocol-admission-only",
      can_pass: false,
    });
    expect(verifyLegacyNativeMatchedPair(pair, repository)).toEqual(expect.objectContaining({ valid: true, can_pass: false, evidence_status: "measured", errors: [] }));
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value), read: () => "", write: () => {} };
    expect(runFrontierInterfaceCli(["verify-current-legacy-native-candidate", candidate], io)).toBe(0);
    expect(runFrontierInterfaceCli(["verify-legacy-native-matched-pair", pair], io)).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ valid: true, can_pass: false, evidence_status: "measured" });
    expect(JSON.parse(output[1]!)).toMatchObject({ valid: true, can_pass: false, evidence_status: "measured" });

    writeFileSync(join(candidate, NATIVE_FRAME_PATH), "tampered\n", "utf8");
    expect(verifyLegacyNativeMatchedPair(pair, repository)).toEqual(expect.objectContaining({ valid: false, can_pass: false, evidence_status: "fail" }));
  }, 60_000);

  test("refuses to bind a current candidate to a source label other than its clean HEAD", () => {
    const repository = cleanHeadWorktree();
    const destination = mkdtempSync(join(tmpdir(), "foi-current-legacy-reject-"));
    temporary.push(destination);
    expect(() => captureCurrentLegacyNativeCandidate({ destination, sourceRevision: ORIGINAL_INTERFACE_BASELINE_REVISION, repository }))
      .toThrow("does not match clean checked-out HEAD");
  });
});
