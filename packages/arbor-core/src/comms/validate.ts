/**
 * Closed-shape validation helpers shared by the comms contracts. Every
 * validator rejects unknown fields: a payload is the declared shape or it is
 * refused, never silently trimmed.
 */
import type { RuntimeContractViolation, RuntimeValidationResult } from "../runtime-contracts.js";

const encoder = new TextEncoder();

export type Violations = RuntimeContractViolation[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length — the unit every comms text bound is stated in. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

export function checkKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string, out: Violations): void {
  for (const key of required) if (!(key in value)) out.push({ path: `${path}.${key}`, message: "is required" });
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) out.push({ path: `${path}.${key}`, message: "is not a declared field" });
}

export function checkId(value: unknown, path: string, out: Violations): void {
  if (typeof value !== "string" || value.trim().length === 0 || utf8Bytes(value) > 256) out.push({ path, message: "must be a non-empty identifier of at most 256 bytes" });
}

export function checkText(value: unknown, path: string, maxBytes: number, out: Violations, { allowEmpty = false } = {}): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    out.push({ path, message: allowEmpty ? "must be a string" : "must be a non-empty string" });
    return;
  }
  if (utf8Bytes(value) > maxBytes) out.push({ path, message: `must be at most ${maxBytes} UTF-8 bytes` });
}

export function checkEnum(value: unknown, members: readonly string[], path: string, out: Violations): void {
  if (typeof value !== "string" || !members.includes(value)) out.push({ path, message: `must be one of ${members.join(", ")}` });
}

export function checkTimestamp(value: unknown, path: string, out: Violations): void {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) out.push({ path, message: "must be an ISO-8601 timestamp" });
}

export function checkIdList(value: unknown, path: string, maxItems: number, out: Violations): void {
  if (!Array.isArray(value) || value.length > maxItems) {
    out.push({ path, message: `must be an array of at most ${maxItems} identifiers` });
    return;
  }
  value.forEach((entry, index) => checkId(entry, `${path}[${index}]`, out));
  if (new Set(value).size !== value.length) out.push({ path, message: "must not repeat an identifier" });
}

export function result<T>(value: unknown, out: Violations): RuntimeValidationResult<T> {
  return out.length === 0 ? { ok: true, value: value as T } : { ok: false, violations: out };
}
