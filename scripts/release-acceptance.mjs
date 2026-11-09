#!/usr/bin/env node
/**
 * Validate revision-bound 1.0.0 release acceptance evidence.
 * This is a checker only: evidence producers must write their own artifacts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { validateSelfhostAcceptanceArtifact } from "./selfhost-acceptance-contract.mjs";
import { verifyReviewAttestation } from "./selfhost-acceptance-review.mjs";

export const REQUIRED_DOMAINS = Object.freeze([
  "native_campaign",
  "mcp",
  "cli",
  "webui",
  "tui",
  "recovery",
  "adoption",
  "evidence",
  "selfhost",
  "external_cohort",
]);

const HEX_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEMBER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Languages that satisfy the roadmap's "one compiled-language repository" requirement. */
export const COMPILED_COHORT_LANGUAGES = Object.freeze(["rust", "go", "c", "cpp", "java", "kotlin", "csharp", "swift", "zig"]);
/** Language coverage the pinned 1.0.0 external cohort must have. */
export const REQUIRED_COHORT_LANGUAGES = Object.freeze(["javascript", "python"]);

function fail(message) {
  const error = new Error(message);
  error.name = "AcceptanceError";
  throw error;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(manifest) {
  if (!isRecord(manifest)) fail("manifest must be a JSON object");
  if (manifest.schema_version !== 1) fail("schema_version must be 1");
  if (manifest.release !== "1.0.0") fail('release must be "1.0.0"');
  if (typeof manifest.candidate_commit !== "string" || !HEX_COMMIT.test(manifest.candidate_commit)) {
    fail("candidate_commit must be a full 40-character lowercase Git commit hash");
  }
  if (!isRecord(manifest.domains)) fail("domains must be an object");
  const missing = REQUIRED_DOMAINS.filter((domain) => !Object.hasOwn(manifest.domains, domain));
  if (missing.length) fail(`required domain records are absent: ${missing.join(", ")}`);
  const unknown = Object.keys(manifest.domains).filter((domain) => !REQUIRED_DOMAINS.includes(domain));
  if (unknown.length) fail(`unknown domain records: ${unknown.join(", ")}`);
  return manifest;
}

function nonEmptyArgv(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function relativeInside(path) {
  return nonEmptyString(path) && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/**
 * Validate the pinned external-cohort specification (roadmap Phase 1, P1-1a):
 * every member names an exact upstream revision, its native acceptance argv,
 * its toolchain prerequisites, a task, and the injected requirement files
 * whose contents hash to their declared digests. Returns every error rather
 * than the first, so one pass shows the whole specification's defects.
 */
export function validateExternalCohortSpec(spec) {
  const errors = [];
  if (!isRecord(spec)) return { valid: false, errors: ["cohort spec must be a JSON object"] };
  if (spec.schema_version !== 1) errors.push("schema_version must be 1");
  if (spec.release !== "1.0.0") errors.push('release must be "1.0.0"');
  if (!nonEmptyString(spec.cohort)) errors.push("cohort must name the cohort");
  if (!nonEmptyString(spec.claim_boundary)) errors.push("claim_boundary must state what the cohort does not prove");
  if (!Array.isArray(spec.members) || spec.members.length === 0) {
    errors.push("members must be a non-empty array");
    return { valid: false, errors };
  }
  const ids = new Set();
  for (const [index, member] of spec.members.entries()) {
    const at = `members[${index}]`;
    if (!isRecord(member)) { errors.push(`${at} must be an object`); continue; }
    if (typeof member.id !== "string" || !MEMBER_ID.test(member.id)) errors.push(`${at}.id must be a lowercase slug`);
    else if (ids.has(member.id)) errors.push(`${at}.id duplicates ${member.id}`);
    else ids.add(member.id);
    if (!nonEmptyString(member.language)) errors.push(`${at}.language is required`);
    if (typeof member.repository !== "string" || !/^https:\/\/[^\s]+$/.test(member.repository)) errors.push(`${at}.repository must be an https URL`);
    if (typeof member.revision !== "string" || !HEX_COMMIT.test(member.revision)) errors.push(`${at}.revision must be a full 40-character lowercase commit hash`);
    if (!nonEmptyArgv(member.acceptance)) errors.push(`${at}.acceptance must be a non-empty argv array`);
    if (member.prepare !== undefined && member.prepare !== null && !nonEmptyArgv(member.prepare)) errors.push(`${at}.prepare must be null or a non-empty argv array`);
    if (!Array.isArray(member.toolchain) || member.toolchain.length === 0 || member.toolchain.some((entry) => !isRecord(entry) || typeof entry.tool !== "string" || !TOOL_NAME.test(entry.tool))) {
      errors.push(`${at}.toolchain must list each prerequisite tool by name`);
    } else {
      const tools = new Set(member.toolchain.map((entry) => entry.tool));
      for (const argv of [member.acceptance, member.prepare]) {
        if (nonEmptyArgv(argv) && !tools.has(argv[0])) errors.push(`${at}.toolchain does not declare ${argv[0]}, which its commands execute`);
      }
    }
    if (!nonEmptyString(member.task)) errors.push(`${at}.task is required`);
    if (!Array.isArray(member.requirements) || member.requirements.length === 0) {
      errors.push(`${at}.requirements must list at least one injected requirement file`);
    } else {
      for (const [r, requirement] of member.requirements.entries()) {
        const rat = `${at}.requirements[${r}]`;
        if (!isRecord(requirement)) { errors.push(`${rat} must be an object`); continue; }
        if (!relativeInside(requirement.path)) errors.push(`${rat}.path must be a relative path inside the repository`);
        if (!Array.isArray(requirement.contents) || requirement.contents.some((line) => typeof line !== "string")) {
          errors.push(`${rat}.contents must be an array of lines`);
          continue;
        }
        const digest = createHash("sha256").update(requirement.contents.join("\n")).digest("hex");
        if (requirement.sha256 !== digest) errors.push(`${rat}.sha256 does not match its contents`);
      }
    }
  }
  const languages = new Set(spec.members.filter(isRecord).map((member) => member.language));
  for (const language of REQUIRED_COHORT_LANGUAGES) if (!languages.has(language)) errors.push(`cohort must include a ${language} member`);
  if (!COMPILED_COHORT_LANGUAGES.some((language) => languages.has(language))) errors.push("cohort must include a compiled-language member");
  return { valid: errors.length === 0, errors };
}

/**
 * Resolve every declared toolchain prerequisite on PATH. Absent tools are
 * reported, never installed: a missing toolchain is an operator blocker.
 */
export function checkCohortToolchains(spec, { resolveTool = defaultResolveTool } = {}) {
  const tools = [...new Set(spec.members.flatMap((member) => member.toolchain.map((entry) => entry.tool)))].sort();
  const results = tools.map((tool) => {
    const path = resolveTool(tool);
    return { tool, present: path !== null, path };
  });
  return { ok: results.every((entry) => entry.present), tools: results, missing: results.filter((entry) => !entry.present).map((entry) => entry.tool) };
}

function defaultResolveTool(tool) {
  const result = spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", tool], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function readManifestRelative(manifestDir, path, label) {
  if (!relativeInside(path)) fail(`${label} path must be relative to the manifest and stay inside its directory`);
  const resolved = resolve(manifestDir, path);
  if (!existsSync(resolved)) fail(`${label} is missing: ${path}`);
  const actual = realpathSync(resolved);
  const realRel = relative(realpathSync(manifestDir), actual);
  if (realRel.startsWith("..") || isAbsolute(realRel)) fail(`${label} symlink escapes the manifest directory`);
  return readFileSync(actual);
}

function validateEvidence(domain, record, { manifestPath, expectedCommit, allowFixtures, reviewerPublicKey }) {
  if (!isRecord(record)) fail(`${domain}: record must be an object`);
  if (record.status === "unavailable") {
    if (!nonEmptyString(record.reason)) fail(`${domain}: unavailable record requires a reason`);
    if (record.commit !== undefined && record.commit !== expectedCommit) fail(`${domain}: unavailable record is bound to a different commit`);
    return { domain, status: "unavailable", reason: record.reason };
  }
  if (record.status !== "passed") fail(`${domain}: status must be "passed" or "unavailable"`);
  if (record.commit !== expectedCommit) fail(`${domain}: proof commit does not match candidate ${expectedCommit}`);
  if (!nonEmptyString(record.producer)) fail(`${domain}: passed proof requires producer`);
  if (!nonEmptyString(record.scope)) fail(`${domain}: passed proof requires an explicit scope`);
  if (!nonEmptyString(record.observed_at) || Number.isNaN(Date.parse(record.observed_at))) {
    fail(`${domain}: passed proof requires an ISO-compatible observed_at timestamp`);
  }
  if (record.kind !== "observed" && record.kind !== "fixture") fail(`${domain}: kind must be "observed" or "fixture"`);
  if (record.kind === "fixture" && !allowFixtures) fail(`${domain}: fixture evidence cannot establish release acceptance (use --allow-fixtures only for structural tests)`);
  if (domain === "tui") {
    if (!Array.isArray(record.coverage)) fail("tui: passed proof requires a coverage array including git.workspace");
    const workspace = record.coverage.find((entry) => isRecord(entry) && entry.path === "git.workspace");
    if (!workspace || workspace.status !== "passed") fail("tui: git.workspace must have candidate-bound passed evidence before the TUI domain can pass");
  }
  if (domain === "external_cohort") {
    const cohort = record.cohort;
    if (!isRecord(cohort) || !nonEmptyString(cohort.name) || !Array.isArray(cohort.integrations) || cohort.integrations.length === 0 || cohort.integrations.some((entry) => !nonEmptyString(entry)) || !Array.isArray(cohort.tasks) || cohort.tasks.length === 0 || cohort.tasks.some((entry) => !nonEmptyString(entry))) {
      fail("external_cohort: passed proof requires cohort name, named integrations, and named tasks");
    }
    if (!nonEmptyString(cohort.spec) || typeof cohort.spec_sha256 !== "string" || !SHA256.test(cohort.spec_sha256)) {
      fail("external_cohort: passed proof requires cohort.spec and cohort.spec_sha256 binding the pinned cohort specification");
    }
    const specBytes = readManifestRelative(resolve(manifestPath, ".."), cohort.spec, "external_cohort: cohort spec");
    if (createHash("sha256").update(specBytes).digest("hex") !== cohort.spec_sha256) fail("external_cohort: cohort spec SHA-256 does not match the manifest");
    let spec;
    try { spec = JSON.parse(specBytes.toString("utf8")); }
    catch (error) { fail(`external_cohort: cohort spec must be valid JSON: ${error.message}`); }
    const specResult = validateExternalCohortSpec(spec);
    if (!specResult.valid) fail(`external_cohort: cohort spec invalid: ${specResult.errors.join("; ")}`);
    if (spec.cohort !== cohort.name) fail(`external_cohort: cohort name ${cohort.name} does not match the pinned spec ${spec.cohort}`);
    const uncovered = spec.members.map((member) => member.id).filter((id) => !cohort.tasks.includes(id));
    if (uncovered.length) fail(`external_cohort: passed proof does not cover pinned cohort members: ${uncovered.join(", ")}`);
  }
  if (!nonEmptyString(record.artifact)) fail(`${domain}: passed proof requires artifact`);
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) fail(`${domain}: passed proof requires a lowercase SHA-256 digest`);

  const manifestDir = resolve(manifestPath, "..");
  if (isAbsolute(record.artifact)) fail(`${domain}: artifact path must be relative to the manifest`);
  const artifactPath = resolve(manifestDir, record.artifact);
  const rel = relative(manifestDir, artifactPath);
  if (rel.startsWith("..") || isAbsolute(rel)) fail(`${domain}: artifact path escapes the manifest directory`);
  if (!existsSync(artifactPath)) fail(`${domain}: artifact is missing: ${record.artifact}`);
  const actualPath = realpathSync(artifactPath);
  const realRel = relative(realpathSync(manifestDir), actualPath);
  if (realRel.startsWith("..") || isAbsolute(realRel)) fail(`${domain}: artifact symlink escapes the manifest directory`);
  const actualDigest = createHash("sha256").update(readFileSync(actualPath)).digest("hex");
  if (actualDigest !== record.sha256) fail(`${domain}: artifact SHA-256 does not match the manifest`);
  if (domain === "selfhost") {
    let artifact;
    try { artifact = JSON.parse(readFileSync(actualPath, "utf8")); }
    catch (error) { fail(`selfhost: artifact must be valid JSON: ${error.message}`); }
    const result = validateSelfhostAcceptanceArtifact(artifact, { expectedCommit, allowFixture: allowFixtures });
    if (!result.valid) fail(`selfhost: ${result.errors.join("; ")}`);
    const evidenceDir = resolve(actualPath, "..");
    for (const [index, run] of artifact.runs.entries()) {
      for (const [stream, pathField, digestField] of [
        ["stdout", "stdout_artifact", "stdout_sha256"], ["stderr", "stderr_artifact", "stderr_sha256"],
      ]) {
        const nestedPath = run[pathField];
        if (isAbsolute(nestedPath)) fail(`selfhost: runs[${index}] ${stream} artifact path must be relative`);
        const nestedResolved = resolve(evidenceDir, nestedPath);
        const nestedRelative = relative(evidenceDir, nestedResolved);
        if (nestedRelative.startsWith("..") || isAbsolute(nestedRelative)) fail(`selfhost: runs[${index}] ${stream} artifact escapes its evidence directory`);
        if (!existsSync(nestedResolved)) fail(`selfhost: runs[${index}] ${stream} artifact is missing: ${nestedPath}`);
        const nestedActual = realpathSync(nestedResolved);
        const nestedRealRelative = relative(realpathSync(evidenceDir), nestedActual);
        if (nestedRealRelative.startsWith("..") || isAbsolute(nestedRealRelative)) fail(`selfhost: runs[${index}] ${stream} artifact symlink escapes its evidence directory`);
        const nestedDigest = createHash("sha256").update(readFileSync(nestedActual)).digest("hex");
        if (nestedDigest !== run[digestField]) fail(`selfhost: runs[${index}] ${stream} artifact SHA-256 does not match`);
      }
    }
    if (record.kind === "observed" && artifact.runs.some((run) => run.outcome !== "passed" || run.verified_result !== true || run.adoption_check !== "passed")) {
      fail("selfhost: observed release proof requires every run to have a verified result and passed independent adoption check");
    }
    if (record.kind === "observed") {
      for (const [index] of artifact.runs.entries()) {
        try { verifyReviewAttestation({ artifact, runIndex: index, evidenceDir, reviewerPublicKey }); }
        catch (error) { fail(`selfhost: ${error.message}`); }
      }
    }
  }
  return { domain, status: "passed", kind: record.kind, commit: record.commit, artifact: record.artifact };
}

export function checkReleaseAcceptance({ root, manifestPath, candidate, allowFixtures = false, reviewerPublicKey }) {
  const absoluteRoot = resolve(root);
  const absoluteManifest = resolve(absoluteRoot, manifestPath);
  let parsed;
  try { parsed = JSON.parse(readFileSync(absoluteManifest, "utf8")); }
  catch (error) { fail(`cannot read valid JSON manifest: ${error.message}`); }
  const manifest = validateManifest(parsed);
  const head = git(absoluteRoot, ["rev-parse", "HEAD"]);
  const candidateCommit = candidate ? git(absoluteRoot, ["rev-parse", `${candidate}^{commit}`]) : head;
  if (manifest.candidate_commit !== candidateCommit) {
    fail(`stale manifest: bound to ${manifest.candidate_commit}, candidate is ${candidateCommit}`);
  }
  const records = REQUIRED_DOMAINS.map((domain) => validateEvidence(domain, manifest.domains[domain], {
    manifestPath: absoluteManifest, expectedCommit: candidateCommit, allowFixtures, reviewerPublicKey,
  }));
  const unavailable = records.filter((item) => item.status === "unavailable");
  const fixtureDomains = records.filter((item) => item.status === "passed" && item.kind === "fixture").map((item) => item.domain);
  const releaseReady = unavailable.length === 0 && fixtureDomains.length === 0;
  return {
    valid: true,
    release_ready: releaseReady,
    candidate_commit: candidateCommit,
    head_commit: head,
    unavailable: unavailable.map(({ domain, reason }) => ({ domain, reason })),
    fixture_domains: fixtureDomains,
    domains: records,
  };
}

function usage() {
  return "Usage: bun scripts/release-acceptance.mjs [--manifest <path>] [--candidate <git-revision>] [--reviewer-key <trusted-public-key.pem>] [--json] [--allow-fixtures]\n" +
    "       bun scripts/release-acceptance.mjs --cohort <external-cohort.json> [--check-toolchains] [--json]\n" +
    "Checks the 1.0.0 acceptance manifest against an exact commit. Observed selfhost proof requires a trusted detached reviewer signature. --allow-fixtures never sets release_ready.\n" +
    "--cohort validates the pinned external-cohort specification only; --check-toolchains also resolves each declared prerequisite on PATH and never installs one.";
}

function parseArgs(args) {
  const options = { manifest: "release-acceptance.json", candidate: undefined, reviewerKey: undefined, cohort: undefined, json: false, allowFixtures: false, checkToolchains: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--allow-fixtures") options.allowFixtures = true;
    else if (arg === "--check-toolchains") options.checkToolchains = true;
    else if (arg === "--manifest" || arg === "--candidate" || arg === "--reviewer-key" || arg === "--cohort") {
      const value = args[++index];
      if (!value) fail(`${arg} requires a value`);
      options[arg === "--manifest" ? "manifest" : arg === "--candidate" ? "candidate" : arg === "--cohort" ? "cohort" : "reviewerKey"] = value;
    } else fail(`unknown argument: ${arg}`);
  }
  return options;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(`${usage()}\n`); process.exit(0); }
    if (options.checkToolchains && options.cohort === undefined) fail("--check-toolchains requires --cohort");
    if (options.cohort !== undefined) {
      let spec;
      try { spec = JSON.parse(readFileSync(resolve(options.cohort), "utf8")); }
      catch (error) { fail(`cannot read valid JSON cohort spec: ${error.message}`); }
      const result = validateExternalCohortSpec(spec);
      const toolchains = result.valid && options.checkToolchains ? checkCohortToolchains(spec) : null;
      const ok = result.valid && (toolchains === null || toolchains.ok);
      const report = { valid: result.valid, errors: result.errors, cohort: spec?.cohort ?? null, members: result.valid ? spec.members.map(({ id, language, revision, acceptance }) => ({ id, language, revision, acceptance })) : [], toolchains };
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(`Cohort spec ${result.valid ? "valid" : "INVALID"}: ${report.cohort ?? "(unnamed)"}\n`);
        for (const error of result.errors) process.stdout.write(`ERROR ${error}\n`);
        for (const tool of toolchains?.tools ?? []) process.stdout.write(`${tool.present ? "PRESENT" : "MISSING"} ${tool.tool}${tool.path ? ` ${tool.path}` : ""}\n`);
      }
      process.exit(ok ? 0 : 1);
    }
    const reviewerPublicKey = options.reviewerKey === undefined ? undefined : readFileSync(resolve(options.reviewerKey), "utf8");
    const result = checkReleaseAcceptance({ root: process.cwd(), manifestPath: options.manifest, candidate: options.candidate, allowFixtures: options.allowFixtures, reviewerPublicKey });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Manifest valid for ${result.candidate_commit}. Release ready: ${result.release_ready ? "yes" : "no"}.\n`);
      for (const item of result.unavailable) process.stdout.write(`UNAVAILABLE ${item.domain}: ${item.reason}\n`);
      for (const domain of result.fixture_domains) process.stdout.write(`FIXTURE ${domain}: structural test evidence only\n`);
    }
    process.exit(result.release_ready || options.allowFixtures ? 0 : 1);
  } catch (error) {
    const options = process.argv.includes("--json");
    const message = error instanceof Error ? error.message : String(error);
    if (options) process.stdout.write(`${JSON.stringify({ valid: false, release_ready: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`Release acceptance failed: ${message}\n`);
    process.exit(1);
  }
}
