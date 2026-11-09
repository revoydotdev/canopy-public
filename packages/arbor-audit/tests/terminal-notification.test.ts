import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../src/index.js";

const input = (emitted = false) => ({
  campaign_id: "campaign", node_id: "operator-terminal", operation_id: "notice-1", idempotency_key: "notice-1",
  notification_ref: `sha256:${"a".repeat(64)}`, focus: "blurred" as const, emitted,
  provenance: { tag: "generated" as const, generator: "opentui-renderer", input_hash: "notice-1" },
  timestamp: "2026-08-12T00:00:00.000Z",
});

describe("terminal notification audit observations", () => {
  it("records, deduplicates, and reads terminal capability profiles", () => {
    const ledger = new EvidenceLedger();
    const profile = {
      campaign_id: "campaign", node_id: "operator-terminal", operation_id: "profile-1", idempotency_key: "profile-1",
      capabilities: { focus_tracking: true, notifications: true, rgb: true, ansi256: true, remote: false, multiplexer: "none" as const, terminal_name: "fixture", terminal_version: "1" },
      theme_mode: "dark" as const, theme_source: "terminal" as const,
      provenance: { tag: "generated" as const, generator: "opentui-renderer", input_hash: "profile-1" },
      timestamp: "2026-08-12T00:00:00.000Z",
    };
    const id = ledger.recordTerminalProfile(profile);
    expect(ledger.recordTerminalProfile(profile)).toBe(id);
    expect(ledger.getTerminalProfiles("campaign")).toHaveLength(1);
    expect(ledger.getTerminalProfiles("other")).toEqual([]);
  });

  it("records only a hashed reference and replays the delivery result", () => {
    const ledger = new EvidenceLedger();
    const id = ledger.recordTerminalNotification(input());
    expect(ledger.recordTerminalNotification(input())).toBe(id);
    expect(ledger.getTerminalNotifications("campaign")[0]).toMatchObject({ notification: { focus: "blurred", emitted: false } });
    expect(ledger.toJSONL()).not.toContain("notification message");
    expect(ledger.verifyIntegrity()).toMatchObject({ valid: true });
    const restored = new EvidenceLedger(); restored.fromJSONL(ledger.toJSONL());
    expect(restored.getTerminalNotifications("campaign")).toEqual(ledger.getTerminalNotifications("campaign"));
  });

  it("rejects malformed identity and focus fields", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.recordTerminalNotification({ ...input(), notification_ref: "raw-id" })).toThrow("terminal notification");
    expect(() => ledger.recordTerminalNotification({ ...input(), focus: "away" as "blurred" })).toThrow("terminal notification");
  });
});
