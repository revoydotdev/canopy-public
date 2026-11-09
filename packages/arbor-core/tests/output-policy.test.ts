import { describe, expect, it } from "vitest";
import { abbreviateOutput, captureDescriptor } from "../src/output-policy.js";
describe("output policy", () => {
  it("enforces independent budgets with deterministic head-tail output even without newlines", () => { const excerpt = abbreviateOutput("abcdefghij", { max_bytes: 9, max_lines: 2, max_tokens_estimate: 3 }); expect(excerpt.abbreviated).toBe(true); expect(excerpt.text).toContain("…"); expect(excerpt.full_bytes).toBe(10); });
  it("bounds adversarial large and tiny-budget output", () => { const excerpt = abbreviateOutput("x".repeat(1_000_000), { max_bytes: 100, max_lines: 1, max_tokens_estimate: 25 }); expect(Buffer.byteLength(excerpt.text)).toBeLessThanOrEqual(100); expect(excerpt.text).toContain("abbreviated"); expect(abbreviateOutput("oversized", { max_bytes: 1, max_lines: 1, max_tokens_estimate: 1 }).text).toBe("."); });
  it("captures full content integrity without exposing raw content", () => { const capture = captureDescriptor("secret", { evidence_pointer: "audit:1", provenance: { tag: "generated", generator: "test", input_hash: "hash" } }); expect(capture).toMatchObject({ content_bytes: 6, raw_view_authorized: false }); });
});
