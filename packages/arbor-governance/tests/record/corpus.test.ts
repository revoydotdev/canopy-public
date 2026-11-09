import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDecisionsCorpus } from "../../src/record/corpus.js";

// packages/arbor-governance/tests/record/corpus.test.ts -> repo root is four
// directories up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DECISIONS_DIR = join(REPO_ROOT, "decisions");

describe("scanDecisionsCorpus — real corpus (decisions/*.md)", () => {
  it("classifies every real ADR file: this is the highest-value test, it runs on real data", () => {
    const result = scanDecisionsCorpus(DECISIONS_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { total, parsed, parsed_with_warnings, unparseable, results } = result.value;

    // Print the classification breakdown so a human running this test sees
    // the real numbers, not just a pass/fail bit.
    // eslint-disable-next-line no-console
    console.log(
      `[record/corpus] ${total} files: ${parsed} parsed, ${parsed_with_warnings} parsed_with_warnings, ${unparseable} unparseable`,
    );
    for (const r of results) {
      if (r.classification !== "parsed") {
        // eslint-disable-next-line no-console
        console.log(`  ${r.classification.padEnd(20)} ${r.source_path.split("/").pop()} — ${r.reasons.join("; ")}`);
      }
    }

    expect(total).toBeGreaterThan(0);
    expect(unparseable).toBe(0);
    expect(parsed + parsed_with_warnings).toBe(total);

    // Every classified record must actually resolve to a value when not
    // unparseable — a null record on a "parsed"/"parsed_with_warnings"
    // classification would itself be a defect this test must catch.
    for (const r of results) {
      if (r.classification === "unparseable") {
        expect(r.record).toBeNull();
      } else {
        expect(r.record).not.toBeNull();
      }
    }
  });

  it("reports a not-ok result for a nonexistent decisions directory instead of throwing", () => {
    const result = scanDecisionsCorpus(join(REPO_ROOT, "no-such-directory-at-all"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });
});
