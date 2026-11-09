import { describe, expect, it } from "vitest";
import { InputRouter, catalogConflicts, helpActions, normalizeKey, type InputCatalog } from "../src/input-catalog.js";
const catalog: InputCatalog = { actions: [
  { id: "quit", title: "Quit", description: "Exit", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "Quit" }] },
  { id: "palette", title: "Palette", description: "Commands", bindings: [{ scope: "global", keys: ["g", "p"], description: "Palette" }] },
  { id: "modal-close", title: "Close", description: "Close modal", bindings: [{ scope: "modal", keys: ["escape"], description: "Close" }] },
] };
describe("input catalog", () => {
  it("normalizes keys and routes scopes/chords deterministically", () => { let now = 0; const router = new InputRouter(catalog, () => now); expect(normalizeKey({ key: "Q", modifiers: ["ctrl"] })).toBe("ctrl+q"); expect(router.handle({ key: "g" }, ["screen"])).toEqual({ kind: "pending" }); now = 1; expect(router.handle({ key: "p" }, ["screen"])).toEqual({ kind: "action", action_id: "palette" }); expect(router.handle({ key: "escape" }, ["modal", "screen"])).toEqual({ kind: "action", action_id: "modal-close" }); });
  it("expires chords only on explicit clock-driven input and bounds paste", () => { let now = 0; const router = new InputRouter(catalog, () => now, 10, 3); router.handle({ key: "g" }, ["screen"]); expect(router.pendingChord()).toEqual(["g"]); now = 20; expect(router.pendingChord()).toEqual([]); expect(router.expire()).toEqual({ kind: "ignored" }); expect(router.handle({ key: "x", paste: true, text: "abcdef" }, [])).toEqual({ kind: "paste", text: "abc", truncated: true }); });
  it("detects conflicts and derives help from the same catalog", () => { expect(catalogConflicts({ actions: [...catalog.actions, { id: "also", title: "Also", description: "", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "" }] }] })).toHaveLength(1); expect(helpActions(catalog, "modal").map((action) => action.id)).toEqual(["modal-close"]); });
});
