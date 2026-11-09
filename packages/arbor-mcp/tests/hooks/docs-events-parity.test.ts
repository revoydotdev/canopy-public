/**
 * WA-43/J3-23 — the "Hooks" section of `docs/operator-guide.md` must list
 * exactly the event names `HOOK_ALL_EVENTS` derives from the closed
 * contracts, never a hand-typed second copy that could drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_ALL_EVENTS } from "../../src/hooks/contracts.js";

describe("docs/operator-guide.md Hooks section", () => {
  it("names exactly the events HOOK_ALL_EVENTS derives from the closed per-kind tables", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "docs", "operator-guide.md"), "utf8");
    const section = doc.slice(doc.indexOf("## Hooks"), doc.indexOf("## Remote and scheduled work"));
    expect(section.length).toBeGreaterThan(0);
    const named = new Set([...section.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).filter((token) => (HOOK_ALL_EVENTS as readonly string[]).includes(token)));
    expect(named).toEqual(new Set(HOOK_ALL_EVENTS));
  });
});
