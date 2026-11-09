import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalizeForHash } from "@arbor/core";

export const GOVERNANCE_ADMISSION_WORK_CLASSES = ["decision_bound", "exploratory"] as const;
export type GovernanceAdmissionWorkClass = (typeof GOVERNANCE_ADMISSION_WORK_CLASSES)[number];

export type GovernanceAdmissionFacts =
  | Readonly<{ kind: "decision_bound"; adr_id: `ADR-${number}`; adr_content_id: string; adr_status: "Accepted"; acceptance_commit_oid: string; interview_receipt_digest: `sha256:${string}`; acceptance_receipt_digest: `sha256:${string}`; active_deferral: false }>
  | Readonly<{ kind: "exploratory"; adr_id: null; adr_content_id: null; adr_status: "not_applicable"; acceptance_commit_oid: null; interview_receipt_digest: null; acceptance_receipt_digest: null; active_deferral: "not_applicable" }>;

export interface GovernanceAdmissionPayload {
  readonly schema_version: 1;
  readonly canonical_payload_version: "revoy.governance-admission.v1";
  readonly attestation_id: string;
  readonly repository_id: `repo:v1:${string}`;
  readonly repo_run_id: string;
  readonly work_class: GovernanceAdmissionWorkClass;
  readonly admission_base_oid: string;
  readonly input_digest: `sha256:${string}`;
  readonly scope_digest: `sha256:${string}`;
  readonly workspace_lineage_digest: `sha256:${string}`;
  readonly proposer_identity: string;
  readonly issuer_identity: string;
  readonly acceptor_identity: string;
  readonly profile_version: string;
  readonly policy_version: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly key_id: string;
  readonly trust_root_ref: string;
  readonly separation_policy_version: string;
  readonly separation_policy_digest: `sha256:${string}`;
  readonly revocation_epoch: number;
  readonly facts: GovernanceAdmissionFacts;
}

export interface GovernanceAdmissionAttestation { readonly payload: GovernanceAdmissionPayload; readonly signature: Readonly<{ algorithm: "ed25519"; value: string }> }

export interface GovernanceAdmissionExpectedBindings {
  readonly repository_id: `repo:v1:${string}`; readonly repo_run_id: string; readonly work_class: GovernanceAdmissionWorkClass;
  readonly admission_base_oid: string; readonly input_digest: `sha256:${string}`; readonly scope_digest: `sha256:${string}`;
  readonly workspace_lineage_digest: `sha256:${string}`; readonly profile_version: string; readonly policy_version: string;
}

export interface GovernanceAdmissionTrustState {
  readonly trust_root_ref: string; readonly separation_policy_version: string; readonly separation_policy_digest: `sha256:${string}`;
  readonly revocation_epoch: number; readonly revoked_key_ids: ReadonlySet<string>; readonly public_keys: ReadonlyMap<string, string | Buffer>;
}

export type GovernanceAdmissionVerification =
  | Readonly<{ ok: true; attestation_digest: `sha256:${string}`; verified_at: string }>
  | Readonly<{ ok: false; code: "schema" | "binding" | "trust" | "signature" | "separation" | "expired"; reason: string }>;

/** Governance-authority operation. Flight must never receive this private key. */
export function issueGovernanceAdmissionAttestation(payload: GovernanceAdmissionPayload, privateKey: string | Buffer): GovernanceAdmissionAttestation {
  const schema = validatePayload(payload);
  if (!schema.ok) throw new Error(schema.reason);
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("governance admission signing key must be Ed25519");
  return Object.freeze({ payload: structuredClone(payload), signature: Object.freeze({ algorithm: "ed25519", value: sign(null, signingBytes(payload), key).toString("base64") }) });
}

/** Flight-side operation: strict schema, current trust state, bindings and signature. */
export function verifyGovernanceAdmissionAttestation(value: unknown, expected: GovernanceAdmissionExpectedBindings, trust: GovernanceAdmissionTrustState, verifiedAt: string): GovernanceAdmissionVerification {
  if (!isAttestation(value)) return refusal("schema", "governance admission attestation has an invalid closed schema");
  const schema = validatePayload(value.payload);
  if (!schema.ok) return schema;
  if (!validTimestamp(verifiedAt)) return refusal("schema", "verification time is invalid");
  const payload = value.payload;
  for (const key of BINDING_KEYS) if (payload[key] !== expected[key]) return refusal("binding", `governance admission ${key} does not match the repository run`);
  if (payload.trust_root_ref !== trust.trust_root_ref || payload.revocation_epoch !== trust.revocation_epoch) return refusal("trust", "governance admission trust state is stale or mismatched");
  if (payload.separation_policy_version !== trust.separation_policy_version || payload.separation_policy_digest !== trust.separation_policy_digest) return refusal("separation", "governance admission separation policy is stale or mismatched");
  if (trust.revoked_key_ids.has(payload.key_id)) return refusal("trust", "governance admission key is revoked");
  if (payload.proposer_identity === payload.acceptor_identity || payload.proposer_identity === payload.issuer_identity || payload.acceptor_identity === payload.issuer_identity) return refusal("separation", "proposer, acceptor and issuer must be distinct principals");
  const issued = Date.parse(payload.issued_at), expires = Date.parse(payload.expires_at), observed = Date.parse(verifiedAt);
  if (issued > observed || expires <= observed || expires <= issued) return refusal("expired", "governance admission warrant is not currently valid");
  const publicMaterial = trust.public_keys.get(payload.key_id);
  if (publicMaterial === undefined) return refusal("trust", "governance admission key is not trusted");
  let publicKey: ReturnType<typeof createPublicKey>;
  try { publicKey = createPublicKey(publicMaterial); } catch { return refusal("trust", "governance admission trust root contains an invalid public key"); }
  if (publicKey.asymmetricKeyType !== "ed25519") return refusal("trust", "governance admission public key must be Ed25519");
  const signature = Buffer.from(value.signature.value, "base64");
  if (signature.byteLength !== 64 || !verify(null, signingBytes(payload), publicKey, signature)) return refusal("signature", "governance admission signature verification failed");
  return Object.freeze({ ok: true, attestation_digest: digest(value), verified_at: verifiedAt });
}

export function governanceAdmissionAttestationDigest(value: GovernanceAdmissionAttestation): `sha256:${string}` { return digest(value); }

const BINDING_KEYS = ["repository_id", "repo_run_id", "work_class", "admission_base_oid", "input_digest", "scope_digest", "workspace_lineage_digest", "profile_version", "policy_version"] as const;
const PAYLOAD_KEYS = ["schema_version", "canonical_payload_version", "attestation_id", ...BINDING_KEYS, "proposer_identity", "issuer_identity", "acceptor_identity", "issued_at", "expires_at", "key_id", "trust_root_ref", "separation_policy_version", "separation_policy_digest", "revocation_epoch", "facts"] as const;
const FACT_KEYS = ["kind", "adr_id", "adr_content_id", "adr_status", "acceptance_commit_oid", "interview_receipt_digest", "acceptance_receipt_digest", "active_deferral"] as const;

function validatePayload(value: GovernanceAdmissionPayload): GovernanceAdmissionVerification {
  if (!plainExact(value, PAYLOAD_KEYS) || value.schema_version !== 1 || value.canonical_payload_version !== "revoy.governance-admission.v1") return refusal("schema", "governance admission payload has an invalid closed schema");
  if (!identifier(value.attestation_id) || !repoId(value.repository_id) || !identifier(value.repo_run_id) || !GOVERNANCE_ADMISSION_WORK_CLASSES.includes(value.work_class) || !oid(value.admission_base_oid)) return refusal("schema", "governance admission identity binding is invalid");
  if (![value.input_digest, value.scope_digest, value.workspace_lineage_digest, value.separation_policy_digest].every(digestValue)) return refusal("schema", "governance admission digest binding is invalid");
  if (![value.proposer_identity, value.issuer_identity, value.acceptor_identity, value.profile_version, value.policy_version, value.key_id, value.trust_root_ref, value.separation_policy_version].every(identifier)) return refusal("schema", "governance admission authority binding is invalid");
  if (!validTimestamp(value.issued_at) || !validTimestamp(value.expires_at) || !Number.isSafeInteger(value.revocation_epoch) || value.revocation_epoch < 0 || !validFacts(value.facts, value.work_class)) return refusal("schema", "governance admission facts or validity binding is invalid");
  return Object.freeze({ ok: true, attestation_digest: digest({ payload: value }), verified_at: value.issued_at });
}

function validFacts(value: unknown, workClass: GovernanceAdmissionWorkClass): value is GovernanceAdmissionFacts {
  if (!plainExact(value, FACT_KEYS) || value.kind !== workClass) return false;
  if (workClass === "exploratory") return value.adr_id === null && value.adr_content_id === null && value.adr_status === "not_applicable" && value.acceptance_commit_oid === null && value.interview_receipt_digest === null && value.acceptance_receipt_digest === null && value.active_deferral === "not_applicable";
  return typeof value.adr_id === "string" && /^ADR-[1-9][0-9]*$/.test(value.adr_id) && identifier(value.adr_content_id) && value.adr_status === "Accepted" && oid(value.acceptance_commit_oid) && digestValue(value.interview_receipt_digest) && digestValue(value.acceptance_receipt_digest) && value.active_deferral === false;
}

function isAttestation(value: unknown): value is GovernanceAdmissionAttestation { return plainExact(value, ["payload", "signature"]) && typeof value.payload === "object" && plainExact(value.signature, ["algorithm", "value"]) && value.signature.algorithm === "ed25519" && typeof value.signature.value === "string" && value.signature.value.length <= 256; }
function signingBytes(payload: GovernanceAdmissionPayload): Buffer { return Buffer.from(canonicalizeForHash(payload), "utf8"); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`; }
function refusal(code: Extract<GovernanceAdmissionVerification, { ok: false }>["code"], reason: string): GovernanceAdmissionVerification { return Object.freeze({ ok: false, code, reason }); }
function plainExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value); }
function repoId(value: unknown): value is `repo:v1:${string}` { return typeof value === "string" && /^repo:v1:[a-f0-9]{64}$/.test(value); }
function oid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function digestValue(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)); }
