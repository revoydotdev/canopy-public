import { describe, expect, it, vi } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { NotificationInboxService } from "../src/notification-inbox-service.js";

const metadata = {
  operation_id: "product-ux-op",
  idempotency_key: "product-ux-key",
  correlation_id: "product-ux-correlation",
  actor_id: "operator",
  requested_at: "2026-08-20T00:00:00.000Z",
};
const provenance = { tag: "claimed", claimant: "operator" } as const;

describe("product UX runtime catalog routes", () => {
  it("round-trips session identity, verification, notifications, and follow-up lineage through canonical catalog routes", async () => {
    const runtime = new ArborRuntime();
    const router = new RuntimeCatalogRouter(runtime);
    await expect(router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "session.identity.mutate", session_id: "session-1", display_name: "Release triage", tags: ["backend"], provenance } } as never)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "follow-up-op", idempotency_key: "follow-up-key" }, command: { kind: "followup.create", parent_campaign_id: "campaign-parent", source_result: { campaign_id: "campaign-source", node_id: "node-result" }, source_node: { campaign_id: "campaign-source", node_id: "node-source" }, provenance } } as never)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    expect(router.executeQuery({ schema_version: 1, query_id: "identity-get", query: { kind: "session.identity.get", session_id: "session-1" } } as never)).toMatchObject({ ok: true, value: { display_name: "Release triage" } });
    expect(router.executeQuery({ schema_version: 1, query_id: "identity-search", query: { kind: "session.identity.search", query: "release", limit: 10 } } as never)).toMatchObject({ ok: true, value: { items: [{ session_id: "session-1" }] } });
    expect(router.executeQuery({ schema_version: 1, query_id: "followup-list", query: { kind: "followup.list", parent_campaign_id: "campaign-parent" } } as never)).toMatchObject({ ok: true, value: { follow_ups: [{ source_result: { node_id: "node-result" }, source_node: { node_id: "node-source" } }] } });
    runtime.recordSessionCompletionUx({ session_id: "session-1", campaign_id: "campaign-source", node_id: "node-result" });
    expect(router.executeQuery({ schema_version: 1, query_id: "verification-list", query: { kind: "result.verification.list", campaign_id: "campaign-source" } } as never)).toMatchObject({ ok: true, value: { records: [{ node_id: "node-result", confidence: "unavailable" }] } });
    const notices = router.executeQuery({ schema_version: 1, query_id: "notifications-before-read", query: { kind: "notification.list", project_id: "campaign-source" } } as never);
    expect(notices).toMatchObject({ ok: true, value: { notifications: [{ id: expect.stringMatching(/^session-completed-[a-f0-9]{64}$/) }] } });
    if (!notices.ok) throw new Error("notification.list failed");
    const notificationId = (notices.value as { notifications: readonly { id: string }[] }).notifications[0]!.id;
    await expect(router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "notice-read-op", idempotency_key: "notice-read-key" }, command: { kind: "notification.read", notification_id: notificationId } } as never)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    expect(router.executeQuery({ schema_version: 1, query_id: "notifications", query: { kind: "notification.list", project_id: "campaign-source", unread_only: true } } as never)).toMatchObject({ ok: true, value: { notifications: [] } });
  });

  it("records session completion evidence absence and an actionable notification", () => {
    const runtime = new ArborRuntime();
    const router = new RuntimeCatalogRouter(runtime);
    runtime.recordSessionCompletionUx({ session_id: "session-2", campaign_id: "campaign-2", node_id: "node-2" });
    expect(router.executeQuery({ schema_version: 1, query_id: "verification", query: { kind: "result.verification.get", campaign_id: "campaign-2", node_id: "node-2" } } as never)).toMatchObject({ ok: true, value: { confidence: "unavailable", absence_reason: expect.stringContaining("without canonical") } });
    expect(router.executeQuery({ schema_version: 1, query_id: "notifications", query: { kind: "notification.list", project_id: "campaign-2" } } as never)).toMatchObject({ ok: true, value: { notifications: [{ actions: [{ action: "result.verification.list" }] }] } });
  });

  it("keeps completion evidence and campaign state intact when notification persistence fails", () => {
    const inbox = new NotificationInboxService();
    vi.spyOn(inbox, "publish").mockImplementation(() => { throw new Error("durable inbox unavailable"); });
    const runtime = new ArborRuntime({ notification_inbox: inbox });
    const longSessionId = `native-human-e2e:node:${"a".repeat(160)}`;

    expect(() => runtime.recordSessionCompletionUx({ session_id: longSessionId, campaign_id: "campaign-3", node_id: "node-3" })).not.toThrow();
    expect(runtime.resultVerification.get("campaign-3", "node-3")).toMatchObject({ confidence: "unavailable" });
    expect(runtime.snapshot().failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "notification_inbox", summary: "session completion notification could not be persisted" }),
    ]));
  });
});
