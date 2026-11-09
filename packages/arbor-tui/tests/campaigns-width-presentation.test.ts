import { describe, expect, it } from "vitest";
import { campaignsScreen } from "../src/screens/campaigns.js";
import { displayWidth } from "../src/widgets.js";

const item = {
  id: "mcp-owned-roundtrip",
  plan_path: "/plans/operator-alpha-review.md",
  halted: true,
  halt_reason: "awaiting_operator_review",
  total_nodes: 12,
  verified_nodes: 4,
};

describe("campaigns operator-width presentation", () => {
  it("uses a rail-constrained wide pane without truncating ordinary identity and status", () => {
    const size = { width: 126, height: 20 };
    const projection = campaignsScreen.project({ items: [item] }, size);
    const lines = campaignsScreen.render({ projection, ...size, selected_id: item.id });
    expect(lines[0]).toContain("↑/↓ select");
    expect(lines[0]).toContain("Ctrl+P commands");
    expect(lines[1]).toContain("Verified");
    expect(lines[2]).toContain(`› ${item.id}`);
    expect(lines[2]).toContain("operator-alpha-review.md");
    expect(lines[2]).toContain(item.halt_reason);
    expect(projection.row_ids).toEqual([{ id: item.id }]);
    expect(lines.every((line) => displayWidth(line) <= size.width)).toBe(true);
  });

  it.each([30, 64, 65, 90, 126])("respects the viewport at %i columns and preserves offset identity", (width) => {
    const size = { width, height: 4 };
    const projection = campaignsScreen.project({ items: [item, { ...item, id: "second" }] }, size);
    const lines = campaignsScreen.render({ projection, ...size, scroll_offset: 1, selected_id: "second" });
    expect(lines.length).toBeLessThanOrEqual(size.height);
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    expect(lines[2]).toContain("›");
    expect(lines.join("\n")).not.toContain(item.id);
  });
});
