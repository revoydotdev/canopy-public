/**
 * `composeRolePrompt`'s guards are the boundary between operator/model-supplied
 * text and a composed role prompt. Their refusal branches were unexercised, so
 * nothing proved an oversized or unprovenanced item is rejected rather than
 * silently truncated into the prompt.
 */
import { describe, expect, it } from "vitest";
import { composeRolePrompt } from "../src/role-profiles.js";

const MAX_ITEM_BYTES = 64 * 1024;
const base = { role_id: "architect" as const, task: "bound the composed role prompt" };

describe("composeRolePrompt input bounds", () => {
  it("refuses an empty or whitespace-only task rather than composing a task-less role", () => {
    expect(() => composeRolePrompt({ ...base, task: "" })).toThrow(/task must be non-empty/);
    expect(() => composeRolePrompt({ ...base, task: "   \n\t " })).toThrow(/task must be non-empty/);
  });

  it("refuses a context item past the per-item byte ceiling instead of truncating it in", () => {
    expect(() => composeRolePrompt({
      ...base,
      context_evidence: [{
        evidence_id: "oversized",
        kind: "repository_fact" as const,
        content: "x".repeat(MAX_ITEM_BYTES + 1),
        provenance: { tag: "generated", generator: "test", input_hash: "h" },
      }],
    })).toThrow(/exceeds \d+ bytes/);
  });

  it("refuses a context item whose provenance is missing or untagged", () => {
    const item = (provenance: unknown) => ({
      evidence_id: "e1", kind: "repository_fact" as const, content: "some evidence", provenance: provenance as never,
    });
    expect(() => composeRolePrompt({ ...base, context_evidence: [item(undefined)] }))
      .toThrow(/provenance is required/);
    expect(() => composeRolePrompt({ ...base, context_evidence: [item({})] }))
      .toThrow(/provenance is required/);
    expect(() => composeRolePrompt({ ...base, context_evidence: [item({ tag: "" })] }))
      .toThrow(/provenance is required/);
  });

  it("refuses duplicate evidence ids, which would make a citation ambiguous", () => {
    const prov = { tag: "generated" as const, generator: "test", input_hash: "h" };
    expect(() => composeRolePrompt({
      ...base,
      context_evidence: [
        { evidence_id: "same", kind: "repository_fact" as const, content: "first", provenance: prov },
        { evidence_id: "same", kind: "repository_fact" as const, content: "second", provenance: prov },
      ],
    })).toThrow(/context evidence_id/);
  });

  it("composes normally when every item is within bounds", () => {
    const composed = composeRolePrompt({
      ...base,
      context_evidence: [{
        evidence_id: "ok",
        kind: "repository_fact" as const,
        content: "bounded evidence",
        provenance: { tag: "generated", generator: "test", input_hash: "h" },
      }],
    });
    expect(composed.profile.role_id).toBe("architect");
    expect(composed.prompt).toContain("bounded evidence");
  });
});

describe("composeRolePrompt whole-prompt bound", () => {
  it("refuses a composition whose assembled prompt exceeds the role-prompt ceiling", () => {
    // Each item is individually legal (under the 64KiB per-item cap); together
    // they push the composed prompt past the 256KiB whole-prompt ceiling. This
    // is the guard that stops many small, individually-valid items from
    // assembling into a prompt no provider will accept.
    const prov = { tag: "generated" as const, generator: "test", input_hash: "h" };
    const context_evidence = Array.from({ length: 8 }, (_, i) => ({
      evidence_id: `bulk-${i}`,
      kind: "repository_fact" as const,
      content: "y".repeat(60 * 1024),
      provenance: prov,
    }));
    expect(() => composeRolePrompt({ ...base, context_evidence }))
      .toThrow(/role prompt exceeds \d+ bytes/);
  });
});
