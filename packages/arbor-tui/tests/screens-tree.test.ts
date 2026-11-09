import { describe, it, expect, afterEach } from "vitest";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens } from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";
import { treeScreen } from "../src/screens/tree.js";

afterEach(() => clearRegisteredScreens());

function render(result: unknown, width = 80, height = 20, selected_id?: string, unicode = true): readonly string[] {
  const projection = treeScreen.project(result, { width, height });
  return treeScreen.render({ projection, width, height, selected_id, unicode });
}

const treePayload = {
  campaign_id: "camp-01",
  nodes: [
    { id: "root", label: "Plan: Refactor Shell", depth: 0, state: "claimed", has_children: true },
    { id: "n1", label: "Expand: Terminal I/O", depth: 1, state: "expanding", has_children: true },
    { id: "n2", label: "Leaf: Unicode Clipping", depth: 2, state: "verified", has_children: false },
    { id: "n3", label: "Branch: Pruned", depth: 1, state: "pruned", has_children: false },
  ],
};

describe("tree screen", () => {
  it("is registered and exposes the real tree.branch/tree.prune commands + campaign.tree query", () => {
    registerScreen(treeScreen);
    const mod = getScreen("tree");
    expect(mod.title).toBe("Tree");
    expect(mod.required_capabilities).toEqual(["tree.read", "tree.write"]);
    expect(mod.surface.commands).toEqual(["tree.branch", "tree.prune"]);
    expect(mod.surface.queries).toEqual(["campaign.tree"]);
  });

  it("is offered only when both tree.read and tree.write are granted", () => {
    registerScreen(treeScreen);
    expect(availableScreens(new Set(["tree.read"])).some((s) => s.id === "tree")).toBe(false);
    expect(availableScreens(new Set(["tree.write"])).some((s) => s.id === "tree")).toBe(false);
    expect(availableScreens(new Set(["tree.read", "tree.write"])).some((s) => s.id === "tree")).toBe(true);
  });

  it("projects the real campaign.tree shape into typed, bounded rows", () => {
    const projection = treeScreen.project(treePayload, { width: 100, height: 20 });
    expect(projection.rows).toHaveLength(4);
    expect(projection.rows[0]).toMatchObject({ id: "root", label: "Plan: Refactor Shell", depth: 0, state: "claimed" });
    expect(projection.columns.map((c) => c.key)).toEqual(["id", "label", "depth", "state", "has_children", "category", "score", "provenance"]);
    expect(projection.caption).toContain("camp-01");
    expect(projection.caption).toContain("4");
  });

  it("bounds rows by height via the cardinality cap", () => {
    const bigTree = { campaign_id: "big", nodes: Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}`, depth: 0, state: "pending", has_children: false })) };
    const projection = treeScreen.project(bigTree, { width: 100, height: 500 });
    expect(projection.rows.length).toBeLessThanOrEqual(500);
  });

  it("renders deterministically and clips by width", () => {
    const out = render(treePayload, 40, 10);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(render(treePayload, 40, 10)).toEqual(out);
  });

  it("renders topology connectors and a truthful live progress rail", () => {
    const out = render(treePayload, 180, 12).join("\n");
    expect(out).toContain("1/4 verified");
    expect(out).toContain("expanding 1");
    expect(out).toContain("claimed 1");
    expect(out).not.toContain("active 2");
    expect(out).toContain("frontier 0");
    expect(out).toContain("depth 2");
    expect(out).toMatch(/[├└]─/u);
    expect(out).toContain("s— v0");
    expect(out).toContain("LEGEND › selected");
    expect(out).toContain("… awaiting review/pending");
    expect(render(treePayload, 180, 12).join("\n")).toContain("siblings=alternatives");
  });

  it("distinguishes claimed planning state from an expanding worker in the progress caption", () => {
    const claimedOnly = render({ campaign_id: "claimed", nodes: [{ id: "root", label: "plan", depth: 0, state: "claimed", has_children: false }] }, 180, 12).join("\n");
    expect(claimedOnly).toContain("expanding 0");
    expect(claimedOnly).toContain("claimed 1");

    const expandingOnly = render({ campaign_id: "expanding", nodes: [{ id: "n1", label: "work", depth: 0, state: "expanding", has_children: false }] }, 180, 12).join("\n");
    expect(expandingOnly).toContain("expanding 1");
    expect(expandingOnly).toContain("claimed 0");
  });

  it("marks the selected row with a cursor and leaves other rows unmarked", () => {
    const withSelection = render(treePayload, 100, 10, "n1");
    const withoutSelection = render(treePayload, 100, 10);
    const selectedLine = withSelection.find((l) => l.includes("Expand: Terminal I/O"));
    const unselectedLine = withoutSelection.find((l) => l.includes("Expand: Terminal I/O"));
    expect(selectedLine).toBeDefined();
    expect(unselectedLine).toBeDefined();
    expect(selectedLine).not.toEqual(unselectedLine);
    expect(selectedLine).toContain("›");
    // A non-selected row (root, when n1 is selected) carries no cursor marker.
    const rootLine = withSelection.find((l) => l.includes("Plan: Refactor Shell"));
    expect(rootLine).toBeDefined();
    expect(rootLine).not.toContain("›");
  });

  it("uses ASCII semantic selection and outcome glyphs when Unicode is disabled", () => {
    const ascii = render({ campaign_id: "ascii", nodes: [
      { id: "ok", label: "Verified task", depth: 0, state: "verified", score: 1 },
      { id: "bad", label: "Failed task", depth: 0, state: "failed", score: 1 },
    ] }, 120, 10, "bad", false);
    const verified = ascii.find((line) => line.includes("Verified task"));
    const failed = ascii.find((line) => line.includes("Failed task"));
    expect(verified).toContain("+v Verified task");
    expect(failed).toContain("> !f Failed task");
    expect([...verified!].every((character) => character.codePointAt(0)! < 0x80)).toBe(true);
    expect([...failed!].every((character) => character.codePointAt(0)! < 0x80)).toBe(true);
    expect(verified).not.toContain("\u001b[");
    expect(failed).not.toContain("\u001b[");
  });

  it("renders a node-detail inspector panel for the selected row, surfacing provenance/gates/outcome/recovery/memory fields the table columns don't show", () => {
    const richPayload = {
      campaign_id: "camp-01",
      nodes: [{
        id: "n1", label: "Expand: Terminal I/O", depth: 1, state: "verified", has_children: false,
        action_delegate: "seed", action_estimated_gain: 50, action_estimated_cost: 10, visit_count: 3,
        high_risk_tool_scope: { declared: true, write_path_count: 2, command_argv_count: 1, declaration_hash: "sha256:fixture" },
        decomposition_depth: 1,
        provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:abc" },
        gate_records: [{ gate: "isolation", result: "pass" }, { gate: "audit", result: "bypass", bypass_evidence_deficit: "no independent auditor" }],
        outcome: { kind: "verdict", approved: true, provenance: { tag: "claimed", claimant: "lenticel" }, message: "Critic approved node result" },
        recovery_attempts: [{ action: "retry", operation_id: "op:1", prior_operation_id: "op:0", actor_id: "crown", reason: "flaky transport", expected_version: "v1" }],
        scope_retry_count: 1, critic_retry_count: 0,
        memory_mode: "consolidate", memory_mode_version: 2, kb_entries_extracted: 4,
      }],
    };
    const withSelection = render(richPayload, 100, 30, "n1");
    const joined = withSelection.join("\n");
    expect(joined).toContain("— node detail —");
    expect(joined).toContain("verified (cmd: pytest");
    expect(joined).toContain("2 recorded, latest: audit=bypass [bypass: no independent auditor]");
    expect(joined).toContain("verdict: true");
    expect(joined).toContain("1 recorded, latest: retry by crown");
    expect(joined).toContain("Corrective retries: scope 1, critic 0");
    expect(joined).toContain("↻S1");
    expect(joined).toContain("retries scope 1 / critic 0");
    expect(joined).toContain("consolidate v2");
    expect(joined).toContain("KB entries extracted: 4");
    expect(joined).toContain("High-risk authority: 2 write path(s), 1 command(s) (durable declaration)");

    const withoutSelection = render(richPayload, 100, 30);
    expect(withoutSelection.join("\n")).not.toContain("— node detail —");
  });

  it("uses lower-pane space for wrapped selected-node gate and critic evidence instead of silently clipping it", () => {
    const longEvidence = {
      campaign_id: "camp-density",
      nodes: [{
        id: "n-density", label: "Remediate the dense terminal layout while preserving readable evidence under compact operator width", depth: 0, state: "awaiting_review", has_children: false,
        gate_records: [{ gate: "evidence", result: "fail", checked_at: "2026-08-28T18:00:00Z", detail: "The independent evidence bundle is incomplete because the retained execution transcript does not yet contain the required cross-provider replay receipt." }],
        critic_verdict: { approved: false, critic: "lenticel", rationale: "The implementation is structurally promising, but the operator-facing proof still omits the bounded failure-path demonstration required for an approval decision.", measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: false, checks: [] },
      }],
    };
    const lines = render(longEvidence, 58, 26, "n-density");
    const joined = lines.join("\n");
    // Compact absent fields may leave space; populated evidence must still
    // wrap within the viewport and satisfy the content assertions below.
    expect(lines.length).toBeLessThanOrEqual(26);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(58);
    expect(joined).toContain("Description: Remediate the dense terminal layout while");
    expect(joined).toMatch(/while\s+preserving/u);
    expect(joined).toContain("Gate history:");
    expect(joined).toContain("independent evidence bundle is incomplete");
    expect(joined).toContain("Critic verdict:");
    expect(joined).toMatch(/operator-facing proof\s+still omits/u);
  });

  it("degrades gracefully on null/unknown/empty results", () => {
    expect(() => render(null)).not.toThrow();
    expect(() => render({ weird: true })).not.toThrow();
    expect(() => render({ campaign_id: "c", nodes: [] })).not.toThrow();
    // EC-006: the caption no longer prescribes selecting a campaign that may
    // not exist; it states the absence and what would produce a tree.
    expect(render(null)[0]).toContain("No search tree yet");
    expect(render({ campaign_id: "c", nodes: [] })[0]).toContain("c");
  });

  // `campaign.tree`'s REAL nodes (arbor-mcp/src/manager.ts's
  // `getCampaignSnapshot`) never carry `label` at all — verified against a
  // real campaign's ledger (.arbor/devtools/devtools.log): eight sibling
  // node ids share a 14-char generated prefix (`node_msds9ktu_1` through
  // `node_msds9ktu_8`), indistinguishable once clipped. Every fixture above
  // this point supplies `label` directly, which is NOT what the real backend
  // sends — this test uses the real shape instead.
  it("falls back to action_description (never bare id) when label is absent — the real campaign.tree shape", () => {
    const realShapeTree = {
      campaign_id: "camp-01",
      nodes: [
        { id: "node_msds9ktu_1", action_description: "Add width validation to the table renderer", depth: 1, state: "pending", children_ids: [] },
        { id: "node_msds9ktu_2", action_description: "Fix the off-by-one in scroll offset clamping", depth: 1, state: "pending", children_ids: [] },
      ],
    };
    const projection = treeScreen.project(realShapeTree, { width: 100, height: 20 });
    expect(projection.rows[0].label).toBe("Add width validation to the table renderer");
    expect(projection.rows[1].label).toBe("Fix the off-by-one in scroll offset clamping");
    // The two labels must differ even though the two node ids share a prefix.
    expect(projection.rows[0].label).not.toBe(projection.rows[1].label);
  });

  it("falls back to the bare id only when neither label nor action_description is present", () => {
    const projection = treeScreen.project({ campaign_id: "c", nodes: [{ id: "bare-node", depth: 0, state: "pending" }] }, { width: 100, height: 20 });
    expect(projection.rows[0].label).toBe("bare-node");
  });

  it("derives has_children from children_ids when the (never-real) has_children flag is absent", () => {
    const projection = treeScreen.project(
      { campaign_id: "c", nodes: [{ id: "n1", action_description: "parent", depth: 0, state: "pending", children_ids: ["n2", "n3"] }] },
      { width: 100, height: 20 },
    );
    expect(projection.rows[0].has_children).toBe(true);
  });

  it("carries row_ids keyed by node id with campaign_id context, the value tree.branch/tree.prune need", () => {
    const projection = treeScreen.project(treePayload, { width: 100, height: 20 });
    expect(projection.row_ids?.[0]).toEqual({ id: "root", context: { campaign_id: "camp-01" } });
  });

  it("every real NodeState renders a distinct, non-'?' icon", () => {
    const states = ["pending", "expanding", "verified", "claimed", "failed", "pruned", "interrupted", "abandoned"];
    const payload = { campaign_id: "c", nodes: states.map((state, i) => ({ id: `n${i}`, label: state, depth: 0, state, has_children: false })) };
    const out = render(payload, 100, 20);
    for (const state of states) {
      const line = out.find((l) => l.includes(state));
      expect(line, `no rendered line for state ${state}`).toBeDefined();
      expect(line).not.toMatch(/\? /);
    }
  });
});

describe("a failed node shows its reason when no outcome was recorded (EC-061)", () => {
  it("renders the FAILED root cause from specialist_output", () => {
    const result = { campaign_id: "c", nodes: [
      { id: "root", label: "Plan", depth: 0, state: "claimed", has_children: true, action_delegate: "crown" },
      { id: "n1", parent_id: "root", label: "greet", depth: 1, state: "failed", has_children: false, action_delegate: "seed", specialist_output: "FAILED: repository status could not be inspected before isolation: fatal: not a git repository\nmore" },
    ] };
    const projection = treeScreen.project(result, { width: 120, height: 40 });
    const lines = treeScreen.render({ projection, width: 120, height: 40, selected_id: "n1" });
    expect(lines.join("\n")).toContain("failed: repository status could not be inspected before isolation");
  });
});
