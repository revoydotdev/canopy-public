import { describe, expect, it } from "vitest";

import { parseTaskComposerProposal } from "../src/task-composer-contracts.js";

const proposal = JSON.stringify({
  summary: "Bounded change",
  assumptions: [],
  questions: [],
  root_action: { description: "Implement", estimated_gain: 2, estimated_cost: 1, category: "general", delegate_to: "seed" },
  actions: [{ description: "Implement", estimated_gain: 2, estimated_cost: 1, category: "general", delegate_to: "seed" }],
  acceptance_checks: [],
  acceptance_mapping: [],
  risk_notes: [],
});

describe("task composer proposal parser", () => {
  it("accepts one valid object wrapped in a provider fence", () => {
    expect(parseTaskComposerProposal(`Here is the plan:\n\`\`\`json\n${proposal}\n\`\`\``).ok).toBe(true);
  });

  it("rejects ambiguous or unbalanced provider output", () => {
    expect(parseTaskComposerProposal(`${proposal}\n${proposal}`)).toMatchObject({ ok: false, error: expect.stringContaining("exactly one") });
    expect(parseTaskComposerProposal(`prefix {${proposal}`)).toMatchObject({ ok: false });
  });

  it("requires every declared acceptance criterion to map to an exact action", () => {
    const mapped = {
      ...JSON.parse(proposal),
      acceptance_checks: ["the workflow is usable"],
      acceptance_mapping: [{ criterion: "the workflow is usable", action_descriptions: ["Implement"] }],
    };
    expect(parseTaskComposerProposal(JSON.stringify(mapped))).toMatchObject({ ok: true, value: { acceptance_mapping: mapped.acceptance_mapping } });
    expect(parseTaskComposerProposal(JSON.stringify({ ...mapped, acceptance_mapping: [{ criterion: "the workflow is usable", action_descriptions: ["unknown action"] }] }))).toMatchObject({ ok: false, error: expect.stringContaining("acceptance mapping") });
  });
});
