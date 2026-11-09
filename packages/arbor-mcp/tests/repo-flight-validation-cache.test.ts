import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO_FLIGHT_NORMALIZED_SOURCE_ROOT,
  RepoFlightValidationCache,
  createRepoFlightValidationFingerprint,
  createRepoFlightValidationShardManifests,
  evaluateRepoFlightDescendantReuse,
  evaluateRepoFlightExactReuse,
  repoFlightValidationDigest,
  repoFlightFullAuditRequired,
  signRepoFlightTransitiveClosureProof,
  signRepoFlightValidationReceipt,
  validateRepoFlightEffectiveCoverageArtifactSet,
  validateRepoFlightValidationShardManifest,
  verifyRepoFlightValidationReceipt,
  verifyRepoFlightFullAuditForFinalization,
  type RepoFlightValidationFingerprint,
} from "../src/repo-flight-validation-cache.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-08-28T18:00:00.000Z");
const trust = new Map([["issuer:governance", { issuer_id: "issuer:governance", key_id: "key:2026", public_key: publicKey }]]);
const sha = (value: string) => `sha256:${"a".repeat(56)}${value.padStart(8, "0").slice(-8)}` as `sha256:${string}`;
const candidate = (oid: string, digest = "1") => ({ candidate_oid: oid.repeat(40 / oid.length), input_digest: sha(digest) });
const base = candidate("a");
const target = candidate("b", "2");

function fingerprint(overrides: Partial<Parameters<typeof createRepoFlightValidationFingerprint>[0]> = {}): RepoFlightValidationFingerprint {
  return createRepoFlightValidationFingerprint({
    repository_id: `repo:v1:${"d".repeat(64)}`,
    candidate: base,
    profile_digest: sha("3"),
    gate_id: "gate:coverage",
    argv: ["bun", "run", "gate:coverage"],
    runtime_identity: { runtime: { node: "v22.0.0", bun: "1.3.14" }, toolchain: { vitest: "2.1.9" }, platform: { os: "linux", arch: "x64", abi: "node-127" } },
    lockfile_digest: sha("4"),
    environment: { CI: "true", TZ: "UTC" },
    configuration_digest: sha("5"),
    shard_manifest_digest: sha("6"),
    shard_assignment_digest: sha("f"),
    artifact_digest: sha("7"),
    ...overrides,
  });
}

function receipt(input: { readonly fp?: RepoFlightValidationFingerprint; readonly kind?: "gate" | "coverage_shard" | "integration" | "full_audit" | "evidence_writer" | "nondeterminism_measurement" | "time_sensitive_governance"; readonly outcome?: "passed" | "failed" | "timed_out" | "interrupted" | "ambiguous"; readonly complete?: boolean } = {}) {
  return signRepoFlightValidationReceipt({
    schema_version: 1,
    kind: "revoy2.repo_flight.validation_receipt",
    receipt_id: "receipt:one",
    producer: { issuer_id: "issuer:governance", key_id: "key:2026" },
    validation_kind: input.kind ?? "coverage_shard",
    outcome: input.outcome ?? "passed",
    artifact_complete: input.complete ?? true,
    issued_at: "2026-08-28T17:00:00.000Z",
    expires_at: "2026-08-29T17:00:00.000Z",
    fingerprint: input.fp ?? fingerprint(),
  }, privateKey);
}

describe("repo flight revision-bound validation cache", () => {
  it("canonicalizes fingerprints independently of record order and accepts only exact signed success", () => {
    const one = fingerprint();
    const two = createRepoFlightValidationFingerprint({ ...one, environment: { TZ: "UTC", CI: "true" }, runtime_identity: { runtime: { bun: "1.3.14", node: "v22.0.0" }, toolchain: { vitest: "2.1.9" }, platform: { abi: "node-127", arch: "x64", os: "linux" } } });
    expect(one.fingerprint).toBe(two.fingerprint);
    expect(evaluateRepoFlightExactReuse(receipt({ fp: one }), two, trust, now)).toMatchObject({ reusable: true, mode: "exact" });
    expect(evaluateRepoFlightExactReuse(receipt({ fp: one }), fingerprint({ configuration_digest: sha("8") }), trust, now)).toMatchObject({ reusable: false, code: "fingerprint_mismatch" });
    expect(evaluateRepoFlightExactReuse(receipt({ fp: one }), fingerprint({ repository_id: `repo:v1:${"e".repeat(64)}` }), trust, now)).toMatchObject({ reusable: false, code: "fingerprint_mismatch" });
  });

  it("rejects tampered, wrong-root, expired, failed, interrupted, incomplete, and time-sensitive receipts", () => {
    const signed = receipt();
    expect(verifyRepoFlightValidationReceipt({ ...signed, artifact_complete: false }, trust, now)).toMatchObject({ ok: false, code: "signature_invalid" });
    expect(verifyRepoFlightValidationReceipt(signed, new Map(), now)).toMatchObject({ ok: false, code: "trust_root_absent" });
    expect(evaluateRepoFlightExactReuse(receipt({ outcome: "failed" }), fingerprint(), trust, now)).toMatchObject({ reusable: false, code: "receipt_not_reusable" });
    expect(evaluateRepoFlightExactReuse(receipt({ outcome: "interrupted" }), fingerprint(), trust, now)).toMatchObject({ reusable: false, code: "receipt_not_reusable" });
    expect(evaluateRepoFlightExactReuse(receipt({ complete: false }), fingerprint(), trust, now)).toMatchObject({ reusable: false, code: "receipt_not_reusable" });
    expect(evaluateRepoFlightExactReuse(receipt({ kind: "time_sensitive_governance" }), fingerprint(), trust, now)).toMatchObject({ reusable: false, code: "receipt_not_reusable" });
    const { signature: _signature, ...expiredPayload } = receipt();
    const expired = signRepoFlightValidationReceipt({ ...expiredPayload, issued_at: "2026-08-01T00:00:00.000Z", expires_at: "2026-08-02T00:00:00.000Z" }, privateKey);
    expect(verifyRepoFlightValidationReceipt(expired, trust, now)).toMatchObject({ ok: false, code: "expired" });
  });

  it("allows descendant reuse only with a trusted complete, unchanged closure", () => {
    const source = fingerprint();
    const expected = fingerprint({ candidate: target, artifact_digest: sha("9") });
    const closure = signRepoFlightTransitiveClosureProof({
      schema_version: 1,
      kind: "revoy2.repo_flight.transitive_closure_proof",
      proof_id: "closure:one",
      producer: { issuer_id: "issuer:governance", key_id: "key:2026" },
      source_candidate: source.candidate,
      target_candidate: target,
      source_shard_manifest_digest: source.shard_manifest_digest,
      target_shard_manifest_digest: expected.shard_manifest_digest,
      analyzer_version: "vi:1",
      graph_digest: sha("a"),
      complete: true,
      nodes: [{ node_id: "file:packages/a/src/a.ts", source_digest: sha("b"), target_digest: sha("b") }],
      unknown_edges: [], dynamic_edges: [], ambiguous_edges: [],
      issued_at: "2026-08-28T17:00:00.000Z", expires_at: "2026-08-29T17:00:00.000Z",
    }, privateKey);
    expect(evaluateRepoFlightDescendantReuse(receipt({ fp: source }), expected, closure, trust, now)).toMatchObject({ reusable: true, mode: "descendant" });
    expect(evaluateRepoFlightDescendantReuse(receipt({ fp: source }), expected, { ...closure, unknown_edges: ["edge:dynamic"] }, trust, now)).toMatchObject({ reusable: false, code: "closure_signature_invalid" });
    const { signature: _closureSignature, ...changedPayload } = closure;
    const changed = signRepoFlightTransitiveClosureProof({ ...changedPayload, nodes: [{ node_id: "file:packages/a/src/a.ts", source_digest: sha("b"), target_digest: sha("c") }] }, privateKey);
    expect(evaluateRepoFlightDescendantReuse(receipt({ fp: source }), expected, changed, trust, now)).toMatchObject({ reusable: false, code: "closure_input_changed" });
  });

  it("builds deterministic complete validation and coverage manifests with serial reasons", () => {
    const files = [
      { path: "packages/a/tests/a.test.ts", coverage_eligible: true, serial_reason: null },
      { path: "packages/a/tests/socket.test.ts", coverage_eligible: true, serial_reason: "local_socket_namespace" },
      { path: "packages/a/tests/opentui.test.ts", coverage_eligible: false, serial_reason: "bun_native_renderer" },
    ] as const;
    const one = createRepoFlightValidationShardManifests({ repository_id: `repo:v1:${"d".repeat(64)}`, candidate: base, profile_digest: sha("3"), classification_digest: sha("e"), hermetic_shard_count: 3, files });
    const two = createRepoFlightValidationShardManifests({ repository_id: `repo:v1:${"d".repeat(64)}`, candidate: base, profile_digest: sha("3"), classification_digest: sha("e"), hermetic_shard_count: 3, files: [...files].reverse() });
    expect(one).toEqual(two);
    expect(validateRepoFlightValidationShardManifest(one.validation)).toMatchObject({ ok: true });
    expect(validateRepoFlightValidationShardManifest(one.coverage)).toMatchObject({ ok: true });
    expect(one.validation.shards.flatMap((shard) => shard.files).sort()).toEqual(files.map((file) => file.path).sort());
    expect(one.coverage.shards.flatMap((shard) => shard.files).sort()).toEqual(files.filter((file) => file.coverage_eligible).map((file) => file.path).sort());
    expect(one.validation.shards.find((shard) => shard.lane === "serial")?.serial_reason).toBe("bun_native_renderer");
    expect(() => createRepoFlightValidationShardManifests({ repository_id: `repo:v1:${"d".repeat(64)}`, candidate: base, profile_digest: sha("3"), classification_digest: sha("e"), hermetic_shard_count: 2, files: [files[0], files[0]] })).toThrow(/duplicate/);
  });

  it("requires one complete, normalized, identity-matched receipt-backed artifact per coverage shard", () => {
    const manifests = createRepoFlightValidationShardManifests({
      repository_id: `repo:v1:${"d".repeat(64)}`, candidate: base, profile_digest: sha("3"), classification_digest: sha("e"), hermetic_shard_count: 2,
      files: [{ path: "packages/a/tests/a.test.ts", coverage_eligible: true, serial_reason: null }, { path: "packages/b/tests/b.test.ts", coverage_eligible: true, serial_reason: null }],
    });
    const artifacts = manifests.coverage.shards.map((shard, index) => {
      const artifact_digest = sha(String(index + 20));
      const fp = fingerprint({ candidate: base, profile_digest: manifests.coverage.profile_digest, shard_manifest_digest: manifests.coverage.manifest_digest, shard_assignment_digest: manifests.coverage.assignment_digest, artifact_digest });
      return {
        shard_id: shard.shard_id, effective_candidate: base, manifest_digest: manifests.coverage.manifest_digest,
        coverage_configuration_digest: sha("5"), toolchain_digest: repoFlightValidationDigest(fp.runtime_identity), normalized_source_root: REPO_FLIGHT_NORMALIZED_SOURCE_ROOT,
        artifact_digest, complete: true, receipt: receipt({ fp }), reuse: { mode: "executed" as const },
      };
    });
    expect(validateRepoFlightEffectiveCoverageArtifactSet({ manifest: manifests.coverage, artifacts, coverage_configuration_digest: sha("5"), toolchain_digest: repoFlightValidationDigest(fingerprint().runtime_identity), trust_roots: trust, now })).toMatchObject({ ok: true, shard_count: manifests.coverage.shards.length });
    expect(validateRepoFlightEffectiveCoverageArtifactSet({ manifest: manifests.coverage, artifacts: artifacts.slice(1), coverage_configuration_digest: sha("5"), toolchain_digest: repoFlightValidationDigest(fingerprint().runtime_identity), trust_roots: trust, now })).toMatchObject({ ok: false, code: "incomplete_shards" });
    expect(validateRepoFlightEffectiveCoverageArtifactSet({ manifest: manifests.coverage, artifacts: [{ ...artifacts[0]!, complete: false }, ...artifacts.slice(1)], coverage_configuration_digest: sha("5"), toolchain_digest: repoFlightValidationDigest(fingerprint().runtime_identity), trust_roots: trust, now })).toMatchObject({ ok: false, code: "artifact_incomplete" });
  });

  it("persists signed terminal outcomes, fails closed after crash recovery, and refuses corrupted state", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy2-validation-cache-"));
    const cache = new RepoFlightValidationCache({ persistence_dir: root, trust_roots: trust, now: () => now });
    const interrupted = receipt({ outcome: "interrupted" });
    expect(cache.record(interrupted)).toMatchObject({ ok: true, idempotent: false });
    expect(cache.lookupExact(fingerprint())).toMatchObject({ reusable: false, code: "cache_miss" });
    cache.close();
    const recovered = new RepoFlightValidationCache({ persistence_dir: root, trust_roots: trust, now: () => now });
    expect(recovered.snapshot()).toHaveLength(1);
    expect(recovered.lookupExact(fingerprint())).toMatchObject({ reusable: false, code: "cache_miss" });
    recovered.close();
    writeFileSync(join(root, "repo-flight-validation-cache.json"), "{not-json\n", "utf8");
    expect(() => new RepoFlightValidationCache({ persistence_dir: root, trust_roots: trust, now: () => now })).toThrow(/unreadable/);
  });

  it("requires an exact successful uncached full audit for finalization and on every invalidating cadence trigger", () => {
    const expected = fingerprint({ gate_id: "gate:full-audit", argv: ["bun", "run", "test:all"] });
    expect(verifyRepoFlightFullAuditForFinalization(receipt({ fp: expected, kind: "full_audit" }), expected, trust, now)).toMatchObject({ ok: true, receipt_digest: expect.stringMatching(/^sha256:/) });
    expect(verifyRepoFlightFullAuditForFinalization(receipt({ fp: expected, kind: "gate" }), expected, trust, now)).toMatchObject({ ok: false, code: "wrong_kind" });
    expect(verifyRepoFlightFullAuditForFinalization(receipt({ fp: expected, kind: "full_audit" }), fingerprint({ gate_id: "gate:full-audit", argv: ["bun", "run", "test:all"], configuration_digest: sha("9") }), trust, now)).toMatchObject({ ok: false, code: "identity_mismatch" });
    expect(repoFlightFullAuditRequired({ last_success_at: "2026-08-28T17:30:00.000Z", now: now.toISOString(), max_age_ms: 3_600_000, descendant_reuse: false, impact_uncertain: false, identity_changed: false })).toBe(false);
    expect(repoFlightFullAuditRequired({ last_success_at: "2026-08-28T17:30:00.000Z", now: now.toISOString(), max_age_ms: 3_600_000, descendant_reuse: true, impact_uncertain: false, identity_changed: false })).toBe(true);
    expect(repoFlightFullAuditRequired({ last_success_at: "2026-08-27T18:00:00.000Z", now: now.toISOString(), max_age_ms: 3_600_000, descendant_reuse: false, impact_uncertain: false, identity_changed: false })).toBe(true);
  });
});
