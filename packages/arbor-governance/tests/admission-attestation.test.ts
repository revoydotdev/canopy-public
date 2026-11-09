import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueGovernanceAdmissionAttestation, verifyGovernanceAdmissionAttestation, type GovernanceAdmissionPayload, type GovernanceAdmissionTrustState } from "../src/admission-attestation.js";

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const oid = (character: string): string => character.repeat(40);

function payload(overrides: Partial<GovernanceAdmissionPayload> = {}): GovernanceAdmissionPayload {
  return {
    schema_version: 1, canonical_payload_version: "revoy.governance-admission.v1", attestation_id: "attestation:1",
    repository_id: `repo:v1:${"a".repeat(64)}`, repo_run_id: "run:1", work_class: "decision_bound",
    admission_base_oid: oid("b"), input_digest: sha("c"), scope_digest: sha("d"), workspace_lineage_digest: sha("e"),
    proposer_identity: "agent:proposer", issuer_identity: "governance:issuer", acceptor_identity: "human:acceptor",
    profile_version: "profile:1", policy_version: "policy:1", issued_at: "2026-08-28T12:00:00.000Z", expires_at: "2026-08-28T13:00:00.000Z",
    key_id: "governance:key:1", trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: sha("f"), revocation_epoch: 4,
    facts: { kind: "decision_bound", adr_id: "ADR-152", adr_content_id: "content:152", adr_status: "Accepted", acceptance_commit_oid: oid("1"), interview_receipt_digest: sha("2"), acceptance_receipt_digest: sha("3"), active_deferral: false },
    ...overrides,
  };
}

function trust(overrides: Partial<GovernanceAdmissionTrustState> = {}): GovernanceAdmissionTrustState {
  return { trust_root_ref: "trust:1", separation_policy_version: "separation:1", separation_policy_digest: sha("f"), revocation_epoch: 4, revoked_key_ids: new Set(), public_keys: new Map([["governance:key:1", publicPem]]), ...overrides };
}

describe("GovernanceAdmissionAttestation", () => {
  it("verifies an externally issued, revision-bound warrant", () => {
    const input = payload();
    const warrant = issueGovernanceAdmissionAttestation(input, privatePem);
    expect(verifyGovernanceAdmissionAttestation(warrant, {
      repository_id: input.repository_id, repo_run_id: input.repo_run_id, work_class: input.work_class,
      admission_base_oid: input.admission_base_oid, input_digest: input.input_digest, scope_digest: input.scope_digest,
      workspace_lineage_digest: input.workspace_lineage_digest, profile_version: input.profile_version, policy_version: input.policy_version,
    }, trust(), "2026-08-28T12:30:00.000Z")).toMatchObject({ ok: true, attestation_digest: expect.stringMatching(/^sha256:/) });
  });

  it.each([
    ["wrong repository", { repository_id: `repo:v1:${"9".repeat(64)}` }, trust(), "2026-08-28T12:30:00.000Z", "binding"],
    ["expired", {}, trust(), "2026-08-28T13:00:00.000Z", "expired"],
    ["revoked", {}, trust({ revoked_key_ids: new Set(["governance:key:1"]) }), "2026-08-28T12:30:00.000Z", "trust"],
    ["stale epoch", {}, trust({ revocation_epoch: 5 }), "2026-08-28T12:30:00.000Z", "trust"],
  ])("rejects %s warrants", (_name, expectedOverrides, trustState, observed, code) => {
    const input = payload();
    const warrant = issueGovernanceAdmissionAttestation(input, privatePem);
    const expected = { repository_id: input.repository_id, repo_run_id: input.repo_run_id, work_class: input.work_class, admission_base_oid: input.admission_base_oid, input_digest: input.input_digest, scope_digest: input.scope_digest, workspace_lineage_digest: input.workspace_lineage_digest, profile_version: input.profile_version, policy_version: input.policy_version, ...expectedOverrides };
    expect(verifyGovernanceAdmissionAttestation(warrant, expected as Parameters<typeof verifyGovernanceAdmissionAttestation>[1], trustState, observed)).toMatchObject({ ok: false, code });
  });

  it("rejects self-approval and signature tampering", () => {
    expect(() => issueGovernanceAdmissionAttestation(payload({ acceptor_identity: "agent:proposer" }), privatePem)).not.toThrow();
    const self = issueGovernanceAdmissionAttestation(payload({ acceptor_identity: "agent:proposer" }), privatePem);
    const input = self.payload;
    const expected = { repository_id: input.repository_id, repo_run_id: input.repo_run_id, work_class: input.work_class, admission_base_oid: input.admission_base_oid, input_digest: input.input_digest, scope_digest: input.scope_digest, workspace_lineage_digest: input.workspace_lineage_digest, profile_version: input.profile_version, policy_version: input.policy_version };
    expect(verifyGovernanceAdmissionAttestation(self, expected, trust(), "2026-08-28T12:30:00.000Z")).toMatchObject({ ok: false, code: "separation" });
    const signed = issueGovernanceAdmissionAttestation(payload(), privatePem);
    const tampered = { ...signed, payload: { ...signed.payload, policy_version: "policy:2" } };
    expect(verifyGovernanceAdmissionAttestation(tampered, { ...expected, policy_version: "policy:2" }, trust(), "2026-08-28T12:30:00.000Z")).toMatchObject({ ok: false, code: "signature" });
  });

  it("requires exploratory decision fields to be explicitly not applicable", () => {
    const exploratory = payload({ work_class: "exploratory", facts: { kind: "exploratory", adr_id: null, adr_content_id: null, adr_status: "not_applicable", acceptance_commit_oid: null, interview_receipt_digest: null, acceptance_receipt_digest: null, active_deferral: "not_applicable" } });
    expect(() => issueGovernanceAdmissionAttestation(exploratory, privatePem)).not.toThrow();
    expect(() => issueGovernanceAdmissionAttestation({ ...exploratory, facts: payload().facts }, privatePem)).toThrow(/facts/);
  });
});
