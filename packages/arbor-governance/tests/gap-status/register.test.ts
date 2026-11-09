import { describe, expect, it } from "vitest";
import { parseGapRegister, gapRegisterMap } from "../../src/gap-status/register.js";

describe("parseGapRegister", () => {
  const text = [
    "# Roadmap",
    "",
    "Some prose before the register mentioning G-01.",
    "",
    "## Verified gap register",
    "",
    "| ID | Gap | Evidence | Fix-or-Note | Prevented by |",
    "|---|---|---|---|---|",
    "| **G-01** | **CLOSED (2026-08-01).** Fixed. | `foo.ts` | none | 6.3 |",
    "| **G-02** | **OPEN (registered 2026-08-02).** Broken. | `bar.ts` | none | 6.3 |",
    "| **G-03** | **NARROWED (2026-08-03).** Partial. | `baz.ts` | none | 6.3 |",
    "| **G-04** | **RESOLVED AS A DECIDED NON-GOAL.** Won't fix. | n/a | n/a | 6.3 |",
    "",
    "## Next section",
    "",
    "More prose mentioning G-02 with no register row here.",
  ].join("\n");

  it("buckets CLOSED/RESOLVED/RATIFIED as closed and everything else as open", () => {
    const register = parseGapRegister(text);
    const byId = gapRegisterMap(register);
    expect(byId.get(1)?.status).toBe("closed");
    expect(byId.get(2)?.status).toBe("open");
    expect(byId.get(3)?.status).toBe("open"); // NARROWED is still "open" for this module
    expect(byId.get(4)?.status).toBe("closed"); // RESOLVED
  });

  it("computes a bodyRange spanning exactly the register table, excluding prose before/after it", () => {
    const register = parseGapRegister(text);
    const lines = text.split("\n");
    const [start, end] = register.bodyRange;
    for (let line = start; line < end; line++) {
      expect(lines[line - 1]).not.toContain("Some prose before the register");
      expect(lines[line - 1]).not.toContain("More prose mentioning G-02");
    }
    // But the table rows themselves are inside the range.
    const g1RowLine = lines.findIndex((l) => l.includes("**G-01**")) + 1;
    expect(g1RowLine).toBeGreaterThanOrEqual(start);
    expect(g1RowLine).toBeLessThan(end);
  });

  it("returns an empty register (not a throw) when there is no register heading", () => {
    const register = parseGapRegister("# Just a doc\n\nNo register here.\n");
    expect(register.rows).toEqual([]);
    expect(register.bodyRange).toEqual([0, 0]);
  });

  it("omits the — sentinel (never-allocated) row rather than treating it as a real gap id", () => {
    const withSentinel = text.replace(
      "| **G-04** |",
      "| — | **G-20 was never allocated.** | n/a | n/a | n/a |\n| **G-04** |",
    );
    const register = parseGapRegister(withSentinel);
    expect(register.rows.some((r) => r.id === 20)).toBe(false);
  });
});
