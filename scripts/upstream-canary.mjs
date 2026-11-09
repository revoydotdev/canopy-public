#!/usr/bin/env bun
/**
 * Provider-backed campaign evidence against a pinned third-party repository.
 *
 * The requirement is explicitly Revoy-injected. This proves compatibility with
 * the named repository revision; it does not imply upstream authorship,
 * endorsement, mergeability, or general performance on arbitrary repositories.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { recordTerminalSession } from "./record-terminal-session.mjs";
import { publishTerminalRecording } from "./terminal-recording-publication.mjs";
import { readinessCommandForIntegration, resolveGeneralistIntegration } from "./lib/generalist-integrations.mjs";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(SCRIPT_ROOT, "scripts", "generalist-campaign-driver.mjs");
const OUTPUT_ROOT = "/mnt/sda2/revoy2/exemplars/upstream-canary";
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const REVISION = /^[0-9a-f]{40}$/;

const BYTEORDER_REQUIREMENT = `use byteorder::{BigEndian, ByteOrder, LittleEndian};

#[test]
fn u40_convenience_methods_round_trip_both_endiannesses() {
    let value = 0x12_3456_789a_u64;
    let mut big = [0_u8; 5];
    BigEndian::write_u40(&mut big, value);
    assert_eq!(big, [0x12, 0x34, 0x56, 0x78, 0x9a]);
    assert_eq!(BigEndian::read_u40(&big), value);

    let mut little = [0_u8; 5];
    LittleEndian::write_u40(&mut little, value);
    assert_eq!(little, [0x9a, 0x78, 0x56, 0x34, 0x12]);
    assert_eq!(LittleEndian::read_u40(&little), value);
}
`;

const YOCTO_QUEUE_REQUIREMENT = `import test from 'ava';
import Queue from './index.js';

test('.enqueueAll() appends iterables in FIFO order', t => {
\tconst queue = new Queue();
\tqueue.enqueue('first');
\tqueue.enqueueAll(['second', 'third']);
\tt.deepEqual([...queue], ['first', 'second', 'third']);

\tconst self = new Queue();
\tself.enqueue('a');
\tself.enqueue('b');
\tself.enqueueAll(self);
\tt.deepEqual([...self], ['a', 'b', 'a', 'b']);
});

test('.enqueueAll() is atomic when input iteration fails', t => {
\tconst queue = new Queue();
\tqueue.enqueue('stable');
\tconst values = (function * () {
\t\tyield 'must-not-be-appended';
\t\tthrow new Error('input failed');
\t})();

\tt.throws(() => queue.enqueueAll(values), {message: 'input failed'});
\tt.deepEqual([...queue], ['stable']);
});
`;

export const UPSTREAM_CANARIES = Object.freeze({
  byteorder: Object.freeze({
    repository: "https://github.com/BurntSushi/byteorder.git",
    revision: "5a82625fae462e8ba64cec8146b24a372b4d75c6",
    upstream_name: "BurntSushi/byteorder",
    license: "Unlicense OR MIT",
    language: "rust",
    verification: Object.freeze(["cargo", "test", "--quiet"]),
    requirement_path: "tests/revoy_u40_canary.rs",
    requirement_contents: BYTEORDER_REQUIREMENT,
    task: "Add documented ByteOrder::read_u40 and ByteOrder::write_u40 convenience methods for five-byte unsigned integers. Preserve no_std support and the existing generic read_uint/write_uint behavior. Keep the change narrowly scoped to the ByteOrder API; do not weaken or remove tests.",
  }),
  "yocto-queue": Object.freeze({
    repository: "https://github.com/sindresorhus/yocto-queue.git",
    revision: "b07eac099753833b29d06c614149904445739776",
    upstream_name: "sindresorhus/yocto-queue",
    license: "MIT",
    language: "javascript",
    prepare: Object.freeze(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]),
    verification: Object.freeze(["npm", "test"]),
    requirements: Object.freeze([
      Object.freeze({ path: "revoy-enqueue-all.test.js", contents: YOCTO_QUEUE_REQUIREMENT }),
    ]),
    task: "Add a documented Queue#enqueueAll(values) API and its TypeScript declaration. It must accept any iterable, preserve FIFO order, handle enqueueAll(queue) without looping forever, and consume the input completely before mutating the queue so an iterator failure leaves the queue unchanged. Do not weaken or remove tests.",
  }),
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allow_failure !== true) {
    throw new Error(`${command} exited ${result.status}: ${String(result.stderr || result.stdout).slice(-3000)}`);
  }
  return Object.freeze({ exit_code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

function git(cwd, args, options = {}) { return run("git", args, { ...options, cwd }); }
function hash(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function option(argv, name, fallback = undefined) { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; }

function safeRoot(path) {
  const requested = resolve(path);
  const allowed = resolve("/mnt/sda2");
  if (requested !== allowed && !requested.startsWith(`${allowed}${sep}`)) throw new Error("upstream canary output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== allowed && !actual.startsWith(`${allowed}${sep}`)) throw new Error("upstream canary output resolves outside /mnt/sda2");
  return actual;
}

function cleanGenerator(path) {
  const root = realpathSync(resolve(path));
  const revision = git(root, ["rev-parse", "HEAD"]).stdout.trim().toLowerCase();
  if (!REVISION.test(revision)) throw new Error("generator HEAD is not an exact commit");
  if (git(root, ["status", "--porcelain"]).stdout.trim()) throw new Error("upstream canary requires a clean generator worktree");
  const driver = join(root, "scripts", "generalist-campaign-driver.mjs");
  if (!existsSync(driver)) throw new Error("generator worktree does not contain the campaign driver");
  return Object.freeze({ root, revision, driver });
}

export function prepareGeneratorDependencies(generator, execute = run) {
  const command = Object.freeze(["bun", "install", "--frozen-lockfile"]);
  execute(command[0], command.slice(1), { cwd: generator.root, timeout: 10 * 60_000 });
  const status = execute("git", ["status", "--porcelain"], { cwd: generator.root });
  if (status.stdout.trim()) {
    throw new Error("generator dependency preparation changed tracked or untracked source bytes");
  }
  return command;
}

export function sanitizeText(value, replacements) {
  let output = String(value);
  for (const [from, to] of replacements) if (from) output = output.replaceAll(from, to);
  output = output
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account withheld]")
    .replaceAll(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_./+-]{12,}|api[_-]?key[=: ]+[A-Za-z0-9_./+-]{12,})/gi, "[credential withheld]");
  return output;
}

function writePublicJson(path, value, replacements) {
  const text = `${sanitizeText(JSON.stringify(value, null, 2), replacements)}\n`;
  assertSecretFree(text, path);
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  return path;
}

export function summarizeFailureAudit(lines) {
  return lines.flatMap((line) => {
    let record;
    try { record = JSON.parse(line); } catch { return []; }
    if (record?.kind !== "trace" || typeof record.node_id !== "string") return [];
    return [{
      node_id: record.node_id,
      parent_id: record.parent_id ?? null,
      action_description: record.action_description ?? null,
      node_state_before: record.node_state_before ?? null,
      node_state_after: record.node_state_after ?? null,
      provenance: record.provenance?.tag ?? null,
      critic_agent: record.critic_agent ?? null,
      critic_verdict_approved: record.critic_verdict_approved ?? null,
      critic_root_cause: record.critic_root_cause ?? null,
      gates: Array.isArray(record.gates) ? record.gates.map((gate) => ({ gate: gate.gate, result: gate.result, detail: gate.detail })) : [],
    }];
  });
}

function failureAuditDiagnostics(persistence) {
  const auditDirectory = join(persistence, "audit");
  if (!existsSync(auditDirectory)) return [];
  return readdirSync(auditDirectory).filter((name) => name.endsWith(".jsonl")).sort().flatMap((name) =>
    summarizeFailureAudit(readFileSync(join(auditDirectory, name), "utf8").split("\n").filter(Boolean)),
  );
}

export function assessCanaryEvidence(input) {
  const gaps = [];
  if (!REVISION.test(String(input.upstream_revision ?? ""))) gaps.push("unpinned_upstream_revision");
  if (input.baseline_exit_code === 0) gaps.push("baseline_not_failing");
  if (input.campaign_ok !== true || typeof input.campaign_id !== "string" || !input.campaign_id.trim()) gaps.push("campaign_not_attributable");
  if (input.adoption_exit_code !== 0) gaps.push("verified_result_not_adopted");
  if (input.verification_exit_code !== 0) gaps.push("native_acceptance_not_green");
  if (!Array.isArray(input.changed_paths) || input.changed_paths.length === 0) gaps.push("no_adopted_source_change");
  return Object.freeze({ ok: gaps.length === 0, gaps: Object.freeze(gaps) });
}

export function canaryPersistenceDirectory(workspace) {
  return resolve(workspace, ".arbor-evidence");
}

export function pinnedFetchArgs(spec) {
  return ["fetch", "--quiet", "origin", spec.revision];
}

export function requirementFiles(spec) {
  const files = spec.requirements ?? [{ path: spec.requirement_path, contents: spec.requirement_contents }];
  if (!Array.isArray(files) || files.length === 0) throw new Error("upstream canary requires at least one injected requirement file");
  return files.map((entry) => {
    if (!entry || typeof entry.path !== "string" || !entry.path || typeof entry.contents !== "string") {
      throw new Error("upstream canary requirement entries need a path and textual contents");
    }
    return Object.freeze({ path: entry.path, contents: entry.contents });
  });
}

function initializePinnedRepository(spec, workspace) {
  mkdirSync(workspace, { recursive: true });
  git(workspace, ["init", "-q", "-b", "master"]);
  git(workspace, ["remote", "add", "origin", spec.repository]);
  git(workspace, pinnedFetchArgs(spec), { timeout: 180_000 });
  git(workspace, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const actual = git(workspace, ["rev-parse", "HEAD"]).stdout.trim().toLowerCase();
  if (actual !== spec.revision) throw new Error(`upstream revision mismatch: expected ${spec.revision}, observed ${actual}`);
  if (git(workspace, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new Error("upstream canary requires complete Git history for detached worktree isolation");
  }
  git(workspace, ["config", "user.email", "canary@revoy.invalid"]);
  git(workspace, ["config", "user.name", "Revoy Upstream Canary"]);
  const requirements = requirementFiles(spec);
  for (const entry of requirements) {
    const requirement = resolve(workspace, entry.path);
    if (relative(workspace, requirement).startsWith("..")) throw new Error("catalog requirement path escapes the workspace");
    mkdirSync(dirname(requirement), { recursive: true });
    writeFileSync(requirement, entry.contents, { encoding: "utf8", flag: "wx" });
  }
  git(workspace, ["add", "--", ...requirements.map((entry) => entry.path)]);
  git(workspace, ["commit", "--quiet", "-m", "test: add revoy upstream compatibility canary"]);
  return git(workspace, ["rev-parse", "HEAD"]).stdout.trim().toLowerCase();
}

export async function runUpstreamCanary(options = {}) {
  const runId = options.run_id ?? `byteorder-codex-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!RUN_ID.test(runId)) throw new Error("run_id must be publication-safe");
  const specId = options.spec ?? "byteorder";
  const spec = UPSTREAM_CANARIES[specId];
  if (!spec) throw new Error(`unknown upstream canary; expected one of: ${Object.keys(UPSTREAM_CANARIES).join(", ")}`);
  const integration = options.integration ?? "codex";
  resolveGeneralistIntegration(integration);
  const generator = cleanGenerator(options.generator_worktree ?? SCRIPT_ROOT);
  const root = safeRoot(options.output_root ?? OUTPUT_ROOT);
  const output = join(root, runId);
  if (existsSync(output)) throw new Error(`run directory already exists: ${output}`);
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(output, ".incomplete"), "upstream canary publication incomplete\n", { flag: "wx" });
  const scratch = mkdtempSync(join(root, ".upstream-canary-tmp-"));
  const workspace = join(scratch, "workspace");
  const capture = join(scratch, "capture");
  const resultPath = join(scratch, "campaign-result.json");
  const persistence = canaryPersistenceDirectory(workspace);
  const replacements = [[workspace, "<upstream-workspace>"], [scratch, "<private-capture>"], [generator.root, "<revoy2>"], [process.env.HOME ?? "", "~"]];
  try {
    const [readinessCommand, readinessArgs] = readinessCommandForIntegration(integration);
    const readiness = run(readinessCommand, readinessArgs, { allow_failure: true, timeout: 30_000 });
    if (readiness.exit_code !== 0) throw new Error(`${integration} integration is not authenticated and ready`);
    const generatorPreparation = prepareGeneratorDependencies(generator);
    const requirementRevision = initializePinnedRepository(spec, workspace);
    if (spec.prepare) run(spec.prepare[0], spec.prepare.slice(1), { cwd: workspace, timeout: 10 * 60_000 });
    const baseline = run(spec.verification[0], spec.verification.slice(1), { cwd: workspace, allow_failure: true, timeout: 10 * 60_000 });
    if (baseline.exit_code === 0) throw new Error("injected upstream requirement did not produce a failing baseline");

    const command = [process.execPath, generator.driver,
      "--cwd", workspace,
      "--result", resultPath,
      "--persistence", persistence,
      "--scratch", scratch,
      "--language", spec.language,
      "--integration", integration,
      "--task", spec.task,
      "--verify-json", JSON.stringify(spec.verification),
    ];
    const recording = await recordTerminalSession({ output: capture, command, cwd: generator.root, env: process.env });
    if (!existsSync(resultPath)) throw new Error("campaign driver exited without a result envelope");
    const campaign = JSON.parse(readFileSync(resultPath, "utf8"));
    const changedPaths = git(workspace, ["diff", "--name-only"]).stdout.split("\n").filter(Boolean).sort();
    const diff = git(workspace, ["diff", "--binary"]).stdout;
    const assessment = assessCanaryEvidence({
      upstream_revision: spec.revision,
      baseline_exit_code: baseline.exit_code,
      campaign_ok: campaign.ok,
      campaign_id: campaign.campaign_id,
      adoption_exit_code: campaign.adoption?.exit_code,
      verification_exit_code: campaign.verification?.exit_code,
      changed_paths: changedPaths,
    });
    if (!assessment.ok) throw new Error(`upstream canary evidence incomplete: ${assessment.gaps.join(", ")}`);

    const media = publishTerminalRecording({
      raw_path: recording.raw_path,
      timing_path: recording.timing_path,
      campaign_id: campaign.campaign_id,
      source_revision: generator.revision,
      generator_worktree: generator.root,
      output_directory: join(output, "media"),
    });
    const baselinePath = writePublicJson(join(output, "baseline.json"), {
      command: spec.verification,
      exit_code: baseline.exit_code,
      output_tail: sanitizeText(`${baseline.stdout}${baseline.stderr}`, replacements).split("\n").slice(-80).join("\n"),
    }, replacements);
    const campaignPath = writePublicJson(join(output, "campaign-result.json"), campaign, replacements);
    const upstreamPath = writePublicJson(join(output, "upstream.json"), {
      schema_version: 1,
      canary_id: specId,
      repository: spec.repository,
      upstream_name: spec.upstream_name,
      upstream_revision: spec.revision,
      license: spec.license,
      requirement_origin: "revoy_injected_compatibility_canary",
      requirement_revision: requirementRevision,
      requirements: requirementFiles(spec).map((entry) => ({
        path: entry.path,
        sha256: sha256Bytes(Buffer.from(entry.contents)),
      })),
      dependency_preparation: spec.prepare ?? null,
      task: spec.task,
      native_acceptance: spec.verification,
    }, replacements);
    const adoptionPath = writePublicJson(join(output, "adoption-evidence.json"), {
      schema_version: 1,
      campaign_id: campaign.campaign_id,
      changed_paths: changedPaths,
      adopted_diff_sha256: hash(diff),
      adopted_diff_bytes: Buffer.byteLength(diff),
      independent_acceptance_exit_code: campaign.verification.exit_code,
      evidence_assessment: assessment,
    }, replacements);
    const privacyPath = writePublicJson(join(output, "privacy-report.json"), {
      schema_version: 1,
      policy: "temporary upstream clone and raw terminal stream are removed after secret-scanned publication",
      secret_pattern_codes: publicationSecretPatternCodes,
      raw_recording_published: false,
      provider_content_published_only_as_secret_scanned_terminal_frames: true,
      arbitrary_desktop_pixels_captured: false,
      findings: 0,
    }, replacements);
    const assets = [baselinePath, campaignPath, upstreamPath, adoptionPath, privacyPath, media.mp4, media.webm, media.manifest, media.checksums];
    const sealed = writeManifestAndChecksums(output, {
      schema_version: 1,
      product: "revoy2",
      artifact_kind: "provider_backed_pinned_upstream_repository_canary",
      run_id: runId,
      generated_at: new Date().toISOString(),
      generator_revision: generator.revision,
      generator_dependency_preparation: generatorPreparation,
      integration,
      campaign_id: campaign.campaign_id,
      upstream: { name: spec.upstream_name, repository: spec.repository, revision: spec.revision, license: spec.license },
      claim_boundary: {
        proven: "the named Revoy revision completed one governed, provider-backed, independently accepted task against the exact upstream revision",
        not_proven: ["upstream endorsement", "mergeability", "arbitrary repository compatibility", "provider equivalence", "unbounded autonomy"],
      },
      assessment,
    }, assets);
    rmSync(join(output, ".incomplete"));
    return Object.freeze({ run_directory: output, campaign_id: campaign.campaign_id, mp4: media.mp4, webm: media.webm, manifest: sealed.manifest_path, checksums: sealed.checksums_path });
  } catch (error) {
    let campaign = null;
    try { campaign = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null; } catch {}
    writePublicJson(join(output, "failure-diagnostic.json"), {
      schema_version: 1,
      publication_status: "failed_closed",
      error: error instanceof Error ? error.message : String(error),
      campaign: campaign === null ? null : {
        campaign_id: campaign.campaign_id ?? null,
        ok: campaign.ok ?? false,
        error: campaign.error ?? null,
        campaign_exit_code: campaign.campaign?.exit_code ?? null,
        campaign_output_tail: campaign.campaign?.output_tail ?? null,
      },
      audit: failureAuditDiagnostics(persistence),
      omitted_private_fields: ["prompts", "credentials", "environment", "full_model_output", "repository_contents", "raw_terminal_stream"],
      private_scratch_removed: true,
    }, replacements);
    writeFileSync(join(output, "failure.txt"), "upstream canary failed closed; see secret-scanned failure-diagnostic.json; private scratch was removed\n", { encoding: "utf8" });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  return {
    run_id: option(argv, "--run-id"),
    spec: option(argv, "--spec", "byteorder"),
    integration: option(argv, "--integration", "codex"),
    output_root: option(argv, "--output-root", OUTPUT_ROOT),
    generator_worktree: option(argv, "--generator-worktree", SCRIPT_ROOT),
  };
}

if (import.meta.main) {
  runUpstreamCanary(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
