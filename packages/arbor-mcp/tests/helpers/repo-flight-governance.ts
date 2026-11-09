import { generateKeyPairSync } from "node:crypto";
import { issueGovernanceAdmissionAttestation, type GovernanceAdmissionTrustState } from "@arbor/governance";
import type { RepoFlightDirector } from "../../src/repo-flight-director.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sha = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

export function governanceTrust(): GovernanceAdmissionTrustState { return { trust_root_ref: "trust:test", separation_policy_version: "separation:test", separation_policy_digest: sha("9"), revocation_epoch: 1, revoked_key_ids: new Set(), public_keys: new Map([["governance:test", publicKey]]) }; }

export function warrantForDirector(director: RepoFlightDirector, repoRunId: string): unknown {
  const run = director.controller.lifecycle.inspect(repoRunId);
  if (run === null) throw new Error("test run is absent");
  const observedAt = Date.now();
  return issueGovernanceAdmissionAttestation({ schema_version: 1, canonical_payload_version: "revoy.governance-admission.v1", attestation_id: `attestation:${repoRunId}`, repository_id: run.repository.repository_id, repo_run_id: run.repo_run_id, work_class: run.work_class, admission_base_oid: run.base_oid, input_digest: run.input_digest, scope_digest: run.scope_digest, workspace_lineage_digest: run.workspace_lineage_digest, proposer_identity: run.proposer_identity, issuer_identity: "governance:issuer", acceptor_identity: "human:acceptor", profile_version: run.profile_version, policy_version: run.policy_version, issued_at: new Date(observedAt - 60_000).toISOString(), expires_at: new Date(observedAt + 60 * 60_000).toISOString(), key_id: "governance:test", trust_root_ref: "trust:test", separation_policy_version: "separation:test", separation_policy_digest: sha("9"), revocation_epoch: 1, facts: { kind: "decision_bound", adr_id: "ADR-152", adr_content_id: "content:152", adr_status: "Accepted", acceptance_commit_oid: "1".repeat(40), interview_receipt_digest: sha("2"), acceptance_receipt_digest: sha("3"), active_deferral: false } }, privateKey);
}
