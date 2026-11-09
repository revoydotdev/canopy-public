import { describe, it, expect } from "vitest";
import { parseSnippet, checkLengthTautology, checkVacuousGuardedAssertion } from "../anti-stub-rules.mjs";

describe("anti-stub Rule 5 — tautological test", () => {
  describe("5a: expect(<expr>.length|.size).toBeGreaterThanOrEqual(0) / toBeGreaterThan(-1)", () => {
    it("catches the exact historical G-24 shape (arbor-opencode/tests/loop.test.ts, fixed commit af9caa8)", () => {
      // Reproduced verbatim from `git show af9caa8 -- packages/arbor-opencode/tests/loop.test.ts`
      // (the pre-fix version) — this is the real code that shipped and passed
      // unconditionally until the G-24 fix rewrote it.
      const src = parseSnippet(`
        it("records an auto compaction lifecycle when the policy fires and the guard is clear", async () => {
          const lifecycles = mgr.getCompactionLifecycles("camp1");
          expect(lifecycles.length).toBeGreaterThanOrEqual(0);
          const auto = lifecycles.find((l) => l.lifecycle.trigger === "auto");
          if (auto) {
            expect(auto.lifecycle.status).toBe("completed");
          }
        });
      `);
      const findings = checkLengthTautology(src);
      expect(findings).toHaveLength(1);
      expect(findings[0].receiver).toBe("length");
    });

    it("does not fire on a non-length/.size numeric field even at the same threshold (real, failable sanity check)", () => {
      const src = parseSnippet(`
        it("usage fields are non-negative", () => {
          expect(usage.input_tokens).toBeGreaterThanOrEqual(0);
          expect(usage.output_tokens).toBeGreaterThanOrEqual(0);
        });
      `);
      expect(checkLengthTautology(src)).toHaveLength(0);
    });

    it("catches the .size / toBeGreaterThan(-1) variants too", () => {
      const src = parseSnippet(`
        it("x", () => {
          expect(cache.size).toBeGreaterThan(-1);
        });
      `);
      expect(checkLengthTautology(src)).toHaveLength(1);
    });

    it("does not fire on indexOf(...).toBeGreaterThanOrEqual(0) — a real 'was it found' assertion", () => {
      const src = parseSnippet(`
        it("x", () => {
          expect(audit.indexOf('"operation_id":"recover:2"')).toBeGreaterThanOrEqual(0);
        });
      `);
      expect(checkLengthTautology(src)).toHaveLength(0);
    });
  });

  describe("5b: expect(...) inside if (<bareIdentifier>) with no else", () => {
    it("catches the exact historical G-24 shape (the vacuous-guard half)", () => {
      const src = parseSnippet(`
        it("records an auto compaction lifecycle when the policy fires and the guard is clear", async () => {
          const lifecycles = mgr.getCompactionLifecycles("camp1");
          expect(lifecycles.length).toBeGreaterThanOrEqual(0);
          const auto = lifecycles.find((l) => l.lifecycle.trigger === "auto");
          if (auto) {
            expect(auto.lifecycle.status).toBe("completed");
          }
        });
      `);
      const findings = checkVacuousGuardedAssertion(src);
      expect(findings).toHaveLength(1);
      expect(findings[0].guard).toBe("auto");
    });

    it("does not fire on a binary-condition guard (the legitimate for..of/if(e.type===X) event-correlation idiom)", () => {
      const src = parseSnippet(`
        it("x", () => {
          for (const e of events) {
            if (e.type === "compaction_skipped") {
              expect(e.campaign_id).toBe("camp1");
            }
          }
        });
      `);
      expect(checkVacuousGuardedAssertion(src)).toHaveLength(0);
    });

    it("does not fire when the guard was already established as defined earlier in the same block", () => {
      const src = parseSnippet(`
        it("x", () => {
          const treeChanged = lines.find((l) => l.event_kind === "tree.node_changed");
          expect(treeChanged).toBeDefined();
          if (treeChanged) {
            expect(treeChanged.source_record_id).toBe(null);
          }
        });
      `);
      expect(checkVacuousGuardedAssertion(src)).toHaveLength(0);
    });

    it("fires when the guard is not established (a live, reportable instance found in this repo's actual tests)", () => {
      // Mirrors packages/arbor-mcp/tests/devtools-log.test.ts's "source_record_id
      // is null for events without a direct ledger pointer" test as it exists
      // today — not fixed here (out of this lane's ownership, packages/**), but
      // used as a real-shape fixture proving the rule fires on genuine cases
      // beyond the single G-24 reproduction above.
      const src = parseSnippet(`
        it("source_record_id is null for events without a direct ledger pointer", () => {
          const treeChanged = lines.find((l) => l.event_kind === "tree.node_changed");
          if (treeChanged) {
            expect(treeChanged.source_record_id).toBe(null);
          }
          const campaignChanged = lines.find((l) => l.event_kind === "campaign.changed");
          expect(campaignChanged).toBeDefined();
        });
      `);
      expect(checkVacuousGuardedAssertion(src)).toHaveLength(1);
    });

    it("does not fire on a guard block with no expect() call at all (cleanup idiom)", () => {
      const src = parseSnippet(`
        afterEach(async () => {
          if (runtime) {
            await runtime.close();
          }
        });
      `);
      expect(checkVacuousGuardedAssertion(src)).toHaveLength(0);
    });

    it("does not fire when the if has an else branch", () => {
      const src = parseSnippet(`
        it("x", () => {
          if (auto) {
            expect(auto.lifecycle.status).toBe("completed");
          } else {
            expect(auto).toBeUndefined();
          }
        });
      `);
      expect(checkVacuousGuardedAssertion(src)).toHaveLength(0);
    });
  });
});
