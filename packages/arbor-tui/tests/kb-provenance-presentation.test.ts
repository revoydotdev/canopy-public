import { describe, expect, it } from "vitest";
import { kbScreen } from "../src/screens/kb.js";

describe("KB envelope trust presentation", () => {
  it("shows supplied provenance and freshness without promoting unknown claims", () => {
    for (const tag of ["verified", "claimed", "critic_approved", "generated"]) {
      const projection = kbScreen.project([{id: "fact", as_of: "iter:7", provenance: {tag}, value: {type: "success_pattern", value: "Observed finding", tier: "specialist_visible"}}], {width: 126, height: 20});
      const lines = kbScreen.render({projection, width: 126, height: 20}).join("\n");
      expect(lines).toContain(`Provenance: ${tag}`);
      expect(lines).toContain("As of: iter:7");
    }
    const unknown = kbScreen.project([{id: "fact", value: {type: "success_pattern", value: "Unspecified trust"}}], {width: 126, height: 20});
    expect(unknown.rows[0]?.provenance).toBe("unknown");
  });
  it("does not expose trust/freshness fields attached to a redacted envelope", () => {
    const projection = kbScreen.project([{id: "restricted", absence: "capability_required", provenance: {tag: "verified"}, as_of: "private-cursor", value: null}], {width: 126, height: 20});
    const text = kbScreen.render({projection, width: 126, height: 20}).join("\n");
    expect(text).toContain("capability_required");
    expect(text).not.toContain("private-cursor");
    expect(text).not.toContain("verified");
  });
  it("marks the bounded summary rather than silently cutting its text", () => {
    const projection = kbScreen.project([{id: "long", provenance: {tag: "claimed"}, value: {type: "success_pattern", value: "evidence ".repeat(80)}}], {width: 126, height: 20});
    expect(String(projection.rows[0]?.detail)).toMatch(/…$/u);
  });
});
