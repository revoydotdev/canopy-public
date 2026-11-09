import type { AgentRegistryView } from "./agent-registry.js";

export interface AgentQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "agent.list"; include_terminal?: boolean };
}

export type AgentRegistryProjection = AgentRegistryView;

export function isAgentQueryEnvelope(value: unknown): value is AgentQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "agent.list";
}

export function validateAgentQuery(value: AgentQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (value.query.include_terminal !== undefined && typeof value.query.include_terminal !== "boolean") failures.push("query.include_terminal must be a boolean");
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
