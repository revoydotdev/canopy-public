import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * scripts/tests/pre-push-prose.test.mjs — prose about the hook must match the hook.
 *
 * WHY THIS EXISTS. `ROADMAP.md` claimed pre-push ran "the four blocking gates"
 * and named four. The hook ran twelve. The claim was stale by eight gates and
 * had been for weeks, in the very document whose own Qualification 3 predicts
 * this class of drift keeps recurring — and the same stale sentence had to be
 * fixed in `AGENTS.md` earlier the same day.
 *
 * Nothing checked it, because `gate:docs-truth` checks citation existence and
 * uniqueness, not whether a sentence still describes the thing it describes.
 * That is the general problem and it is not mechanically decidable. THIS is:
 * the hook either enumerates its gates or delegates to the checked-in
 * execution profile, so a document can be compared against the authority
 * that actually schedules its checks.
 *
 * The comparison is deliberately narrow — the gate NAMES and their COUNT, not
 * the surrounding prose. A test that tried to police the paragraph would fire
 * on every rewording and get waived, which is how a check stops meaning
 * anything.
 */

/** Gates the hook actually runs blockingly — `|| true` means advisory. */
function hookGates() {
  const body = readFileSync(join(REPO, "scripts/hooks/pre-push"), "utf8");
  if (body.includes("bun run enforcement:prepush")) {
    const profile = JSON.parse(readFileSync(join(REPO, "scripts/execution-profile.json"), "utf8"));
    return new Set(Object.entries(profile.gates)
      .filter(([, entry]) => entry.contexts.prepush === true)
      .map(([name]) => name));
  }
  const found = new Set();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (!/\bbun run gate:/.test(trimmed) || trimmed.includes("|| true")) continue;
    found.add(/gate:[a-z0-9:-]+/.exec(trimmed)[0]);
  }
  return found;
}

/** Gate names a document lists where it describes the pre-push hook. */
function documentedGates(relative, anchor) {
  const text = readFileSync(join(REPO, relative), "utf8");
  const at = text.indexOf(anchor);
  expect(at, `${relative} no longer contains the anchor: ${anchor}`).toBeGreaterThan(-1);
  const window = text.slice(at, at + 800);
  return { gates: new Set(window.match(/gate:[a-z0-9:-]+/g) ?? []), window };
}

describe("a document describing the pre-push hook names the gates the hook runs", () => {
  const hook = hookGates();

  it("the hook runs a non-trivial set of blocking gates", () => {
    // Guards the guard: if the extraction silently found nothing, every
    // comparison below would pass vacuously.
    expect(hook.size).toBeGreaterThan(5);
  });

  it("ROADMAP.md's install-hooks paragraph matches the hook exactly", () => {
    const { gates, window } = documentedGates("ROADMAP.md", "install-hooks` installs a local `pre-push`");
    if (window.includes("declarative pre-push execution profile")) {
      expect(window).toContain("scripts/execution-profile.json");
    } else {
      expect([...gates].sort()).toEqual([...hook].sort());
    }
  });

  it("no document states a gate COUNT that contradicts the hook", () => {
    // The original defect was the word "four", not the list. A reader takes
    // the number at face value without counting the names after it.
    const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
    for (const relative of ["ROADMAP.md", "AGENTS.md"]) {
      // Unwrap first. The original defect read "four\n> blocking gates" — a
      // markdown blockquote line break sits between the number and the noun,
      // and `>` is not whitespace, so a naive \s+ match sails straight past
      // the very instance this test was written for.
      const text = readFileSync(join(REPO, relative), "utf8").replace(/\n\s*>?\s*/g, " ");
      for (const [word, value] of Object.entries(words)) {
        const pattern = new RegExp(`\\b${word}\\s+blocking gates\\b`, "gi");
        if (pattern.test(text)) {
          expect(value, `${relative} says "${word} blocking gates"; the hook runs ${hook.size}`).toBe(hook.size);
        }
      }
    }
  });
});
