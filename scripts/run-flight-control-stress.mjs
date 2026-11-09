#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runFlightControlStress } from "../packages/arbor-mcp/src/flight-control-stress.ts";
import { computeFlightEventHash, validateFlightEvents } from "./flight-control-replay.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const runId = value("--run-id", `flight-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const publicationPath = resolve(value("--publication", `/tmp/${runId}-events.jsonl`));
const reportPath = resolve(value("--report", `/tmp/${runId}-report.json`));
const workRoot = value("--work-root", undefined);
const keepArtifacts = args.includes("--keep-artifacts");

const stageFor = {
  "topology.online": "topology", "message.sent": "parent_child", "message.acknowledged": "parent_child",
  "peer.query": "sibling", "peer.reply": "sibling", "cross_repo.sent": "cross_repo",
  "cross_repo.received": "cross_repo", "lease.attempt": "collision", "lease.acquired": "collision",
  "lease.denied": "collision", "scope.write_denied": "scope_denial",
  "agent.cancel_requested": "cancellation", "agent.terminated": "cancellation",
  "session.crashed": "recovery", "lease.stale_detected": "recovery", "lease.recovered": "recovery",
  "lease.quarantined": "recovery", "retry.started": "retry", "retry.succeeded": "retry",
  "integrity.repo_clean": "integrity", "integrity.ledger_verified": "integrity",
};
const statusFor = {
  "topology.online": "pass", "message.sent": "working", "message.acknowledged": "pass",
  "peer.query": "working", "peer.reply": "pass", "cross_repo.sent": "working",
  "cross_repo.received": "pass", "lease.attempt": "working", "lease.acquired": "pass",
  "lease.denied": "denied", "scope.write_denied": "denied", "agent.cancel_requested": "working",
  "agent.terminated": "pass", "session.crashed": "failed", "lease.stale_detected": "info",
  "lease.recovered": "recovered", "lease.quarantined": "quarantined", "retry.started": "working",
  "retry.succeeded": "pass", "integrity.repo_clean": "pass", "integrity.ledger_verified": "pass",
};
const rolesFor = {
  "topology.online": ["orchestrator", "repository"], "message.sent": ["orchestrator", "agent"],
  "message.acknowledged": ["agent", "orchestrator"], "peer.query": ["agent", "agent"],
  "peer.reply": ["agent", "agent"], "cross_repo.sent": ["orchestrator", "orchestrator"],
  "cross_repo.received": ["orchestrator", "orchestrator"], "lease.attempt": ["agent", "system"],
  "lease.acquired": ["agent", "system"], "lease.denied": ["agent", "system"],
  "scope.write_denied": ["agent", "system"], "agent.cancel_requested": ["orchestrator", "agent"],
  "agent.terminated": ["system", "agent"], "session.crashed": ["agent", "system"],
  "lease.stale_detected": ["system", "system"], "lease.recovered": ["system", "system"],
  "lease.quarantined": ["system", "system"], "retry.started": ["system", "system"],
  "retry.succeeded": ["system", "system"], "integrity.repo_clean": ["system", "repository"],
  "integrity.ledger_verified": ["system", "repository"],
};

const report = await runFlightControlStress({ scenario_id: runId, work_root: workRoot, keep_artifacts: keepArtifacts });
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.ok) {
  const failed = report.checks.filter((check) => !check.ok).map((check) => check.id);
  throw new Error(`flight control proof incomplete: ${failed.join(", ") || report.gaps.join(", ")}`);
}

const atoms = [];
for (const atom of report.publication_events) {
  if (atom.kind === "topology.online") {
    for (const repoId of ["repo-a", "repo-b"]) atoms.push({ ...atom, repo_id: repoId, agent_id: `${repoId}-orchestrator`, peer_id: repoId, session_id: `${repoId}-session` });
  } else atoms.push(atom);
}
const stageOrder = ["topology", "parent_child", "sibling", "cross_repo", "collision", "scope_denial", "cancellation", "recovery", "retry", "integrity"];
atoms.sort((a, b) => stageOrder.indexOf(stageFor[a.kind]) - stageOrder.indexOf(stageFor[b.kind]) || a.sequence - b.sequence);

let previousHash = null;
const events = atoms.map((atom, offset) => {
  const crossReceived = atom.kind === "cross_repo.received";
  const sourceRepo = atom.kind.startsWith("peer.") ? "repo-a" : atom.repo_id;
  const targetRepo = atom.kind.startsWith("cross_repo.") ? atom.peer_id : undefined;
  const correlation = atom.kind.startsWith("cross_repo.") ? atom.session_id
    : atom.kind.startsWith("message.") ? atom.resource_id
    : atom.kind.startsWith("peer.") ? "worker-a-worker-b-relay"
    : ["lease.attempt", "lease.acquired", "lease.denied"].includes(atom.kind) ? atom.resource_id
    : ["agent.cancel_requested", "agent.terminated"].includes(atom.kind) ? atom.resource_id
    : ["session.crashed", "lease.stale_detected", "lease.recovered", "lease.quarantined", "retry.started", "retry.succeeded"].includes(atom.kind) ? "writer-lock-recovery"
    : undefined;
  const [actorRole, targetRole] = rolesFor[atom.kind];
  const event = {
    schema_version: 1, sequence: offset + 1, event_id: `${runId}:${String(offset + 1).padStart(3, "0")}`,
    run_id: runId, timestamp: atom.at, stage: stageFor[atom.kind], kind: atom.kind,
    status: statusFor[atom.kind], caption: atom.caption, source_repo_id: sourceRepo ?? "repo-a",
    actor_id: atom.kind.startsWith("cross_repo.") ? `${sourceRepo}-orchestrator` : atom.agent_id ?? (sourceRepo ? `${sourceRepo}-orchestrator` : "flight-controller"), actor_role: actorRole,
    previous_hash: previousHash,
  };
  if (targetRepo) event.target_repo_id = targetRepo;
  if (atom.kind.startsWith("cross_repo.")) event.target_id = `${targetRepo}-orchestrator`;
  else if (atom.peer_id) event.target_id = atom.peer_id;
  else if (atom.resource_id) event.target_id = atom.resource_id;
  else if (atom.kind.startsWith("integrity.")) event.target_id = atom.repo_id;
  if (event.target_id) event.target_role = targetRole;
  if (correlation) event.correlation_id = correlation;
  if (atom.resource_id) event.resource_id = atom.resource_id;
  event.hash = computeFlightEventHash(event);
  previousHash = event.hash;
  return event;
});

validateFlightEvents(events, { require_complete: true });
mkdirSync(dirname(publicationPath), { recursive: true });
writeFileSync(publicationPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ ok: true, run_id: runId, report: reportPath, publication: publicationPath, events: events.length }));
