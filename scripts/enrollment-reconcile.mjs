#!/usr/bin/env node
/** Authenticated GitHub enrollment reconciliation with hermetic receipt support. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, loadExecutionProfile, resolveCandidateIdentity, sha256 } from "./enforcement-control-plane.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INVENTORY_SCHEMA_VERSION = 1;
export const ENROLLMENT_SCHEMA_VERSION = 1;
export const PROVIDER_RECEIPT_SCHEMA_VERSION = 3;
export const COVERAGE_MODES = Object.freeze(["allowlist", "all_non_archived", "all_non_archived_with_workflows"]);
const DEFAULT_MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;
const digest = (value) => sha256(canonicalJson(value));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sortedUnique = (values) => [...new Set(values)].sort();
const sameValues = (left, right) => canonicalJson(sortedUnique(left)) === canonicalJson(sortedUnique(right));

export function configuredGitHubRepository(repo = REPO_ROOT) {
  const remote = spawnSync("git", ["-C", repo, "remote", "get-url", "--push", "origin"], { encoding: "utf8" });
  const raw = remote.status === 0 ? remote.stdout.trim() : "";
  const match = raw.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, "") : null;
}

function scopeKind(inventory) { return inventory?.scope?.kind ?? "allowlist"; }
function expectedRepositories(inventory) { return sortedUnique((inventory?.repositories ?? []).map((entry) => entry?.repository).filter((value) => typeof value === "string")); }
function activeRepositories(receipt) { return sortedUnique((receipt?.repositories ?? []).filter((entry) => entry && entry.archived === false).map((entry) => entry.repository)); }
function receiptPayload(receipt) {
  if (!receipt || typeof receipt !== "object") return receipt;
  const { receipt_digest: _receiptDigest, ...payload } = receipt;
  return payload;
}

/** A canonical digest detects field substitution; it is not GitHub authentication. */
export function githubEnrollmentReceiptDigest(receipt) { return digest(receiptPayload(receipt)); }

function coverageFailures(receipt, inventory) {
  const failures = [];
  const scope = scopeKind(inventory);
  const coverage = receipt?.coverage;
  if (!coverage || typeof coverage !== "object") return ["provider_coverage_missing"];
  if (coverage.mode !== scope || !COVERAGE_MODES.includes(coverage.mode)) failures.push("provider_coverage_mode_mismatch");
  if (typeof coverage.organization_enumeration_complete !== "boolean") failures.push("provider_enumeration_completeness_missing");
  if (typeof coverage.authority !== "string" || coverage.authority.length === 0) failures.push("provider_coverage_authority_missing");
  if (coverage.workflow_queries_complete !== true) failures.push("provider_workflow_queries_incomplete");
  const expected = expectedRepositories(inventory);
  const observedActive = activeRepositories(receipt);
  if (scope === "allowlist") {
    if (coverage.organization_enumeration_complete !== false) failures.push("provider_allowlist_must_not_claim_organization_enumeration");
    if (coverage.authority !== "direct_governed_repository_queries") failures.push("provider_allowlist_authority_invalid");
    if (!sameValues(coverage.directly_queried_repositories ?? [], expected)) failures.push("provider_allowlist_direct_query_set_mismatch");
    if (!sameValues((receipt?.repositories ?? []).map((entry) => entry?.repository), expected)) failures.push("provider_allowlist_repository_set_mismatch");
  } else {
    if (coverage.organization_enumeration_complete !== true) failures.push("provider_organization_enumeration_incomplete");
    if (coverage.authority !== "organization_owner_membership") failures.push("provider_organization_enumeration_authority_invalid");
    if (coverage.membership?.state !== "active" || coverage.membership?.role !== "admin") failures.push("provider_organization_membership_insufficient");
    if (!sameValues(coverage.observed_active_repositories ?? [], observedActive)) failures.push("provider_active_repository_set_mismatch");
  }
  return failures;
}

function receiptFailures({ receipt, inventory, manifests, candidate, profileVersion, now = Date.now(), maxAgeMs = DEFAULT_MAX_RECEIPT_AGE_MS }) {
  const failures = [];
  if (!receipt) return ["provider_receipt_absent"];
  if (receipt.schema_version !== PROVIDER_RECEIPT_SCHEMA_VERSION || receipt.kind !== "revoy2.github_enrollment_receipt") failures.push("provider_receipt_schema_invalid");
  if (receipt.source !== "github_api" || receipt.authenticated !== true) failures.push("provider_receipt_untrusted");
  const accessProof = receipt.repository_access_proof;
  if (accessProof?.kind !== "github_api_private_repository_contents") failures.push("provider_repository_access_proof_missing");
  if (accessProof?.repository !== inventory?.canonical_repository || accessProof?.private !== true || typeof accessProof?.default_branch !== "string" || !Array.isArray(accessProof?.workflow_paths)) failures.push("provider_repository_access_proof_invalid");
  if (receipt.organization !== inventory?.organization) failures.push("provider_wrong_organization");
  const observedAt = Date.parse(receipt.observed_at ?? "");
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) failures.push("provider_receipt_stale");
  if (receipt.inventory_digest !== digest(inventory)) failures.push("provider_inventory_digest_mismatch");
  if (receipt.manifests_digest !== digest(manifests)) failures.push("provider_manifests_digest_mismatch");
  if (receipt.candidate?.oid !== candidate.candidate_oid || receipt.candidate?.input_digest !== candidate.input_digest) failures.push("provider_candidate_identity_mismatch");
  if (receipt.profile_version !== profileVersion) failures.push("provider_profile_mismatch");
  if (!Array.isArray(receipt.repositories)) failures.push("provider_repository_set_invalid");
  const seen = new Set();
  for (const observed of receipt.repositories ?? []) {
    if (!observed || typeof observed.repository !== "string" || !observed.repository.startsWith(`${inventory?.organization}/`)) { failures.push("provider_repository_identity_invalid"); continue; }
    if (seen.has(observed.repository)) failures.push(`provider_repository_duplicate:${observed.repository}`);
    seen.add(observed.repository);
    if (typeof observed.archived !== "boolean") failures.push(`provider_archive_state_invalid:${observed.repository}`);
    if (typeof observed.private !== "boolean") failures.push(`provider_private_state_invalid:${observed.repository}`);
    if (!observed.archived && typeof observed.default_branch !== "string") failures.push(`provider_default_branch_missing:${observed.repository}`);
    if (!Array.isArray(observed.workflow_paths)) failures.push(`provider_workflow_contract_missing:${observed.repository}`);
  }
  const canonical = (receipt.repositories ?? []).find((entry) => entry?.repository === inventory?.canonical_repository);
  if (!canonical || canonical.private !== true || canonical.default_branch !== accessProof?.default_branch || !sameValues(canonical.workflow_paths ?? [], accessProof?.workflow_paths ?? [])) failures.push("provider_repository_access_proof_mismatch");
  failures.push(...coverageFailures(receipt, inventory));
  if (receipt.receipt_digest !== githubEnrollmentReceiptDigest(receipt)) failures.push("provider_receipt_digest_mismatch");
  return failures;
}

export function validateGitHubEnrollmentReceipt(input) {
  const failures = receiptFailures(input);
  return Object.freeze({ ok: failures.length === 0, status: failures.length === 0 ? "verified" : "unverifiable", failures: Object.freeze(failures) });
}

function observedRepository(entry) {
  return { repository: entry?.full_name ?? null, archived: entry?.archived === true, private: entry?.private === true, default_branch: entry?.default_branch ?? null, workflow_paths: [] };
}

function workflowPaths(call, repository, defaultBranch) {
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) throw new Error(`repository ${repository} lacks a default branch for workflow-content verification`);
  // Repository-scoped GITHUB_TOKEN credentials can read the checked-out
  // repository's contents but cannot necessarily call the Actions workflow
  // administration endpoint. The contents listing is the least-privilege
  // proof of the workflow/default-branch contract.
  try {
    const entries = call([`/repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`]);
    return Array.isArray(entries) ? entries.map((entry) => entry?.path).filter((value) => typeof value === "string").sort() : [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A real missing directory is evidence of no workflow. Authorization and
    // transport failures remain hard errors and cannot downgrade to green.
    if (/HTTP 404\b|\bNot Found\b/i.test(detail)) return [];
    throw new Error(`GitHub Contents API workflow verification failed for ${repository}@${defaultBranch}: ${detail}`);
  }
}

function organizationEnumerationAuthority(call, organization) {
  try {
    const membership = call([`/user/memberships/orgs/${organization}`]);
    const complete = membership?.state === "active" && membership?.role === "admin";
    return Object.freeze({ complete, authority: complete ? "organization_owner_membership" : "organization_enumeration_unverified", membership: Object.freeze({ state: membership?.state ?? "unknown", role: membership?.role ?? "unknown" }) });
  } catch {
    return Object.freeze({ complete: false, authority: "organization_enumeration_unverified", membership: Object.freeze({ state: "unavailable", role: "unavailable" }) });
  }
}

function completeReceipt(payload) {
  return Object.freeze({ ...payload, receipt_digest: githubEnrollmentReceiptDigest(payload) });
}

/** Creates a receipt from authenticated GitHub API responses; no repository count is hard-coded. */
export function collectGitHubEnrollmentReceipt({ inventory, manifests, candidate, profileVersion, gh = null, observedAt = new Date().toISOString() }) {
  const call = gh ?? ((args) => {
    const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`GitHub API ${args.join(" ")} failed: ${(result.stderr || result.stdout || "gh api failed").trim()}`);
    return JSON.parse(result.stdout);
  });
  const scope = scopeKind(inventory);
  // GITHUB_TOKEN is an installation token and GitHub rejects GET /user for
  // it. A successful private-repository response plus a Contents response is
  // the compatible least-privilege authentication proof. Do not substitute
  // ambient actor variables: they identify an event, not this credential.
  const directRepositories = new Map();
  const directRepository = (repository) => {
    const existing = directRepositories.get(repository);
    if (existing) return existing;
    const observed = observedRepository(call([`/repos/${repository}`]));
    directRepositories.set(repository, observed);
    return observed;
  };
  const canonicalRepository = directRepository(inventory.canonical_repository);
  canonicalRepository.workflow_paths = workflowPaths(call, canonicalRepository.repository, canonicalRepository.default_branch);
  let repositories;
  let coverage;
  if (scope === "allowlist") {
    const queried = expectedRepositories(inventory);
    repositories = queried.map(directRepository);
    for (const observed of repositories.filter((entry) => !entry.archived)) observed.workflow_paths = workflowPaths(call, observed.repository, observed.default_branch);
    coverage = Object.freeze({ mode: scope, organization_enumeration_complete: false, authority: "direct_governed_repository_queries", directly_queried_repositories: Object.freeze(queried), observed_active_repositories: Object.freeze(activeRepositories({ repositories })), workflow_queries_complete: true });
  } else {
    const pages = call(["--paginate", "--slurp", `/orgs/${inventory.organization}/repos?per_page=100&type=all`]);
    repositories = (Array.isArray(pages) ? pages.flat() : []).map(observedRepository);
    for (const observed of repositories.filter((entry) => !entry.archived)) observed.workflow_paths = workflowPaths(call, observed.repository, observed.default_branch);
    const authority = organizationEnumerationAuthority(call, inventory.organization);
    coverage = Object.freeze({ mode: scope, organization_enumeration_complete: authority.complete, authority: authority.authority, membership: authority.membership, observed_active_repositories: Object.freeze(activeRepositories({ repositories })), workflow_queries_complete: true });
  }
  return completeReceipt({
    schema_version: PROVIDER_RECEIPT_SCHEMA_VERSION,
    kind: "revoy2.github_enrollment_receipt",
    source: "github_api",
    authenticated: true,
    repository_access_proof: Object.freeze({
      kind: "github_api_private_repository_contents",
      repository: canonicalRepository.repository,
      private: canonicalRepository.private,
      default_branch: canonicalRepository.default_branch,
      workflow_paths: Object.freeze([...canonicalRepository.workflow_paths]),
    }),
    organization: inventory.organization,
    observed_at: observedAt,
    inventory_digest: digest(inventory),
    manifests_digest: digest(manifests),
    candidate: Object.freeze({ oid: candidate.candidate_oid, input_digest: candidate.input_digest }),
    profile_version: profileVersion,
    coverage,
    repositories: Object.freeze(repositories.map((entry) => Object.freeze({ ...entry, workflow_paths: Object.freeze(entry.workflow_paths) }))),
  });
}

function enrollmentProblems(enrollment, expected, inventory, profileVersion) {
  const failures = [];
  if (!enrollment) return ["missing_enrollment"];
  if (enrollment.schema_version !== ENROLLMENT_SCHEMA_VERSION) failures.push("manifest_schema_invalid");
  if (enrollment.organization !== inventory.organization) failures.push("organization_mismatch");
  if (enrollment.profile_version !== (expected?.required_profile_version ?? profileVersion)) failures.push("profile_version_mismatch");
  if (typeof enrollment.ci_contract?.aggregate_check !== "string" || typeof enrollment.ci_contract?.workflow_path !== "string") failures.push("ci_contract_missing");
  if (enrollment.ci_contract?.attestation_kind !== "revoy2.aggregate_gate_attestation") failures.push("ci_contract_attestation_kind_invalid");
  if (typeof enrollment.attestation?.endpoint !== "string" || typeof enrollment.attestation?.status !== "string") failures.push("attestation_contract_missing");
  return failures;
}

export function reconcileEnrollment({ inventory, manifests, candidate, profileVersion, providerReceipt = null, provider = null, configuredRepository = null, now = Date.now() }) {
  const failures = [];
  if (inventory?.schema_version !== INVENTORY_SCHEMA_VERSION) failures.push({ code: "inventory_schema_invalid", detail: "inventory schema_version must be 1" });
  if (!["required", "bootstrap"].includes(inventory?.mode)) failures.push({ code: "inventory_mode_invalid", detail: "inventory mode must be required or bootstrap" });
  if (typeof inventory?.organization !== "string" || inventory.organization.length === 0) failures.push({ code: "inventory_organization_invalid", detail: "inventory must name its GitHub organization" });
  if (typeof inventory?.canonical_repository !== "string") failures.push({ code: "canonical_repository_missing", detail: "inventory must bind the local repository identity" });
  if (configuredRepository !== null && configuredRepository !== inventory?.canonical_repository) failures.push({ code: "configured_remote_mismatch", detail: `configured GitHub remote ${configuredRepository} does not match inventory canonical repository ${inventory?.canonical_repository}` });
  const scope = scopeKind(inventory);
  if (!COVERAGE_MODES.includes(scope)) failures.push({ code: "coverage_scope_invalid", detail: `scope.kind must be one of ${COVERAGE_MODES.join(", ")}` });
  const repositories = Array.isArray(inventory?.repositories) ? inventory.repositories : null;
  if (!repositories) failures.push({ code: "inventory_repositories_invalid", detail: "inventory repositories must be an array" });
  if (inventory?.mode === "required" && repositories?.length === 0) failures.push({ code: "required_inventory_empty", detail: "required enrollment cannot treat an empty repository inventory as proof" });
  const byRepository = new Map((Array.isArray(manifests?.entries) ? manifests.entries : []).filter((entry) => entry && typeof entry.repository === "string").map((entry) => [entry.repository, entry]));
  const evidence = [];
  for (const expected of repositories ?? []) {
    if (!expected || typeof expected.repository !== "string") { failures.push({ code: "inventory_repository_invalid", detail: "each inventory repository needs an identity" }); continue; }
    const enrollment = byRepository.get(expected.repository);
    const itemFailures = enrollmentProblems(enrollment, expected, inventory, profileVersion);
    evidence.push(Object.freeze({ repository: expected.repository, revision_binding: Object.freeze({ candidate_oid: candidate.candidate_oid, input_digest: candidate.input_digest }), required_profile_version: expected.required_profile_version ?? profileVersion, manifest_digest: enrollment ? digest(enrollment) : null, aggregate_check: enrollment?.ci_contract?.aggregate_check ?? null, workflow_path: enrollment?.ci_contract?.workflow_path ?? null, attestation_endpoint: enrollment?.attestation?.endpoint ?? null, attestation_status: enrollment?.attestation?.status ?? null, ok: itemFailures.length === 0, failures: itemFailures }));
    for (const code of itemFailures) failures.push({ code, repository: expected.repository, detail: `enrollment manifest failed ${code}` });
  }
  const receiptAudit = validateGitHubEnrollmentReceipt({ receipt: providerReceipt, inventory, manifests, candidate, profileVersion, now });
  const observed = new Map((providerReceipt?.repositories ?? []).filter((entry) => entry && typeof entry.repository === "string").map((entry) => [entry.repository, entry]));
  const active = [...observed.values()].filter((entry) => entry.archived === false);
  const staticRepositories = expectedRepositories(inventory);
  const coverageRepositories = receiptAudit.ok
    ? scope === "all_non_archived" ? active.map((entry) => entry.repository).sort()
      : scope === "all_non_archived_with_workflows" ? active.filter((entry) => entry.workflow_paths.length > 0).map((entry) => entry.repository).sort()
        : staticRepositories
    : staticRepositories;
  const coverageGaps = [];
  if (receiptAudit.ok) {
    for (const repository of coverageRepositories) {
      const actual = observed.get(repository);
      const enrollment = byRepository.get(repository);
      if (!actual || actual.archived) {
        failures.push({ code: "observed_governed_repo_missing", repository, detail: "authenticated provider receipt does not expose an active governed repository" });
        coverageGaps.push({ code: "observed_governed_repo_missing", repository });
        continue;
      }
      if (!enrollment) {
        if (!staticRepositories.includes(repository)) failures.push({ code: "unenrolled_observed_repository", repository, detail: "authoritatively observed repository is inside the declared coverage scope but lacks an enrollment manifest" });
        coverageGaps.push({ code: "unenrolled_observed_repository", repository });
        continue;
      }
      if (!actual.workflow_paths.includes(enrollment.ci_contract?.workflow_path)) {
        failures.push({ code: "observed_workflow_missing", repository, detail: `authenticated provider receipt lacks ${enrollment.ci_contract?.workflow_path ?? "the declared workflow"}` });
        coverageGaps.push({ code: "observed_workflow_missing", repository });
      }
    }
  }
  const outOfScope = receiptAudit.ok && scope === "allowlist" ? active.filter((entry) => !staticRepositories.includes(entry.repository)).map((entry) => entry.repository).sort() : [];
  const nonCiActiveRepositories = receiptAudit.ok && scope === "all_non_archived_with_workflows" ? active.filter((entry) => entry.workflow_paths.length === 0).map((entry) => entry.repository).sort() : [];
  const bootstrap = inventory?.mode === "bootstrap";
  const ok = failures.length === 0;
  const authoritative = ok && !bootstrap && receiptAudit.ok;
  // `ok` describes local manifest consistency. Only `gate_ok` passes a
  // required gate because it includes independent API authority.
  const gate_ok = inventory?.mode === "required" ? authoritative : ok;
  return Object.freeze({ ok, gate_ok, authoritative, mode: inventory?.mode ?? null, organization: inventory?.organization ?? null, candidate_oid: candidate.candidate_oid, input_digest: candidate.input_digest, profile_version: profileVersion, coverage_scope: scope, reconciliation: Object.freeze({ status: receiptAudit.status, receipt_failures: receiptAudit.failures, caller_provider_ignored: provider !== null, organization_enumeration_complete: receiptAudit.ok ? providerReceipt.coverage.organization_enumeration_complete : false, observed_repository_count: receiptAudit.ok ? observed.size : null, required_repositories: Object.freeze(coverageRepositories), coverage_gaps: Object.freeze(coverageGaps), out_of_scope_repositories: Object.freeze(outOfScope), non_ci_active_repositories: Object.freeze(nonCiActiveRepositories) }), evidence: Object.freeze(evidence), failures: Object.freeze(failures), bootstrap_notice: bootstrap ? "Bootstrap enrollment is explicitly non-authoritative." : null });
}

function value(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; }
function main() {
  const repo = resolve(value("--repo") ?? REPO_ROOT);
  const inventoryPath = resolve(value("--inventory") ?? join(repo, "governance", "enrollment", "inventory.json"));
  const manifestsPath = resolve(value("--manifests") ?? join(repo, "governance", "enrollment", "manifests.json"));
  if (!existsSync(inventoryPath) || !existsSync(manifestsPath)) throw new Error("enrollment inventory and manifests are required");
  const inventory = readJson(inventoryPath);
  const manifests = readJson(manifestsPath);
  const profile = loadExecutionProfile(value("--registry") ?? undefined);
  const candidate = resolveCandidateIdentity(repo, value("--candidate") ?? "HEAD");
  const receiptPath = value("--provider-receipt");
  const receipt = receiptPath ? readJson(resolve(receiptPath)) : process.argv.includes("--github-api") ? collectGitHubEnrollmentReceipt({ inventory, manifests, candidate, profileVersion: profile.profile_version }) : null;
  const result = reconcileEnrollment({ inventory, manifests, candidate, profileVersion: profile.profile_version, providerReceipt: receipt, provider: value("--provider-status") ? { caller_status: value("--provider-status") } : null, configuredRepository: configuredGitHubRepository(repo) });
  console.log(JSON.stringify(result, null, 2));
  return process.argv.includes("--report-only") ? (result.ok ? 0 : 1) : (result.gate_ok ? 0 : 1);
}
if (import.meta.main) { try { process.exitCode = main(); } catch (error) { console.error(`organization enrollment: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; } }
