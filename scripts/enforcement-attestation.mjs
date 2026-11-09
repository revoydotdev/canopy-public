#!/usr/bin/env node
/** Revision-bound CI attestation format and verification boundary. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, createExecutionManifest, loadExecutionProfile, resolveCandidateIdentity, sha256 } from "./enforcement-control-plane.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ATTESTATION_SCHEMA_VERSION = 1;
export const ATTESTATION_ISSUER = "github_actions";
export const GITHUB_ACTIONS_RECEIPT_SCHEMA_VERSION = 2;
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;

export function requiredCiGateNames(registry) {
  return Object.entries(registry.gates).filter(([, entry]) => entry.required && entry.contexts.ci).map(([name]) => name).sort();
}

export function makeAggregateAttestation({ report, registry, repository, workflowRef, runId, runAttempt, issuer = ATTESTATION_ISSUER, emittedAt = new Date().toISOString() }) {
  if (!report?.candidate_oid || !report?.input_digest || !Array.isArray(report.gates)) throw new Error("aggregate report lacks revision-bound gate results");
  const gates = report.gates.map((result) => ({
    gate: result.gate,
    status: result.status,
    candidate_oid: result.candidate_oid,
    input_digest: result.input_digest,
    profile_version: result.profile_version,
    duration_ms: result.duration_ms,
    prerequisite_failures: result.prerequisite_failures ?? [],
  }));
  // A failed/cancelled aggregate must still say which required checks never
  // ran. Omission is ambiguous; `not_run` is an actionable attestation state.
  const present = new Set(gates.map((gate) => gate.gate));
  for (const gate of requiredCiGateNames(registry)) {
    if (!present.has(gate)) gates.push({ gate, status: "not_run", candidate_oid: report.candidate_oid, input_digest: report.input_digest, profile_version: registry.profile_version, duration_ms: 0, prerequisite_failures: [] });
  }
  gates.sort((a, b) => a.gate.localeCompare(b.gate));
  const executionManifest = createExecutionManifest({
    candidate_oid: report.candidate_oid,
    input_digest: report.input_digest,
    profile_version: registry.profile_version,
    profile_fingerprint: report.profile_fingerprint ?? null,
    context: "ci",
    status: report.status,
    gates,
  });
  return Object.freeze({
    schema_version: ATTESTATION_SCHEMA_VERSION,
    kind: "revoy2.aggregate_gate_attestation",
    issuer: Object.freeze({ kind: issuer, repository, workflow_ref: workflowRef, run_id: runId, run_attempt: runAttempt ?? null }),
    candidate: Object.freeze({ oid: report.candidate_oid, input_digest: report.input_digest }),
    execution_profile: Object.freeze({ version: registry.profile_version, digest: sha256(canonicalJson(registry.gates)) }),
    execution_manifest: Object.freeze({ schema_version: executionManifest.schema_version, digest: executionManifest.digest, profile_fingerprint: executionManifest.profile_fingerprint }),
    gates: Object.freeze(gates),
    required_gates: Object.freeze(requiredCiGateNames(registry)),
    aggregate_status: report.status,
    emitted_at: emittedAt,
    // An artifact is CI-produced but does not authenticate itself. The verifier
    // below requires a separate platform API receipt before calling it central.
    authority_state: "ci_produced_pending_platform_authentication",
  });
}

export function attestationDigest(attestation) { return sha256(canonicalJson(attestation)); }
function workflowBinding(repository, workflowRef) {
  const prefix = `${repository}/`;
  if (typeof workflowRef !== "string" || !workflowRef.startsWith(prefix)) return null;
  const suffix = workflowRef.slice(prefix.length);
  const separator = suffix.lastIndexOf("@");
  if (separator <= 0) return null;
  return Object.freeze({ workflow_ref: workflowRef, workflow_path: suffix.slice(0, separator), workflow_revision: suffix.slice(separator + 1) });
}
function artifactName(attestation) { return `revoy2-aggregate-enforcement-attestation-${attestation.candidate?.oid ?? "unknown"}`; }
function githubJson(args) {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "gh api failed").trim());
  return JSON.parse(result.stdout);
}
function downloadedArtifactAttestation(repository, artifactId) {
  const endpoint = `/repos/${repository}/actions/artifacts/${artifactId}/zip`;
  const result = spawnSync("gh", ["api", endpoint], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr?.toString() || result.stdout?.toString() || "artifact download failed").trim());
  const directory = mkdtempSync(join(tmpdir(), "revoy2-attestation-artifact-"));
  const archive = join(directory, "artifact.zip");
  try {
    writeFileSync(archive, result.stdout);
    const listed = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    if (listed.status !== 0) throw new Error((listed.stderr || listed.stdout || "could not inspect downloaded artifact").trim());
    const name = listed.stdout.split(/\r?\n/).find((entry) => entry.endsWith("aggregate-attestation.json"));
    if (!name) throw new Error("downloaded GitHub artifact lacks aggregate-attestation.json");
    const extracted = spawnSync("unzip", ["-p", archive, name], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error((extracted.stderr || extracted.stdout || "could not extract aggregate attestation").trim());
    return JSON.parse(extracted.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Collects the run and downloaded artifact through authenticated GitHub API calls. */
export function collectGitHubActionsAttestationReceipt({ attestation, repository, gh = null, artifactFetcher = null, observedAt = new Date().toISOString() }) {
  if (!attestation?.issuer?.run_id || !attestation?.issuer?.workflow_ref) throw new Error("attestation issuer lacks a GitHub Actions run identity");
  const workflow = workflowBinding(repository, attestation.issuer.workflow_ref);
  if (!workflow) throw new Error("attestation workflow_ref is not bound to the expected repository/path");
  const call = gh ?? githubJson;
  const principal = call(["user"]);
  const run = call([`/repos/${repository}/actions/runs/${attestation.issuer.run_id}`]);
  if (typeof run?.head_sha !== "string" || run.head_sha.length === 0) throw new Error("GitHub Actions run lacks head_sha for workflow-content binding");
  const workflowContent = call([`/repos/${repository}/contents/${workflow.workflow_path}?ref=${encodeURIComponent(run.head_sha)}`]);
  if (typeof workflowContent?.sha !== "string" || workflowContent.sha.length === 0) throw new Error("GitHub Actions workflow-content lookup lacks a blob SHA");
  const artifacts = call([`/repos/${repository}/actions/runs/${attestation.issuer.run_id}/artifacts?per_page=100`]);
  const expectedName = artifactName(attestation);
  const artifact = (artifacts.artifacts ?? []).find((entry) => entry?.name === expectedName);
  if (!artifact) throw new Error(`GitHub Actions run lacks required artifact ${expectedName}`);
  const remoteAttestation = artifactFetcher
    ? artifactFetcher({ repository, artifact_id: artifact.id, artifact_name: artifact.name })
    : gh
      ? call([`/repos/${repository}/actions/artifacts/${artifact.id}/zip`])?.attestation
      : downloadedArtifactAttestation(repository, artifact.id);
  if (!remoteAttestation || typeof remoteAttestation !== "object") throw new Error("GitHub Actions artifact could not yield aggregate-attestation.json");
  return Object.freeze({
    schema_version: GITHUB_ACTIONS_RECEIPT_SCHEMA_VERSION,
    kind: "revoy2.github_actions_attestation_receipt",
    source: "github_api",
    authenticated: true,
    principal: Object.freeze({ login: principal?.login ?? null, id: principal?.id ?? null, type: principal?.type ?? null }),
    repository,
    observed_at: observedAt,
    workflow: Object.freeze({ ...workflow, content_ref: run.head_sha, content_blob_sha: workflowContent.sha }),
    run: Object.freeze({ id: run?.id ?? null, attempt: run?.run_attempt ?? null, head_sha: run?.head_sha ?? null, conclusion: run?.conclusion ?? null, workflow_path: run?.path ?? null }),
    artifact: Object.freeze({ id: artifact.id ?? null, name: artifact.name ?? null, digest: typeof artifact.digest === "string" ? artifact.digest : null, remote_attestation_digest: attestationDigest(remoteAttestation) }),
    attestation_digest: attestationDigest(remoteAttestation),
  });
}
export function validateGitHubActionsAttestationReceipt({ receipt, attestation, expectedCandidate, expectedRepository, now = Date.now(), maxAgeMs = MAX_RECEIPT_AGE_MS }) {
  const failures = [];
  if (!receipt) return Object.freeze({ ok: false, failures: ["platform_authentication_absent"] });
  if (receipt.schema_version !== GITHUB_ACTIONS_RECEIPT_SCHEMA_VERSION || receipt.kind !== "revoy2.github_actions_attestation_receipt") failures.push("platform_receipt_schema_invalid");
  if (receipt.source !== "github_api" || receipt.authenticated !== true) failures.push("platform_receipt_untrusted");
  if (typeof receipt.principal?.login !== "string" || !["string", "number"].includes(typeof receipt.principal?.id) || typeof receipt.principal?.type !== "string") failures.push("platform_receipt_principal_invalid");
  if (receipt.repository !== expectedRepository || receipt.repository !== attestation?.issuer?.repository) failures.push("platform_receipt_repository_mismatch");
  const observedAt = Date.parse(receipt.observed_at ?? "");
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) failures.push("platform_receipt_stale");
  const expectedWorkflow = workflowBinding(expectedRepository, attestation?.issuer?.workflow_ref);
  if (!expectedWorkflow || receipt.workflow?.workflow_ref !== expectedWorkflow.workflow_ref || receipt.workflow?.workflow_path !== expectedWorkflow.workflow_path || receipt.workflow?.workflow_revision !== expectedWorkflow.workflow_revision) failures.push("platform_receipt_workflow_mismatch");
  if (!expectedWorkflow || receipt.run?.workflow_path !== expectedWorkflow.workflow_path) failures.push("platform_receipt_workflow_run_path_mismatch");
  if (receipt.workflow?.content_ref !== receipt.run?.head_sha || receipt.workflow?.content_ref !== expectedCandidate.candidate_oid) failures.push("platform_receipt_workflow_content_ref_mismatch");
  if (typeof receipt.workflow?.content_blob_sha !== "string" || receipt.workflow.content_blob_sha.length === 0) failures.push("platform_receipt_workflow_blob_missing");
  if (String(receipt.run?.id) !== String(attestation?.issuer?.run_id) || String(receipt.run?.attempt) !== String(attestation?.issuer?.run_attempt)) failures.push("platform_receipt_run_mismatch");
  if (receipt.run?.head_sha !== expectedCandidate.candidate_oid || receipt.run?.head_sha !== attestation?.candidate?.oid) failures.push("platform_receipt_sha_mismatch");
  if (receipt.run?.conclusion !== "success") failures.push(`platform_receipt_conclusion:${receipt.run?.conclusion ?? "unknown"}`);
  if (!receipt.artifact || !["string", "number"].includes(typeof receipt.artifact.id) || receipt.artifact.name !== artifactName(attestation) || !Object.hasOwn(receipt.artifact, "digest")) failures.push("platform_receipt_artifact_mismatch");
  const expectedDigest = attestationDigest(attestation);
  if (receipt.attestation_digest !== expectedDigest || receipt.artifact?.remote_attestation_digest !== expectedDigest) failures.push("platform_receipt_digest_mismatch");
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

/**
 * Pure verifier. `fixturePlatformReceipt` is deliberately an in-memory test
 * seam; the production CLI below never accepts receipt files as authority.
 */
export function verifyCentralAttestation({ attestation, registry, expectedCandidate, expectedRepository, fixturePlatformReceipt = null }) {
  const failures = [];
  if (!attestation) return Object.freeze({ ok: false, code: "attestation_absent", failures: ["no aggregate attestation was supplied"] });
  if (attestation.schema_version !== ATTESTATION_SCHEMA_VERSION || attestation.kind !== "revoy2.aggregate_gate_attestation") failures.push("invalid_schema");
  if (attestation.issuer?.kind !== ATTESTATION_ISSUER) failures.push("issuer_untrusted");
  if (attestation.candidate?.oid !== expectedCandidate.candidate_oid) failures.push("candidate_sha_mismatch");
  if (attestation.candidate?.input_digest !== expectedCandidate.input_digest) failures.push("input_digest_mismatch");
  if (attestation.execution_profile?.version !== registry.profile_version || attestation.execution_profile?.digest !== sha256(canonicalJson(registry.gates))) failures.push("profile_mismatch");
  if (expectedRepository && attestation.issuer?.repository !== expectedRepository) failures.push("repository_mismatch");
  const byGate = new Map((attestation.gates ?? []).map((gate) => [gate.gate, gate]));
  for (const gate of requiredCiGateNames(registry)) {
    const record = byGate.get(gate);
    if (!record) { failures.push(`required_gate_missing:${gate}`); continue; }
    if (record.status === "runner_unavailable") failures.push(`runner_unavailable:${gate}`);
    else if (record.status === "not_run") failures.push(`not_run:${gate}`);
    else if (record.status !== "passed" && record.status !== "cached") failures.push(`gate_not_passed:${gate}:${record.status}`);
    if (record.candidate_oid !== expectedCandidate.candidate_oid) failures.push(`gate_sha_mismatch:${gate}`);
    if (record.input_digest !== expectedCandidate.input_digest) failures.push(`gate_digest_mismatch:${gate}`);
    if (record.profile_version !== registry.profile_version) failures.push(`gate_profile_mismatch:${gate}`);
  }
  const reconstructedManifest = createExecutionManifest({
    candidate_oid: attestation.candidate?.oid,
    input_digest: attestation.candidate?.input_digest,
    profile_version: attestation.execution_profile?.version,
    profile_fingerprint: attestation.execution_manifest?.profile_fingerprint ?? null,
    context: "ci",
    status: attestation.aggregate_status,
    gates: attestation.gates ?? [],
  });
  if (attestation.execution_manifest?.schema_version !== 1 || attestation.execution_manifest?.digest !== reconstructedManifest.digest) failures.push("execution_manifest_mismatch");
  failures.push(...validateGitHubActionsAttestationReceipt({ receipt: fixturePlatformReceipt, attestation, expectedCandidate, expectedRepository }).failures);
  return Object.freeze({ ok: failures.length === 0, code: failures.length === 0 ? "verified_central_attestation" : failures[0], failures: Object.freeze(failures) });
}

/** Truthful readiness check: protected refs/rulesets are the only BLOCKED mechanism. */
export function validateGitHubProtectionReceipt({ receipt, repository, requiredCheck = "revoy2 / aggregate enforcement attestation", now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 }) {
  const failures = [];
  if (!receipt) return Object.freeze({ ok: false, failures: ["platform_protection_receipt_absent"] });
  if (receipt.schema_version !== 1 || receipt.kind !== "revoy2.github_protection_receipt") failures.push("platform_protection_receipt_schema_invalid");
  if (receipt.source !== "github_api" || receipt.authenticated !== true) failures.push("platform_protection_receipt_untrusted");
  if (typeof receipt.principal?.login !== "string" || receipt.principal.login.length === 0) failures.push("platform_protection_principal_missing");
  if (receipt.repository !== repository) failures.push("platform_protection_repository_mismatch");
  const observedAt = Date.parse(receipt.observed_at ?? "");
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) failures.push("platform_protection_receipt_stale");
  if (typeof receipt.visibility !== "string" || typeof receipt.plan !== "string") failures.push("platform_protection_metadata_invalid");
  if (typeof receipt.branch_protection?.enabled !== "boolean" || !Array.isArray(receipt.branch_protection.required_checks)) failures.push("platform_protection_contract_invalid");
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures), required_check: requiredCheck });
}
export function collectGitHubProtectionReceipt({ repository, gh = null, observedAt = new Date().toISOString() }) {
  const call = gh ?? ((path) => {
    const result = spawnSync("gh", ["api", path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "gh api failed").trim());
    return JSON.parse(result.stdout);
  });
  const principal = call("user");
  const repo = call(`/repos/${repository}`);
  let protection = null;
  try { protection = call(`/repos/${repository}/branches/${repo.default_branch}/protection`); } catch { protection = null; }
  const requiredChecks = protection?.required_status_checks?.contexts ?? protection?.required_status_checks?.checks?.map((check) => check.context) ?? [];
  // The repository payload's embedded organization is not a plan authority.
  // Until a separately authenticated organization-plan endpoint is modeled,
  // report unknown rather than promoting an incidental or omitted field.
  return Object.freeze({ schema_version: 1, kind: "revoy2.github_protection_receipt", source: "github_api", authenticated: true, principal: Object.freeze({ login: principal.login, id: principal.id ?? null }), repository, observed_at: observedAt, visibility: repo.private ? "private" : "public", plan: "unknown", branch_protection: Object.freeze({ enabled: protection !== null, required_checks: requiredChecks }), default_branch: repo.default_branch });
}
export function serverEnforcementReadiness({ repository, protectionReceipt = null, requiredCheck = "revoy2 / aggregate enforcement attestation", now = Date.now() }) {
  const failures = [];
  const receiptAudit = validateGitHubProtectionReceipt({ receipt: protectionReceipt, repository, requiredCheck, now });
  if (!receiptAudit.ok) failures.push("platform_protection_unverifiable", ...receiptAudit.failures);
  const visibility = receiptAudit.ok ? protectionReceipt.visibility : null;
  const plan = receiptAudit.ok ? protectionReceipt.plan : null;
  const branchProtection = receiptAudit.ok ? protectionReceipt.branch_protection : null;
  if (visibility === "private" && plan === "free") failures.push("private_free_plan_cannot_enable_required_branch_protection");
  if (branchProtection?.enabled !== true) failures.push("protected_ref_not_enabled");
  if (!branchProtection?.required_checks?.includes(requiredCheck)) failures.push("aggregate_attestation_check_not_required");
  return Object.freeze({
    ok: failures.length === 0,
    tier: failures.length === 0 ? "BLOCKED" : "DETECTED",
    repository,
    required_check: requiredCheck,
    failures,
    remediation: failures.length === 0
      ? "Protected refs require the trusted aggregate check; local --no-verify cannot satisfy this server-side rule."
      : "Do not treat hooks or artifact files as BLOCKED. Move this private repository to a plan/organization with protected-ref rulesets, require the trusted aggregate CI check on the target ref, and retain CI-origin verification through platform API receipts.",
  });
}

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function main() {
  const command = process.argv[2];
  const repo = resolve(value("--repo") ?? REPO_ROOT);
  const registry = loadExecutionProfile(value("--registry") ?? undefined);
  if (command === "emit") {
    if (process.env.GITHUB_ACTIONS !== "true") throw new Error("refusing to emit a CI attestation outside GitHub Actions; a local artifact must not claim central authority");
    const report = readJson(value("--report"));
    const out = resolve(value("--out") ?? join(repo, ".arbor", "enforcement", "aggregate-attestation.json"));
    const attestation = makeAggregateAttestation({ report, registry, repository: process.env.GITHUB_REPOSITORY, workflowRef: process.env.GITHUB_WORKFLOW_REF ?? `${process.env.GITHUB_REPOSITORY}/.github/workflows/ci.yml@${process.env.GITHUB_SHA}`, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, out, digest: attestationDigest(attestation) }, null, 2));
    return 0;
  }
  if (command === "verify") {
    if (value("--receipt")) throw new Error("--receipt is not a production authority input; use --github-api with GH_TOKEN so the run and artifact are collected from GitHub");
    if (!process.argv.includes("--github-api")) throw new Error("verify requires --github-api; local receipt files cannot establish central authority");
    if (!process.env.GH_TOKEN) throw new Error("verify --github-api requires GH_TOKEN with Actions read access");
    const attestationPath = value("--attestation");
    const attestation = attestationPath && existsSync(attestationPath) ? readJson(attestationPath) : null;
    const repository = value("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("verify --github-api requires --repository (or GITHUB_REPOSITORY) to bind the GitHub API endpoint");
    const expectedCandidate = resolveCandidateIdentity(repo, value("--candidate") ?? "HEAD");
    const receipt = attestation ? collectGitHubActionsAttestationReceipt({ attestation, repository }) : null;
    const result = verifyCentralAttestation({ attestation, registry, expectedCandidate, expectedRepository: repository, fixturePlatformReceipt: receipt });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command === "doctor") {
    const repository = value("--repository") ?? process.env.GITHUB_REPOSITORY ?? "unconfigured";
    const receiptPath = value("--platform-receipt");
    const receipt = receiptPath ? readJson(receiptPath) : process.argv.includes("--github-api") ? collectGitHubProtectionReceipt({ repository }) : null;
    const result = serverEnforcementReadiness({ repository, protectionReceipt: receipt });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }
  throw new Error("usage: enforcement-attestation.mjs <emit|verify|doctor> [...]");
}
if (import.meta.main) {
  try { process.exitCode = main(); } catch (error) { console.error(`enforcement attestation: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
