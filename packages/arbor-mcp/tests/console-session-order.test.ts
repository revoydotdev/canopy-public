import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleCampaignSessionIds } from "../src/console-session-order.js";
import { HarnessSessionJournal } from "../src/harness-session-journal.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = (id: string, at?: string, sequence = 1, live = false) => ({
  session_id: id, campaign_id: "campaign", latest_event_at: at,
  latest_sequence: sequence, terminal: live ? null : { state: "completed" },
});

describe("Console canonical session recency", () => {
  it("ranks timestamps rather than event counts or UUID order", () => {
    expect(consoleCampaignSessionIds({ sessions: [
      session("z-old", "2026-09-05T10:00:00Z", 146),
      session("a-new", "2026-09-05T10:01:00Z", 6),
    ] }, "campaign")).toEqual(["a-new", "z-old"]);
  });
  it("retains live priority and excludes other campaigns", () => {
    expect(consoleCampaignSessionIds({ items: [
      session("terminal", "2026-09-05T10:01:00Z"),
      session("live", "2026-09-05T10:00:00Z", 1, true),
      { ...session("foreign", "2026-09-05T10:02:00Z", 1, true), campaign_id: "other" },
    ] }, "campaign")).toEqual(["live", "terminal"]);
  });
  it("keeps unknown timestamps deterministic without inventing recency", () => {
    expect(consoleCampaignSessionIds({ sessions: [
      session("a", undefined, 999), session("z", "invalid", 1),
      session("known", "2026-09-05T10:00:00Z"), null, {},
    ] }, "campaign")).toEqual(["known", "z", "a"]);
  });
  it("handles empty input", () => {
    expect(consoleCampaignSessionIds(null, null)).toEqual([]);
  });
  it("derives timestamps from durable events through replay and the catalog", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "revoy-session-recency-"));
    dirs.push(persistence_dir);
    const journal = new HarnessSessionJournal({ persistence_dir });
    for (const [id, at] of [["z-old", "2026-09-05T10:00:00Z"], ["a-new", "2026-09-05T10:01:00Z"]] as const) {
      expect(journal.recordStarted({ session_id: id, campaign_id: "campaign", node_id: "node", operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "seed", state: "running", latest_sequence: 0 })).toBe(true);
      expect(journal.inspect(id)?.latest_event_at).toBeUndefined();
      expect(journal.recordEvent({ session_id: id, sequence: 1, occurred_at: at, kind: "terminal", payload: { state: "completed", cause: "completed", result: "claimed", provenance: { tag: "claimed", claimant: "worker" } } })).toBe(true);
      expect(journal.inspect(id)?.latest_event_at).toBe(at);
    }
    const replayed = new HarnessSessionJournal({ persistence_dir });
    expect(replayed.inspect("a-new")?.latest_event_at).toBe("2026-09-05T10:01:00Z");
    const result = new RuntimeCatalogRouter(new ArborRuntime({ harness_sessions: replayed })).executeQuery({
      schema_version: 1, query_id: "recency", query: { kind: "harness.session.list", campaign_id: "campaign", limit: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("session catalog query failed");
    expect(consoleCampaignSessionIds(result.value, "campaign")).toEqual(["a-new", "z-old"]);
  });
});
