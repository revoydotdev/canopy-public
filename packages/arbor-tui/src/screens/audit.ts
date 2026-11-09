/**
 * Audit (evidence ledger) screen (finding 9, TUI-vs-backend observability
 * gap audit).
 *
 * Renders the real per-campaign evidence ledger `audit.list`
 * (`@arbor/mcp`'s `runtime-catalog.ts`, backed by
 * `CampaignManager.getAuditRecords`) returns: trace packets, gate
 * checkpoints, recovery decisions, interruptions, and the rest of
 * `@arbor/audit`'s `AuditRecord` union. Previously an operator only ever saw
 * the record's opaque id flash through the diagnostics event log
 * (`audit.evidence_recorded`/`diagnostics.ts`) — the actual governed
 * transition, gate result, or decision behind it was unreachable.
 *
 * This is a LEAF module: it never imports `@arbor/audit`, `@arbor/core`, or
 * `@arbor/mcp` (ADR-011). `describeRecord` below duck-types every
 * `AuditRecord.kind` this package's real producer can emit
 * (`arbor-audit/src/audit.ts`'s closed union), mirroring
 * `diagnostics.ts`'s `describeEvent` discipline: an unrecognized kind is
 * rendered as a visible "unhandled kind" marker, never collapsed into the
 * same blank text a legitimately detail-less record would also produce.
 */
import { clipDisplay } from "../widgets.js";

import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { renderStatusDocument } from "./status-document.js";

const MAX_ROWS = 200;
const MAX_DETAIL_CHARS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "?";
}

/** Recognized as an `audit.list` result: an array (possibly empty — a real "no records yet" is not "no query issued"). */
function isAuditListShape(result: unknown): result is readonly Record<string, unknown>[] {
  if (!Array.isArray(result)) return false;
  if (result.length === 0) return true;
  return isRecord(result[0]) && "id" in result[0] && "campaign_id" in result[0];
}

/**
 * `AuditRecord.kind` (`arbor-audit/src/audit.ts:442`): `TracePacket.kind` is
 * the one optional member — persisted records carry it, but the type only
 * requires it be `"trace"` when present, so a missing `kind` here still
 * means "trace".
 */
function describeRecord(record: Record<string, unknown>): string {
  const kind = typeof record.kind === "string" ? record.kind : "trace";
  switch (kind) {
    case "trace": {
      return `${str(record.action_description)}: ${str(record.node_state_before)} -> ${str(record.node_state_after)} (score ${str(record.score_before)}->${str(record.score_after)})`;
    }
    case "gate_checkpoint": {
      const checkpoint = isRecord(record.checkpoint) ? record.checkpoint : {};
      const gate = isRecord(checkpoint.gate) ? checkpoint.gate : {};
      return `${str(checkpoint.transition)}: ${str(gate.gate)} -> ${str(gate.result)}${gate.bypass_evidence_deficit ? ` (bypass: ${str(gate.bypass_evidence_deficit)})` : ""}`;
    }
    case "recovery_decision": {
      const decision = isRecord(record.decision) ? record.decision : {};
      return `${str(decision.decision)} by ${str(decision.actor)} -> ${str(decision.outcome)}`;
    }
    case "interruption": {
      const interruption = isRecord(record.interruption) ? record.interruption : {};
      return `${str(interruption.scope)} ${str(interruption.phase)}: ${str(interruption.reason)}`;
    }
    case "node_communication": {
      const communication = isRecord(record.communication) ? record.communication : {};
      const remote = isRecord(communication.remote_attribution) ? communication.remote_attribution : null;
      const attribution = remote === null ? "" : ` · remote ${str(remote.integrity)} session=${str(remote.session_id)} key=${str(remote.key_id)} cert=${str(remote.certificate_id)}`;
      return `${str(communication.kind)}: ${str(communication.author_node_id)} -> ${str(communication.recipient_node_id)}${attribution}`;
    }
    case "memory_fact": {
      const fact = isRecord(record.fact) ? record.fact : {};
      return `${str(fact.type)}: ${str(fact.content)}`;
    }
    case "telemetry_observation": {
      const observation = isRecord(record.observation) ? record.observation : {};
      return `${str(observation.type)} ${str(observation.phase)} -> ${str(observation.outcome)}`;
    }
    case "phase_message": {
      const message = isRecord(record.message) ? record.message : {};
      return `${str(message.phase)}: ${str(message.content)}`;
    }
    case "compaction_lifecycle": {
      const lifecycle = isRecord(record.lifecycle) ? record.lifecycle : {};
      return `${str(lifecycle.trigger)} ${str(lifecycle.strategy)} -> ${str(lifecycle.status)}`;
    }
    case "request_user_input": {
      const question = isRecord(record.question) ? record.question : {};
      return `${str(record.status)}: ${str(question.question)}`;
    }
    case "user_input_answer": {
      const answer = isRecord(record.answer) ? record.answer : {};
      return `answered by ${str(answer.answered_by)}: ${str(answer.custom_text ?? answer.option_id)}`;
    }
    case "campaign_reopen": {
      const reopen = isRecord(record.reopen) ? record.reopen : {};
      return `reopen ${str(reopen.phase)} by ${str(reopen.actor)}: overrode ${str(reopen.overridden_halt_reason)} halt for ${str(record.node_id)}`;
    }
    default:
      return `unhandled record kind: ${kind}`;
  }
}

function rowCountCaption(count: number): string {
  return count > 0 ? `Evidence records (${count})` : "no evidence records";
}

function projectAuditList(records: readonly Record<string, unknown>[], limit: number): Omit<ScreenProjection, "variant"> {
  const sliced = records.slice(0, limit);
  const bounded = sliced.map((record) => ({
    id: typeof record.id === "string" ? record.id : "?",
    kind: typeof record.kind === "string" ? record.kind : "trace",
    node_id: typeof record.node_id === "string" ? record.node_id : "-",
    detail: clipDisplay(describeRecord(record), MAX_DETAIL_CHARS),
  }));
  return {
    screen: "audit",
    rows: bounded,
    columns: [
      { key: "id", title: "ID", width: 12, truncate: "middle" },
      { key: "kind", title: "Kind", width: 20 },
      { key: "node_id", title: "Node", width: 12 },
      { key: "detail", title: "Detail", width: 50 },
    ],
    caption: rowCountCaption(bounded.length),
    row_ids: sliced.map((record): RowIdentity | null => (typeof record.id === "string" ? { id: record.id } : null)),
  };
}

function renderAuditTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  return renderStatusDocument(projection, width, height, offset, { wide_min_columns: 104, empty_caption: "Evidence data unavailable" });
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return { screen: "audit", rows: [], columns: [{ key: "id", title: "ID", width: 12, truncate: "middle" }], caption: "Evidence data unavailable — no ledger state is inferred" };
}

const AUDIT_VARIANTS = [
  defineVariant({
    tag: "records",
    match: isAuditListShape,
    project: (shape) => projectAuditList(shape, MAX_ROWS),
    render: (projection, ctx) => renderAuditTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const auditScreen: ScreenModule = {
  id: "audit" as ScreenId,
  title: "Evidence Ledger",
  required_capabilities: ["audit.read"],

  surface: { commands: [], queries: ["audit.list"] },

  ...buildScreenPipeline(AUDIT_VARIANTS, { emptyProjection }),
};
