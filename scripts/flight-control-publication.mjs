#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeFlightEventHash, validateFlightEvents } from "./flight-control-replay.mjs";

const STAGE = Object.freeze({
  "topology.online": "topology", "message.sent": "parent_child", "message.acknowledged": "parent_child",
  "peer.query": "sibling", "peer.reply": "sibling", "cross_repo.sent": "cross_repo", "cross_repo.received": "cross_repo",
  "lease.attempt": "collision", "lease.acquired": "collision", "lease.denied": "collision", "scope.write_denied": "scope_denial",
  "agent.cancel_requested": "cancellation", "agent.terminated": "cancellation", "session.crashed": "recovery",
  "lease.stale_detected": "recovery", "lease.recovered": "recovery", "lease.quarantined": "recovery",
  "retry.started": "retry", "retry.succeeded": "retry", "integrity.repo_clean": "integrity", "integrity.ledger_verified": "integrity",
});
const ORDER = new Map(["topology", "parent_child", "sibling", "cross_repo", "collision", "scope_denial", "cancellation", "recovery", "retry", "integrity"].map((stage, index) => [stage, index]));
const STATUS = Object.freeze({
  "topology.online": "pass", "message.sent": "working", "message.acknowledged": "pass", "peer.query": "working", "peer.reply": "pass",
  "cross_repo.sent": "working", "cross_repo.received": "pass", "lease.attempt": "working", "lease.acquired": "pass", "lease.denied": "denied",
  "scope.write_denied": "denied", "agent.cancel_requested": "working", "agent.terminated": "pass", "session.crashed": "failed",
  "lease.stale_detected": "info", "lease.recovered": "recovered", "lease.quarantined": "quarantined", "retry.started": "working",
  "retry.succeeded": "pass", "integrity.repo_clean": "pass", "integrity.ledger_verified": "pass",
});

export function publicationToReplay(report) {
  if (!report || report.schema_version !== 1 || report.ok !== true || !Array.isArray(report.publication_events)) throw new Error("flight report must be a successful schema-v1 report with publication events");
  const source = report.publication_events;
  const topology = source.find((event) => event.kind === "topology.online");
  if (!topology) throw new Error("flight publication is missing topology evidence");
  const expanded = source.flatMap((event) => event.kind === "topology.online" ? [
    { ...event, repo_id: "repo-a", agent_id: "orchestrator-a", peer_id: "orchestrator-b", caption: "Repository A orchestrator is online" },
    { ...event, repo_id: "repo-b", agent_id: "orchestrator-b", peer_id: "orchestrator-a", caption: "Repository B orchestrator is online" },
  ] : [event]);
  const ordered = expanded.map((event, sourceIndex) => ({ event, sourceIndex })).sort((left, right) => {
    const stage = (ORDER.get(STAGE[left.event.kind]) ?? 99) - (ORDER.get(STAGE[right.event.kind]) ?? 99);
    return stage || left.sourceIndex - right.sourceIndex;
  });
  let previous = null;
  const events = ordered.map(({ event, sourceIndex }, index) => {
    const endpoints = endpoint(event);
    const unsigned = {
      schema_version: 1,
      sequence: index + 1,
      event_id: `flight-${String(index + 1).padStart(3, "0")}`,
      run_id: String(report.scenario_id).slice(0, 96),
      timestamp: event.at,
      stage: STAGE[event.kind],
      kind: event.kind,
      status: STATUS[event.kind],
      caption: event.caption,
      detail: `Observed public flight atom ${sourceIndex + 1}; editorial stage ordering only.`,
      source_repo_id: endpoints.sourceRepo,
      ...(endpoints.targetRepo ? { target_repo_id: endpoints.targetRepo } : {}),
      actor_id: endpoints.actor,
      actor_role: endpoints.actorRole,
      ...(endpoints.target ? { target_id: endpoints.target, target_role: endpoints.targetRole } : {}),
      ...(endpoints.correlation ? { correlation_id: endpoints.correlation } : {}),
      ...(event.resource_id ? { resource_id: publicAtom(event.resource_id) } : {}),
      previous_hash: previous,
    };
    const complete = { ...unsigned, hash: computeFlightEventHash(unsigned) };
    previous = complete.hash;
    return complete;
  });
  return validateFlightEvents(events, { require_complete: true });
}

function endpoint(event) {
  const repo = event.repo_id ?? "repo-a";
  if (event.kind === "topology.online") return { sourceRepo: repo, actor: event.agent_id, actorRole: "orchestrator", target: event.peer_id, targetRole: "orchestrator", correlation: "topology" };
  if (event.kind === "message.sent" || event.kind === "message.acknowledged") return { sourceRepo: repo, actor: event.agent_id, actorRole: event.agent_id === "orchestrator" ? "orchestrator" : "agent", target: event.peer_id, targetRole: event.peer_id === "orchestrator" ? "orchestrator" : "agent", correlation: publicAtom(event.resource_id ?? "delegate") };
  if (event.kind === "peer.query" || event.kind === "peer.reply") return { sourceRepo: repo, targetRepo: repo === "repo-a" ? "repo-b" : "repo-a", actor: event.agent_id, actorRole: "agent", target: event.peer_id, targetRole: "agent", correlation: "parent-ipc-relay" };
  if (event.kind.startsWith("cross_repo.")) { const targetRepo = event.peer_id; return { sourceRepo: repo, targetRepo, actor: `${repo}-orchestrator`, actorRole: "orchestrator", target: `${targetRepo}-orchestrator`, targetRole: "orchestrator", correlation: publicAtom(event.session_id ?? "cross-repo") }; }
  if (event.kind === "agent.cancel_requested") return { sourceRepo: repo, actor: "orchestrator-a", actorRole: "orchestrator", target: event.agent_id, targetRole: "agent", correlation: publicAtom(event.resource_id ?? "cancel") };
  if (event.kind === "agent.terminated") return { sourceRepo: repo, actor: event.agent_id, actorRole: "agent", target: event.agent_id, targetRole: "agent", correlation: publicAtom(event.resource_id ?? "cancel") };
  if (event.kind.startsWith("integrity.")) return { sourceRepo: repo, actor: repo, actorRole: "repository" };
  return { sourceRepo: repo, actor: event.agent_id ?? event.session_id ?? "flight-control", actorRole: event.agent_id || event.session_id ? "agent" : "system", correlation: event.resource_id ? publicAtom(event.resource_id) : undefined };
}

function publicAtom(value) { return String(value).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96) || "event"; }

function main(args) {
  const input = args[0], output = args[1];
  if (!input || !output) throw new Error("usage: bun scripts/flight-control-publication.mjs <flight-report.json> <flight-events.jsonl>");
  const report = JSON.parse(readFileSync(resolve(input), "utf8"));
  const events = publicationToReplay(report);
  writeFileSync(resolve(output), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, events: events.length, output: resolve(output), chain_head: events.at(-1).hash })}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
