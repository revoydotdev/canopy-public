import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredScreens, availableScreens } from "../src/screens/screen.js";
import { installScreens } from "../src/screens/install.js";
import { compactionScreen } from "../src/screens/compaction.js";
import { siblingsScreen } from "../src/screens/siblings.js";
import { surveillanceScreen } from "../src/screens/surveillance.js";
import { capabilitiesScreen } from "../src/screens/capabilities.js";
import { threadsScreen } from "../src/screens/threads.js";
import { busScreen } from "../src/screens/bus.js";
import { a2aScreen } from "../src/screens/a2a.js";
import { overlaysScreen } from "../src/screens/overlays.js";
import { trustScreen, TRUST_OPERATIONS_UNAVAILABLE, TRUST_UNAVAILABLE } from "../src/screens/trust.js";

afterEach(() => clearRegisteredScreens());

describe("authority and operational screens", () => {
  it("projects review-safe remote-session lifecycle state with real host-local controls", () => {
    const projection = trustScreen.project({ sessions: [{ session_id: "remote-1", actor_id: "seed-1", key_id: "key-1", state: "active", expires_at: "2026-08-10T00:00:00.000Z", thread_audiences: [{ parent_node_id: "root" }], approval_authority: false, revoked_key_ids: ["old-key"], revoked_at: null, public_key_pem: "must never render" }], total: 1 }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ session: "remote-1", actor: "seed-1", state: "active", edges: 1, approval: "denied", rotation: "1 prior key(s)", revoked: "—", key: "key-1" });
    expect(trustScreen.render({ projection, width: 120, height: 20 }).join("\n")).toContain("remote-1");
    expect(trustScreen.render({ projection, width: 180, height: 20 }).join("\n")).toContain("Quota limits");
    expect(JSON.stringify(projection)).not.toContain("must never render");

    const status = trustScreen.project({
      session_id: "remote-1", actor_id: "seed-1", key_id: "key-1", state: "active",
      expires_at: "2026-08-10T00:00:00.000Z", thread_audiences: [{ parent_node_id: "root" }],
      approval_authority: false, revoked_key_ids: ["old-key"], public_key_pem: "must never render",
    }, { width: 100, height: 20 });
    expect(status.variant).toBe("status");
    expect(status.caption).toContain("canonical trust.session.status");
    expect(trustScreen.render({ projection: status, width: 120, height: 20 }).join("\n")).toContain("key-1");
    expect(JSON.stringify(status)).not.toContain("must never render");
    const unavailable = trustScreen.project(undefined, { width: 100, height: 20 });
    expect(trustScreen.render({ projection: unavailable, width: 100, height: 20 }).join("\n")).toContain("No remote trust projection");
    installScreens();
    expect(availableScreens(new Set(["trust.session.read", "trust.session.write"])).map((screen) => screen.id)).toContain("trust");
    expect(TRUST_UNAVAILABLE).toContain("trust.session.write");
    expect(TRUST_OPERATIONS_UNAVAILABLE).toContain("no public listener");
  });

  it("distinguishes a recognized-but-empty session list from an unrecognized projection, and degrades a render fault to a safe fallback line", () => {
    // Recognized "sessions" variant with zero rows: the caption states the
    // zero count explicitly, and render prefixes the enrollment line before
    // the shared unavailable-controls text.
    const empty = trustScreen.project({ sessions: [], total: 0 }, { width: 200, height: 20 });
    expect(empty.caption).toBe("No enrolled remote sessions. Use Enroll Remote Trust to add a host-issued certificate/key binding.");
    const emptyRendered = trustScreen.render({ projection: empty, width: 200, height: 20 }).join("\n");
    expect(emptyRendered).toContain("No enrolled remote sessions");
    expect(emptyRendered).toContain("host-issued certificate/key binding");

    // Unrecognized projection (no matching variant) falls through to the
    // module's emptyProjection, whose render path omits the "No enrolled"
    // line entirely — proving the ternary's other arm is live.
    const unrecognized = trustScreen.project({ nonsense: true }, { width: 200, height: 20 });
    const unrecognizedRendered = trustScreen.render({ projection: unrecognized, width: 200, height: 20 }).join("\n");
    expect(unrecognizedRendered).not.toContain("No enrolled remote sessions");
    expect(unrecognizedRendered).toContain("No remote trust projection");

    // A negative scroll offset is rejected by renderTable's own bound check;
    // trust.ts must catch that fault and degrade to "(render error)" rather
    // than let it propagate out of the render pipeline.
    const populated = trustScreen.project({ sessions: [{ session_id: "s1" }], total: 1 }, { width: 100, height: 20 });
    expect(trustScreen.render({ projection: populated, width: 100, height: 20, scroll_offset: -1 })).toEqual(["(render error)"]);
  });

  it("renders durable compaction history with an honest rollback anchor", () => {
    const projection = compactionScreen.project({ records: [{ id: "fold-1", node_id: "node-a", lifecycle: { status: "completed", strategy: "structural_folding", pre_evidence_id: "evidence-before" } }] }, { width: 100, height: 20 });
    expect(projection.variant).toBe("history");
    expect(projection.rows[0]).toMatchObject({ node: "node-a", status: "completed", rollback: "restore anchor evidence-before" });
    expect(compactionScreen.render({ projection, width: 80, height: 8 })).toContain("Compaction history (1)");
  });

  it("does not invent a rollback when a failed fold has only a durable reason", () => {
    const projection = compactionScreen.project({ records: [{ id: "fold-2", node_id: "node-b", lifecycle: { status: "failed", strategy: "local_model", reason: "context limit" } }] }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ rollback: "context limit" });
    // EC-012: empty captions name their subject and what creates a record.
    expect(compactionScreen.project({ records: [] }, { width: 80, height: 10 }).caption).toContain("No compaction records yet");
  });

  it("projects active sibling topology and bounds without claiming a full process graph", () => {
    const projection = siblingsScreen.project({ node_id: "parent", active: ["child-a", "child-b"], depth: 2, within_bounds: false }, { width: 100, height: 20 });
    expect(projection.caption).toContain("outside bounds");
    expect(projection.rows).toEqual([{ sibling: "child-a", status: "delegated" }, { sibling: "child-b", status: "delegated" }]);
    expect(siblingsScreen.render({ projection, width: 70, height: 10 }).join("\n")).toContain("Active sibling");
  });

  it("shows real advisory surveillance findings and a truthful empty result", () => {
    const projection = surveillanceScreen.project({ findings: [{ dedup_key: "finding-1", severity: "critical", kind: "orphaned_work", summary: "operation no longer has an owner" }] }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ severity: "critical", kind: "orphaned_work" });
    expect(surveillanceScreen.render({ projection, width: 90, height: 10 }).join("\n")).toContain("operation no longer has an o\u2026");
    expect(surveillanceScreen.project({ findings: [] }, { width: 80, height: 10 }).caption).toBe("no surveillance findings");
  });

  it("renders derived action classes and makes the authority screen capability-gated", () => {
    const projection = capabilitiesScreen.project({ catalog: [{ kind: "campaign.halt", action_class: "preview-confirm", minimum_tier: "senior", supported: true }, { kind: "a2a.cards", action_class: "read", minimum_tier: "junior", supported: false }] }, { width: 100, height: 20 });
    expect(projection.rows).toEqual([
      { kind: "campaign.halt", class: "preview-confirm", tier: "senior", state: "supported" },
      { kind: "a2a.cards", class: "read", tier: "junior", state: "unavailable" },
    ]);
    installScreens();
    expect(availableScreens(new Set(["capability.read"])).map((screen) => screen.id)).toContain("capabilities");
    expect(availableScreens(new Set()).map((screen) => screen.id)).not.toContain("capabilities");
  });

  it("flattens grouped and ungrouped conversation bus messages, real Map and plain-object shapes alike", () => {
    const message = { id: "m1", conversation_id: "conv-1", author_node_id: "n1", recipient_node_ids: ["n2"], kind: "report", as_of: "2026-08-10T00:00:00.000Z", payload_preview: { content: "status update" } };
    const mapProjection = busScreen.project({ campaign_id: "c1", conversations: new Map([["conv-1", [message]]]), ungrouped: [], as_of: "2026-08-10T00:00:00.000Z" }, { width: 100, height: 20 });
    expect(mapProjection.rows[0]).toMatchObject({ conversation: "conv-1", kind: "report", author: "n1", recipients: "n2", content: "status update" });
    expect(busScreen.render({ projection: mapProjection, width: 100, height: 8 }).join("\n")).toContain("Conversation bus (1)");

    const ungroupedProjection = busScreen.project({ campaign_id: "c1", conversations: {}, ungrouped: [{ ...message, id: "m2", conversation_id: undefined }], as_of: "2026-08-10T00:00:00.000Z" }, { width: 100, height: 20 });
    expect(ungroupedProjection.rows[0]).toMatchObject({ conversation: "(ungrouped)" });
    expect(busScreen.project({ campaign_id: "c1", conversations: {}, ungrouped: [], as_of: "2026-08-10T00:00:00.000Z" }, { width: 80, height: 10 }).caption).toBe("no bus messages");
  });

  it("projects A2A source cards and a truthful empty result when publication is unconfigured", () => {
    const projection = a2aScreen.project({ campaign_id: "c1", cards: [{ node_ref: "node-a", role: "specialist", tier: "critic", skills: ["delegate", "report"], signature: "sig-abc" }] }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ node_ref: "node-a", role: "specialist", tier: "critic", skills: "delegate, report" });
    expect(a2aScreen.render({ projection, width: 100, height: 8 }).join("\n")).toContain("A2A source cards (1)");
    expect(a2aScreen.project({ campaign_id: "c1", cards: [] }, { width: 80, height: 10 }).caption).toBe("no A2A source cards");
    const unconfigured = a2aScreen.project({
      campaign_id: "c1",
      cards: [],
      configured: false,
      message: "A2A publication is not configured — run `arbor setup` to provision a signing secret.",
    }, { width: 100, height: 10 });
    expect(unconfigured.rows).toEqual([]);
    expect(a2aScreen.render({ projection: unconfigured, width: 100, height: 8 }).join("\n")).toContain("run `arbor setup`");
  });

  it("projects the durable direct-edge thread with delivery, acknowledgement and evidence references", () => {
    const projection = threadsScreen.project({
      thread_id: "parent-child:root:child", parent_node_id: "root", child_node_id: "child",
      version: "message-2", can_accept_direct_input: true,
      messages: [{ id: "message-1", author_node_id: "child", recipient_node_ids: ["root"], kind: "clarify", intent: "needs_attention", ack_required: true, deadline_at: "2026-08-10T00:00:00.000Z", delivery: "acknowledged", payload_preview: { content: "Need evidence", evidence_refs: ["audit://evidence/7"] } }],
    }, { width: 100, height: 20 });
    expect(projection.caption).toContain("direct input accepted");
    expect(projection.caption).toContain("CAS message-2");
    expect(projection.caption).toContain("attention 1");
    expect(projection.rows[0]).toMatchObject({ from: "child", to: "root", intent: "needs_attention", delivery: "acknowledged", due: "2026-08-10T00:00:00.000Z" });
    expect(projection.rows[0]).toMatchObject({ receipt: "recipient ack", trust: "local" });
    expect(projection.row_ids?.[0]).toEqual({ id: "message-1", context: { parent_node_id: "root", child_node_id: "child", expected_thread_version: "message-2", author_node_id: "child", ack_required: "true" } });
    expect(threadsScreen.render({ projection, width: 180, height: 8 }).join("\n")).toContain("Need evidence");
    expect(threadsScreen.project({ thread_id: "parent-child:root:child", parent_node_id: "root", child_node_id: "child", version: "origin", messages: [] }, { width: 80, height: 8 }).caption).toContain("direct input unavailable");
  });

  it("covers the remaining thread row fallbacks: unacknowledged delivery, remote attribution, and malformed fields", () => {
    const projection = threadsScreen.project({
      thread_id: "parent-child:root:child", parent_node_id: "root", child_node_id: "child", version: "message-3",
      messages: [
        // ack_required true but not yet acknowledged -> "awaiting ack"; falls back to `kind` when `intent` is absent; remote attribution present.
        { id: "m1", author_node_id: "child", recipient_node_ids: ["root"], kind: "status", ack_required: true, delivery: "pending", payload_preview: { content: "waiting" }, remote_attribution: { integrity: "unverified", session_id: "remote-9" } },
        // ack_required falsy and not acknowledged -> "not required"; no kind/intent -> "?"; malformed recipients/payload/author -> "?".
        { author_node_id: 7, recipient_node_ids: "not-an-array", delivery: "queued", payload_preview: "not-an-object" },
      ],
    }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ intent: "status", receipt: "awaiting ack", trust: "unverified:remote-9" });
    expect(projection.rows[1]).toMatchObject({ from: "?", to: "?", intent: "?", receipt: "not required", content: "?" });
    // No `id` on the second message means its row identity must be null, not a synthesized id.
    expect(projection.row_ids).toEqual([{ id: "m1", context: { parent_node_id: "root", child_node_id: "child", expected_thread_version: "message-3", author_node_id: "child", ack_required: "true" } }, null]);

    // A negative scroll offset makes renderTable throw; threads.ts must catch that and degrade safely.
    expect(threadsScreen.render({ projection, width: 100, height: 10, scroll_offset: -1 })).toEqual(["(render error)"]);
  });

  it("renders only active governed overlays with their canonical rollback fact", () => {
    const projection = overlaysScreen.project({ campaign_id: "c", active_folds: [{ id: "fold-1", status: "active", source_event_ids: ["event-1"] }], active_playbook: [{ id: "lesson", status: "active", source_event_ids: ["event-2"] }], active_harness_revisions: [], rollbackable_ids: ["fold-1"] }, { width: 100, height: 20 });
    expect(projection.rows).toEqual(expect.arrayContaining([expect.objectContaining({ type: "fold", id: "fold-1", rollback: "available" }), expect.objectContaining({ type: "playbook", rollback: "—" })]));
    expect(projection.row_ids?.[0]).toEqual({ id: "fold-1", context: { campaign_id: "c", overlay_type: "fold", status: "active" } });
  });

  it("claims only the aggregate query shape that its projector can render", () => {
    expect(overlaysScreen.surface.queries).toEqual(["context.overlays"]);
  });

  it("falls back to evidence_ids when source_event_ids is absent, and renders the populated overlay table", () => {
    const projection = overlaysScreen.project({ campaign_id: "c", active_folds: [], active_playbook: [], active_harness_revisions: [{ id: "rev-1", state: "active", evidence_ids: ["ev-1", "ev-2"] }], rollbackable_ids: [] }, { width: 100, height: 20 });
    expect(projection.rows[0]).toMatchObject({ type: "harness", id: "rev-1", status: "active", evidence: "ev-1,ev-2" });
    expect(overlaysScreen.render({ projection, width: 100, height: 20 }).join("\n")).toContain("ev-1,ev-2");
  });

});
