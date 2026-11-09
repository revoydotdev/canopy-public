import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
function metadata(id: string, actor_id: string) { return { operation_id: id, idempotency_key: id, correlation_id: id, actor_id, requested_at: "2026-08-20T00:00:00.000Z" }; }

function setup() {
  const persistence = mkdtempSync(join(tmpdir(), "arbor-native-peer-")); roots.push(persistence);
  const manager = new CampaignManager({ persistence_dir: persistence }); manager.startCampaign("campaign", "plan.md", rootAction);
  const children = manager.branch("campaign", "root", [{ ...rootAction, description: "left", delegate_to: "seed" }, { ...rootAction, description: "right", delegate_to: "seed" }, { ...rootAction, description: "outsider", delegate_to: "seed" }]);
  const [left, right, outsider] = children; if (!left || !right || !outsider) throw new Error("missing peer fixture nodes");
  const runtime = new ArborRuntime({ manager, persistence_dir: persistence });
  const router = (node_id: string, kind: "parent" | "peer" = "peer") => new RuntimeCatalogRouter(runtime, { peer_caller: kind === "parent" ? { kind, actor_id: "parent-authority", campaign_id: "campaign", node_id, capability_tier: "orchestrator" } : { kind, actor_id: node_id, campaign_id: "campaign", node_id, capability_tier: "critic" } });
  return { persistence, manager, runtime, router, left, right, outsider };
}

async function grant(router: RuntimeCatalogRouter, left: string, right: string, grant_id = "peer-grant") {
  return router.dispatchCommand({ schema_version: 1, metadata: metadata(`grant-${grant_id}`, "parent-authority"), command: { kind: "peer.grant", grant_id, campaign_id: "campaign", parent_node_id: "root", left_node_id: left, right_node_id: right, capabilities: ["query", "reply"], capability_tier: "critic", max_disclosure_bytes: 96, expires_at: "2099-08-21T00:00:00.000Z", provenance: { tag: "claimed", claimant: "operator" } } });
}

describe("capability-scoped native peer channels", () => {
  it("durably queries/replies, escalates disagreement, detects a wait cycle, redacts by tier, and replays after restart", async () => {
    const { persistence, router, left, right } = setup();
    await expect(grant(router("root", "parent"), left, right)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    const first = await router(left).dispatchCommand({ schema_version: 1, metadata: metadata("query-op", left), command: { kind: "peer.query", grant_id: "peer-grant", query_id: "question-one", from_node_id: left, to_node_id: right, expected_version: "origin", content: "Does the bounded invariant hold?" } });
    expect(first).toMatchObject({ ok: true, value: { accepted: true, message_id: expect.any(String) } });
    if (!first.ok || !first.value.accepted || !("message_id" in first.value)) throw new Error("query failed"); const queryMessage = String(first.value.message_id);

    const afterQuery = router(left).executeQuery({ schema_version: 1, query_id: "history-one", query: { kind: "peer.history", grant_id: "peer-grant" } });
    expect(afterQuery).toMatchObject({ ok: true, value: { unresolved_queries: 1, version: queryMessage } });
    if (!afterQuery.ok) throw new Error("history failed"); const version = String((afterQuery.value as { version: string }).version);

    const cycle = await router(right).dispatchCommand({ schema_version: 1, metadata: metadata("cycle-op", right), command: { kind: "peer.query", grant_id: "peer-grant", query_id: "question-cycle", from_node_id: right, to_node_id: left, expected_version: version, content: "Wait for my answer first." } });
    expect(cycle).toMatchObject({ ok: true, value: { accepted: false, escalation_id: expect.any(String), error: { summary: expect.stringContaining("wait cycle") } } });

    const afterCycle = router("root", "parent").executeQuery({ schema_version: 1, query_id: "history-cycle", query: { kind: "peer.history", grant_id: "peer-grant" } });
    expect(afterCycle).toMatchObject({ ok: true, value: { messages: expect.arrayContaining([expect.objectContaining({ recipient_node_ids: ["root"], kind: "report" })]) } });
    if (!afterCycle.ok) throw new Error("cycle history failed"); const replyVersion = String((afterCycle.value as { version: string }).version);
    const reply = await router(right).dispatchCommand({ schema_version: 1, metadata: metadata("reply-op", right), command: { kind: "peer.reply", grant_id: "peer-grant", query_message_id: queryMessage, from_node_id: right, to_node_id: left, expected_version: replyVersion, content: "No; the evidence conflicts.", agrees: false } });
    expect(reply).toMatchObject({ ok: true, value: { accepted: true, message_id: expect.any(String), escalation_id: expect.any(String) } });

    const specialist = router(left).executeQuery({ schema_version: 1, query_id: "history-specialist", query: { kind: "peer.history", grant_id: "peer-grant" } });
    expect(specialist).toMatchObject({ ok: true, value: { messages: expect.not.arrayContaining([expect.objectContaining({ capability_tier: "orchestrator" })]) } });

    const restarted = new ArborRuntime({ manager: new CampaignManager({ persistence_dir: persistence }), persistence_dir: persistence });
    const replay = new RuntimeCatalogRouter(restarted, { peer_caller: { kind: "parent", actor_id: "parent-authority", campaign_id: "campaign", node_id: "root", capability_tier: "orchestrator" } }).executeQuery({ schema_version: 1, query_id: "history-restart", query: { kind: "peer.history", grant_id: "peer-grant" } });
    expect(replay).toMatchObject({ ok: true, value: { unresolved_queries: 0, messages: expect.arrayContaining([expect.objectContaining({ kind: "clarify" }), expect.objectContaining({ kind: "reply" }), expect.objectContaining({ kind: "report" })]) } });
  });

  it("fails closed on foreign endpoints, disclosure overflow, missing capability, and arbitrary delegation fields", async () => {
    const { runtime, router, left, right, outsider } = setup(); await grant(router("root", "parent"), left, right);
    await expect(router(left).dispatchCommand({ schema_version: 1, metadata: metadata("foreign", left), command: { kind: "peer.query", grant_id: "peer-grant", query_id: "foreign-query", from_node_id: left, to_node_id: outsider, expected_version: "origin", content: "x" } })).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    await expect(router(left).dispatchCommand({ schema_version: 1, metadata: metadata("oversized", left), command: { kind: "peer.query", grant_id: "peer-grant", query_id: "oversized-query", from_node_id: left, to_node_id: right, expected_version: "origin", content: "x".repeat(97) } })).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    await expect(router(left).dispatchCommand({ schema_version: 1, metadata: metadata("delegate-attempt", left), command: { kind: "peer.query", grant_id: "peer-grant", query_id: "delegate-query", from_node_id: left, to_node_id: right, expected_version: "origin", content: "x", delegate_to: "heartwood", spawn: true } })).resolves.toMatchObject({ ok: false, error: { code: "validation" } });
    await expect(new RuntimeCatalogRouter(runtime).dispatchCommand({ schema_version: 1, metadata: metadata("self-grant", "operator"), command: { kind: "peer.grant", grant_id: "self-grant", campaign_id: "campaign", parent_node_id: "root", left_node_id: left, right_node_id: right, capabilities: ["query"], capability_tier: "specialist", max_disclosure_bytes: 10, expires_at: "2099-08-21T00:00:00.000Z", provenance: { tag: "claimed", claimant: "operator" } } })).resolves.toMatchObject({ ok: false, error: { code: "permission" } });
    expect(RUNTIME_CATALOG.filter((entry) => entry.kind.startsWith("peer.")).map((entry) => entry.kind).sort()).toEqual(["peer.grant", "peer.grants", "peer.history", "peer.query", "peer.reply"]);
    expect(RUNTIME_CATALOG.filter((entry) => entry.kind.startsWith("peer.")).some((entry) => entry.kind.includes("spawn") || entry.kind.includes("delegate"))).toBe(false);
    await expect(router("root", "parent").dispatchCommand({ schema_version: 1, metadata: metadata("bad-provenance", "parent-authority"), command: { kind: "peer.grant", grant_id: "bad-provenance", campaign_id: "campaign", parent_node_id: "root", left_node_id: left, right_node_id: right, capabilities: ["query"], capability_tier: "specialist", max_disclosure_bytes: 10, expires_at: "2099-08-21T00:00:00.000Z", provenance: { tag: "invented" } as never } })).resolves.toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("detects a multi-grant wait cycle", async () => {
    const { router, left, right, outsider } = setup();
    await grant(router("root", "parent"), left, right, "left-right"); await grant(router("root", "parent"), right, outsider, "right-outsider"); await grant(router("root", "parent"), outsider, left, "outsider-left");
    await expect(router(left).dispatchCommand({ schema_version: 1, metadata: metadata("left-right", left), command: { kind: "peer.query", grant_id: "left-right", query_id: "left-right", from_node_id: left, to_node_id: right, expected_version: "origin", content: "left waits" } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(router(right).dispatchCommand({ schema_version: 1, metadata: metadata("right-outsider", right), command: { kind: "peer.query", grant_id: "right-outsider", query_id: "right-outsider", from_node_id: right, to_node_id: outsider, expected_version: "origin", content: "right waits" } })).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(router(outsider).dispatchCommand({ schema_version: 1, metadata: metadata("outsider-left", outsider), command: { kind: "peer.query", grant_id: "outsider-left", query_id: "outsider-left", from_node_id: outsider, to_node_id: left, expected_version: "origin", content: "must refuse" } })).resolves.toMatchObject({ ok: true, value: { accepted: false, error: { summary: expect.stringContaining("wait cycle") } } });
  });
});
