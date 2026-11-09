import { describe, expect, it } from "vitest";
import { assessLifecycleResult } from "../upstream-lifecycle-demo.mjs";

describe("upstream lifecycle demo", () => {
  it("requires an independently accepted, linear root and follow-up", () => {
    expect(assessLifecycleResult({ ok: true, campaign_id: "a", adoption: { exit_code: 0 }, verification: { exit_code: 0 }, followups: [{ parent_campaign_id: "a", campaign_id: "b", baseline: { exit_code: 101 }, adoption: { exit_code: 0 }, verification: { exit_code: 0 } }] })).toEqual({ root_campaign_id: "a", terminal_campaign_id: "b", campaign_count: 2 });
  });

  it("fails closed on missing acceptance or broken lineage", () => {
    expect(() => assessLifecycleResult({ ok: true, campaign_id: "a", adoption: { exit_code: 0 }, verification: { exit_code: 1 }, followups: [] })).toThrow(/root campaign/);
    expect(() => assessLifecycleResult({ ok: true, campaign_id: "a", adoption: { exit_code: 0 }, verification: { exit_code: 0 }, followups: [{ parent_campaign_id: "wrong", campaign_id: "b", baseline: { exit_code: 1 }, adoption: { exit_code: 0 }, verification: { exit_code: 0 } }] })).toThrow(/lineage/);
  });
});
