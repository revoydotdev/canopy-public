#!/usr/bin/env node

// DEPRECATED-LANE SCRIPT (ADR-192). --integration selects one of the opencode, claude-code
// or codex connectors (the closed catalog in lib/generalist-integrations.mjs); none is
// Canopy (revoy-native), so each is a deprecated lane. The driver refuses unless the
// operator has set connectors.allow_deprecated: true and connectors.reason in an
// arbor.jsonc that resolves for --cwd. It never opts in for you.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requestOperatorKeypress } from "./operator-keypress.mjs";
import { assertDeprecatedLaneOptIn } from "./lib/deprecated-lane-optin.mjs";
import { resolveGeneralistIntegration } from "./lib/generalist-integrations.mjs";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARBOR_ENTRYPOINT = resolve(HARNESS_ROOT, "packages/arbor-mcp/bin/arbor-mcp.mjs");

function emit(line = "") {
  process.stdout.write(`${line}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);
      });
    }
    child.on("error", (error) => resolveRun({ command, args, exit_code: 127, duration_ms: Date.now() - started, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolveRun({ command, args, exit_code: code ?? 1, duration_ms: Date.now() - started, output }));
  });
}

async function runArbor(args, options = {}) {
  const executed = await run(ARBOR_ENTRYPOINT, args, options);
  return { ...executed, command: "arbor", harness_entrypoint: ARBOR_ENTRYPOINT };
}

function parseJson(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "{") starts.push(index);
  for (const start of starts) {
    try {
      return JSON.parse(text.slice(start));
    } catch {}
  }
  return null;
}

function findCampaignId(value) {
  if (typeof value === "string" && /^(?:composer-draft-|campaign-)[a-z0-9-]+$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCampaignId(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (typeof value.campaign_result?.campaign_id === "string") return value.campaign_result.campaign_id;
    if (typeof value.campaign_id === "string") return value.campaign_id;
    for (const [key, item] of Object.entries(value)) {
      if (key === "parent_campaign_id") continue;
      if (/campaign.*id/i.test(key) && typeof item === "string") return item;
      const found = findCampaignId(item);
      if (found) return found;
    }
  }
  return null;
}

function findDraft(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDraft(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (typeof value.id === "string" && value.id.startsWith("draft-") && Number.isSafeInteger(value.revision) && typeof value.status === "string") return value;
    for (const item of Object.values(value)) {
      const found = findDraft(item);
      if (found) return found;
    }
  }
  return null;
}

function safeTail(text) {
  return text
    .replaceAll(process.env.HOME ?? "/home/user", "~")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account withheld]")
    .replaceAll(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_./+-]{12,}|api[_-]?key[=: ]+[A-Za-z0-9_./+-]{12,})/gi, "[credential withheld]")
    .split("\n").slice(-80).join("\n");
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cwd = resolve(arg("--cwd", process.cwd()));
const resultPath = resolve(arg("--result", "campaign-result.json"));
const language = arg("--language", "unknown");
const task = arg("--task");
const verifyCommand = JSON.parse(arg("--verify-json", "[]"));
const integration = arg("--integration", "claude-code");
const followupTask = arg("--followup-task");
const followupFiles = JSON.parse(arg("--followup-files-json", "{}"));
const configuredFollowups = JSON.parse(arg("--followups-json", "[]"));
const followups = configuredFollowups.length > 0
  ? configuredFollowups
  : followupTask
    ? [{ task: followupTask, files: followupFiles }]
    : [];
const interviewAnswer = arg("--interview-answer", "No undocumented edge-case behavior must be preserved. Treat the committed tests and the stated task as the complete contract; keep the implementation narrowly scoped and do not weaken tests.");
const persistence = resolve(arg("--persistence", `${cwd}/.arbor-evidence`));
const scratch = resolve(arg("--scratch", dirname(resultPath)));
const interactiveInput = process.argv.includes("--interactive-input");
let interviewSequence = 0;
if (!task || !verifyCommand.length) throw new Error("--task and --verify-json are required");
resolveGeneralistIntegration(integration);
assertDeprecatedLaneOptIn(cwd, integration, "scripts/generalist-campaign-driver.mjs");

mkdirSync(dirname(resultPath), { recursive: true });
const env = {
  ...process.env,
  ARBOR_HARNESS_INTEGRATION: integration,
  ARBOR_PERSISTENCE_DIR: persistence,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
};
const result = { schema_version: 1, language, cwd, started_at: new Date().toISOString(), executor: integration, governance_tier: "governed", harness_entrypoint: ARBOR_ENTRYPOINT };

async function settleGovernedTask(args, label) {
  const turns = [];
  let turn = await runArbor(args, { cwd, env });
  turns.push(turn);
  for (let round = 1; round <= 4; round += 1) {
    const parsed = parseJson(turn.output);
    const campaignId = findCampaignId(parsed) ?? turn.output.match(/(?:composer-draft-|campaign-)[a-z0-9-]+/i)?.[0] ?? null;
    const draft = findDraft(parsed);
    if (campaignId && !campaignId.startsWith("composer-draft-")) return { final: turn, turns, campaign_id: campaignId };
    if (draft?.status === "awaiting_clarification") {
      const question = draft.proposal?.questions?.find((item) => item?.answer === null);
      if (!question?.id) throw new Error(`${label} draft requested clarification without a revisioned question`);
      emit("");
      emit(`[interview ${round}] ${question.question ?? question.id}`);
      const answer = interactiveInput
        ? await requestOperatorKeypress({ scratch, sequence: ++interviewSequence, purpose: `${label}_clarification`, question: question.question ?? question.id })
        : interviewAnswer;
      if (!interactiveInput) emit(`operator> ${answer}`);
      turn = await runArbor(["task", "answer", draft.id, String(draft.revision), question.id, answer, "--json", "--progress"], { cwd, env });
      turns.push(turn);
      if (turn.exit_code !== 0) return { final: turn, turns, campaign_id: null };
      continue;
    }
    if (draft?.status === "proposed") {
      emit("");
      emit(`[interview ${round}] proposal ready; operator confirms revision ${draft.revision}`);
      if (interactiveInput) await requestOperatorKeypress({ scratch, sequence: ++interviewSequence, purpose: `${label}_confirmation`, question: "The governed plan is ready. Confirm execution of this bounded scope and its acceptance command." });
      turn = await runArbor(["task", "confirm", draft.id, String(draft.revision), "--wait", "--json", "--progress"], { cwd, env });
      turns.push(turn);
      if (turn.exit_code !== 0) return { final: turn, turns, campaign_id: findCampaignId(parseJson(turn.output)) };
      continue;
    }
    return { final: turn, turns, campaign_id: campaignId };
  }
  throw new Error(`${label} exceeded four clarification/confirmation turns`);
}

try {
  emit("REVOY2 GENERALIST FLIGHT");
  emit(`Language lane : ${language}`);
  emit("Control model : governed (Specialist -> independent Critic -> verified adoption)");
  emit(`Executor      : provider-backed ${integration} integration`);
  emit("");
  emit("[1/3] Dispatching governed campaign");
  const settledCampaign = await settleGovernedTask(["task", task, "--tier", "governed", ...(interactiveInput ? ["--plan"] : []), "--json", "--progress"], "campaign");
  const campaign = settledCampaign.final;
  result.task_turns = settledCampaign.turns.map((turn) => ({ command: turn.command, args: turn.args, exit_code: turn.exit_code, duration_ms: turn.duration_ms, output_tail: safeTail(turn.output) }));
  result.campaign = { ...campaign, output: undefined, output_tail: safeTail(campaign.output) };
  result.campaign_id = settledCampaign.campaign_id;
  if (campaign.exit_code !== 0) throw new Error(`campaign exited ${campaign.exit_code}`);
  if (!result.campaign_id) throw new Error("campaign completed without an attributable campaign ID");

  emit("");
  emit(`[2/3] Adopting verified result from ${result.campaign_id}`);
  const adoption = await runArbor(["adopt", "--campaign", result.campaign_id, "--apply", "--json"], { cwd, env });
  result.adoption = { ...adoption, output: undefined, output_tail: safeTail(adoption.output) };
  if (adoption.exit_code !== 0) throw new Error(`adoption exited ${adoption.exit_code}`);

  emit("");
  emit(`[3/3] Independent acceptance: ${verifyCommand.join(" ")}`);
  const verification = await run(verifyCommand[0], verifyCommand.slice(1), { cwd, env: process.env });
  result.verification = { ...verification, output: undefined, output_tail: safeTail(verification.output) };
  if (verification.exit_code !== 0) throw new Error(`independent acceptance exited ${verification.exit_code}`);

  let parentCampaignId = result.campaign_id;
  if (followups.length > 0) result.followups = [];
  for (const [followupIndex, requirement] of followups.entries()) {
    const stage = 4 + followupIndex * 3;
    const totalStages = 3 + followups.length * 3;
    emit("");
    emit(`[${stage}/${totalStages}] Committing operator requirement ${followupIndex + 1} of ${followups.length}`);
    for (const [name, contents] of Object.entries(requirement.files ?? {})) {
      const path = resolve(cwd, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(contents));
    }
    const add = await run("git", ["add", "."], { cwd, env: process.env });
    if (add.exit_code !== 0) throw new Error(`follow-up fixture staging exited ${add.exit_code}`);
    const commit = await run("git", ["commit", "-m", requirement.commit_message ?? `test: add lifecycle requirement ${followupIndex + 1}`], { cwd, env: process.env });
    if (commit.exit_code !== 0) throw new Error(`follow-up fixture commit exited ${commit.exit_code}`);
    const followupBaseline = await run(verifyCommand[0], verifyCommand.slice(1), { cwd, env: process.env });
    const baselineEvidence = { ...followupBaseline, output: undefined, output_tail: safeTail(followupBaseline.output) };
    if (followupBaseline.exit_code === 0) throw new Error("follow-up requirement must begin with failing acceptance");

    emit("");
    emit(`[${stage + 1}/${totalStages}] Dispatching lineage-linked follow-up from ${parentCampaignId}`);
    const settledFollowup = await settleGovernedTask(["task", "follow-up", parentCampaignId, requirement.task, "--tier", "governed", ...(interactiveInput ? ["--plan"] : []), "--json", "--progress"], `follow-up ${followupIndex + 1}`);
    const followup = settledFollowup.final;
    const followupCampaignId = settledFollowup.campaign_id;
    const followupEvidence = {
      requirement_index: followupIndex + 1,
      parent_campaign_id: parentCampaignId,
      campaign_id: followupCampaignId,
      task_turns: settledFollowup.turns.map((turn) => ({ command: turn.command, args: turn.args, exit_code: turn.exit_code, duration_ms: turn.duration_ms, output_tail: safeTail(turn.output) })),
      campaign: { ...followup, output: undefined, output_tail: safeTail(followup.output) },
      baseline: baselineEvidence,
      adoption: null,
      verification: null,
    };
    result.followups.push(followupEvidence);
    if (followupIndex === 0) {
      result.followup = { ...followupEvidence.campaign, campaign_id: followupCampaignId };
      result.followup_task_turns = followupEvidence.task_turns;
      result.followup_baseline = baselineEvidence;
    }
    if (followup.exit_code !== 0 || !followupCampaignId) throw new Error(`follow-up campaign exited ${followup.exit_code}${followupCampaignId ? ` (child ${followupCampaignId})` : " without an attributable campaign ID"}`);

    emit("");
    emit(`[${stage + 2}/${totalStages}] Adopting and independently accepting follow-up ${followupCampaignId}`);
    const followupAdoption = await runArbor(["adopt", "--campaign", followupCampaignId, "--apply", "--json"], { cwd, env });
    if (followupAdoption.exit_code !== 0) throw new Error(`follow-up adoption exited ${followupAdoption.exit_code}`);
    const followupVerification = await run(verifyCommand[0], verifyCommand.slice(1), { cwd, env: process.env });
    if (followupVerification.exit_code !== 0) throw new Error(`follow-up independent acceptance exited ${followupVerification.exit_code}`);
    followupEvidence.adoption = { ...followupAdoption, output: undefined, output_tail: safeTail(followupAdoption.output) };
    followupEvidence.verification = { ...followupVerification, output: undefined, output_tail: safeTail(followupVerification.output) };
    if (followupIndex === 0) {
      result.followup_adoption = followupEvidence.adoption;
      result.followup_verification = followupEvidence.verification;
    }
    parentCampaignId = followupCampaignId;
  }
  result.ok = true;
  emit("");
  emit(followups.length > 0 ? `VERIFIED: ${followups.length + 1} governed lifecycle turns adopted and independently accepted` : "VERIFIED: governed result adopted and independently accepted");
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  emit("");
  emit(`FAILED CLOSED: ${result.error}`);
} finally {
  result.completed_at = new Date().toISOString();
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
}

process.exitCode = result.ok ? 0 : 1;
