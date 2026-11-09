import { describe, expect, it } from "vitest";
import { sidebarTabAtColumn, tabBar } from "../src/responsive-sidebar.js";

const tabs = ["project", "adrs", "docs", "devtools"] as const;

describe("sidebar tab pointer targets", () => {
  for (const selected of tabs) {
    for (const width of [40, 22, 12]) {
      it(`matches visible labels with ${selected} selected at width ${width}`, () => {
        const labels = tabBar(selected, null, "truecolor", width).split(" | ");
        let column = 0;
        for (let index = 0; index < labels.length; index++) {
          const label = labels[index]!;
          for (let offset = 0; offset < label.length; offset++) {
            expect(sidebarTabAtColumn(selected, column + offset, width))
              .toBe(column + offset < width ? tabs[index] : null);
          }
          for (let offset = 0; offset < 3; offset++) {
            expect(sidebarTabAtColumn(selected, column + label.length + offset, width)).toBeNull();
          }
          column += label.length + 3;
        }
      });
    }
  }
  it("rejects borders, fractional columns and non-finite input", () => {
    for (const column of [-1, 40, 1.5, NaN, Infinity]) {
      expect(sidebarTabAtColumn("project", column, 40)).toBeNull();
    }
  });
});
