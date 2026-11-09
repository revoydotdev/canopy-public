import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FollowUpLineageService } from "../src/follow-up-lineage-service.js";
import { NotificationInboxService } from "../src/notification-inbox-service.js";
import { ResultVerificationService } from "../src/result-verification-service.js";
import { SessionIdentityService } from "../src/session-identity-service.js";

const provenance = { tag: "claimed", claimant: "operator" } as const;
const temporaryDirectories: string[] = [];

function persistenceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "arbor-product-ux-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SessionIdentityService", () => {
  it("persists bounded names and tags with idempotent fuzzy search", () => {
    const directory = persistenceDirectory();
    const service = new SessionIdentityService({ persistence_dir: directory });
    const first = service.mutate({
      session_id: "session-1",
      display_name: "Release triage",
      tags: ["Urgent", "Backend"],
      provenance,
      idempotency_key: "identity-1",
    });
    const retry = service.mutate({
      session_id: "session-1",
      display_name: "Release triage",
      tags: ["Urgent", "Backend"],
      provenance,
      idempotency_key: "identity-1",
    });

    expect(retry).toEqual(first);
    expect(service.search({ query: "rlstrg", limit: 10 }).items).toHaveLength(1);
    expect(new SessionIdentityService({ persistence_dir: directory }).get("session-1")).toMatchObject({
      display_name: "Release triage",
      tags: ["backend", "urgent"],
    });
  });
});

describe("ResultVerificationService", () => {
  it("records durable metrics and explicitly represents unavailable evidence", () => {
    const directory = persistenceDirectory();
    const service = new ResultVerificationService({ persistence_dir: directory });
    const verified = service.record({
      campaign_id: "campaign-1",
      node_id: "node-1",
      checks: [{ command: ["bun", "test"], exit_status: 0, duration_ms: 1_250, summary: "passed", provenance }],
      files: ["packages/arbor-mcp/src/example.ts"],
      diffstat: { additions: 12, deletions: 3, files_changed: 1 },
      confidence: "verified",
      absence_reason: null,
      provenance,
      idempotency_key: "verification-1",
    });
    const unavailable = service.record({
      campaign_id: "campaign-1",
      node_id: "node-2",
      checks: [],
      files: [],
      diffstat: { additions: null, deletions: null, files_changed: null },
      confidence: "unavailable",
      absence_reason: "runner evidence was not retained",
      provenance,
      idempotency_key: "verification-2",
    });
    const refusedDowngrade = service.record({
      campaign_id: "campaign-1",
      node_id: "node-1",
      checks: [],
      files: [],
      diffstat: { additions: null, deletions: null, files_changed: null },
      confidence: "unavailable",
      absence_reason: "later adoption did not carry its own verification payload",
      provenance,
      idempotency_key: "verification-downgrade",
    });

    expect(verified.checks[0]?.command).toEqual(["bun", "test"]);
    expect(unavailable.absence_reason).toContain("not retained");
    expect(refusedDowngrade).toMatchObject({ confidence: "verified", files: ["packages/arbor-mcp/src/example.ts"] });
    expect(new ResultVerificationService({ persistence_dir: directory }).get("campaign-1", "node-1"))
      .toMatchObject({ diffstat: { additions: 12, deletions: 3, files_changed: 1 }, confidence: "verified" });
  });
});

describe("NotificationInboxService", () => {
  it("deduplicates delivery records, preserves unread state, and persists policy", () => {
    const directory = persistenceDirectory();
    const service = new NotificationInboxService({ persistence_dir: directory });
    const input = {
      id: "notice-1",
      fingerprint: "campaign-1:failed",
      project_id: "project-1",
      severity: "error" as const,
      title: "Campaign failed",
      body: "token=not-for-storage",
      actions: [{ label: "Open campaign", action: "campaign.open" }],
      delivery: { channels: ["tui", "terminal"] as const, quiet_hours: { start_minute: 1_320, end_minute: 420, timezone: "UTC" } },
      provenance,
      idempotency_key: "notice-1",
    };
    const first = service.publish(input);
    service.markRead({ id: first.id, idempotency_key: "notice-read-1" });
    const duplicate = service.publish({ ...input, id: "notice-2", idempotency_key: "notice-2" });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.occurrences).toBe(2);
    expect(duplicate.read_at).toBeNull();
    expect(duplicate.body).not.toContain("not-for-storage");
    expect(new NotificationInboxService({ persistence_dir: directory }).list({ unread_only: true, limit: 10 }))
      .toHaveLength(1);
  });
});

describe("FollowUpLineageService", () => {
  it("persists typed source result, source node, and parent campaign lineage", () => {
    const directory = persistenceDirectory();
    const service = new FollowUpLineageService({ persistence_dir: directory });
    const lineage = service.create({
      id: "follow-up-1",
      parent_campaign_id: "campaign-parent",
      source_result: { campaign_id: "campaign-source", node_id: "node-result" },
      source_node: { campaign_id: "campaign-source", node_id: "node-source" },
      provenance,
      idempotency_key: "lineage-1",
    });

    expect(new FollowUpLineageService({ persistence_dir: directory }).list("campaign-parent")).toEqual([lineage]);
  });
});
