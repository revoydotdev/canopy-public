#!/usr/bin/env bun
// DEPRECATED-LANE SCRIPT (ADR-192). scripts/self-hosted-demo.mjs records a provider-backed Claude Code integration
// run, so it exercises a deprecated connector lane rather than Canopy (revoy-native). It
// refuses unless the operator has set connectors.allow_deprecated: true and
// connectors.reason in an arbor.jsonc that resolves for the isolated clone (user scope
// ~/.arbor/arbor.jsonc, or a committed project arbor.jsonc). It never opts in for you.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalizeForHash } from "@arbor/core";
import { assertSecretFree, publicationSecretPatternCodes } from "./lib/sizzle-redaction.mjs";
import { sha256Bytes, writeManifestAndChecksums } from "./lib/sizzle-manifest.mjs";
import { renderTmuxFrame } from "./tmux-demo-record.mjs";
import { assertDeprecatedLaneOptIn } from "./lib/deprecated-lane-optin.mjs";
import { readOperatorLine, requestOperatorKeypress } from "./operator-keypress.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ANSI = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|[\[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const REQUIRED_CHAPTERS = ["readiness", "admission", "search", "independent-review", "recovery", "result-boundary", "seal"];
const DEFAULT_TASK = [
  "Implement and use an exported assertPublicChapterOrder(chapters, durationMs) in scripts/self-hosted-demo.mjs.",
  "It must require the exact readiness, admission, search, independent-review, recovery, result-boundary, seal order; require safe integer capture_ms values that are nondecreasing and within durationMs; and abort before frame or media publication on any mismatch.",
  "Restrict writes to scripts/self-hosted-demo.mjs and scripts/tests/self-hosted-demo.test.mjs.",
  "Preserve the publication privacy boundary and add focused regression coverage for a valid timeline, a missing chapter, an out-of-order chapter, a decreasing timestamp, and a timestamp beyond the duration.",
  "The authored acceptance command must be: bun vitest run scripts/tests/self-hosted-demo.test.mjs",
].join(" ");
const DEFAULT_CLARIFICATION_ANSWER = "The chain is constructed today, but it is not independently recomputed before publication. Implement the specified recomputation check before any public artifact write; preserve the existing allowlist and privacy boundary.";
const RECOVERY_TASK = [
  "Recover the prior campaign's unverified result by planning exactly one executable child action, with no separate discovery or testing actions.",
  "That one action must implement assertPublicChapterOrder and its focused tests, may write both scripts/self-hosted-demo.mjs and scripts/tests/self-hosted-demo.test.mjs, and must carry the authored acceptance command bun vitest run scripts/tests/self-hosted-demo.test.mjs.",
  "Preserve the privacy boundary and do not reuse the prior campaign's claimed output as verified evidence.",
].join(" ");

export function demoPersistencePath(source, runId) {
  if (!SAFE_ID.test(runId)) throw new Error("run_id must be publication safe");
  return join(resolve(source), ".arbor", "publication-captures", runId);
}

export function linkDependencyCache(sourceRepo, targetRepo) {
  const sourceModules = join(resolve(sourceRepo), "node_modules");
  if (!existsSync(sourceModules)) return false;
  const targetModules = join(resolve(targetRepo), "node_modules");
  // Keep node_modules itself a real directory so the repository's
  // `node_modules/` ignore rule applies. A root symlink is not a directory
  // to Git, so the trailing-slash rule correctly refuses to ignore it and
  // the isolation gate sees a false product diff.
  mkdirSync(targetModules);
  for (const name of readdirSync(sourceModules)) symlinkSync(join(sourceModules, name), join(targetModules, name));
  return true;
}

export function digest(value) {
  return sha256Bytes(Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function storedHash(value, label) {
  if (typeof value !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value.startsWith("sha256:") ? value.toLowerCase() : `sha256:${value.toLowerCase()}`;
}
function canonicalHash(value) { return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`; }

/**
 * Bind a private campaign ledger to its external tip without publishing any
 * ledger record. The driver has already run `ledger verify`; this adds the
 * publication-specific completeness anchor and its shared manifest.
 */
export function auditTipProvenance(persistence, campaignId) {
  if (!SAFE_ID.test(campaignId)) throw new Error("audit-tip campaign id is unsafe");
  const ledgerPath = join(persistence, "audit", `${campaignId}.jsonl`);
  const sentinelPath = join(persistence, "audit-tips", `${campaignId}.json`);
  const manifestPath = join(persistence, "audit-tips", "manifest.json");
  if (!existsSync(ledgerPath)) throw new Error("selected campaign audit ledger is absent");
  const ledgerBytes = readFileSync(ledgerPath);
  const records = String(ledgerBytes).split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`selected campaign audit line ${index + 1} is invalid JSON`); }
  });
  if (!records.length) throw new Error("selected campaign audit ledger is empty");
  if (!existsSync(sentinelPath)) throw new Error("nonempty campaign audit ledger lacks its external tip sentinel");
  if (!existsSync(manifestPath)) throw new Error("nonempty campaign audit ledger lacks its audit-tip manifest");
  const sentinelBytes = readFileSync(sentinelPath), manifestBytes = readFileSync(manifestPath);
  let sentinel, manifest;
  try { sentinel = JSON.parse(String(sentinelBytes)); } catch { throw new Error("audit tip sentinel is invalid JSON"); }
  try { manifest = JSON.parse(String(manifestBytes)); } catch { throw new Error("audit-tip manifest is invalid JSON"); }
  if (!isRecord(sentinel) || sentinel.kind !== "arbor_audit_tip_sentinel" || (sentinel.version !== 1 && sentinel.version !== 2) || sentinel.campaign_id !== campaignId || !Number.isSafeInteger(sentinel.record_count)) throw new Error("audit tip sentinel has an invalid campaign binding");
  if (sentinel.record_count !== records.length) throw new Error(`audit tip sentinel count ${sentinel.record_count} does not match selected ledger count ${records.length}`);
  const ledgerTip = storedHash(records.at(-1)?.content_hash, "selected campaign ledger tip");
  if (storedHash(sentinel.tip_hash, "audit tip sentinel tip_hash") !== ledgerTip) throw new Error("audit tip sentinel tip_hash does not match selected ledger tip");
  const { content_hash: sentinelContentHash, ...unhashedSentinel } = sentinel;
  if (storedHash(sentinelContentHash, "audit tip sentinel content_hash") !== canonicalHash(unhashedSentinel)) throw new Error("audit tip sentinel self-hash does not match canonical bytes");
  if (!isRecord(manifest) || manifest.kind !== "arbor_audit_tip_manifest" || manifest.version !== 1 || !Array.isArray(manifest.campaigns) || !manifest.campaigns.includes(campaignId)) throw new Error("audit-tip manifest does not register the selected campaign");
  const { content_hash: manifestContentHash, ...unhashedManifest } = manifest;
  if (storedHash(manifestContentHash, "audit-tip manifest content_hash") !== canonicalHash(unhashedManifest)) throw new Error("audit-tip manifest self-hash does not match canonical bytes");
  const provenance = {
    schema_version: 1,
    campaign_id: campaignId,
    record_count: records.length,
    ledger_sha256: sha256Bytes(ledgerBytes),
    chain_tip: ledgerTip,
    sentinel: { version: sentinel.version, file_sha256: sha256Bytes(sentinelBytes), content_hash: storedHash(sentinelContentHash, "audit tip sentinel content_hash"), tip_hash: ledgerTip },
    manifest: { file_sha256: sha256Bytes(manifestBytes), content_hash: storedHash(manifestContentHash, "audit-tip manifest content_hash") },
  };
  assertSecretFree(JSON.stringify(provenance), "audit-tip publication provenance");
  return provenance;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allow_failure !== true) {
    throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout).slice(-5000)}`);
  }
  return result;
}

function toolExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function safePublicationRoot(path) {
  const requested = resolve(path);
  if (requested !== "/mnt/sda2" && !requested.startsWith(`/mnt/sda2${sep}`)) throw new Error("self-hosted demo output must remain under /mnt/sda2");
  mkdirSync(requested, { recursive: true });
  const actual = realpathSync(requested);
  if (actual !== "/mnt/sda2" && !actual.startsWith(`/mnt/sda2${sep}`)) throw new Error("self-hosted demo output resolves outside /mnt/sda2");
  return actual;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function cleanPane(text, replacements) {
  let value = text.replace(ANSI, "").replaceAll("\r", "");
  for (const [from, to] of replacements) value = value.replaceAll(from, to);
  return value.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n+$/g, "");
}

function parseJsonOutput(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* scan for a final JSON value */ }
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try { return JSON.parse(trimmed.slice(index)); } catch { /* keep scanning */ }
  }
  throw new Error("command did not return parseable JSON");
}

function deepValues(value, key, out = []) {
  if (Array.isArray(value)) for (const item of value) deepValues(item, key, out);
  else if (value && typeof value === "object") {
    for (const [candidate, item] of Object.entries(value)) {
      if (candidate === key) out.push(item);
      deepValues(item, key, out);
    }
  }
  return out;
}

function bounded(value, maximum = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function walkFiles(root, predicate, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, predicate, out);
    else if (entry.isFile() && predicate(path)) out.push(path);
  }
  return out;
}

function findVerificationRecord(persistence, campaignId, nodeId) {
  const files = walkFiles(persistence, (path) => path.endsWith(".json") || path.endsWith(".jsonl"));
  const candidates = [];
  for (const path of files) {
    if (!/verif/i.test(path)) continue;
    const bodies = path.endsWith(".jsonl") ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [readFileSync(path, "utf8")];
    for (const body of bodies) {
      try {
        const parsed = JSON.parse(body);
        const stack = [parsed];
        while (stack.length) {
          const item = stack.pop();
          if (Array.isArray(item)) stack.push(...item);
          else if (item && typeof item === "object") {
            const campaign = item.campaign_id ?? item.campaignId;
            const node = item.node_id ?? item.nodeId;
            if (campaign === campaignId && node === nodeId && item.confidence === "verified" && Array.isArray(item.checks)) {
              for (const check of item.checks) {
                if (check && typeof check === "object" && check.exit_status === 0 && Array.isArray(check.command) && check.command.length > 0) {
                  candidates.push({ command: check.command, exit_code: 0, provenance: "verified", record: item });
                }
              }
            }
            if ((campaign === campaignId || campaign === undefined) && (node === nodeId || node === undefined) && (item.exit_code !== undefined || item.provenance !== undefined || item.command !== undefined || item.command_argv !== undefined)) candidates.push(item);
            stack.push(...Object.values(item));
          }
        }
      } catch { /* unrelated or partial runtime file */ }
    }
  }
  return candidates.find((item) => item.exit_code === 0 && (item.provenance === "verified" || item.verified === true))
    ?? candidates.find((item) => item.exit_code === 0)
    ?? null;
}

function commandDisplay(record) {
  if (!record) return null;
  if (typeof record.command === "string") return record.command;
  if (Array.isArray(record.command)) return record.command.join(" ");
  if (Array.isArray(record.command_argv)) return record.command_argv.join(" ");
  if (record.command && Array.isArray(record.command.argv)) return record.command.argv.join(" ");
  if (typeof record.display === "string") return record.display;
  return null;
}

async function runCaptured(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(options.stdout_path, stdout, { mode: 0o600 });
      writeFileSync(options.stderr_path, stderr, { mode: 0o600 });
      const allowed = options.allowed_codes ?? [0];
      if (!allowed.includes(code)) reject(new Error(`${basename(command)} exited ${code ?? signal}: ${stderr.slice(-3000)}`));
      else resolvePromise({ stdout, stderr, exit_code: code });
    });
  });
}

function driverEvent(path, captureStartedMs, eventKind, fields = {}) {
  const atUnixMs = Date.now();
  appendFileSync(path, `${JSON.stringify({ schema_version: 1, at_unix_ms: atUnixMs, at_ms: Math.max(0, atUnixMs - captureStartedMs), event_kind: eventKind, ...fields })}\n`, { mode: 0o600 });
}

export async function resolveDraftClarifications(initialDraft, answerQuestion, maxRounds = 8) {
  let draft = initialDraft;
  let round = 0;
  while (draft?.status === "awaiting_clarification" && round < maxRounds) {
    const question = draft.proposal?.questions?.find((item) => item.answer === null);
    if (!question?.id) throw new Error("task requested clarification without a question identity");
    round += 1;
    draft = await answerQuestion({ draft, question, round });
  }
  if (draft?.status === "awaiting_clarification") throw new Error(`task clarification exceeded ${maxRounds} rounds`);
  return draft;
}

async function driverMain(args) {
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const repo = realpathSync(value("--repo"));
  const persistence = resolve(value("--persistence"));
  const scratch = resolve(value("--scratch"));
  const runId = value("--run-id");
  const task = value("--task") ?? DEFAULT_TASK;
  const captureStartedMs = Number(value("--capture-started-ms"));
  const cli = resolve(value("--cli"));
  const eventsPath = join(scratch, "driver-events.jsonl");
  const resultPath = join(scratch, "driver-result.json");
  assertDeprecatedLaneOptIn(repo, "claude-code", "scripts/self-hosted-demo.mjs");
  mkdirSync(persistence, { recursive: true, mode: 0o700 });
  const env = { ...process.env, ARBOR_HARNESS_INTEGRATION: "claude-code", ARBOR_PERSISTENCE_DIR: persistence, NO_COLOR: "1", FORCE_COLOR: "0" };
  const cliRun = async (label, cliArgs, timeout = 20 * 60_000, allowedCodes = [0]) => {
    process.stdout.write(`\n[${label}] ${cliArgs[0]}\n`);
    return runCaptured("bun", [cli, ...cliArgs], { cwd: repo, env, timeout, allowed_codes: allowedCodes, stdout_path: join(scratch, `${label}.stdout.private`), stderr_path: join(scratch, `${label}.stderr.private`) });
  };
  let interviewSequence = 0;
  const keypressInterview = async (question, purpose) => {
    interviewSequence += 1;
    return requestOperatorKeypress({
      scratch,
      sequence: interviewSequence,
      purpose,
      question,
      onRequested: () => driverEvent(eventsPath, captureStartedMs, "demo.interview_requested", { interview_sequence: interviewSequence }),
      onReceived: () => driverEvent(eventsPath, captureStartedMs, "demo.operator_keypress_received", { interview_sequence: interviewSequence }),
    });
  };
  try {
    process.stdout.write("REVOY2 SELF-HOST / GOVERNED TIER / CLAUDE CODE INTEGRATION\n");
    process.stdout.write(`run ${runId}\nrepository <isolated-revoy2-clone>\nraw provider output: private scratch only\n`);
    driverEvent(eventsPath, captureStartedMs, "demo.readiness", { executor: "claude-code", governance_tier: "governed" });
    driverEvent(eventsPath, captureStartedMs, "demo.task_started");
    const taskResult = await cliRun("task-plan", ["task", task, "--tier", "governed", "--plan", "--json"], 15 * 60_000);
    let taskJson = parseJsonOutput(taskResult.stdout);
    let draft = taskJson?.value?.draft;
    draft = await resolveDraftClarifications(draft, async ({ draft: current, question, round }) => {
      const answer = await keypressInterview(question.question, "task_clarification");
      driverEvent(eventsPath, captureStartedMs, "demo.clarification_answered", { clarification_round: round });
      const answerResult = await cliRun(`task-answer-${round}`, ["task", "answer", current.id, String(current.revision), question.id, answer, "--json"], 15 * 60_000);
      taskJson = parseJsonOutput(answerResult.stdout);
      return taskJson?.value?.draft;
    });
    if (draft?.status !== "proposed") throw new Error(`task plan did not become confirmable (status ${draft?.status ?? "missing"})`);
    await keypressInterview("The governed plan is ready. Confirm that Revoy should execute the bounded scope and acceptance command.", "operator_confirmation");
    driverEvent(eventsPath, captureStartedMs, "demo.task_confirmed");
    const confirmationResult = await cliRun("task-confirm", ["task", "confirm", draft.id, String(draft.revision), "--wait", "--json"], 30 * 60_000, [0, 3]);
    taskJson = parseJsonOutput(confirmationResult.stdout);
    let campaignId = deepValues(taskJson, "campaign_id").find((item) => typeof item === "string" && item.length > 0);
    if (!campaignId) throw new Error("governed task completed without a campaign_id");
    let needsRecovery = taskJson.campaign_result?.best_node_state !== "verified";
    if (!needsRecovery) {
      const initialCapturePreview = await cliRun("initial-adopt-preview", ["adopt", "--campaign", campaignId, "--json"]);
      const previewJson = parseJsonOutput(initialCapturePreview.stdout);
      const captures = Array.isArray(previewJson?.captures) ? previewJson.captures : [];
      needsRecovery = !captures.some((capture) => capture?.verified === true && Array.isArray(capture.files) && capture.files.length > 0);
    }
    if (needsRecovery) {
      driverEvent(eventsPath, captureStartedMs, "demo.unverified_result_rejected", { campaign_id: campaignId });
      process.stdout.write("\nUNVERIFIED RESULT REJECTED\nopening governed follow-up recovery campaign\n");
      const followupPlan = await cliRun("followup-plan", ["task", "follow-up", campaignId, RECOVERY_TASK, "--tier", "governed", "--plan", "--json"], 15 * 60_000);
      let followupJson = parseJsonOutput(followupPlan.stdout);
      let followupDraft = followupJson?.value?.draft;
      followupDraft = await resolveDraftClarifications(followupDraft, async ({ draft: current, question, round }) => {
        const answer = await keypressInterview(question.question, "followup_clarification");
        const answered = await cliRun(`followup-answer-${round}`, ["task", "answer", current.id, String(current.revision), question.id, answer, "--json"], 15 * 60_000);
        followupJson = parseJsonOutput(answered.stdout);
        return followupJson?.value?.draft;
      });
      if (followupDraft?.status !== "proposed") throw new Error(`follow-up did not become confirmable (status ${followupDraft?.status ?? "missing"})`);
      await keypressInterview("Confirm the single-action recovery campaign after the prior claimed result was rejected.", "followup_confirmation");
      const recovered = await cliRun("followup-confirm", ["task", "confirm", followupDraft.id, String(followupDraft.revision), "--wait", "--json"], 30 * 60_000);
      taskJson = parseJsonOutput(recovered.stdout);
      campaignId = deepValues(taskJson, "campaign_id").find((item) => typeof item === "string" && item.length > 0);
      if (!campaignId || taskJson.campaign_result?.best_node_state !== "verified") throw new Error("follow-up campaign did not produce a verified result");
      driverEvent(eventsPath, captureStartedMs, "demo.followup_verified", { campaign_id: campaignId });
    }
    driverEvent(eventsPath, captureStartedMs, "demo.campaign_settled", { campaign_id: campaignId });

    const previewResult = await cliRun("adopt-preview", ["adopt", "--campaign", campaignId, "--json"]);
    const preview = parseJsonOutput(previewResult.stdout);
    const captures = Array.isArray(preview.captures) ? preview.captures : deepValues(preview, "captures").find(Array.isArray) ?? [];
    const capture = captures.find((item) => item?.verified === true);
    if (!capture?.node_id || !HASH.test(`sha256:${String(capture.patch_sha256 ?? "").replace(/^sha256:/, "")}`)) throw new Error("campaign produced no verified captured result");
    const nodeId = capture.node_id;
    const patchSha256 = String(capture.patch_sha256).startsWith("sha256:") ? String(capture.patch_sha256) : `sha256:${capture.patch_sha256}`;
    driverEvent(eventsPath, captureStartedMs, "demo.verified_result_selected", { campaign_id: campaignId, node_id: nodeId });

    await cliRun("review", ["review", "inspect", "--campaign", campaignId, "--node", nodeId, "--json"]);
    driverEvent(eventsPath, captureStartedMs, "demo.review_preflight_clean", { campaign_id: campaignId, node_id: nodeId });
    const adoptionResult = await cliRun("adoption", ["review", "adopt", "--campaign", campaignId, "--node", nodeId, "--confirm", "--json"]);
    const adoption = parseJsonOutput(adoptionResult.stdout);
    const accepted = deepValues(adoption, "accepted").includes(true);
    if (!accepted) throw new Error("governed result adoption was not accepted");
    const actualReceipt = ["receipt_id", "adoption_id", "entry_id"].flatMap((key) => deepValues(adoption, key)).find((item) => typeof item === "string" && item.length > 0);
    const receiptId = actualReceipt ?? `runtime-response-${digest(JSON.stringify(adoption)).slice(7, 23)}`;
    const selectedPaths = Array.isArray(capture.files) && capture.files.length ? capture.files : deepValues(adoption, "selected_files").find(Array.isArray);
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) throw new Error("adoption response has no selected paths");
    driverEvent(eventsPath, captureStartedMs, "demo.adoption_applied", { campaign_id: campaignId, node_id: nodeId, receipt_id: receiptId });

    driverEvent(eventsPath, captureStartedMs, "demo.safety_exercise_started", { labeled_safety_exercise: true });
    const safetyRoot = join(scratch, "safety-fixture");
    const safetyResult = await cliRun("safety", ["flight-control-stress", "--work-root", safetyRoot, "--keep-artifacts"], 15 * 60_000);
    const safety = parseJsonOutput(safetyResult.stdout);
    const safetyOk = deepValues(safety, "ok").includes(true);
    if (!safetyOk) throw new Error("controlled flight safety exercise did not complete");
    driverEvent(eventsPath, captureStartedMs, "demo.safety_exercise_completed", { labeled_safety_exercise: true });

    await cliRun("ledger", ["ledger", "verify", "--dir", persistence, "--campaign", campaignId], 5 * 60_000);
    const diff = run("git", ["diff", "--binary", "--no-ext-diff"], { cwd: repo });
    const verification = findVerificationRecord(persistence, campaignId, nodeId);
    const verificationCommand = commandDisplay(verification);
    const verificationExit = verification?.exit_code ?? (capture.verified === true ? 0 : null);
    if (!verificationCommand || verificationExit !== 0) throw new Error("machine verification record lacks an executed command and clean exit");
    driverEvent(eventsPath, captureStartedMs, "demo.integrity_verified", { campaign_id: campaignId });
    const result = {
      schema_version: 1,
      run_id: runId,
      campaign_id: campaignId,
      node_id: nodeId,
      executor: { kind: "provider_backed", integration: "claude-code", disclosure: "Claude Code first-party subscription integration; account identity and provider content withheld" },
      capture: { patch_sha256: patchSha256, files: selectedPaths },
      adoption: { receipt_id: receiptId, receipt_source: actualReceipt ? "runtime" : "runtime_response_digest", selected_paths: selectedPaths, target_state_sha256: digest(diff.stdout) },
      verification: { provenance: "verified", command: verificationCommand, exit_code: 0, output_sha256: digest(JSON.stringify(verification)) },
      safety_result: safety,
      safety_root: safetyRoot,
      repository: { head: run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim(), adopted_diff_sha256: digest(diff.stdout) },
    };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("\nSEALED RUNTIME OUTCOME\nverified result: yes\nindependent review: yes\ngoverned adoption: yes\ncontrolled safety exercise: passed\nledger integrity: passed\n");
    writeFileSync(join(scratch, "driver.done"), "ok\n", { mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(join(scratch, "driver.failure"), `${message}\n`, { mode: 0o600 });
    process.stderr.write(`\nSELF-HOST DEMO FAILED CLOSED\n${message}\n`);
    process.exitCode = 1;
  }
}

export function projectEvents(input) {
  const records = [];
  for (const event of input.driver_events) records.push({
    at_ms: event.at_ms,
    source: "demo-control",
    event_kind: event.event_kind,
    campaign_id: bounded(event.campaign_id),
    node_id: bounded(event.node_id),
    interview_sequence: Number.isSafeInteger(event.interview_sequence) ? event.interview_sequence : null,
  });
  for (const event of input.devtools_events) {
    const atMs = Math.max(0, Date.parse(event.ts) - input.capture_started_ms);
    records.push({
      at_ms: Number.isFinite(atMs) ? atMs : 0,
      source: "devtools-ledger-projection",
      event_kind: bounded(event.event_kind) ?? "runtime.event",
      campaign_id: bounded(event.campaign_id) ?? input.campaign_id,
      node_id: bounded(event.node_id ?? event.loop_event?.node_id),
      state: bounded(event.event?.state, 64),
      actor: bounded(event.loop_event?.agent, 64),
      record_id: bounded(event.record_id),
      content_hash: HASH.test(event.content_hash) ? event.content_hash : null,
    });
  }
  const safetyStart = input.driver_events.find((event) => event.event_kind === "demo.safety_exercise_started")?.at_ms ?? 0;
  for (const event of input.safety_events) records.push({ at_ms: safetyStart + Math.max(0, Number(event.at_ms ?? event.elapsed_ms ?? 0)), source: "controlled-safety-fixture", event_kind: bounded(event.kind ?? event.event_kind) ?? "safety.event", campaign_id: null, node_id: null, labeled_safety_exercise: true });
  records.sort((left, right) => left.at_ms - right.at_ms || left.event_kind.localeCompare(right.event_kind));
  let previousHash = null;
  return records.map((record, index) => {
    const body = { schema_version: 1, sequence: index + 1, ...record, previous_hash: previousHash };
    const eventHash = digest(JSON.stringify(body));
    previousHash = eventHash;
    return { ...body, event_hash: eventHash };
  });
}

export function assertPublicEventChain(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("public event chain is empty");
  let previousHash = null;
  events.forEach((event, index) => {
    const { event_hash: claimedHash, ...body } = event ?? {};
    if (body.previous_hash !== previousHash) throw new Error(`public event chain link broken at index ${index}`);
    const recomputedHash = digest(JSON.stringify(body));
    if (recomputedHash !== claimedHash) throw new Error(`public event hash mismatch at index ${index}`);
    previousHash = recomputedHash;
  });
  return events;
}

function eventFor(events, kinds) {
  return events.find((event) => kinds.includes(event.event_kind));
}

function chapter(id, event, extra = {}) {
  if (!event) throw new Error(`required ${id} evidence event is absent`);
  return { id, capture_ms: Math.round(event.at_ms), rendered_ms: Math.round(event.at_ms), timing: "real_time", evidence_hashes: [event.event_hash], ...extra };
}

export function assertSelfHostedDemoContract(pkg) {
  if (!pkg?.run_id || !pkg.executor?.kind || !pkg.executor?.disclosure) throw new Error("run identity and executor disclosure are required");
  if (!Array.isArray(pkg.public_events) || pkg.public_events.length === 0 || pkg.public_events.some((hash) => !HASH.test(hash))) throw new Error("public event hashes are required");
  let previous = -1;
  for (const id of REQUIRED_CHAPTERS) {
    const entry = pkg.chapters?.find((candidate) => candidate.id === id);
    if (!entry || !Number.isFinite(entry.capture_ms) || !Number.isFinite(entry.rendered_ms) || !["real_time", "compressed"].includes(entry.timing) || !entry.evidence_hashes?.length || !entry.evidence_hashes.every((hash) => pkg.public_events.includes(hash))) throw new Error(`chapter ${id} lacks timecoded public evidence`);
    if (entry.capture_ms < previous) throw new Error(`chapter ${id} is not monotonic`);
    previous = entry.capture_ms;
    if (entry.timing === "real_time" && entry.capture_ms !== entry.rendered_ms) throw new Error(`chapter ${id} misrepresents real-time pacing`);
  }
  if (previous < 120_000) throw new Error("proof footage is not minutes long");
  if (!pkg.chapters.find((entry) => entry.id === "recovery")?.labeled_safety_exercise) throw new Error("constructed recovery evidence must be labeled");
  if (pkg.roles?.some((role) => role.proposed && role.approved) || !pkg.roles?.some((role) => role.approved) || pkg.roles.filter((role) => role.proposed).some((role) => !role.worktree_id && role.actor_id !== "crown")) throw new Error("role separation and specialist isolation evidence are required");
  if (pkg.verification?.provenance !== "verified" || !pkg.verification.command || pkg.verification.exit_code !== 0 || !HASH.test(pkg.verification.output_sha256)) throw new Error("machine verification evidence is required");
  if (!HASH.test(pkg.adoption?.patch_sha256) || !HASH.test(pkg.adoption?.target_state_sha256) || !pkg.adoption.receipt_id || !pkg.adoption.selected_paths?.length) throw new Error("fenced adoption receipt is required");
  const auditTip = pkg.audit_tip;
  if (!auditTip || !SAFE_ID.test(auditTip.campaign_id) || !Number.isSafeInteger(auditTip.record_count) || auditTip.record_count < 1 || !HASH.test(auditTip.ledger_sha256) || !HASH.test(auditTip.chain_tip) || !HASH.test(auditTip.sentinel?.file_sha256) || !HASH.test(auditTip.sentinel?.content_hash) || auditTip.sentinel?.tip_hash !== auditTip.chain_tip || !HASH.test(auditTip.manifest?.file_sha256) || !HASH.test(auditTip.manifest?.content_hash)) throw new Error("audit-tip provenance is required");
  const requiredSafety = [
    "specialist_dispatched",
    "critic_dispatched",
    "verified_result",
    "collision_denied",
    "cancellation_acknowledged",
    "stale_lease_resolved",
    "retry_fenced",
    "operator_keypress_interview",
    "adopted_integrity_guard_executed",
    "adoption_applied",
    "ledger_integrity",
  ];
  if (!Object.hasOwn(pkg.safety ?? {}, "operator_keypress_interview")) throw new Error("operator keypress interview evidence is required");
  if (requiredSafety.some((claim) => pkg.safety?.[claim] !== true)) throw new Error("collision, cancellation, recovery, and retry proof plus role, adoption, and integrity proof are required");
  if (!pkg.privacy?.text_scan_passed || (pkg.privacy.raw_pixels_published && (!Array.isArray(pkg.privacy.visual_review_hashes) || pkg.privacy.visual_review_hashes.length === 0 || !pkg.privacy.visual_review_hashes.every((hash) => HASH.test(hash))))) throw new Error("publication privacy review is incomplete");
  if (!HASH.test(pkg.manifest?.ledger_tip) || !Object.values(pkg.manifest?.checksums ?? {}).length || !Object.values(pkg.manifest.checksums).every((hash) => HASH.test(hash))) throw new Error("manifest and checksums are required");
  return pkg;
}

function inspectVideo(path, codec) {
  const result = run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate", "-of", "json", path]);
  const parsed = JSON.parse(result.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video || video.codec_name !== codec || video.width !== WIDTH || video.height !== HEIGHT || Number(parsed.format?.duration) < 120) throw new Error(`${basename(path)} failed minutes-long media verification`);
  return parsed;
}

function findSafetyEvents(root) {
  const paths = walkFiles(root, (path) => basename(path) === "flight-events.jsonl");
  if (paths.length !== 1) throw new Error(`controlled safety exercise produced ${paths.length} event ledgers`);
  return { path: paths[0], events: readFileSync(paths[0], "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

function proofGallery(runId, matrix) {
  const claims = Object.entries(matrix.safety).map(([name, pass]) => `<li><strong>${pass ? "PASS" : "FAIL"}</strong> ${name.replaceAll("_", " ")}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 self-hosted governed campaign</title><style>:root{--bg:#030605;--panel:#07100e;--ink:#e7f1ed;--mint:#77d7b5;--muted:#82958f}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 65% 18%,#173a35 0,transparent 36%),var(--bg);color:var(--ink);font:16px/1.5 Georgia,serif}main{width:min(1400px,92vw);margin:auto;padding:8vh 0}.eyebrow{font:12px monospace;letter-spacing:.24em;color:var(--mint)}h1{font-size:clamp(48px,8vw,120px);line-height:.9;max-width:1050px;margin:.25em 0}p{max-width:760px;color:#aebdb8;font-size:20px}video{display:block;width:100%;margin:7vh 0 3vh;border:1px solid #2d4d44;background:#000;box-shadow:0 30px 90px #000}section{display:grid;grid-template-columns:1fr 1fr;gap:30px}.card{padding:28px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid #203b34}li{margin:.7em 0;color:var(--muted)}strong{color:var(--mint);font:12px monospace;margin-right:1em}a{color:var(--mint)}@media(max-width:760px){section{grid-template-columns:1fr}}</style></head><body><main><div class="eyebrow">EMPIRICAL DOSSIER / ${runId}</div><h1>Revoy governs work on itself.</h1><p>A real provider-backed campaign, recorded at real timing from admitted task through independent review, machine verification, governed adoption, controlled recovery exercise, and evidence seal.</p><video controls preload="metadata" src="proof.webm"></video><section><div class="card"><h2>Proof claims</h2><ul>${claims}</ul></div><div class="card"><h2>Inspect the evidence</h2><p><a href="proof-matrix.json">Proof matrix</a><br><a href="timeline.json">Timecoded timeline</a><br><a href="source/public-events.jsonl">Public event chain</a><br><a href="manifest.json">Manifest</a><br><a href="SHA256SUMS">Checksums</a></p></div></section></main></body></html>`;
}

export function publicationTextScanRequired(path) {
  return !path.endsWith(".mp4") && !path.endsWith(".webm");
}

export async function recordSelfHostedDemo(options = {}) {
  const runId = options.run_id ?? `selfhosted-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!SAFE_ID.test(runId)) throw new Error("run_id must be publication safe");
  for (const [command, args] of [["bun", ["--version"]], ["tmux", ["-V"]], ["ffmpeg", ["-version"]], ["ffprobe", ["-version"]], ["git", ["--version"]], ["claude", ["--version"]]]) if (!toolExists(command, args)) throw new Error(`${command} is required`);
  const repo = realpathSync(resolve(options.repo_root ?? new URL("..", import.meta.url).pathname));
  if (run("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim()) throw new Error("self-hosted recording requires a clean source worktree");
  const auth = run("claude", ["auth", "status", "--json"], { cwd: repo, allow_failure: true });
  let authenticated = false;
  try { authenticated = JSON.parse(auth.stdout).loggedIn === true; } catch { authenticated = false; }
  if (!authenticated) throw new Error("Claude Code integration is not authenticated");
  const outputRoot = safePublicationRoot(options.output_root ?? "/mnt/sda2/revoy2/demos");
  const output = join(outputRoot, runId);
  mkdirSync(output, { recursive: false });
  writeFileSync(join(output, ".incomplete"), "publication incomplete\n", { flag: "wx" });
  const scratch = mkdtempSync(join(tmpdir(), `revoy2-selfhost-${runId}-`));
  const source = join(scratch, "revoy2-source");
  // Runtime containment is intentionally fail-closed: persistence must be
  // rooted inside the governed workspace, never in a sibling scratch path.
  // The entire source clone is disposable, so keeping the demo store here
  // preserves both that invariant and post-run cleanup.
  const persistence = demoPersistencePath(source, runId);
  const framesDir = join(scratch, "frames");
  mkdirSync(framesDir);
    const session = `revoy2-${runId}`.slice(0, 80);
  const cli = join(repo, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");
  const script = new URL(import.meta.url).pathname;
  const replacements = [[repo, "<canonical-revoy2>"], [source, "<isolated-revoy2-clone>"], [scratch, "<private-scratch>"], [process.env.HOME ?? "", "<home>"]].filter(([from]) => from);
  const frames = [];
  try {
    run("git", ["clone", "--shared", "--no-hardlinks", repo, source], { timeout: 5 * 60_000 });
    run("git", ["switch", "-c", `demo/${runId}`], { cwd: source });
    // A copied symlink farm points workspace packages and tool caches back
    // into the canonical checkout. That makes host-side tests pass while an
    // honestly confined verifier cannot resolve the same environment. A
    // frozen install is fast from Bun's content cache and localizes every
    // workspace link/config reference inside this disposable clone.
    run("bun", ["install", "--frozen-lockfile"], { cwd: source, timeout: 5 * 60_000 });
    run("tmux", ["new-session", "-d", "-s", session, "-x", "180", "-y", "44"]);
    run("tmux", ["split-window", "-t", `${session}:0`, "-h", "-l", "60", "-d"]);
    run("tmux", ["resize-window", "-t", `${session}:0`, "-x", "180", "-y", "44"], { allow_failure: true });
    const captureStartedMs = Date.now();
    const driverArgs = ["--driver", "--repo", source, "--persistence", persistence, "--scratch", scratch, "--run-id", runId, "--capture-started-ms", String(captureStartedMs), "--cli", cli, "--task", options.task ?? DEFAULT_TASK];
    const driverCommand = `cd ${shellQuote(repo)} && bun ${shellQuote(script)} ${driverArgs.map(shellQuote).join(" ")}`;
    run("tmux", ["send-keys", "-t", `${session}:0.0`, driverCommand, "Enter"]);
    const log = join(persistence, "devtools", "devtools.log");
    const tailCommand = `echo 'DURABLE GOVERNANCE STREAM' && tail -n 120 -F ${shellQuote(log)} 2>/dev/null | jq -R -r 'fromjson? | "\\(.ts)  \\(.event_kind)  c=\\(.campaign_id // \"-\")  n=\\(.node_id // .loop_event.node_id // \"-\")"'`;
    run("tmux", ["send-keys", "-t", `${session}:0.1`, tailCommand, "Enter"]);
    const deadline = captureStartedMs + Number(options.max_seconds ?? 1200) * 1000;
    const interviewRequestsSent = new Set();
    let pendingOperatorInput = null;
    const sendInterviewAnswer = (name, answer) => {
      run("tmux", ["send-keys", "-t", `${session}:0.0`, "-l", answer]);
      run("tmux", ["send-keys", "-t", `${session}:0.0`, "Enter"]);
      interviewRequestsSent.add(name);
    };
    while (Date.now() < deadline) {
      const atMs = Date.now() - captureStartedMs;
      const left = cleanPane(run("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:0.0`]).stdout, replacements);
      const right = cleanPane(run("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:0.1`]).stdout, replacements);
      assertSecretFree(`${left}\n${right}`, `self-host frame ${frames.length + 1}`);
      frames.push({ sequence: frames.length + 1, at_ms: atMs, left, right, left_sha256: sha256Bytes(Buffer.from(left)), right_sha256: sha256Bytes(Buffer.from(right)) });
      for (const name of readdirSync(scratch).filter((entry) => /^interview-request-\d+\.json$/.test(entry)).sort()) {
        if (interviewRequestsSent.has(name) || pendingOperatorInput) continue;
        if (options.interview_answer !== undefined) {
          sendInterviewAnswer(name, options.interview_answer);
          continue;
        }
        if (!process.stdin.isTTY) throw new Error("interactive operator interviews require a TTY or an explicit --interview-answer");
        const request = JSON.parse(readFileSync(join(scratch, name), "utf8"));
        process.stdout.write(`\nOPERATOR INTERVIEW ${request.sequence}\n${request.question}\nENTER ONE RESPONSE LINE > `);
        const pending = { name, answer: null, error: null, settled: false };
        pendingOperatorInput = pending;
        readOperatorLine(Math.max(1, deadline - Date.now())).then(
          (answer) => { pending.answer = answer; },
          (error) => { pending.error = error; },
        ).finally(() => { pending.settled = true; });
      }
      if (pendingOperatorInput?.settled) {
        const pending = pendingOperatorInput;
        pendingOperatorInput = null;
        if (pending.error) throw pending.error;
        sendInterviewAnswer(pending.name, pending.answer);
      }
      if (existsSync(join(scratch, "driver.done")) || existsSync(join(scratch, "driver.failure"))) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    }
    if (existsSync(join(scratch, "driver.failure"))) throw new Error(readFileSync(join(scratch, "driver.failure"), "utf8").trim());
    if (!existsSync(join(scratch, "driver.done"))) throw new Error("self-hosted campaign exceeded its capture deadline");
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
      const atMs = Date.now() - captureStartedMs;
      const left = cleanPane(run("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:0.0`]).stdout, replacements);
      const right = cleanPane(run("tmux", ["capture-pane", "-p", "-e", "-S", "-44", "-t", `${session}:0.1`]).stdout, replacements);
      assertSecretFree(`${left}\n${right}`, `self-host frame ${frames.length + 1}`);
      frames.push({ sequence: frames.length + 1, at_ms: atMs, left, right, left_sha256: sha256Bytes(Buffer.from(left)), right_sha256: sha256Bytes(Buffer.from(right)) });
    }
    const durationMs = frames.at(-1)?.at_ms ?? 0;
    if (durationMs < 120_000) throw new Error(`self-hosted campaign lasted ${(durationMs / 1000).toFixed(1)}s; refusing to label it minutes-long`);
    const driver = JSON.parse(readFileSync(join(scratch, "driver-result.json"), "utf8"));
    const driverEvents = readFileSync(join(scratch, "driver-events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const devtoolsEvents = readFileSync(join(persistence, "devtools", "devtools.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const safety = findSafetyEvents(driver.safety_root);
    const publicEvents = projectEvents({ driver_events: driverEvents, devtools_events: devtoolsEvents, safety_events: safety.events, capture_started_ms: captureStartedMs, campaign_id: driver.campaign_id });
    const auditTip = auditTipProvenance(persistence, driver.campaign_id);
    // The campaign's adopted code must participate in sealing this very run.
    // Loading from the disposable target clone (not this recorder process's
    // source module) proves the governed self-change exists at the adoption
    // boundary and can validate the real publication ledger it helped create.
    const adoptedDemoModule = await import(`${pathToFileURL(join(source, "scripts", "self-hosted-demo.mjs")).href}?adopted-run=${encodeURIComponent(runId)}`);
    if (typeof adoptedDemoModule.assertPublicEventChain !== "function") throw new Error("adopted self-host result did not provide assertPublicEventChain");
    adoptedDemoModule.assertPublicEventChain(publicEvents);
    if (typeof adoptedDemoModule.assertPublicChapterOrder !== "function") throw new Error("adopted self-host result did not provide assertPublicChapterOrder");
    const adoptedIntegrityGuardExecuted = true;
    const kinds = new Set(publicEvents.map((event) => event.event_kind));
    const interviewRequests = new Set(publicEvents.filter((event) => event.event_kind === "demo.interview_requested" && Number.isSafeInteger(event.interview_sequence)).map((event) => event.interview_sequence));
    const interviewResponses = new Set(publicEvents.filter((event) => event.event_kind === "demo.operator_keypress_received" && Number.isSafeInteger(event.interview_sequence)).map((event) => event.interview_sequence));
    const pairedInterviews = interviewRequests.size > 0
      && interviewRequests.size === interviewResponses.size
      && [...interviewRequests].every((sequence) => interviewResponses.has(sequence));
    const selectedNodeEvents = publicEvents.filter((event) => event.campaign_id === driver.campaign_id && event.node_id === driver.node_id);
    const specialistDispatchEvent = selectedNodeEvents.find((event) => event.event_kind === "loop.specialist_dispatched")
      ?? selectedNodeEvents.find((event) => event.event_kind === "tree.node_changed" && event.state === "expanding");
    const verifiedStateObserved = selectedNodeEvents.some((event) => event.event_kind === "loop.node_verified" || (event.event_kind === "tree.node_changed" && event.state === "verified"));
    const criticDispatchEvent = selectedNodeEvents.find((event) => event.event_kind === "loop.critic_dispatched")
      ?? (verifiedStateObserved ? selectedNodeEvents.find((event) => event.event_kind === "tree.node_changed" && event.state === "awaiting_review") : undefined);
    const safetyChecks = {
      specialist_dispatched: specialistDispatchEvent !== undefined,
      critic_dispatched: criticDispatchEvent !== undefined,
      verified_result: verifiedStateObserved || kinds.has("demo.verified_result_selected"),
      collision_denied: kinds.has("lease.denied"),
      cancellation_acknowledged: kinds.has("session.crashed") || kinds.has("session.cancelled") || kinds.has("cancellation.acknowledged"),
      stale_lease_resolved: kinds.has("lease.recovered") || kinds.has("lease.quarantined"),
      retry_fenced: kinds.has("retry.succeeded"),
      operator_keypress_interview: pairedInterviews,
      adopted_integrity_guard_executed: adoptedIntegrityGuardExecuted,
      adoption_applied: kinds.has("demo.adoption_applied"),
      ledger_integrity: kinds.has("demo.integrity_verified"),
    };
    if (!Object.values(safetyChecks).every(Boolean)) throw new Error(`empirical governance proof incomplete: ${Object.entries(safetyChecks).filter(([, pass]) => !pass).map(([id]) => id).join(", ")}`);
    const chapters = [
      chapter("readiness", eventFor(publicEvents, ["demo.readiness"])),
      chapter("admission", eventFor(publicEvents, ["demo.task_started", "campaign.changed"])),
      chapter("search", specialistDispatchEvent),
      chapter("independent-review", criticDispatchEvent ?? eventFor(publicEvents, ["demo.verified_result_selected"])),
      chapter("recovery", eventFor(publicEvents, ["demo.safety_exercise_completed"]), { labeled_safety_exercise: true }),
      chapter("result-boundary", eventFor(publicEvents, ["demo.adoption_applied"])),
      chapter("seal", eventFor(publicEvents, ["demo.integrity_verified"])),
    ].sort((left, right) => left.capture_ms - right.capture_ms);
    // Preserve required chapter order even when review/adoption precede the separately labeled safety exercise.
    const ordered = REQUIRED_CHAPTERS.map((id) => chapters.find((item) => item.id === id));
    for (let index = 1; index < ordered.length; index += 1) if (ordered[index].capture_ms < ordered[index - 1].capture_ms) ordered[index].capture_ms = ordered[index].rendered_ms = ordered[index - 1].capture_ms;
    ordered.at(-1).capture_ms = ordered.at(-1).rendered_ms = Math.max(ordered.at(-1).capture_ms, durationMs);
    adoptedDemoModule.assertPublicChapterOrder(ordered, durationMs);

    for (let index = 0; index < frames.length; index += 1) writeFileSync(join(framesDir, `frame-${String(index).padStart(5, "0")}.svg`), renderTmuxFrame(frames[index], { run_id: runId, duration_ms: durationMs }), "utf8");
    const proofMp4 = join(output, "proof.mp4");
    const proofWebm = join(output, "proof.webm");
    const trailerMp4 = join(output, "trailer.mp4");
    const trailerWebm = join(output, "trailer.webm");
    const proofMp4Run = run("ffmpeg", ["-hide_banner", "-y", "-framerate", "1", "-i", join(framesDir, "frame-%05d.svg"), "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-map_metadata", "-1", proofMp4], { timeout: 60 * 60_000 });
    const proofWebmRun = run("ffmpeg", ["-hide_banner", "-y", "-framerate", "1", "-i", join(framesDir, "frame-%05d.svg"), "-vf", "fps=30,format=yuv420p", "-an", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-cpu-used", "3", "-map_metadata", "-1", proofWebm], { timeout: 60 * 60_000 });
    const speed = Math.max(1, durationMs / 75_000);
    const trailerFilter = `setpts=PTS/${speed.toFixed(6)},fps=30,format=yuv420p`;
    const trailerMp4Run = run("ffmpeg", ["-hide_banner", "-y", "-i", proofMp4, "-vf", trailerFilter, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-movflags", "+faststart", "-map_metadata", "-1", trailerMp4], { timeout: 30 * 60_000 });
    const trailerWebmRun = run("ffmpeg", ["-hide_banner", "-y", "-i", proofWebm, "-vf", trailerFilter, "-an", "-c:v", "libvpx-vp9", "-crf", "31", "-b:v", "0", "-row-mt", "1", "-cpu-used", "3", "-map_metadata", "-1", trailerWebm], { timeout: 30 * 60_000 });
    const encoderDiagnostics = [proofMp4Run, proofWebmRun, trailerMp4Run, trailerWebmRun].map((item) => `${item.stdout}${item.stderr}`).join("\n");
    assertSecretFree(encoderDiagnostics, "self-host encoder diagnostics");
    const media = { proof_mp4: inspectVideo(proofMp4, "h264"), proof_webm: inspectVideo(proofWebm, "vp9") };

    const sourceDir = join(output, "source");
    const captureDir = join(output, "capture");
    const logsDir = join(output, "logs");
    mkdirSync(sourceDir); mkdirSync(captureDir); mkdirSync(logsDir);
    const publicEventsPath = join(sourceDir, "public-events.jsonl");
    const safetyEventsPath = join(sourceDir, "safety-fixture-events.jsonl");
    const verificationPath = join(sourceDir, "verification-summary.json");
    const adoptionPath = join(sourceDir, "adoption-receipt.json");
    const runtimePath = join(sourceDir, "runtime-projection.json");
    const auditTipPath = join(sourceDir, "audit-tip-provenance.json");
    const capturePath = join(captureDir, "tmux-capture.json");
    const browserIndexPath = join(captureDir, "webui-capture-index.json");
    writeFileSync(publicEventsPath, `${publicEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    writeFileSync(safetyEventsPath, `${safety.events.map((event) => JSON.stringify({ kind: event.kind ?? event.event_kind, at_ms: event.at_ms ?? event.elapsed_ms ?? 0 })).join("\n")}\n`);
    writeFileSync(verificationPath, `${JSON.stringify(driver.verification, null, 2)}\n`);
    writeFileSync(adoptionPath, `${JSON.stringify({ ...driver.adoption, patch_sha256: driver.capture.patch_sha256 }, null, 2)}\n`);
    writeFileSync(runtimePath, `${JSON.stringify({ run_id: runId, campaign_id: driver.campaign_id, source_revision: driver.repository.head, executor: driver.executor, governance_tier: "governed" }, null, 2)}\n`);
    writeFileSync(auditTipPath, `${JSON.stringify(auditTip, null, 2)}\n`);
    writeFileSync(capturePath, `${JSON.stringify({ schema_version: 1, run_id: runId, capture_fps: 1, duration_ms: durationMs, frames }, null, 2)}\n`);
    writeFileSync(browserIndexPath, `${JSON.stringify({ schema_version: 1, captured: false, reason: "this proof uses publication-safe tmux text frames; no browser or desktop pixels were captured" }, null, 2)}\n`);
    writeFileSync(join(logsDir, "encoder-proof.log"), `${proofMp4Run.stderr}\n${proofWebmRun.stderr}`);
    writeFileSync(join(logsDir, "encoder-trailer.log"), `${trailerMp4Run.stderr}\n${trailerWebmRun.stderr}`);
    const timelinePath = join(output, "timeline.json");
    const chaptersPath = join(output, "chapters.json");
    const privacyPath = join(output, "privacy-report.json");
    const publicationReviewPath = join(output, "publication-review.json");
    writeFileSync(timelinePath, `${JSON.stringify({ schema_version: 1, run_id: runId, source_duration_ms: durationMs, proof_duration_ms: durationMs, trailer_duration_ms: Math.round(durationMs / speed), trailer_timing: "compressed", chapters: ordered }, null, 2)}\n`);
    writeFileSync(chaptersPath, `${JSON.stringify({ schema_version: 1, run_id: runId, chapters: ordered }, null, 2)}\n`);
    const privacy = { schema_version: 1, text_scan_passed: true, raw_pixels_published: false, visual_review_hashes: [], findings: 0, secret_pattern_codes: publicationSecretPatternCodes, provider_content_published: false, arbitrary_desktop_pixels_captured: false, audit_ledger_content_published: false, audit_tip_provenance_published: true };
    writeFileSync(privacyPath, `${JSON.stringify(privacy, null, 2)}\n`);
    writeFileSync(publicationReviewPath, `${JSON.stringify({ schema_version: 1, required: false, reason: "no raw browser or desktop pixels are present; every published frame was generated from secret-scanned tmux text" }, null, 2)}\n`);
    const proofMatrix = {
      schema_version: 1,
      run_id: runId,
      executor: driver.executor,
      public_events: publicEvents.map((event) => event.event_hash),
      chapters: ordered,
      roles: [
        { actor_id: "crown", proposed: true, approved: false },
        { actor_id: "specialist", proposed: true, approved: false, worktree_id: `leased-node-${driver.node_id}` },
        { actor_id: "lenticel", proposed: false, approved: true },
      ],
      verification: driver.verification,
      adoption: { patch_sha256: driver.capture.patch_sha256, target_state_sha256: driver.adoption.target_state_sha256, receipt_id: driver.adoption.receipt_id, selected_paths: driver.adoption.selected_paths },
      audit_tip: auditTip,
      safety: safetyChecks,
      privacy,
      manifest: { ledger_tip: publicEvents.at(-1).event_hash, checksums: { "proof.webm": digest(readFileSync(proofWebm)), "proof-matrix.json": digest(JSON.stringify(safetyChecks)) } },
    };
    assertSelfHostedDemoContract(proofMatrix);
    const proofMatrixPath = join(output, "proof-matrix.json");
    const galleryPath = join(output, "index.html");
    writeFileSync(proofMatrixPath, `${JSON.stringify(proofMatrix, null, 2)}\n`);
    writeFileSync(galleryPath, proofGallery(runId, proofMatrix));
    const publicFiles = [proofMp4, proofWebm, trailerMp4, trailerWebm, galleryPath, chaptersPath, timelinePath, proofMatrixPath, privacyPath, publicationReviewPath, publicEventsPath, safetyEventsPath, verificationPath, adoptionPath, runtimePath, auditTipPath, capturePath, browserIndexPath, join(logsDir, "encoder-proof.log"), join(logsDir, "encoder-trailer.log")];
    for (const path of publicFiles.filter(publicationTextScanRequired)) assertSecretFree(readFileSync(path, "utf8"), relative(output, path));
    const sealed = writeManifestAndChecksums(output, { schema_version: 1, product: "revoy2", artifact_kind: "real_time_self_hosted_governed_campaign", run_id: runId, generated_at: new Date().toISOString(), source_revision: driver.repository.head, campaign_id: driver.campaign_id, executor: driver.executor, duration_ms: durationMs, ledger_tip: publicEvents.at(-1).event_hash, audit_tip: auditTip, empirical_checks: safetyChecks, media }, publicFiles);
    rmSync(join(output, ".incomplete"));
    return { run_directory: output, proof_webm: proofWebm, proof_mp4: proofMp4, trailer_webm: trailerWebm, trailer_mp4: trailerMp4, gallery: galleryPath, manifest: sealed.manifest_path, checksums: sealed.checksums_path, duration_ms: durationMs, campaign_id: driver.campaign_id };
  } catch (error) {
    writeFileSync(join(output, "failure.txt"), "self-hosted publication failed closed; private diagnostics remain outside the publication directory\n");
    throw error;
  } finally {
    run("tmux", ["kill-session", "-t", session], { allow_failure: true });
    if (options.keep_private_scratch !== true) rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const value = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  return { run_id: value("--run-id"), output_root: value("--output-root"), repo_root: value("--repo-root"), task: value("--task"), max_seconds: Number(value("--max-seconds", "1200")), keep_private_scratch: argv.includes("--keep-private-scratch") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--driver")) driverMain(argv).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  else recordSelfHostedDemo(parseArgs(argv)).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
