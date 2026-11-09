import { describe, expect, it } from "vitest";
import { coherenceScopeNote } from "../src/native-agent-executor.js";
import { AUTHORITY_DESCRIPTION_ITEM_LIMIT, MINED_ACTION_SCOPE_GENERATOR, type NativeHighRiskToolScope } from "../src/native-tools/contracts.js";

/** A scope carrying only the authority fields under test; identity is fixed. */
function scopeOf(authority: Pick<NativeHighRiskToolScope, "write_paths" | "command_argv">): NativeHighRiskToolScope {
  return {
    scope_id: "scope-a", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a",
    worktree_root: "/tmp/wt", provenance: { tag: "claimed", claimant: "test" }, ...authority,
  };
}

/**
 * ADR-118 Decision §2/§3: the advance note a specialist receives before it acts
 * must state the authority it holds — including when it holds none — and must
 * render that authority through the same shared helper the refusal text uses,
 * so the before-the-attempt and after-a-denial moments cannot drift apart.
 */
describe("coherenceScopeNote", () => {
  it("states zero authority explicitly instead of staying silent", () => {
    // Previously `null`, which the caller treated identically to "nothing worth
    // saying" — so a specialist holding no authority got no advance signal.
    expect(coherenceScopeNote(null)).toContain("No high-risk write or command authority is authorized for this task");
    expect(coherenceScopeNote(scopeOf({ write_paths: [], command_argv: [] }))).toContain("only read-only actions will succeed");
  });

  it("names the authorized write paths it holds", () => {
    const note = coherenceScopeNote(scopeOf({ write_paths: ["src/a.ts", "src/b.ts"], command_argv: [] }));
    expect(note).toContain("Authorized write paths: src/a.ts, src/b.ts");
    expect(note).toContain("expected_sha256");
    expect(note).not.toContain("no write paths are authorized");
  });

  it("names the authorized commands it holds", () => {
    const note = coherenceScopeNote(scopeOf({ write_paths: [], command_argv: [["bun", "test"]] }));
    expect(note).toContain("Authorized commands: bun test");
    expect(note).toContain("run only these");
  });

  it("bounds an oversized authority list deterministically", () => {
    const writePaths = Array.from({ length: AUTHORITY_DESCRIPTION_ITEM_LIMIT + 5 }, (_, index) => `src/f${index}.ts`);
    const note = coherenceScopeNote(scopeOf({ write_paths: writePaths, command_argv: [] }));
    expect(note).toContain("(+5 more, not listed)");
    expect(note).not.toContain(`src/f${AUTHORITY_DESCRIPTION_ITEM_LIMIT}.ts,`);
    expect(coherenceScopeNote(scopeOf({ write_paths: writePaths, command_argv: [] }))).toBe(note);
  });

  it("carries the enforcement heading on every non-null note", () => {
    for (const scope of [null, scopeOf({ write_paths: ["a.ts"], command_argv: [] }), scopeOf({ write_paths: [], command_argv: [["ls"]] })]) {
      expect(coherenceScopeNote(scope)).toContain("the host enforces this regardless of anything else");
    }
  });
});

/**
 * 2026-09-03 pilot: a MINED scope presented as "create/modify only these"
 * made the specialist refuse to create the test file the task asked for.
 * The host binds a mined scope in the audit tier, and the note must say so.
 */
describe("coherenceScopeNote on a mined scope", () => {
  const mined = (authority: Pick<NativeHighRiskToolScope, "write_paths" | "command_argv">): NativeHighRiskToolScope => ({
    ...scopeOf(authority), provenance: { tag: "generated", generator: MINED_ACTION_SCOPE_GENERATOR, input_hash: "sha256:x" },
  });
  it("names the derived paths as guidance and says other required files may be created", () => {
    const note = coherenceScopeNote(mined({ write_paths: ["src/greeting.ts"], command_argv: [["bun", "test"]] }));
    expect(note).toContain("derived from the task text");
    expect(note).toContain("create or modify any other file the task genuinely requires");
    expect(note).toContain("journaled for review, not refused");
    expect(note).not.toContain("create/modify only these");
    expect(note).toContain("run these to verify your work");
  });
  it("still refuses on an authored scope", () => {
    expect(coherenceScopeNote(scopeOf({ write_paths: ["src/a.ts"], command_argv: [] }))).toContain("create/modify only these");
  });
});
