#!/usr/bin/env node
/**
 * Local completion coordinator.
 *
 * This composes existing authorities; it does not recreate them. Evidence is
 * produced by the repository-common atomic transaction, and final verification
 * is the exact immutable prepush battery. The coordinator owns only ordering,
 * typed phase state, and operator-visible next actions.
 *
 *   bun run finalize                 # inspect admission, then verify once ready
 *   bun run finalize -- --refresh    # refresh stale evidence atomically, then stop at commit barrier
 *   bun run finalize -- --plan       # emit state/plan without refresh or immutable verification
 *   bun run finalize -- --json
 *   bun run finalize -- --progress=human|json|auto  # ADR-091 streaming progress on stderr (default auto)
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_PATH_PREFIXES, runEvidenceRefreshTransaction } from "./evidence-transaction.mjs";
import { loadExecutionProfile, runImmutableBattery } from "./enforcement-control-plane.mjs";
import { formatReport } from "./preflight-push.mjs";
import { createProgressReporter, selectProgressRenderer } from "./finalization-progress.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
/** The profile owns finalization ordering too; this module only projects it. */
export const FINALIZATION_PHASES = Object.freeze((loadExecutionProfile().execution?.finalization?.phases ?? []).map((phase) => Object.freeze({
  id: phase.id,
  depends_on: Object.freeze([...phase.depends_on]),
  mutability: phase.mutability,
})));

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown failure").trim()}`);
  return result.stdout;
}

function isEvidencePath(path) {
  const normalized = path.replaceAll("\\", "/");
  return EVIDENCE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function inspectFinalizationTree(repo = REPO_ROOT) {
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const raw = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const records = raw.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code.includes("R") || code.includes("C")) paths.push(records[++index] ?? "");
  }
  const evidence_paths = [...new Set(paths.filter(isEvidencePath))].sort();
  const source_paths = [...new Set(paths.filter((path) => !isEvidencePath(path)))].sort();
  return Object.freeze({ head, clean: paths.length === 0, source_paths: Object.freeze(source_paths), evidence_paths: Object.freeze(evidence_paths) });
}

export function readStoreFreshness(repo = REPO_ROOT) {
  const result = spawnSync("bun", [resolvePath(repo, "scripts", "store-freshness-gate.mjs"), "--json"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`store-freshness did not emit JSON: ${(result.stderr || result.stdout || "no output").trim()}`); }
  if (!report || typeof report.ok !== "boolean" || !Array.isArray(report.stores)) throw new Error("store-freshness emitted an invalid report");
  return Object.freeze(report);
}

function phaseProjection(current, evidence = {}, complete = false) {
  const currentIndex = FINALIZATION_PHASES.findIndex((phase) => phase.id === current);
  return FINALIZATION_PHASES.map((phase, index) => Object.freeze({
    ...phase,
    status: complete || index < currentIndex ? "passed" : index === currentIndex ? "current" : "blocked",
    evidence: phase.id === current ? Object.freeze(evidence) : Object.freeze({}),
  }));
}

function result(state, currentPhase, { ok = false, remedy = null, evidence = {}, battery = null } = {}) {
  return Object.freeze({
    schema_version: 1,
    kind: "revoy2.finalization_plan",
    workflow_id: "local_finalize",
    status: state,
    ok,
    current_phase: currentPhase,
    phases: Object.freeze(phaseProjection(currentPhase, evidence, ok)),
    remedy,
    battery,
  });
}

/** ADR-091: finalize.mjs status -> the run-level terminal outcome/reason a shared progress reporter records. */
function finalizeRunOutcome(plan) {
  if (plan.status === "verified" || plan.status === "verification_ready") return { outcome: "succeeded", reason_code: plan.status, exit_code: null };
  if (["source_commit_required", "evidence_commit_required", "evidence_refresh_required"].includes(plan.status)) {
    return { outcome: "refused", reason_code: plan.status, exit_code: null };
  }
  return { outcome: "failed", reason_code: plan.status, exit_code: null };
}

/**
 * Execute only the current satisfiable phase; never cross the evidence commit
 * authority barrier. `progress`, when non-null, is an ADR-091 reporter this
 * function contributes phase-level stage events to; it does not own that
 * reporter's run_started/run_terminal/heartbeat lifecycle (see
 * `runFinalization` below, which does).
 */
async function runFinalizationCore({
  repo = REPO_ROOT,
  refresh = false,
  planOnly = false,
  inspect = inspectFinalizationTree,
  freshness = readStoreFreshness,
  refreshEvidence = ({ repo: target }) => runEvidenceRefreshTransaction({ repo: target, scope: "auto" }),
  verify = ({ repo: target, candidate, progress: forwardedProgress }) => runImmutableBattery({ repo: target, candidate, context: "prepush", progress: forwardedProgress }),
  progress = null,
} = {}) {
  const phase = (id, deadline_reason = "unbounded_setup") => progress?.startStage(id, { deadline_reason, kind: "phase" });
  const phaseDone = (id, outcome, reason_code) => progress?.stageTerminal(id, { outcome, reason_code, exit_code: null });

  phase("source_candidate");
  const tree = inspect(repo);
  if (tree.source_paths.length > 0) {
    phaseDone("source_candidate", "refused", "source_commit_required");
    return result("source_commit_required", "source_candidate", {
      evidence: { candidate_oid: tree.head, source_paths: tree.source_paths, evidence_paths: tree.evidence_paths },
      remedy: "Commit, ignore, or move every listed source path, then rerun `bun run finalize`.",
    });
  }
  phaseDone("source_candidate", "succeeded", "source_candidate_admitted");

  if (tree.evidence_paths.length > 0) {
    phase("evidence_commit");
    phaseDone("evidence_commit", "refused", "evidence_commit_required");
    return result("evidence_commit_required", "evidence_commit", {
      evidence: { candidate_oid: tree.head, evidence_paths: tree.evidence_paths },
      remedy: "Review and commit the staged/generated evidence as a separate evidence commit, then rerun `bun run finalize`.",
    });
  }

  phase("evidence_admission");
  const freshnessReport = freshness(repo);
  const staleStores = freshnessReport.stores.filter((store) => store.state !== "ok").map((store) => store.name).sort();
  if (!freshnessReport.ok) {
    if (!refresh) {
      phaseDone("evidence_admission", "refused", "evidence_refresh_required");
      return result("evidence_refresh_required", "evidence_admission", {
        evidence: { candidate_oid: tree.head, stale_stores: staleStores },
        remedy: "Run `bun run finalize -- --refresh`; it uses the atomic evidence transaction and stops at the evidence commit barrier.",
      });
    }
    if (planOnly) {
      phaseDone("evidence_admission", "refused", "evidence_refresh_required_plan_only");
      return result("evidence_refresh_required", "evidence_admission", {
        evidence: { candidate_oid: tree.head, stale_stores: staleStores },
        remedy: "Plan-only mode made no changes. Run `bun run finalize -- --refresh` to execute evidence closure.",
      });
    }
    phaseDone("evidence_admission", "succeeded", "evidence_admission_stale_refresh_authorized");
    phase("evidence_closure");
    const refreshed = await refreshEvidence({ repo });
    if (!refreshed.ok) {
      phaseDone("evidence_closure", "failed", "evidence_refresh_failed");
      return result("evidence_refresh_failed", "evidence_closure", {
        evidence: { candidate_oid: tree.head, stale_stores: staleStores, transaction_id: refreshed.transaction_id ?? null, output: refreshed.output ?? "" },
        remedy: "Fix the reported evidence producer failure, inspect `bun run evidence:status`, then rerun `bun run finalize -- --refresh`.",
      });
    }
    const after = inspect(repo);
    if (after.source_paths.length > 0 || after.evidence_paths.length > 0) {
      phaseDone("evidence_closure", "succeeded", "evidence_closure_staged");
      phase("evidence_commit");
      phaseDone("evidence_commit", "refused", "evidence_commit_required");
      return result("evidence_commit_required", "evidence_commit", {
        evidence: { candidate_oid: tree.head, transaction_id: refreshed.transaction_id, evidence_paths: after.evidence_paths, published: refreshed.published },
        remedy: "Review and commit the staged/generated evidence as a separate evidence commit, then rerun `bun run finalize`.",
      });
    }
    // A no-op refresh can happen when the freshness observation raced a
    // harmless ordering change. Do not make an operator rerun the same
    // immutable battery when the refresh left the candidate untouched.
    const afterFreshness = freshness(repo);
    if (!afterFreshness.ok) {
      phaseDone("evidence_closure", "failed", "evidence_still_stale_after_refresh");
      return result("evidence_refresh_failed", "evidence_closure", {
        evidence: { candidate_oid: tree.head, transaction_id: refreshed.transaction_id, stale_stores: afterFreshness.stores.filter((store) => store.state !== "ok").map((store) => store.name).sort() },
        remedy: "Evidence is still stale after the atomic refresh; inspect `bun run evidence:status` before retrying.",
      });
    }
    phaseDone("evidence_closure", "succeeded", "evidence_closure_noop");
    if (planOnly) {
      phase("immutable_prepush", "unbounded_setup");
      phaseDone("immutable_prepush", "succeeded", "verification_ready_plan_only");
      return result("verification_ready", "immutable_prepush", {
        evidence: { candidate_oid: tree.head, stale_stores: [], transaction_id: refreshed.transaction_id },
        remedy: "Run `bun run finalize` to execute the exact immutable prepush battery once.",
      });
    }
    phase("immutable_prepush", "unbounded_setup");
    const battery = await verify({ repo, candidate: tree.head, progress });
    phaseDone("immutable_prepush", battery.ok ? "succeeded" : "failed", battery.ok ? "verified" : "verification_failed");
    return result(battery.ok ? "verified" : "verification_failed", "immutable_prepush", {
      ok: battery.ok,
      evidence: { candidate_oid: tree.head, battery_status: battery.status, transaction_id: refreshed.transaction_id },
      remedy: battery.ok ? null : "Apply each gate's emitted remedy, then rerun `bun run finalize`.",
      battery,
    });
  }
  phaseDone("evidence_admission", "succeeded", "evidence_fresh");

  if (planOnly) {
    phase("immutable_prepush", "unbounded_setup");
    phaseDone("immutable_prepush", "succeeded", "verification_ready_plan_only");
    return result("verification_ready", "immutable_prepush", {
      evidence: { candidate_oid: tree.head, stale_stores: [] },
      remedy: "Run `bun run finalize` to execute the exact immutable prepush battery once.",
    });
  }
  phase("immutable_prepush", "unbounded_setup");
  const battery = await verify({ repo, candidate: tree.head, progress });
  phaseDone("immutable_prepush", battery.ok ? "succeeded" : "failed", battery.ok ? "verified" : "verification_failed");
  return result(battery.ok ? "verified" : "verification_failed", "immutable_prepush", {
    ok: battery.ok,
    evidence: { candidate_oid: tree.head, battery_status: battery.status },
    remedy: battery.ok ? null : "Apply each gate's emitted remedy, then rerun `bun run finalize`.",
    battery,
  });
}

/** The default shared reporter: NDJSON on non-TTY (CI/agent), human lines on an interactive TTY. Decision §4: no silent-progress escape hatch on the governed path. */
function defaultFinalizeReporter(progressMode) {
  const renderer = selectProgressRenderer(progressMode, process.stderr.isTTY === true);
  return createProgressReporter({
    workflowId: "local_finalize",
    context: "prepush",
    onEvent: (event) => { process.stderr.write(`${renderer(event)}\n`); },
  });
}

/**
 * Public entrypoint: owns the single ADR-091 run lifecycle (`run_started` ...
 * exactly one `run_terminal`) around `runFinalizationCore`, and the real
 * heartbeat timer while it runs. Pass `progress: null` to opt out entirely
 * (used by tests that don't care about the progress channel); otherwise a
 * real reporter streams to stderr by default, or pass your own reporter (e.g.
 * one backed by a fake clock) to drive the protocol under test.
 */
export async function runFinalization({ progress = undefined, progressMode = "auto", ...args } = {}) {
  const ownsReporter = progress === undefined;
  const reporter = ownsReporter ? defaultFinalizeReporter(progressMode) : progress;
  if (ownsReporter) reporter?.startRealHeartbeat?.();
  try {
    reporter?.runStarted();
    FINALIZATION_PHASES.forEach((finalizationPhase) => {
      reporter?.planStage({ id: finalizationPhase.id, kind: "phase", phase_id: finalizationPhase.id, wave: null, deadline_reason: "unbounded_setup" });
    });
    const plan = await runFinalizationCore({ ...args, progress: reporter });
    reporter?.runTerminal(finalizeRunOutcome(plan));
    return plan;
  } catch (error) {
    reporter?.runTerminal({ outcome: "failed", reason_code: "finalize_threw", exit_code: null });
    throw error;
  } finally {
    if (ownsReporter) reporter?.stopRealHeartbeat?.();
  }
}

export function formatFinalization(plan) {
  const lines = ["finalize — deterministic local completion plan"];
  for (const [index, phase] of plan.phases.entries()) {
    const marker = phase.status === "passed" ? "ok " : phase.status === "current" ? ">> " : "-- ";
    lines.push(`  ${marker}${index + 1}. ${phase.id} [${phase.mutability}]`);
  }
  lines.push("");
  lines.push(`${plan.ok ? "PASS" : "STOP"} — ${plan.status}`);
  if (plan.remedy) lines.push(`Next: ${plan.remedy}`);
  if (plan.battery) {
    lines.push("");
    lines.push(...formatReport(plan.battery).lines);
  }
  return lines;
}

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

async function main() {
  const json = process.argv.includes("--json");
  const plan = await runFinalization({
    refresh: process.argv.includes("--refresh"),
    planOnly: process.argv.includes("--plan"),
    progressMode: flagValue("--progress", "auto"),
  });
  if (json) console.log(JSON.stringify(plan, null, 2));
  else for (const line of formatFinalization(plan)) console.log(line);
  return plan.ok || plan.status === "verification_ready" ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
