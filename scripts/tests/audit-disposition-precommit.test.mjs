import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), "..", "execution-profile.json");

/**
 * gate:audit-disposition caught a real omission this session — a document
 * landed in audit/ without declaring what decision it owed — but only at Stop,
 * after the commit had already been made. Its own message is the argument for
 * moving it earlier: "Leaving a document undispositioned is what puts findings
 * in a transcript and nowhere else." The moment to say so is while the author
 * still has the document in hand, not a turn later.
 *
 * It is read-only and measured at ~20ms, so it costs a precommit run nothing
 * meaningful.
 */
describe("gate:audit-disposition runs at precommit", () => {
  const profile = JSON.parse(readFileSync(PROFILE, "utf8"));
  const gate = profile.gates["gate:audit-disposition"];

  it("is selected by the precommit context", () => {
    expect(gate.contexts.precommit).toBe(true);
  });

  it("no longer declares a precommit omission, because there is none to declare", () => {
    expect(gate.excluded_contexts?.precommit).toBeUndefined();
  });

  it("stays read-only and cheap enough for a hook that fires on every commit", () => {
    expect(gate.mutability).toBe("read_only");
  });
});
