import { describe, expect, it } from "vitest";
import { communicationsScreen } from "../src/screens/communications.js";
import { threadsScreen } from "../src/screens/threads.js";
import { busScreen } from "../src/screens/bus.js";

describe("communications, threads, and bus causal documents", () => {
  it("labels the canonical communication source and preserves declared handoff links without exposing a redacted payload", () => {
    const projection = communicationsScreen.project({
      campaign_id: "campaign-1",
      node_id: "node-child",
      communications: [{
        id: "reply-2", kind: "reply", capability_tier: "critic",
        author_node_id: "node-child", recipient_node_id: "node-parent",
        parent_communication_id: "delegate-1", reply_to_communication_id: "delegate-1",
        acknowledges_communication_id: "delegate-1", retracts_communication_id: null,
        payload: { content: "withheld at this tier" },
      }],
    }, { width: 120, height: 16, consumerTier: "specialist" });
    const rendered = communicationsScreen.render({ projection, width: 120, height: 16 }).join("\n");

    expect(projection.caption).toContain("canonical/communication.selection");
    expect(projection.rows[0]).not.toHaveProperty("content");
    expect(rendered).toContain("canonical/communication.selection");
    expect(rendered).toContain("parent delegate-1");
    expect(rendered).toContain("reply delegate-1");
    expect(rendered).toContain("acknowledges delegate-1");
    expect(rendered).toContain("payload structurally unavailable");
    expect(rendered).not.toContain("withheld at this tier");
  });

  it("keeps the direct-edge identities, CAS cursor, acknowledgement outcome, and acknowledgement command on Threads", () => {
    const projection = threadsScreen.project({
      thread_id: "parent-child:parent:child", parent_node_id: "parent", child_node_id: "child", version: "ack-2",
      messages: [{
        id: "ack-2", author_node_id: "child", recipient_node_ids: ["parent"], kind: "reply", intent: "response",
        acknowledges_communication_id: "send-1", ack_required: false, delivery: "acknowledged",
        payload_preview: { content: "durably acknowledged" },
      }],
    }, { width: 140, height: 16 });
    const rendered = threadsScreen.render({ projection, width: 140, height: 16 }).join("\n");

    expect(threadsScreen.surface.commands).toEqual(["bus.thread.send", "bus.thread.ack"]);
    expect(projection.caption).toContain("parent ↔ child");
    expect(projection.caption).toContain("canonical/bus.thread.history");
    expect(projection.caption).toContain("CAS ack-2");
    expect(projection.row_ids?.[0]).toEqual(expect.objectContaining({ id: "ack-2", context: expect.objectContaining({ parent_node_id: "parent", child_node_id: "child", expected_thread_version: "ack-2" }) }));
    expect(rendered).toContain("acknowledges send-1");
    expect(rendered).toContain("acknowledged; recipient ack");
  });

  it("renders campaign bus messages in canonical conversation lanes instead of fabricating a cross-conversation chronology", () => {
    const laterInFirstLane = { id: "lane-a-1", conversation_id: "lane-a", author_node_id: "a", recipient_node_ids: ["b"], kind: "delegate", as_of: "2026-08-30T12:00:00.000Z", payload_preview: { content: "first lane" } };
    const earlierInSecondLane = { id: "lane-b-1", conversation_id: "lane-b", author_node_id: "c", recipient_node_ids: ["d"], kind: "report", as_of: "2026-08-30T01:00:00.000Z", payload_preview: { content: "second lane" }, reply_to_communication_id: "lane-a-1", ack_required: true };
    const projection = busScreen.project({ campaign_id: "campaign-1", conversations: new Map([["lane-a", [laterInFirstLane]], ["lane-b", [earlierInSecondLane]]]), ungrouped: [], as_of: "2026-08-30T12:30:00.000Z" }, { width: 140, height: 20 });
    const rendered = busScreen.render({ projection, width: 140, height: 20 }).join("\n");

    expect(projection.rows.map((row) => row.id)).toEqual(["lane-a-1", "lane-b-1"]);
    expect(projection.caption).toContain("canonical/bus.history");
    expect(projection.caption).toContain("conversation lanes");
    expect(rendered).toContain("lane lane-b · reply lane-a-1");
    expect(rendered).toContain("ack required");
  });
});
