/**
 * scripts/tests/repo-session-conformance.test.mjs — the gate refactor's own proof.
 *
 * The negative canary (`scripts/canaries/repo-session-conformance/
 * undocumented-repo-session-dispatch`) proves the gate can FAIL. This proves the
 * other half, and it is the whole content of the refactor: a repository whose
 * repository-session lifecycle is implemented NATIVELY — no scripts/session-close.mjs,
 * no scripts/hooks bridges, no flag map, no subprocess — must PASS.
 *
 * Before the refactor the fixture below was RED. The gate mandated the shape of the
 * implementation (the spawnSync shim, the resolved coordinator path, the exact
 * begin/status/open/close/abort flag map, the `.sh` bridges' text) rather than the
 * invariants it was proxying for, so the only implementation it could accept was the
 * one it already shipped. After it, the same fixture is green because the gate asks
 * the right question. Deleting the assertions instead would have made this test
 * green too — so the assertions that DID survive are pinned here as well.
 */
import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO_ROOT, "scripts", "repo-session-conformance-gate.mjs");
const CANARIES = join(REPO_ROOT, "scripts", "canaries", "repo-session-conformance");
const NATIVE_FIXTURE = join(CANARIES, "native-repo-session-accepted");

function runGate(root) {
  const result = spawnSync("bun", [GATE, "--root", root], { encoding: "utf8", cwd: REPO_ROOT, timeout: 60_000 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The positive fixture, mutated into a negative one. Deriving it rather than
 *  committing a sibling keeps the difference between the two trees to exactly the
 *  property under test — a drift in the rest of the fixture cannot turn a
 *  negative that should fail into a green tree that cannot. */
function fixtureWith(mutate) {
  const root = mkdtempSync(join(tmpdir(), "repo-session-conformance-"));
  cpSync(NATIVE_FIXTURE, root, { recursive: true });
  mutate(root);
  return root;
}

const TIMEOUT_PROBLEM = "must declare a host timeout that is an integer from 1 to 3 seconds";

/** A codex SessionEnd adapter carrying this repository's marker. */
const sessionEndAdapter = (timeout) => ({
  type: "command",
  command: 'repo_root="$(git rev-parse --show-toplevel)" && cd "$repo_root" && bun scripts/hooks/codex-session-lifecycle.mjs --session-end # revoy2-hook:codex.sessionend.repo-session-lifecycle',
  timeout,
});

describe("gate:repo-session-conformance — a native implementation is legal", () => {
  it("accepts a native lifecycle that satisfies every invariant and none of the shape pins", () => {
    const { status, output } = runGate(NATIVE_FIXTURE);
    expect(output, `gate rejected a native implementation:\n${output}`).toContain("repo-session conformance gate — PASS");
    expect(status).toBe(0);
  });

  it("still refuses a native CLI that never wired the lifecycle in", () => {
    // The same gate, one assertion weaker. Without this the test above would also
    // pass if the gate had been neutered into printing PASS unconditionally.
    const { status, output } = runGate(join(REPO_ROOT, "scripts", "canaries", "repo-session-conformance", "undocumented-repo-session-dispatch"));
    expect(status).not.toBe(0);
    expect(output).toContain("does not dispatch");
  });

  it("keeps the campaign session_end observe-only assertions as invariants", () => {
    const source = readFileSync(GATE, "utf8");
    expect(source, "the observe-only campaign contract must remain in the gate").toContain("HOOK_LIFECYCLE_VETO_EVENT");
    expect(source).toContain("campaign session_end was added to the tool-veto event set");
    expect(source, "the close ordering is an invariant, not a comment").toMatch(/--tier[\s\S]{0,80}stop[\s\S]{0,200}--tier[\s\S]{0,80}full/);
    expect(source, "the end-of-session path must remain forbidden from closing the record").toMatch(/must not|never/);
  });

  it("no longer mandates the deleted implementation's shape", () => {
    const source = readFileSync(GATE, "utf8");
    // The mandate FORMS, not the filenames: the gate's own header names what it
    // dropped and why, and that prose must not be what this assertion reads. What
    // must be gone is the gate READING those files and requiring the shim.
    expect(source).not.toContain('read("scripts/session-close.mjs")');
    expect(source).not.toContain("spawnSync(process.execPath");
    expect(source).not.toMatch(/session-close-(?:start|end)\.sh/);
    expect(source).not.toMatch(/codex-session-lifecycle/);
    expect(source).not.toMatch(/coordinatorAction|commandArgs/);
    // The five verbs are still named, because they are the operator contract.
    expect(source).toContain("begin|status|open|close|abort");
  });
});

describe("invariant 5: a Codex SessionEnd adapter's host timeout is 1-3 seconds", () => {
  // The refactor DECLARED `SESSION_END_TIMEOUT` and kept claiming the invariant in
  // two places in its own header, but never referenced the constant again, so the
  // check was silently gone: a fixture whose SessionEnd adapter declared
  // `timeout: 600` exited 0 PASS. This is the assertion that the constant is load-
  // bearing, because it is the only thing that fails when it stops being read.
  afterEach(() => { if (mutated !== "") rmSync(mutated, { recursive: true, force: true }); });
  let mutated = "";

  it("fails a deployed .codex/hooks.json adapter whose timeout is 600 seconds", () => {
    mutated = fixtureWith((root) => writeFileSync(join(root, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [sessionEndAdapter(600)] }] } })));
    const { status, output } = runGate(mutated);
    expect(status).not.toBe(0);
    expect(output).toContain(TIMEOUT_PROBLEM);
  });

  it("fails the host-controls manifest entry on its own, with no .codex entry beside it", () => {
    mutated = fixtureWith((root) => writeFileSync(join(root, "scripts", "host-controls.json"), JSON.stringify({
      schema_version: 1,
      adapters: [{ host: "codex", configPath: ".codex/hooks.json", events: [{ event: "SessionEnd", groups: [{ hooks: [{
        id: "codex.sessionend.repo-session-lifecycle",
        command: "bun scripts/hooks/codex-session-lifecycle.mjs --session-end",
        options: { timeout: 600 },
      }] }] }] }],
    })));
    const { status, output } = runGate(mutated);
    expect(status).not.toBe(0);
    expect(output).toContain(TIMEOUT_PROBLEM);
  });

  it("fails a non-integer and an out-of-range timeout, and accepts every integer in the range", () => {
    // `3.5` and `"3"` are not integers; 0 and 4 are outside the range. The bound is
    // about a HOST BUDGET, so a value the host has to coerce is not a value this
    // gate will accept on the host's behalf.
    for (const bad of [0, 4, 30, 600, 3.5, "3", null]) {
      mutated = fixtureWith((root) => writeFileSync(join(root, ".codex", "hooks.json"),
        JSON.stringify({ hooks: { SessionEnd: [{ hooks: [sessionEndAdapter(bad)] }] } })));
      const { status, output } = runGate(mutated);
      expect(status, `timeout ${JSON.stringify(bad)} was accepted`).not.toBe(0);
      expect(output).toContain(TIMEOUT_PROBLEM);
      rmSync(mutated, { recursive: true, force: true });
      mutated = "";
    }
    for (const good of [1, 2, 3]) {
      const root = fixtureWith((r) => writeFileSync(join(r, ".codex", "hooks.json"),
        JSON.stringify({ hooks: { SessionEnd: [{ hooks: [sessionEndAdapter(good)] }] } })));
      const { status, output } = runGate(root);
      expect(status, `timeout ${good} was rejected:\n${output}`).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a SessionEnd adapter that is NOT a session-lifecycle adapter alone", () => {
    // The rule is about the repository-session end path's budget, not about every
    // hook the host happens to run at SessionEnd.
    mutated = fixtureWith((root) => writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "bun scripts/some-other-hook.mjs", timeout: 600 }] }] },
    })));
    expect(runGate(mutated).status).toBe(0);
  });

  it("states the invariant in its own header only because the code READS the constant", () => {
    const source = readFileSync(GATE, "utf8");
    // Anti-vacuity for the exact defect this restores: the header names the bound
    // twice and the constant was declared, so the prose was already true while
    // nothing compared anything to it. The bound must appear inside the check.
    expect(source, "SESSION_END_TIMEOUT must be read, not only declared").toMatch(/SESSION_END_TIMEOUT\.min/);
    expect(source).toMatch(/SESSION_END_TIMEOUT\.max/);
  });
});
