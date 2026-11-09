import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { buildPromptInputDebugDump } from "../src/prompt-input-debug.js";
import { main } from "../src/cli.js";

const action = (description: string): Action => ({
  description,
  category: "implementation",
  delegate_to: "seed",
  estimated_gain: 10,
  estimated_cost: 2,
  constraints: ["preserve campaign scope"],
});

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let value = "";
  stream.on("data", (chunk: Buffer) => { value += chunk.toString(); });
  return { stream, text: () => value };
}

describe("scoped prompt-input debug projection", () => {
  it("renders the literal specialist dispatch prompt and excludes cross-campaign approval state by construction", async () => {
    const runtime = new ArborRuntime();
    expect(runtime.manager.startCampaign("campaign-a", "a.md", action("CURRENT_CAMPAIGN_ACTION")).ok).toBe(true);
    expect(runtime.manager.startCampaign("campaign-b", "b.md", action("CROSS_CAMPAIGN_ACTION_SECRET")).ok).toBe(true);
    const requested = runtime.approvals.request({
      request_id: "other-approval",
      idempotency_key: "other-approval-key",
      action: "campaign.halt",
      subject: "CROSS_CAMPAIGN_APPROVAL_SECRET",
      resource_id: "campaign-b",
      proposer: "alice",
      rationale: "CROSS_CAMPAIGN_RATIONALE_SECRET",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(requested.ok).toBe(true);
    const nodeId = runtime.manager.getCampaignSnapshot("campaign-a")!.root_id;

    const dump = await buildPromptInputDebugDump(runtime, {
      campaign_id: "campaign-a",
      node_id: nodeId,
      checkpoint_at: "2030-01-01T00:00:00.000Z",
    });
    const serialized = JSON.stringify(dump);
    expect(dump.model_input.messages).toHaveLength(1);
    expect(dump.model_input.messages[0].content).toContain("Action: CURRENT_CAMPAIGN_ACTION");
    expect(dump.model_input.messages[0].content).toContain("Constraints: preserve campaign scope");
    expect(dump.integrity.bytes).toBe(Buffer.byteLength(dump.model_input.messages[0].content, "utf8"));
    expect(dump.integrity.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(dump.excluded_sources).toContainEqual({ source: "approval_memory", disposition: "excluded_by_construction" });
    expect(serialized).not.toContain("CROSS_CAMPAIGN_ACTION_SECRET");
    expect(serialized).not.toContain("CROSS_CAMPAIGN_APPROVAL_SECRET");
    expect(serialized).not.toContain("CROSS_CAMPAIGN_RATIONALE_SECRET");
  });

  it("exposes the projection through the durable CLI surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-prompt-input-cli-"));
    try {
      const seeded = new ArborRuntime({ persistence_dir: join(root, ".arbor") });
      expect(seeded.manager.startCampaign("cli-campaign", "plan.md", action("CLI_PROMPT_ACTION")).ok).toBe(true);
      const nodeId = seeded.manager.getCampaignSnapshot("cli-campaign")!.root_id;
      await seeded.close();
      const stdout = capture();
      const stderr = capture();
      const code = await main([
        "debug", "prompt-input", "--campaign", "cli-campaign", "--node", nodeId,
        "--checkpoint-at", "2030-01-01T00:00:00.000Z", "--json",
      ], { cwd: root, stdin: new PassThrough(), stdout: stdout.stream, stderr: stderr.stream });
      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
      const dump = JSON.parse(stdout.text()) as { schema: string; model_input: { messages: Array<{ content: string }> } };
      expect(dump.schema).toBe("arbor.prompt-input/v1");
      expect(dump.model_input.messages[0]!.content).toContain("CLI_PROMPT_ACTION");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
