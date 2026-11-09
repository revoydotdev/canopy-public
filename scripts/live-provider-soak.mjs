#!/usr/bin/env node
/**
 * Opt-in G-09 live-provider soak.
 *
 * Success is derived from durable campaign evidence, never from process exit:
 * `arbor run` intentionally exits zero after a graceful SIGTERM, so an
 * exit-code-only wrapper can otherwise turn an externally stopped run into a
 * false provider attestation. The soak stops as soon as one campaign records
 * both a successful specialist model identity and positive provider-counter
 * usage. It is intentionally absent from pull-request CI.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const DEFAULT_MODEL = "openrouter/~deepseek/deepseek-v4-flash-latest";
const DEFAULT_CRITIC_MODEL = "openrouter/~openai/gpt-mini-latest";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARBOR_BIN = join(REPO_ROOT, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs");

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function json(path) {
  try {
    if (statSync(path).size > MAX_EVIDENCE_FILE_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    return record(value) ? value : null;
  } catch { return null; }
}
function lines(path) {
  try {
    if (statSync(path).size > MAX_EVIDENCE_FILE_BYTES) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { const value = JSON.parse(line); return record(value) ? [value] : []; } catch { return []; }
    });
  } catch { return []; }
}
function files(path, suffix) {
  try { return readdirSync(path).filter((name) => name.endsWith(suffix)).sort().map((name) => join(path, name)); }
  catch { return []; }
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function safeDiagnostic(value) {
  const sanitized = value
    .replaceAll(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replaceAll(process.cwd(), "[repository]")
    .replaceAll(process.env.HOME ?? "/home/user", "~")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account withheld]")
    .replaceAll(/(?:sk-|api[_-]?key[=: ]+)[A-Za-z0-9_./+-]{12,}/gi, "[credential withheld]");
  return Buffer.from(sanitized, "utf8").subarray(-MAX_DIAGNOSTIC_BYTES).toString("utf8").trim();
}

function collectProviderUsage(value, output) {
  if (Array.isArray(value)) { for (const item of value) collectProviderUsage(item, output); return; }
  if (!record(value)) return;
  if (value.counter_source === "provider_counter" && integer(value.input_tokens) && integer(value.output_tokens)
      && integer(value.cached_input_tokens ?? 0) && integer(value.cache_write_input_tokens ?? 0)) {
    output.push({
      input_tokens: value.input_tokens,
      output_tokens: value.output_tokens,
      cached_input_tokens: value.cached_input_tokens ?? 0,
      cache_write_input_tokens: value.cache_write_input_tokens ?? 0,
      counter_source: "provider_counter",
    });
  }
  for (const item of Object.values(value)) collectProviderUsage(item, output);
}

/** Read bounded, secret-free provider facts from canonical audit/tree stores. */
export function readProviderEvidence(persistenceDir) {
  const auditFiles = files(join(persistenceDir, "audit"), ".jsonl");
  const treeFiles = files(join(persistenceDir, "tree"), ".json");
  const identities = [];
  for (const path of auditFiles) {
    for (const entry of lines(path)) {
      const observation = record(entry.observation) ? entry.observation : null;
      if (entry.kind !== "telemetry_observation" || observation?.type !== "role_model_identity"
          || observation.role !== "specialist" || observation.phase !== "expand" || observation.outcome !== "success"
          || typeof observation.model_id !== "string" || !observation.model_id.trim()
          || ["default", "unknown", "unavailable"].includes(observation.model_id.trim().toLowerCase())
          || typeof entry.campaign_id !== "string" || !entry.campaign_id.trim()) continue;
      identities.push({ campaign_id: entry.campaign_id, node_id: typeof entry.node_id === "string" ? entry.node_id : null, model_id: observation.model_id });
    }
  }
  const usageByCampaign = new Map();
  for (const path of treeFiles) {
    const tree = json(path);
    if (tree === null || typeof tree.id !== "string" || !tree.id.trim()) continue;
    const usage = [];
    collectProviderUsage(tree, usage);
    if (usage.length > 0) usageByCampaign.set(tree.id, usage);
  }
  const campaignIds = [...new Set(identities.map((item) => item.campaign_id).filter((id) => usageByCampaign.has(id)))].sort();
  const matchedIdentities = identities.filter((item) => campaignIds.includes(item.campaign_id));
  const matchedUsage = campaignIds.flatMap((campaignId) => usageByCampaign.get(campaignId) ?? []);
  const totals = matchedUsage.reduce((sum, usage) => ({
    input_tokens: sum.input_tokens + usage.input_tokens,
    output_tokens: sum.output_tokens + usage.output_tokens,
    cached_input_tokens: sum.cached_input_tokens + usage.cached_input_tokens,
    cache_write_input_tokens: sum.cache_write_input_tokens + usage.cache_write_input_tokens,
  }), { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 });
  const proven = campaignIds.length > 0 && matchedIdentities.length > 0 && (totals.input_tokens + totals.output_tokens) > 0;
  const evidenceFiles = proven ? [
    ...auditFiles.filter((path) => lines(path).some((entry) => campaignIds.includes(entry.campaign_id))),
    ...treeFiles.filter((path) => { const tree = json(path); return tree !== null && campaignIds.includes(tree.id); }),
  ].map((path) => ({ name: basename(path), sha256: sha256(path) })) : [];
  return {
    proven,
    campaign_ids: campaignIds,
    model_identities: [...new Set(matchedIdentities.map((item) => item.model_id))].sort(),
    provider_usage: { ...totals, counter_source: "provider_counter" },
    evidence_files: evidenceFiles,
  };
}

export function classifySoakOutcome({ evidence, timedOut, spawnError, exitCode, signal, proofDrivenStop }) {
  if (spawnError) return { status: "failed", detail: `campaign process could not start: ${spawnError}` };
  if (timedOut) return { status: "failed", detail: "hard wall-clock budget expired before provider evidence was complete" };
  if (!evidence.proven) return { status: "failed", detail: `campaign exited ${exitCode ?? "without code"}${signal ? ` (${signal})` : ""} without attributable provider-counter evidence` };
  return { status: "passed", detail: proofDrivenStop ? "durable provider identity and provider-counter usage observed; probe stopped at its proof threshold" : "campaign exited after recording durable provider identity and provider-counter usage" };
}

function configuredCredential(env) {
  if (env.OPENROUTER_API_KEY || env.ZAI_API_KEY || env.ZHIPU_API_KEY) return true;
  const result = spawnSync("opencode", ["auth", "list"], { encoding: "utf8" });
  return result.status === 0 && /OpenRouter|Z\.AI/i.test(`${result.stdout}${result.stderr}`);
}
function sourceRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function initializeFixture(workspace) {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Bounded provider transport probe\n");
  for (const args of [["init", "-q", "-b", "master"], ["config", "user.email", "probe@revoy.invalid"], ["config", "user.name", "Revoy Provider Probe"], ["add", "README.md"], ["commit", "-qm", "fixture: initialize provider transport probe"]]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    if (result.status !== 0) return `${result.stderr || result.stdout || `git ${args[0]} failed`}`.trim();
  }
  return null;
}

export async function runLiveProviderSoak(env = process.env) {
  const outputPath = resolve(env.ARBOR_SOAK_RESULT ?? "live-provider-soak-result.json");
  const timeoutMs = Number.parseInt(env.ARBOR_SOAK_TIMEOUT_MS ?? "300000", 10);
  const heartbeatMs = Number.parseInt(env.ARBOR_SOAK_HEARTBEAT_MS ?? "15000", 10);
  const model = env.ARBOR_SOAK_MODEL ?? DEFAULT_MODEL;
  const criticModel = env.ARBOR_SOAK_CRITIC_MODEL ?? DEFAULT_CRITIC_MODEL;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runRoot = resolve(env.ARBOR_SOAK_PERSISTENCE ?? `.arbor/live-provider-soak/run-${Date.now()}-${process.pid}`);
  const workspace = join(runRoot, "workspace");
  const persistenceDir = join(workspace, ".arbor");
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  let finished = false;
  const finish = (outcome, evidence, termination, exitCode = 0, diagnosticTail = "") => {
    if (finished) return;
    finished = true;
    const envelope = {
      schema_version: 2, status: outcome.status, detail: outcome.detail,
      started_at: startedAt, finished_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      source_revision: sourceRevision(), transport: "server", model, critic_model: criticModel,
      timeout_ms: timeoutMs, termination, evidence,
      ...(outcome.status === "failed" && diagnosticTail ? { diagnostic_tail: safeDiagnostic(diagnosticTail) } : {}),
    };
    writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
    process.stdout.write(`live-provider-soak: ${outcome.status} — ${outcome.detail}\n`);
    process.exitCode = exitCode;
  };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
    finish({ status: "failed", detail: "ARBOR_SOAK_TIMEOUT_MS must be 10000..3600000" }, readProviderEvidence(persistenceDir), "preflight", 1); return;
  }
  if (!configuredCredential(env)) {
    finish({ status: "inconclusive", detail: "no supported provider credential was supplied or configured" }, readProviderEvidence(persistenceDir), "preflight", 0); return;
  }
  if (spawnSync("opencode", ["--version"], { stdio: "ignore" }).status !== 0) {
    finish({ status: "inconclusive", detail: "opencode binary is unavailable" }, readProviderEvidence(persistenceDir), "preflight", 0); return;
  }
  const fixtureError = initializeFixture(workspace);
  if (fixtureError !== null) {
    finish({ status: "failed", detail: "isolated provider fixture could not be initialized" }, readProviderEvidence(persistenceDir), "preflight", 1, fixtureError); return;
  }
  process.stdout.write(`live-provider-soak: started server-transport proof (timeout ${Math.round(timeoutMs / 1000)}s)\n`);
  const child = spawn("bun", [
    ARBOR_BIN, "run", "--once", "--executor", "real",
    "--transport", "server", "--model", model, "--critic-model", criticModel,
    "--persistence-dir", persistenceDir,
  ], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env });
  let diagnosticTail = "";
  const retainDiagnostic = (chunk) => {
    diagnosticTail = Buffer.from(`${diagnosticTail}${chunk.toString()}`, "utf8").subarray(-MAX_DIAGNOSTIC_BYTES * 2).toString("utf8");
  };
  child.stdout.on("data", retainDiagnostic); child.stderr.on("data", retainDiagnostic);
  let timedOut = false;
  let proofDrivenStop = false;
  let spawnError = null;
  let forceTimer = null;
  const stop = () => {
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceTimer.unref();
  };
  const heartbeat = setInterval(() => {
    const evidence = readProviderEvidence(persistenceDir);
    process.stdout.write(`live-provider-soak: ${Math.round((Date.now() - started) / 1000)}s · identities ${evidence.model_identities.length} · provider tokens ${evidence.provider_usage.input_tokens + evidence.provider_usage.output_tokens}\n`);
  }, Math.max(1_000, heartbeatMs));
  const monitor = setInterval(() => {
    if (readProviderEvidence(persistenceDir).proven && !proofDrivenStop) { proofDrivenStop = true; stop(); }
  }, 1_000);
  const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const completion = await new Promise((resolveExit) => {
    child.once("error", (error) => { spawnError = error.message; resolveExit({ code: null, signal: null }); });
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearInterval(heartbeat); clearInterval(monitor); clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer);
  const evidence = readProviderEvidence(persistenceDir);
  const outcome = classifySoakOutcome({ evidence, timedOut, spawnError, exitCode: completion.code, signal: completion.signal, proofDrivenStop });
  finish(outcome, evidence, proofDrivenStop ? "proof_threshold" : timedOut ? "timeout" : "process_exit", outcome.status === "failed" ? 1 : 0, diagnosticTail);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLiveProviderSoak();
