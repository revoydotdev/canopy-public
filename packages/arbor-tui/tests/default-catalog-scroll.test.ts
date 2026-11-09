/**
 * Wave2/tui-input-model: the four scroll-control catalog entries
 * (`default-catalog.ts`'s PAGE_UP/PAGE_DOWN/SCROLL_HOME/SCROLL_END). Verifies
 * they are real, non-conflicting, globally-scoped catalog actions that
 * `InputRouter` actually routes — the same bar `default-catalog.test.ts`
 * (existing, not touched here) already holds the tree/operator actions to.
 */
import { describe, expect, it } from "vitest";
import {
  buildDefaultCatalog,
  PAGE_UP_ACTION_ID,
  PAGE_DOWN_ACTION_ID,
  SCROLL_HOME_ACTION_ID,
  SCROLL_END_ACTION_ID,
} from "../src/default-catalog.js";
import { catalogConflicts, InputRouter } from "../src/input-catalog.js";

describe("default catalog scroll actions", () => {
  it("registers all four scroll actions bound to their navigation keys", () => {
    const catalog = buildDefaultCatalog();
    const byId = new Map(catalog.actions.map((action) => [action.id, action]));
    expect(byId.get(PAGE_UP_ACTION_ID)?.bindings[0]?.keys).toEqual(["pageup"]);
    expect(byId.get(PAGE_DOWN_ACTION_ID)?.bindings[0]?.keys).toEqual(["pagedown"]);
    expect(byId.get(SCROLL_HOME_ACTION_ID)?.bindings[0]?.keys).toEqual(["home"]);
    expect(byId.get(SCROLL_END_ACTION_ID)?.bindings[0]?.keys).toEqual(["end"]);
  });

  it("introduces no binding conflicts with the rest of the default catalog", () => {
    const catalog = buildDefaultCatalog();
    expect(catalogConflicts(catalog)).toEqual([]);
    expect(() => new InputRouter(catalog, () => 0)).not.toThrow();
  });

  it("InputRouter resolves a normalized pageup/pagedown/home/end key event to the scroll action", () => {
    const catalog = buildDefaultCatalog();
    const router = new InputRouter(catalog, () => 0);
    expect(router.handle({ key: "pageup" }, ["global"])).toEqual({ kind: "action", action_id: PAGE_UP_ACTION_ID });
    expect(router.handle({ key: "pagedown" }, ["global"])).toEqual({ kind: "action", action_id: PAGE_DOWN_ACTION_ID });
    expect(router.handle({ key: "home" }, ["global"])).toEqual({ kind: "action", action_id: SCROLL_HOME_ACTION_ID });
    expect(router.handle({ key: "end" }, ["global"])).toEqual({ kind: "action", action_id: SCROLL_END_ACTION_ID });
  });
});
