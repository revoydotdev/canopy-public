import { describe, expect, it } from "vitest";

import { awaitConfirmedCampaign } from "../src/cli.js";

const confirmation = {
  value: { draft: { campaign_id: "campaign-1", job_id: "job-1" } },
};

function runtimeWith(options: { reject?: unknown; halted?: boolean } = {}) {
  const snapshot = {
    nodes: [],
    halted: options.halted ?? true,
    halt_reason: options.halted === false ? null : "no_nodes",
    best_score: null,
    iterations_completed: 1,
  };
  return {
    manager: {
      getCampaignSnapshot: () => snapshot,
      listCampaigns: () => [],
      awaitingUserInput: () => false,
    },
    awaitCampaignRun: async () => {
      if ("reject" in options) throw options.reject;
      return { task_state: null, diagnostic: null };
    },
  } as never;
}

describe("awaitConfirmedCampaign lifecycle projection", () => {
  it("publishes reviewing then halted progress and projects unknown settlement", async () => {
    const progress: string[] = [];

    const result = await awaitConfirmedCampaign(
      runtimeWith(),
      undefined,
      confirmation,
      (line) => progress.push(line),
    ) as { campaign_result: Record<string, unknown> };

    expect(progress).toEqual([
      "[revoy] reviewing: campaign campaign-1 · nodes 0 · verified 0",
      "[revoy] halted: campaign campaign-1 · nodes 0 · verified 0",
    ]);
    expect(result.campaign_result).toMatchObject({
      campaign_id: "campaign-1",
      job_id: "job-1",
      job_state: "unknown",
      halted: true,
      halt_reason: "no_nodes",
      failure_summary: null,
    });
  });

  it("reports a non-Error rejection through progress and structured output", async () => {
    const progress: string[] = [];

    const result = await awaitConfirmedCampaign(
      runtimeWith({ reject: "transport closed" }),
      undefined,
      confirmation,
      (line) => progress.push(line),
    ) as { campaign_result: Record<string, unknown> };

    expect(progress.at(-1)).toBe("[revoy] failed: campaign campaign-1 · transport closed");
    expect(result.campaign_result.error).toBe("transport closed");
  });

  it("handles Error rejection without requiring a progress consumer", async () => {
    const result = await awaitConfirmedCampaign(
      runtimeWith({ reject: new Error("worker failed") }),
      undefined,
      confirmation,
    ) as { campaign_result: Record<string, unknown> };

    expect(result.campaign_result.error).toBe("worker failed");
  });
});
