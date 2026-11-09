import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import { createNativePeerToolPorts } from "../src/native-peer-tools.js";
import { nativePeerToolsForSession } from "../src/cli.js";

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const action: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const request = (session_id: string, call_id: string, input: unknown) => ({ session_id, turn: 1, call_id, input, workspace_roots: [], filesystem: "read_only" as const, network_allowed: false, intent_evidence: [] });

describe("native peer model tools", () => {
  it("autonomously invokes a capability-bound query and exposes no authority escalation tools", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "peer-tools-")); roots.push(persistence); const manager = new CampaignManager({ persistence_dir: persistence }); manager.startCampaign("campaign", "plan", action); const [left, right] = manager.branch("campaign", "root", [{ ...action, delegate_to: "seed" }, { ...action, delegate_to: "seed" }]); if (!left || !right) throw new Error("fixture failed"); const runtime = new ArborRuntime({ manager, persistence_dir: persistence });
    runtime.nativePeerChannels.grant({ kind: "peer.grant", grant_id: "grant", campaign_id: "campaign", parent_node_id: "root", left_node_id: left, right_node_id: right, capabilities: ["query", "reply"], capability_tier: "specialist", max_disclosure_bytes: 64, expires_at: "2099-01-01T00:00:00.000Z", provenance: { tag: "claimed", claimant: "operator" } }, { kind: "parent", actor_id: "parent", campaign_id: "campaign", node_id: "root", capability_tier: "orchestrator" });
    const ports = createNativePeerToolPorts({ service: runtime.nativePeerChannels, scope: { campaign_id: "campaign", node_id: left, session_id: "session", capability_tier: "specialist" }, now: () => new Date("2026-08-20T00:00:00.000Z") });
    expect(ports.map((port) => port.tool).sort()).toEqual(["peer.history", "peer.query", "peer.reply"]); expect(ports.some((port) => /grant|spawn|delegate/.test(port.tool))).toBe(false); expect(JSON.stringify(ports.map((port) => port.model_definition))).not.toContain("outsider");
    const production = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"); expect(production).toContain("nativePeerToolsForSession(runtimeBox, scope)");
    const query = ports.find((port) => port.tool === "peer.query")!; await expect(query.execute(request("session", "call-one", { grant_id: "grant", peer_node_id: right, expected_version: "origin", content: "Does it hold?" }), null, new AbortController().signal)).resolves.toMatchObject({ evidence: { outcome: "succeeded" } });
    await expect(query.execute(request("session", "call-two", { grant_id: "grant", peer_node_id: "foreign", expected_version: "origin", content: "escape" }), null, new AbortController().signal)).resolves.toMatchObject({ evidence: { outcome: "failed" }, model_output: expect.stringContaining("outside") });
  });
  it("provisions a fixed parent-authorized sibling edge for two production specialist invocations without pre-seeding", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "peer-production-")); roots.push(persistence); const manager = new CampaignManager({ persistence_dir: persistence }); manager.startCampaign("campaign", "plan", action); const [left, right] = manager.branch("campaign", "root", [{ ...action, delegate_to: "seed" }, { ...action, delegate_to: "heartwood" }]); if (!left || !right) throw new Error("fixture failed"); const runtime = new ArborRuntime({ manager, persistence_dir: persistence }); const runtimeBox = { current: runtime };
    expect(runtime.nativePeerChannels.list("campaign")).toHaveLength(0); const leftPorts = nativePeerToolsForSession(runtimeBox, { campaign_id: "campaign", node_id: left, session_id: "left-session" }); const rightPorts = nativePeerToolsForSession(runtimeBox, { campaign_id: "campaign", node_id: right, session_id: "right-session" }); const [grant] = runtime.nativePeerChannels.list("campaign"); expect(grant).toMatchObject({ parent_node_id: "root", capabilities: ["query", "reply"], capability_tier: "specialist", max_disclosure_bytes: 4096, provenance: { tag: "generated", generator: "native-parent-peer-provisioner-v1" } }); if (!grant) throw new Error("host provisioning failed"); expect(runtime.nativePeerChannels.list("campaign")).toHaveLength(1);
    const queryPort = leftPorts.find((port) => port.tool === "peer.query")!; const sent = await queryPort.execute(request("left-session", "query-call", { grant_id: grant.grant_id, peer_node_id: right, expected_version: "origin", content: "Is the sibling result consistent?" }), null, new AbortController().signal); expect(sent).toMatchObject({ evidence: { outcome: "succeeded" } }); const queryMessage = JSON.parse(sent.model_output).message_id as string;
    const historyPort = rightPorts.find((port) => port.tool === "peer.history")!; const history = await historyPort.execute(request("right-session", "history-call", { grant_id: grant.grant_id }), null, new AbortController().signal); const version = JSON.parse(history.model_output).version as string; const replyPort = rightPorts.find((port) => port.tool === "peer.reply")!; await expect(replyPort.execute(request("right-session", "reply-call", { grant_id: grant.grant_id, peer_node_id: left, expected_version: version, query_message_id: queryMessage, content: "Yes; the evidence agrees.", agrees: true }), null, new AbortController().signal)).resolves.toMatchObject({ evidence: { outcome: "succeeded" } });
    expect(leftPorts.some((port) => /grant|delegate|spawn/.test(port.tool))).toBe(false); expect(rightPorts.some((port) => /grant|delegate|spawn/.test(port.tool))).toBe(false);
  });
});
