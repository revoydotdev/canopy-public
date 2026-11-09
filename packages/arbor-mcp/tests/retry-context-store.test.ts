import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRetryContextCapsule } from "@arbor/opencode";
import { RetryContextStore } from "../src/retry-context-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function capsule(campaignId = "campaign-a", nodeId = "node-a") {
  const result = buildRetryContextCapsule({
    identity: { campaignId, nodeId },
    failure: { failure_class: "critic", kind: "critic_rejection", normalized_root_cause: "missing evidence" },
    stableContextDigest: "a".repeat(64),
    attempt: 1,
    priorPromptDigest: "b".repeat(64),
    taskFacts: [{ id: "task", summary: "repair the failing test" }],
    changedFiles: [],
    evidence: [],
    requirements: [{ id: "evidence", description: "provide a passing regression test", status: "unresolved" }],
    toolSignatures: [],
  });
  if (!result.ok) throw new Error(result.error.reason);
  return result.capsule;
}

describe("RetryContextStore", () => {
  it("round-trips a capsule across store instances", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-retry-context-"));
    temporaryDirectories.push(root);
    new RetryContextStore(root).save({ campaign_id: "campaign-a", node_id: "node-a", capsule: capsule() });

    const restored = new RetryContextStore(root).load({ campaign_id: "campaign-a", node_id: "node-a" });

    expect(restored).toEqual(capsule());
    expect(readdirSync(join(root, "retry-context"))).toHaveLength(1);
  });

  it("rejects a tampered durable capsule instead of injecting it", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-retry-context-"));
    temporaryDirectories.push(root);
    const store = new RetryContextStore(root);
    store.save({ campaign_id: "campaign-a", node_id: "node-a", capsule: capsule() });
    const file = join(root, "retry-context", readdirSync(join(root, "retry-context"))[0]!);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { failure: { normalized_root_cause: string } };
    parsed.failure.normalized_root_cause = "tampered";
    writeFileSync(file, JSON.stringify(parsed));

    expect(() => new RetryContextStore(root).load({ campaign_id: "campaign-a", node_id: "node-a" })).toThrow(/integrity/);
  });

  it("keeps ephemeral runtimes in memory without writing a global fallback", () => {
    const store = new RetryContextStore(null);
    store.save({ campaign_id: "campaign-a", node_id: "node-a", capsule: capsule() });
    expect(store.load({ campaign_id: "campaign-a", node_id: "node-a" })).toEqual(capsule());
  });
});
