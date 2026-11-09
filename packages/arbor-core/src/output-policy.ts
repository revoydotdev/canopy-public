import { createHash } from "node:crypto";
import type { Provenance } from "./types.js";

export type OutputChannel = "model_context" | "transcript" | "preview" | "render";
export interface OutputBudget { max_bytes: number; max_lines: number; max_tokens_estimate: number; }
export type OutputPolicy = Readonly<Record<OutputChannel, OutputBudget>>;

/** Deliberately separate ceilings: a UI render limit is not a model-context limit. */
export const DEFAULT_OUTPUT_POLICY: OutputPolicy = {
  model_context: { max_bytes: 24_000, max_lines: 420, max_tokens_estimate: 6_000 },
  transcript: { max_bytes: 96_000, max_lines: 2_400, max_tokens_estimate: 24_000 },
  preview: { max_bytes: 12_000, max_lines: 180, max_tokens_estimate: 3_000 },
  render: { max_bytes: 6_000, max_lines: 90, max_tokens_estimate: 1_500 },
};

export interface OutputExcerpt { text: string; abbreviated: boolean; full_bytes: number; full_lines: number; full_tokens_estimate: number; }
export interface CaptureDescriptor { content_sha256: string; content_bytes: number; evidence_pointer: string; provenance: Provenance; raw_view_authorized: boolean; }

export function estimateTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 4); }
export function captureDescriptor(content: string, input: { provenance: Provenance; evidence_pointer: string; raw_view_authorized?: boolean }): CaptureDescriptor {
  if (!input.evidence_pointer.trim()) throw new Error("evidence_pointer must be non-empty");
  return { content_sha256: createHash("sha256").update(content).digest("hex"), content_bytes: Buffer.byteLength(content, "utf8"), evidence_pointer: input.evidence_pointer, provenance: structuredClone(input.provenance), raw_view_authorized: input.raw_view_authorized === true };
}

export function abbreviateOutput(content: string, budget: OutputBudget): OutputExcerpt {
  validateBudget(budget); const bytes = Buffer.byteLength(content, "utf8"); const lines = content.split("\n").length; const tokens = estimateTokens(content);
  if (bytes <= budget.max_bytes && lines <= budget.max_lines && tokens <= budget.max_tokens_estimate) return { text: content, abbreviated: false, full_bytes: bytes, full_lines: lines, full_tokens_estimate: tokens };
  const marker = "…[output abbreviated]…";
  const source = [...content];
  const fits = (candidate: string): boolean => Buffer.byteLength(candidate, "utf8") <= budget.max_bytes
    && candidate.split("\n").length <= budget.max_lines
    && estimateTokens(candidate) <= budget.max_tokens_estimate;
  let low = 0; let high = source.length; let text = "";
  // Retained characters are monotonic for all three budgets, so avoid a
  // character-at-a-time quadratic scan on multi-megabyte/no-newline output.
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const head = Math.ceil(retained / 2); const tail = retained - head;
    const candidate = `${source.slice(0, head).join("")}${marker}${source.slice(source.length - tail).join("")}`;
    if (fits(candidate)) { text = candidate; low = retained + 1; } else high = retained - 1;
  }
  // Extremely tiny budgets still return a deterministic ASCII marker fragment.
  if (!text) {
    const fallbackBytes = Math.min(budget.max_bytes, budget.max_tokens_estimate * 4);
    text = fallbackBytes >= 3 ? "…" : clipBytes("...", fallbackBytes);
  }
  return { text, abbreviated: true, full_bytes: bytes, full_lines: lines, full_tokens_estimate: tokens };
}

function validateBudget(budget: OutputBudget): void { for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("output budgets must be positive safe integers"); }
function clipBytes(value: string, max: number): string { let result = ""; for (const char of value) { if (Buffer.byteLength(result + char, "utf8") > max) break; result += char; } return result; }
