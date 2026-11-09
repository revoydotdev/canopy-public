import type { ApplicationCommand, ApplicationQuery } from "./runtime-contracts.js";

export type RuntimeCatalogKind = ApplicationCommand["kind"] | ApplicationQuery["kind"]
  | "repo.flight.session.enroll" | "repo.flight.session.reconcile" | "repo.flight.session.drain" | "repo.flight.session.quiesce" | "repo.flight.clearance.request" | "repo.flight.clearance.renew" | "repo.flight.clearance.revoke" | "repo.flight.drain.request" | "repo.flight.drain.ack" | "repo.flight.drain.activate" | "repo.flight.drain.release" | "repo.flight.gate.request" | "repo.flight.gate.ack" | "repo.flight.gate.activate" | "repo.flight.gate.run" | "repo.flight.delivery.sent" | "repo.flight.delivery.transition" | "repo.flight.effect.reconcile" | "repo.flight.run.create" | "repo.flight.run.authorize" | "repo.flight.run.transition" | "repo.flight.execution.schedule" | "repo.flight.status" | "repo.flight.sessions" | "repo.flight.clearances" | "repo.flight.drains" | "repo.flight.gate" | "repo.flight.deliveries" | "repo.flight.effects" | "repo.flight.runs" | "repo.flight.profile" | "repo.flight.telemetry"
  | "tree.interrupt"
  | "communication.record" | "communication.selection" | "communication.history"
  | "output.capture" | "output.descriptor" | "output.list" | "output.raw"
  | "surveillance.scan" | "surveillance.findings"
  | "capability.introspect"
  | "config.get"
  | "governance.snapshot"
  | "governance.backlog"
  | "governance.record.search"
  | "governance.record.read"
  | "kb.list"
  | "audit.list"
  | "agent.list"
  | "operation.list"
  | "inspect.action"
  | "recovery.pending"
  | "job.submit" | "job.cancel" | "job.retry" | "job.pause" | "job.resume" | "job.list"
  | "approval.request" | "approval.approve" | "approval.reject" | "approval.expire" | "approval.list"
  | "trust.session.enroll" | "trust.session.rotate" | "trust.session.revoke" | "trust.session.list" | "trust.session.status"
  | "compaction.record" | "compaction.list" | "compaction.guard"
  | "phase_message.list"
  | "userinput.ask" | "userinput.answer" | "userinput.list" | "userinput.awaiting"
  | "bus.record" | "bus.history"
  | "bus.thread.send" | "bus.thread.ack" | "bus.thread.history"
  | "peer.grant" | "peer.query" | "peer.reply" | "peer.history" | "peer.grants"
  | "sibling.status"
  | "sibling.spawn"
  | "foreground.derive" | "nodecard.resolve"
  | "a2a.send" | "a2a.receive" | "a2a.cards"
  | "context.artifact.capture" | "context.workspace" | "context.overlays" | "context.governance"
  | "fold.propose" | "fold.approve" | "fold.rollback"
  | "playbook.propose" | "playbook.approve"
  | "harness.propose" | "harness.approve" | "harness.rollback" | "harness.evaluate" | "harness.promote"
  | "subagent.execute" | "subagent.executions"
  | "harness.evaluation.start" | "harness.evaluation.candidates" | "harness.evaluation.runs" | "harness.evaluation.detail" | "harness.quarantine"
  | "harness.connector.inventory"
  | "harness.native.readiness"
  | "doctor.get" | "migration.inspect" | "migration.preview" | "migration.apply" | "migration.rollback"
  | "integration.list" | "integration.inspect" | "integration.admit" | "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "integration.rollback" | "remote.inspect" | "remote.control" | "scheduler.inspect" | "scheduler.control"
  | "project.registry.list"
  | "project.manage"
  | "harness.session.interrupt" | "harness.session.steer" | "harness.session.list" | "harness.session.inspect" | "harness.session.events" | "harness.session.attach"
  | "harness.session.availability" | "harness.session.resume" | "harness.session.fork" | "harness.session.respawn"
  | "native.budget.get"
  | "taskcomposer.submit" | "taskcomposer.answer" | "taskcomposer.confirm" | "taskcomposer.cancel" | "taskcomposer.retry" | "taskcomposer.reject"
  | "taskcomposer.get" | "taskcomposer.list"
  | "result.list" | "result.inspect" | "result.scope.authorize" | "result.adopt" | "result.revert" | "result.review.workspace" | "result.review.comment" | "result.review.request_revision" | "result.review.editor_handoff"
  | "session.identity.get" | "session.identity.search" | "session.identity.mutate"
  | "result.verification.get" | "result.verification.list"
  | "notification.list" | "notification.read"
  | "followup.list" | "followup.create"
  | "control.status" | "control.discover" | "control.inbox"
  | "git.workspace" | "git.worktree.create" | "git.worktree.switch" | "git.worktree.cleanup";

export interface RuntimeCatalogEntry {
  kind: RuntimeCatalogKind;
  direction: "command" | "query";
  capability: string;
  idempotency: "required" | "not_applicable";
  supported: boolean;
  unavailable_reason?: string;
}



/** Advisory classifications consumed by runtimeOperationHints in the MCP router. */
export const DESTRUCTIVE_RUNTIME_KINDS = [
  "campaign.halt", "tree.prune", "tree.interrupt", "operation.cancel", "recovery.abandon",
  "git.worktree.cleanup", "integration.disable", "integration.rollback",
  "migration.rollback", "result.revert", "job.cancel", "job.pause",
] as const satisfies readonly RuntimeCatalogKind[];

export const OPEN_WORLD_RUNTIME_KINDS = [
  "remote.control", "integration.install", "integration.enable", "integration.update",
] as const satisfies readonly RuntimeCatalogKind[];

/**
 * The complete core-contract catalog. Unsupported variants remain visible so
 * transports cannot accidentally claim an unimplemented control is wired.
 */
export const RUNTIME_CATALOG_MANIFEST = [
  { kind: "campaign.start", direction: "command", capability: "campaign.write", idempotency: "required", supported: true },
  { kind: "campaign.halt", direction: "command", capability: "campaign.write", idempotency: "required", supported: true },
  { kind: "tree.branch", direction: "command", capability: "tree.write", idempotency: "required", supported: true },
  { kind: "tree.prune", direction: "command", capability: "tree.write", idempotency: "required", supported: true },
  { kind: "tree.interrupt", direction: "command", capability: "tree.interrupt", idempotency: "required", supported: true },
  { kind: "operation.cancel", direction: "command", capability: "operation.cancel", idempotency: "required", supported: true },
  { kind: "task.retry", direction: "command", capability: "task.retry", idempotency: "required", supported: true },
  { kind: "recovery.retry", direction: "command", capability: "recovery.write", idempotency: "required", supported: true },
  { kind: "recovery.abandon", direction: "command", capability: "recovery.abandon", idempotency: "required", supported: true },
  { kind: "campaign.list", direction: "query", capability: "campaign.read", idempotency: "not_applicable", supported: true },
  { kind: "campaign.snapshot", direction: "query", capability: "campaign.read", idempotency: "not_applicable", supported: true },
  { kind: "campaign.tree", direction: "query", capability: "tree.read", idempotency: "not_applicable", supported: true },
  { kind: "git.workspace", direction: "query", capability: "git.read", idempotency: "not_applicable", supported: true },
  { kind: "git.worktree.create", direction: "command", capability: "git.worktree.write", idempotency: "required", supported: true },
  { kind: "git.worktree.switch", direction: "command", capability: "git.worktree.write", idempotency: "required", supported: true },
  { kind: "git.worktree.cleanup", direction: "command", capability: "git.worktree.write", idempotency: "required", supported: true },
  { kind: "control.status", direction: "query", capability: "control.read", idempotency: "not_applicable", supported: true },
  { kind: "control.discover", direction: "query", capability: "control.read", idempotency: "not_applicable", supported: true },
  { kind: "control.inbox", direction: "query", capability: "control.read", idempotency: "not_applicable", supported: true },
  { kind: "operation.get", direction: "query", capability: "operation.read", idempotency: "not_applicable", supported: true },
  // M6: structured Inspect lookup is a read-only projection over the same
  // canonical operation registry; it carries an authoritative snapshot stamp.
  { kind: "inspect.action", direction: "query", capability: "operation.read", idempotency: "not_applicable", supported: true },
  // G-32 closed: the `operations` TUI screen had no honest query to issue —
  // `operation.get` needs a specific id and nothing enumerated one. Backed by
  // `OperationRegistry.list` (arbor-core/src/operation-registry.ts), the
  // registry's own real enumeration surface — same capability as
  // `operation.get` since both read the same registry.
  { kind: "operation.list", direction: "query", capability: "operation.read", idempotency: "not_applicable", supported: true },
  { kind: "recovery.pending", direction: "query", capability: "recovery.read", idempotency: "not_applicable", supported: true },
  { kind: "task.list", direction: "query", capability: "task.read", idempotency: "not_applicable", supported: true },
  { kind: "event.resume", direction: "query", capability: "event.read", idempotency: "not_applicable", supported: true },
  { kind: "communication.record", direction: "command", capability: "communication.write", idempotency: "required", supported: true },
  { kind: "communication.selection", direction: "query", capability: "communication.read", idempotency: "not_applicable", supported: true },
  { kind: "communication.history", direction: "query", capability: "communication.read", idempotency: "not_applicable", supported: true },
  { kind: "output.capture", direction: "command", capability: "output.capture", idempotency: "required", supported: true },
  { kind: "output.descriptor", direction: "query", capability: "output.read", idempotency: "not_applicable", supported: true },
  // Same capability as `output.descriptor` — both read persisted descriptor
  // records. Neither query touches blob bytes: raw disclosure is exclusively
  // the separately approval-bound `output.raw` query below.
  { kind: "output.list", direction: "query", capability: "output.read", idempotency: "not_applicable", supported: true },
  { kind: "output.raw", direction: "query", capability: "output.raw", idempotency: "not_applicable", supported: true },
  { kind: "surveillance.scan", direction: "command", capability: "surveillance.scan", idempotency: "required", supported: true },
  { kind: "surveillance.findings", direction: "query", capability: "surveillance.read", idempotency: "not_applicable", supported: true },
  { kind: "capability.introspect", direction: "query", capability: "capability.read", idempotency: "not_applicable", supported: true },
  // Reads decisions/ from disk and projects it; no campaign state involved.
  { kind: "governance.snapshot", direction: "query", capability: "governance.read", idempotency: "not_applicable", supported: true },
  // Same corpus, different facet (finding 15): the ranked POL-04 work backlog
  // `selfhost.ts` already drives a self-host campaign's next task from, but
  // only ever printed to CLI stdout. Reads decisions/ from disk; no campaign
  // state involved, same as governance.snapshot above.
  { kind: "governance.backlog", direction: "query", capability: "governance.backlog.read", idempotency: "not_applicable", supported: true },
  { kind: "governance.record.search", direction: "query", capability: "governance.read", idempotency: "not_applicable", supported: true },
  { kind: "governance.record.read", direction: "query", capability: "governance.read", idempotency: "not_applicable", supported: true },
  // finding 8: KB entries were visible only as an opaque id flashing through
  // kb.entry_added events. Backed by CampaignManager.kbQuery — real,
  // capability-gated, campaign-scoped envelopes.
  { kind: "kb.list", direction: "query", capability: "kb.read", idempotency: "not_applicable", supported: true },
  // finding 9: the evidence ledger was visible only as an opaque id flashing
  // through audit.evidence_recorded events. Backed by
  // CampaignManager.getAuditRecords — the real, complete per-campaign ledger.
  { kind: "audit.list", direction: "query", capability: "audit.read", idempotency: "not_applicable", supported: true },
  { kind: "config.get", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "doctor.get", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "migration.inspect", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "migration.preview", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "migration.apply", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "migration.rollback", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "integration.list", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "integration.inspect", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "integration.admit", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "remote.inspect", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "scheduler.inspect", direction: "query", capability: "config.read", idempotency: "not_applicable", supported: true },
  { kind: "integration.install", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "integration.enable", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "integration.disable", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "integration.update", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "integration.rollback", direction: "command", capability: "config.write", idempotency: "required", supported: true },
  { kind: "remote.control", direction: "command", capability: "trust.session.write", idempotency: "required", supported: true },
  { kind: "scheduler.control", direction: "command", capability: "schedule.write", idempotency: "required", supported: true },
  // The campaign allocation authority is durable and separate from both
  // static native config and ledger telemetry.  This projection exposes only
  // its actual configured snapshot (or typed absence), never a derived spend.
  { kind: "native.budget.get", direction: "query", capability: "campaign.read", idempotency: "not_applicable", supported: true },
  // Task composition is a separate pre-campaign authority. These routes are
  // intentionally adapters only: TaskComposer owns planning, revision/CAS,
  // persistence, and admission; the catalog owns normal capability and
  // operation-boundary enforcement.
  { kind: "taskcomposer.submit", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.answer", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.confirm", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.cancel", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.retry", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.reject", direction: "command", capability: "taskcomposer.write", idempotency: "required", supported: true },
  { kind: "taskcomposer.get", direction: "query", capability: "taskcomposer.read", idempotency: "not_applicable", supported: true },
  { kind: "taskcomposer.list", direction: "query", capability: "taskcomposer.read", idempotency: "not_applicable", supported: true },
  { kind: "result.list", direction: "query", capability: "result.read", idempotency: "not_applicable", supported: true },
  { kind: "result.inspect", direction: "query", capability: "result.read", idempotency: "not_applicable", supported: true },
  { kind: "result.scope.authorize", direction: "command", capability: "result.adopt", idempotency: "required", supported: true },
  { kind: "result.adopt", direction: "command", capability: "result.adopt", idempotency: "required", supported: true },
  { kind: "result.revert", direction: "command", capability: "result.revert", idempotency: "required", supported: true },
  { kind: "result.review.workspace", direction: "query", capability: "result.read", idempotency: "not_applicable", supported: true },
  { kind: "result.review.comment", direction: "command", capability: "result.adopt", idempotency: "required", supported: true },
  { kind: "result.review.request_revision", direction: "command", capability: "result.adopt", idempotency: "required", supported: true },
  { kind: "result.review.editor_handoff", direction: "command", capability: "result.adopt", idempotency: "required", supported: true },
  { kind: "session.identity.get", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "session.identity.search", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "session.identity.mutate", direction: "command", capability: "harness.session.write", idempotency: "required", supported: true },
  { kind: "result.verification.get", direction: "query", capability: "result.read", idempotency: "not_applicable", supported: true },
  { kind: "result.verification.list", direction: "query", capability: "result.read", idempotency: "not_applicable", supported: true },
  { kind: "notification.list", direction: "query", capability: "notification.read", idempotency: "not_applicable", supported: true },
  { kind: "notification.read", direction: "command", capability: "notification.write", idempotency: "required", supported: true },
  { kind: "followup.list", direction: "query", capability: "campaign.read", idempotency: "not_applicable", supported: true },
  { kind: "followup.create", direction: "command", capability: "campaign.write", idempotency: "required", supported: true },
  { kind: "agent.list", direction: "query", capability: "agent.read", idempotency: "not_applicable", supported: true },
  { kind: "job.submit", direction: "command", capability: "job.write", idempotency: "required", supported: true },
  { kind: "job.cancel", direction: "command", capability: "job.write", idempotency: "required", supported: true },
  { kind: "job.retry", direction: "command", capability: "job.write", idempotency: "required", supported: true },
  { kind: "job.pause", direction: "command", capability: "job.write", idempotency: "required", supported: true },
  { kind: "job.resume", direction: "command", capability: "job.write", idempotency: "required", supported: true },
  { kind: "job.list", direction: "query", capability: "job.read", idempotency: "not_applicable", supported: true },
  { kind: "approval.request", direction: "command", capability: "approval.request", idempotency: "required", supported: true },
  { kind: "approval.approve", direction: "command", capability: "approval.decide", idempotency: "required", supported: true },
  { kind: "approval.reject", direction: "command", capability: "approval.decide", idempotency: "required", supported: true },
  { kind: "approval.expire", direction: "command", capability: "approval.decide", idempotency: "required", supported: true },
  { kind: "approval.list", direction: "query", capability: "approval.read", idempotency: "not_applicable", supported: true },
  // Host-local remote-session authority controls. These enrol or inspect
  // credentials for an explicitly configured adapter; they do not start or
  // advertise a transport of any kind.
  { kind: "trust.session.enroll", direction: "command", capability: "trust.session.write", idempotency: "required", supported: true },
  { kind: "trust.session.rotate", direction: "command", capability: "trust.session.write", idempotency: "required", supported: true },
  { kind: "trust.session.revoke", direction: "command", capability: "trust.session.write", idempotency: "required", supported: true },
  { kind: "trust.session.list", direction: "query", capability: "trust.session.read", idempotency: "not_applicable", supported: true },
  { kind: "trust.session.status", direction: "query", capability: "trust.session.read", idempotency: "not_applicable", supported: true },
  { kind: "compaction.record", direction: "command", capability: "compaction.write", idempotency: "required", supported: true },
  { kind: "compaction.list", direction: "query", capability: "compaction.read", idempotency: "not_applicable", supported: true },
  { kind: "compaction.guard", direction: "query", capability: "compaction.read", idempotency: "not_applicable", supported: true },
  // ADR-016: no `phase_message.record` command exists here deliberately — a
  // write surface would let a caller fabricate the record this ledger
  // exists to prove. Only `runCampaign` (arbor-opencode/loop.ts), via
  // `EvidenceLedger.recordPhaseMessage`, ever produces one.
  { kind: "phase_message.list", direction: "query", capability: "phase_message.read", idempotency: "not_applicable", supported: true },
  { kind: "userinput.ask", direction: "command", capability: "userinput.write", idempotency: "required", supported: true },
  { kind: "userinput.answer", direction: "command", capability: "userinput.write", idempotency: "required", supported: true },
  { kind: "userinput.list", direction: "query", capability: "userinput.read", idempotency: "not_applicable", supported: true },
  { kind: "userinput.awaiting", direction: "query", capability: "userinput.read", idempotency: "not_applicable", supported: true },
  { kind: "bus.record", direction: "command", capability: "bus.write", idempotency: "required", supported: true },
  { kind: "bus.history", direction: "query", capability: "bus.read", idempotency: "not_applicable", supported: true },
  { kind: "bus.thread.send", direction: "command", capability: "bus.write", idempotency: "required", supported: true },
  { kind: "bus.thread.ack", direction: "command", capability: "bus.write", idempotency: "required", supported: true },
  { kind: "bus.thread.history", direction: "query", capability: "bus.read", idempotency: "not_applicable", supported: true },
  { kind: "peer.grant", direction: "command", capability: "peer.grant", idempotency: "required", supported: true },
  { kind: "peer.query", direction: "command", capability: "peer.write", idempotency: "required", supported: true },
  { kind: "peer.reply", direction: "command", capability: "peer.write", idempotency: "required", supported: true },
  { kind: "peer.history", direction: "query", capability: "peer.read", idempotency: "not_applicable", supported: true },
  { kind: "peer.grants", direction: "query", capability: "peer.read", idempotency: "not_applicable", supported: true },
  { kind: "sibling.status", direction: "query", capability: "sibling.read", idempotency: "not_applicable", supported: true },
  { kind: "sibling.spawn", direction: "command", capability: "sibling.write", idempotency: "required", supported: true },
  // The same opencode authorities used by campaign dispatch re-derive these
  // from the canonical campaign snapshot; no parallel card registry exists.
  { kind: "foreground.derive", direction: "query", capability: "foreground.read", idempotency: "not_applicable", supported: true },
  { kind: "nodecard.resolve", direction: "query", capability: "nodecard.read", idempotency: "not_applicable", supported: true },
  { kind: "a2a.send", direction: "command", capability: "a2a.write", idempotency: "required", supported: true },
  { kind: "a2a.receive", direction: "command", capability: "a2a.write", idempotency: "required", supported: true },
  // Source cards are live; publication remains fail-closed without an A2A
  // signing secret, enforced in executeLiveProjectionQuery.
  { kind: "a2a.cards", direction: "query", capability: "a2a.read", idempotency: "not_applicable", supported: true },
  { kind: "context.artifact.capture", direction: "command", capability: "context.write", idempotency: "required", supported: true },
  { kind: "context.workspace", direction: "query", capability: "context.read", idempotency: "not_applicable", supported: true },
  { kind: "context.overlays", direction: "query", capability: "context.read", idempotency: "not_applicable", supported: true },
  { kind: "context.governance", direction: "query", capability: "context.read", idempotency: "not_applicable", supported: true },
  { kind: "fold.propose", direction: "command", capability: "fold.write", idempotency: "required", supported: true },
  { kind: "fold.approve", direction: "command", capability: "fold.approve", idempotency: "required", supported: true },
  { kind: "fold.rollback", direction: "command", capability: "fold.rollback", idempotency: "required", supported: true },
  { kind: "playbook.propose", direction: "command", capability: "playbook.write", idempotency: "required", supported: true },
  { kind: "playbook.approve", direction: "command", capability: "playbook.approve", idempotency: "required", supported: true },
  { kind: "harness.propose", direction: "command", capability: "harness.write", idempotency: "required", supported: true },
  { kind: "harness.approve", direction: "command", capability: "harness.approve", idempotency: "required", supported: true },
  { kind: "harness.rollback", direction: "command", capability: "harness.rollback", idempotency: "required", supported: true },
  { kind: "harness.evaluate", direction: "command", capability: "harness.evaluate", idempotency: "required", supported: true },
  { kind: "harness.promote", direction: "command", capability: "harness.promote", idempotency: "required", supported: true },
  // This is deliberately distinct from `subagent.describe`, which remains a
  // checkpoint-only context capability.  Execution is a separately composed
  // native, fixed no-tools child and may truthfully be unavailable.
  { kind: "subagent.execute", direction: "command", capability: "subagent.execute", idempotency: "required", supported: true },
  { kind: "subagent.executions", direction: "query", capability: "subagent.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.evaluation.start", direction: "command", capability: "harness.evaluate", idempotency: "required", supported: true },
  { kind: "harness.evaluation.candidates", direction: "query", capability: "harness.evaluate", idempotency: "not_applicable", supported: true },
  { kind: "harness.evaluation.runs", direction: "query", capability: "harness.evaluate", idempotency: "not_applicable", supported: true },
  { kind: "harness.evaluation.detail", direction: "query", capability: "harness.evaluate", idempotency: "not_applicable", supported: true },
  { kind: "harness.quarantine", direction: "command", capability: "harness.quarantine", idempotency: "required", supported: true },
  { kind: "harness.connector.inventory", direction: "query", capability: "harness.connector.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.native.readiness", direction: "query", capability: "harness.connector.read", idempotency: "not_applicable", supported: true },
  // ADR-076/Roadmap 23 W2+W6: the multi-project registry TUI screen. Neither
  // kind writes project-registry.json — `project.registry.list` re-verifies
  // every entry fresh (or one scoped `project_id`) on every call, and
  // `project.manage` runs the real per-entry gate battery and reports; both
  // are "a query that performs real work and reports" the same shape
  // harness.native.readiness above already uses for its own doctor probe.
  { kind: "project.registry.list", direction: "query", capability: "project.registry.read", idempotency: "not_applicable", supported: true },
  { kind: "project.manage", direction: "query", capability: "project.manage.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.session.interrupt", direction: "command", capability: "harness.session.interrupt", idempotency: "required", supported: true },
  { kind: "harness.session.steer", direction: "command", capability: "harness.session.write", idempotency: "required", supported: true },
  { kind: "harness.session.resume", direction: "command", capability: "harness.session.write", idempotency: "required", supported: true },
  { kind: "harness.session.fork", direction: "command", capability: "harness.session.write", idempotency: "required", supported: true },
  { kind: "harness.session.respawn", direction: "command", capability: "harness.session.write", idempotency: "required", supported: true },
  { kind: "harness.session.list", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.session.inspect", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.session.events", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.session.attach", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "harness.session.availability", direction: "query", capability: "harness.session.read", idempotency: "not_applicable", supported: true },
  { kind: "repo.flight.status", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.sessions", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.clearances", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.drains", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.gate", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.deliveries", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.effects", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.runs", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.profile", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.telemetry", direction: "query", capability: "repo.flight.read", idempotency: "not_applicable", supported: false },
  { kind: "repo.flight.session.enroll", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.session.reconcile", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.session.drain", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.session.quiesce", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.clearance.request", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.clearance.renew", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.clearance.revoke", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.drain.request", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.drain.ack", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.drain.activate", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.drain.release", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.gate.request", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.gate.ack", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.gate.activate", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.gate.run", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.delivery.sent", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.delivery.transition", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.effect.reconcile", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.run.create", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.run.authorize", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.run.transition", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
  { kind: "repo.flight.execution.schedule", direction: "command", capability: "repo.flight.write", idempotency: "required", supported: false },
] as const satisfies readonly RuntimeCatalogEntry[];
