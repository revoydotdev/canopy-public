import { describe, expect, it } from "vitest";
import { applyUctEvents, emptyUctGraph, initialUctReader, updateUctReader } from "../src/uct-model.js";

describe("semantic UCT lifecycle model", () => {
  it("folds delayed/duplicate events without inventing topology and detects gaps", () => {
    let model = applyUctEvents(emptyUctGraph(), [{ sequence: 1, kind: "snapshot", nodes: [{ id: "root", parent_id: null, state: "claimed" }, { id: "a", parent_id: "root", state: "pending" }], edges: [{ from: "root", to: "a" }] }]);
    model = applyUctEvents(model, [{ sequence: 1, kind: "node_changed", node: { id: "a", state: "verified" } }, { sequence: 3, kind: "node_changed", node: { id: "a", state: "failed" } }]);
    expect(model.status).toBe("gap");
    expect(model.nodes.get("a")?.state).toBe("pending");
    expect(model.edges.size).toBe(1);
  });

  it("handles pruning and rerooting while preserving stable identities", () => {
    let model = applyUctEvents(emptyUctGraph(), [
      { sequence: 1, kind: "snapshot", nodes: [{ id: "r", parent_id: null, state: "claimed" }, { id: "a", parent_id: "r", state: "pending" }, { id: "b", parent_id: "a", state: "pending" }], edges: [{ from: "r", to: "a" }, { from: "a", to: "b" }] },
      { sequence: 2, kind: "rerooted", node_id: "a" },
      { sequence: 3, kind: "node_pruned", node_id: "b" },
    ]);
    expect(model.nodes.has("a")).toBe(true); expect(model.nodes.has("b")).toBe(false); expect(model.edges.size).toBe(0);
  });

  it("accepts a watermark snapshot as a reconnect boundary and derives omitted parent edges", () => {
    const model = applyUctEvents(emptyUctGraph(), [{
      sequence: 42,
      kind: "snapshot",
      nodes: [{ id: "root", parent_id: null, state: "claimed" }, { id: "child", parent_id: "root", state: "pending" }],
    }]);
    expect(model.status).toBe("ok");
    expect(model.sequence).toBe(42);
    expect(model.edges.size).toBe(1);
    const recovered = applyUctEvents(model, [{ sequence: 43, kind: "node_changed", node: { id: "child", state: "verified" } }]);
    expect(recovered.nodes.get("child")?.state).toBe("verified");
  });

  it("accepts sequence zero as the first canonical tree snapshot", () => {
    const model = applyUctEvents(emptyUctGraph(), [{
      sequence: 0,
      kind: "snapshot",
      nodes: [{ id: "root", parent_id: null, state: "claimed" }],
    }]);
    expect(model.status).toBe("ok");
    expect(model.nodes.get("root")?.state).toBe("claimed");
  });

  it("filters and selects at scale, and toggles the filter-entry modal", () => {
    const model = applyUctEvents(emptyUctGraph(), [{ sequence: 1, kind: "snapshot", nodes: Array.from({ length: 20_000 }, (_, i) => ({ id: `n${i}`, parent_id: i ? `n${i - 1}` : null, state: "pending" })) }]);
    let reader = initialUctReader(); reader = updateUctReader(reader, model, { filter: "n19999" }); reader = updateUctReader(reader, model, "next");
    expect(reader.selected_id).toBe("n19999"); expect(reader.follow_active).toBe(false);
    reader = updateUctReader(reader, model, "modal"); expect(reader.modal).toBe(true);
  });

  it("retains manual selection when follow is off and follows the newest active node when on", () => {
    const snapshot = (sequence: number, states: readonly [string, string][]) => applyUctEvents(emptyUctGraph(), [{
      sequence, kind: "snapshot", nodes: states.map(([id, state]) => ({ id, parent_id: null, state, label: id })),
    }]);
    let reader = initialUctReader();
    reader = updateUctReader(reader, snapshot(1, [["root", "pending"], ["a", "expanding"]]), "snapshot");
    expect(reader.selected_id).toBe("a");
    reader = updateUctReader(reader, snapshot(2, [["root", "pending"], ["a", "verified"], ["b", "claimed"]]), "snapshot");
    expect(reader.selected_id).toBe("b");
    reader = updateUctReader(reader, snapshot(3, [["root", "pending"], ["a", "expanding"], ["b", "claimed"]]), "follow");
    reader = updateUctReader(reader, snapshot(4, [["root", "pending"], ["a", "expanding"], ["b", "claimed"]]), "snapshot");
    expect(reader.selected_id).toBe("b");
    expect(reader.follow_active).toBe(false);
  });
});
