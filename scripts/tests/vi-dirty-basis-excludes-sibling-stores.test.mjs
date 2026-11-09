import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROFILE } from "../lib/project-profile.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The rebind chain used to poison its own next run. `vi-observe` stamps
 * `tree_state: "dirty"` from `git status --porcelain`, excluding only
 * `.visual-intelligence/` — but by the time it runs, its SIBLING producers in
 * the same chain have already written `.claim-ledger/` and
 * `.completion-depth/` and left them uncommitted. Those are derived outputs of
 * the very same refresh, not source drift, so counting them guaranteed
 * `tree_state: "dirty"` on every run, which `gate:vi-freshness` then rejected
 * as "a state no commit has". It failed on every rebind of this session.
 *
 * Both dirtiness judgements must therefore exclude EVERY configured evidence
 * store, not one hardcoded literal.
 */
describe("vi dirtiness excludes sibling evidence stores", () => {
  const stores = DEFAULT_PROFILE.governance.evidence_stores;

  it("the profile lists more than one evidence store, so a single hardcoded exclusion is provably incomplete", () => {
    expect(stores.length).toBeGreaterThan(1);
    expect(stores).toContain(".visual-intelligence");
    expect(stores).toContain(".claim-ledger");
  });

  // A source-pattern assertion alone is too weak: the first version of this
  // fix referenced `profileOrDefaults` without importing it, every pattern
  // check still passed, and the defect only surfaced when the rebind chain
  // died with "profileOrDefaults is not defined" two steps later. Importing
  // the modules is not an option — they are scripts that EXECUTE on import —
  // so assert the binding statically instead: a file that references a
  // profile helper must also import it.
  for (const file of ["vi-observe.mjs", "vi-refresh.mjs"]) {
    it(`${file} imports every profile helper it references`, () => {
      const source = readFileSync(join(SCRIPTS, file), "utf8");
      for (const helper of ["profileOrDefaults", "DEFAULT_PROFILE"]) {
        if (!new RegExp(`\\b${helper}\\s*\\(|\\b${helper}\\.`).test(source)) continue;
        expect(source).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${helper}\\b[^}]*\\}\\s*from\\s*["'\`][^"'\`]*project-profile\\.mjs["'\`]`));
      }
    });
  }

  for (const file of ["vi-observe.mjs", "vi-refresh.mjs"]) {
    it(`${file} filters dirty paths against every configured evidence store, not just .visual-intelligence`, () => {
      const source = readFileSync(join(SCRIPTS, file), "utf8");
      // The defect shape: a porcelain filter whose only exclusion is the
      // visual-intelligence literal.
      const hardcodedOnly = /\.filter\(\([^)]*\)\s*=>\s*[^)]*!\w*\.includes\(["'`]\.visual-intelligence\/["'`]\)\s*\)/;
      expect(source).not.toMatch(hardcodedOnly);
      expect(source).toMatch(/evidenceStorePrefixes|EVIDENCE_STORE_PREFIXES/);
    });
  }
});
