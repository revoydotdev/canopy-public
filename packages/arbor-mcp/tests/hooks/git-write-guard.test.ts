/**
 * `veto.git-write-guard` — the behaviour `scripts/hooks/git-write-guard.sh`
 * had, asserted on the native handler through the real veto chain.
 *
 * The two properties the shell hook said it must never trade away are the
 * teeth of this file: the orchestrator is never blocked, and the hook fails
 * open on anything it cannot parse. The subagent-deny table is carried over
 * case for case from the deleted `scripts/tests/git-write-guard.test.mjs`,
 * including the two "allows" rows that exist to catch a prefix regex that
 * matches too much (`npm add foo`, `git checkout mybranch`).
 */
import { describe, expect, it } from "vitest";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import type { HookVetoContext, HookVetoDecision, HookVetoHandler } from "../../src/hooks/contracts.js";
import { gitWriteGuard } from "../../src/hooks/git-write-guard.js";
import type { NativeToolPort, NativeToolPreflightResult, NativeToolRequest, NativeToolResponse } from "@arbor/harness";

const bash = (command: string, subagent: boolean, tool = "shell.execute"): HookVetoContext => Object.freeze({
  event: "tool_preflight", hook_id: "git-write-guard", version: "1.0.0", session_id: "s-1", call_id: "c-1",
  tool, subagent, tool_input: Object.freeze({ command, path: "", added_text: "", removed_text: "" }),
});

const request = (input: unknown): NativeToolRequest => Object.freeze({
  session_id: "s-1", turn: 1, call_id: "c-1", input, workspace_roots: ["/workspace"],
  filesystem: "workspace_write", network_allowed: false, intent_evidence: [],
});

const decide = (context: HookVetoContext): HookVetoDecision => gitWriteGuard(context);

/** A shell port whose own preflight allows, so a denial below can only be the hook's. */
const permissivePort = (): NativeToolPort => Object.freeze({
  tool: "shell.execute",
  preflight: (): NativeToolPreflightResult => ({ allowed: true }),
  execute: (): Promise<NativeToolResponse> => Promise.reject(new Error("preflight should have refused this call")),
});

const wired = (): HookBus => {
  const catalog = new HookCatalog();
  catalog.register(JSON.stringify({
    schema_version: 1, hook_id: "git-write-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.git-write-guard", why: "refuse a forbidden git write from subagent context",
  }));
  return new HookBus({ catalog });
};

describe("veto.git-write-guard — subagent context", () => {
  it.each([
    ["git stash", "stash"],
    ["git stash pop", "stash pop"],
    ["git commit -am wip", "commit"],
    ["git add foo.txt", "add"],
    ["git reset --hard HEAD~1", "reset"],
    ["git -C /repo reset --hard", "reset with global -C flag"],
    ["git rebase main", "rebase"],
    ["git checkout -- foo.txt", "checkout --"],
    ["git worktree add ../wt", "worktree add"],
    ["cd /tmp && git commit -m x", "commit after a compound command"],
  ])("denies `%s` (%s)", (command) => {
    expect(decide(bash(command, true)).allow).toBe(false);
  });

  it.each([
    ["git stash", "stash"],
    ["git add foo.txt", "add"],
    ["git reset --hard HEAD~1", "reset"],
    ["git checkout -- foo.txt", "checkout --"],
    ["git worktree add ../wt", "worktree add"],
  ])("names the matched shape in the denial for `%s`", (command, matched) => {
    const decision = decide(bash(command, true));
    expect(decision.allow === false && decision.reason).toContain(matched);
  });

  it.each([
    ["git show HEAD:package.json", "read-only show"],
    ["git log -p -- foo.txt", "read-only log"],
    ["git checkout mybranch", "branch switch, not a discard"],
    ["git status", "read-only status"],
    ["npm add foo", "non-git command containing the word add"],
    ["", "empty command"],
  ])("allows `%s` (%s)", (command) => {
    expect(decide(bash(command, true))).toEqual({ allow: true });
  });

  it("ignores a non-shell tool even when its payload carries a command", () => {
    expect(decide(bash("git stash", true, "file.write"))).toEqual({ allow: true });
  });
});

describe("veto.git-write-guard — the orchestrator is never blocked", () => {
  it.each(["git stash", "git commit -am wip", "git add -A", "git reset --hard", "git checkout -- .", "git clean -fd"])(
    "allows `%s` from the main thread",
    (command) => {
      expect(decide(bash(command, false))).toEqual({ allow: true });
    },
  );
});

describe("veto.git-write-guard — through the real veto chain", () => {
  it("denies a subagent's `git stash` before the port's own preflight runs", () => {
    const bus = wired();
    const port = bus.wrapToolPort(permissivePort(), { subagent: true });
    const result = port.preflight?.(request({ argv: ["git", "stash"] }));
    expect(result?.allowed).toBe(false);
    expect(result?.allowed === false && result.reason).toContain("git-write-guard");
    expect(bus.ledger()).toMatchObject([{ hook_id: "git-write-guard", decision: "deny" }]);
  });

  it("allows the same call from the orchestrator, and the port's own preflight then decides", () => {
    const bus = wired();
    const port = bus.wrapToolPort(permissivePort());
    expect(port.preflight?.(request({ command: "git stash" }))).toEqual({ allowed: true });
  });

  it("redacts the command before a handler can see it, so a secret cannot reach a deny reason", () => {
    const bus = wired();
    const port = bus.wrapToolPort(permissivePort(), { subagent: true });
    const result = port.preflight?.(request({ command: "git commit -m sk-live-ABCDEF" }));
    expect(result?.allowed).toBe(false);
    expect(bus.ledger().map((row) => row.evidence_ref).join("\n")).not.toContain("sk-live-ABCDEF");
  });
});

describe("veto.git-write-guard — the registered handler is the one under test", () => {
  it("is a closed-registry veto entry, not an ad-hoc function", () => {
    const handler = new HookCatalog().resolveHandler("veto.git-write-guard");
    expect(handler?.kind).toBe("veto");
    const registered: HookVetoHandler = handler?.kind === "veto" ? handler.handler : () => { throw new Error("not a veto entry"); };
    expect(registered(bash("git rebase main", true)).allow).toBe(false);
  });
});
