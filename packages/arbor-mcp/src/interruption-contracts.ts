import type { OperationMetadata, Provenance } from "@arbor/core";

export interface InterruptionCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata & { expected_version: string };
  command: {
    kind: "tree.interrupt";
    campaign_id: string;
    node_id: string;
    scope: "node" | "subtree";
    reason: string;
    partial_evidence_ids?: readonly string[];
    provenance: Provenance;
  };
}

export function isInterruptionCommandEnvelope(value: unknown): value is InterruptionCommandEnvelope {
  return record(value) && record(value.command) && value.command.kind === "tree.interrupt";
}

export function validateInterruptionCommand(value: InterruptionCommandEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must equal 1");
  if (!record(value.metadata)) failures.push("metadata is required");
  else {
    for (const key of ["operation_id", "idempotency_key", "correlation_id", "actor_id", "expected_version"] as const) {
      if (!text(value.metadata[key])) failures.push(`metadata.${key} must be non-empty`);
    }
    if (!text(value.metadata.requested_at) || Number.isNaN(Date.parse(value.metadata.requested_at))) failures.push("metadata.requested_at must be ISO-parseable");
  }
  const command = value.command;
  if (!text(command.campaign_id) || !text(command.node_id) || !text(command.reason)) failures.push("campaign_id, node_id, and reason must be non-empty");
  if (command.scope !== "node" && command.scope !== "subtree") failures.push("scope must be node or subtree");
  if (!validProvenance(command.provenance)) failures.push("provenance must be a typed provenance value");
  if (command.partial_evidence_ids !== undefined && (!Array.isArray(command.partial_evidence_ids)
    || command.partial_evidence_ids.length > 128 || command.partial_evidence_ids.some((id) => !text(id)))) {
    failures.push("partial_evidence_ids must contain at most 128 non-empty IDs");
  }
  return failures;
}

function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validProvenance(value: unknown): value is Provenance {
  if (!record(value) || !text(value.tag)) return false;
  if (value.tag === "verified") return text(value.cmd) && Number.isFinite(value.exit) && text(value.stdout_hash);
  if (value.tag === "claimed") return text(value.claimant);
  if (value.tag === "critic_approved") return text(value.critic) && text(value.rationale);
  return value.tag === "generated" && text(value.generator) && text(value.input_hash);
}
