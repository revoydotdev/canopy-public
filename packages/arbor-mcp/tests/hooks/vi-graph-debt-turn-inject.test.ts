/**
 * `inject.vi-graph-debt` — the graph-debt report on the ADVISORY `turn_end`
 * lane, which is the only place it can reach the MODEL.
 *
 * The deleted `vi-graph-debt.sh` printed its prose to stdout at Stop time, and
 * Claude Code fed that to the model. Its first native replacement was an
 * OBSERVE handler, so its product became a ledger row — and a ledger row with
 * zero production readers is a note nobody reads, which the header of
 * `vi-graph-debt.ts` claimed otherwise. The `turn_end` inject lane is what
 * restores the lost half: an `inject` handler returns a `Tropism`, the bus
 * validates and bounds it, and the worker's turn loop carries it into the NEXT
 * turn's prompt.
 *
 * Three properties are asserted here, and each one is a defect this repository
 * has already shipped in some form:
 *
 *  1. IT REACHES THE MODEL. Asserted through the REAL `NativeHarnessWorker`
 *     over a real bus, not by inspecting a return value: a handler that
 *     computes a correct report nobody is ever shown is the "green in unit
 *     tests, broken in the product" shape AGENTS.md names three instances of.
 *  2. §5.3 DEDUPE STILL SUPPRESSES AN UNCHANGED DERIVATION. This is what makes
 *     a per-turn lane affordable, and it is also the trap: a report whose
 *     `derived_from` does not move goes SILENT rather than wrong, and silence
 *     is indistinguishable from a clean repository (ADR-032's ~42 sessions).
 *     So the derivation must be a function of the live intersection, and a
 *     MOVED intersection must render again.
 *  3. THE PER-TURN GIT WORK LEAVES THE CALLER'S STACK. The handler costs three
 *     `git` subprocesses; an async wrapper around a body with no `await` runs
 *     them on whoever called it. Measured: 13-17 ms of the turn boundary's own
 *     stack per turn, and it took the native production e2e from 4/4 to 2/4
 *     before it was deferred. The assertion is ORDERING, not wall clock: the
 *     caller's next event-loop turn must complete before the first `git` spawn
 *     happens, which is deterministic and cannot flake under load the way a
 *     millisecond threshold would.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilitySupport, ExecutionPolicy, NativeModelPort, NativeToolResponse, SessionStartRequest } from "@arbor/harness";
import { NativeHarnessWorker, NativeSessionEngine } from "@arbor/harness";

import { HookBus } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { HOOK_LIFECYCLE_EVENTS, HOOK_LIFECYCLE_VETO_EVENT, HOOK_VETO_EVENTS } from "../../src/hooks/contracts.js";
import { GitAdapter } from "../../src/git-workspace-projection.js";
import { viGraphDebtTropism } from "../../src/hooks/vi-graph-debt.js";

let root = "";
let hooksDir = "";

const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
/** A tracked path, edited in the working tree so `git status` reports it. */
const edit = (path: string): void => writeFileSync(join(root, path), "// edited\n");
/** The append-only session tracker the native `observe.vi-dirty-tracker` writes. */
const dirty = (...paths: string[]): void => appendFileSync(join(root, ".visual-intelligence", ".dirty"), paths.map((path) => `${path}\n`).join(""));
/** The handler's own answer for this repository, bypassing the bus. */
const report = () => viGraphDebtTropism(root);

/** Every shipped descriptor except `vi-graph-debt`, materialized into a real `.arbor/hooks`. */
const materializeAll = (): void => {
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(hooksDir, descriptor.filename), descriptor.contents);
};
/** Only `vi-graph-debt`, so a spawn count attributes to it alone. */
const materializeOnlyGraphDebt = (): void => {
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) {
    if (descriptor.filename !== "vi-graph-debt@1.0.0.json") continue;
    writeFileSync(join(hooksDir, descriptor.filename), descriptor.contents);
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-graph-debt-turn-"));
  hooksDir = join(root, ".arbor", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(join(root, ".visual-intelligence"), { recursive: true });
  mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
  mkdirSync(join(root, "decisions"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "decisions", "ADR-001-first.md"), "# First\n");
  writeFileSync(join(root, "notes", "seed.md"), "seed\n");
  // Tracked on purpose: `--porcelain` collapses an untracked DIRECTORY to one
  // `?? dir/` entry, so a per-file edit under one would never appear.
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("graph debt reaches the MODEL, not just the ledger", () => {
  it("renders the report into a prompt on the NEXT turn, through the real worker", async () => {
    materializeAll();
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const bus = HookBus.fromDirectory(hooksDir);

    const capabilities: readonly CapabilitySupport[] = [
      "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
    ].map((capability) => ({
      capability, grade: "native",
      evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" },
    })) as readonly CapabilitySupport[];
    const policy: ExecutionPolicy = {
      filesystem: "read_only", approvals: "never", tool_allow: ["read"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 3_600_000, max_events: 200, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false,
    };
    const start: SessionStartRequest = { session_id: "s-debt", policy, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false };
    const read = (): NativeToolResponse => ({
      result_summary: "read", model_output: "source text",
      evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } },
    });
    const prompts: string[] = [];
    const model: NativeModelPort = {
      async run(request) {
        prompts.push(request.prompt);
        return prompts.length <= 3
          ? { text: [], tool_calls: [{ call_id: `c${prompts.length}`, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null }
          : { text: [], tool_calls: [], final_message: "the answer" };
      },
    };

    const result = await new NativeHarnessWorker({
      session_engine: new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities }),
      model,
      tools: [{ tool: "read", async execute() { return read(); } }],
      turn_inject: async (boundary) => {
        const scope = await bus.injectTurnEnd({ session_id: boundary.session_id, turn: boundary.turn });
        return scope.content === "" ? null : scope.content;
      },
    }).run({ start, prompt: "do the work", max_turns: 6 });

    expect(result.session.state).toBe("completed");
    // The turn that STARTS an injection is not the turn that receives it: the
    // worker begins at the top of a turn and settles at the top of the next
    // one, so the first prompt cannot carry it. That is the timing contract,
    // and this is what proves the product leaves the bus at all.
    expect(prompts[0]).not.toContain("graph debt");
    const delivered = prompts.findIndex((prompt) => prompt.includes("graph debt: 1 path(s) changed"));
    expect(delivered).toBeGreaterThan(0);
    expect(prompts[delivered]).toContain("packages/x/src/a.ts");
    expect(prompts[delivered]).toContain("Refresh with maintenance mode");
  });

  it("is silent — no prompt bytes — when the intersection is empty", async () => {
    materializeAll();
    dirty("packages/x/src/a.ts");
    const bus = HookBus.fromDirectory(hooksDir);

    const scope = await bus.injectTurnEnd({ session_id: "s-clean", turn: 1 });

    // A path in `.dirty` that the worktree no longer holds is not debt. Saying
    // so anyway is the 42-session false alarm this whole intersection removes.
    expect(scope.content).toBe("");
    expect(bus.ledger().some((row) => row.hook_id === "vi-graph-debt" && (row.evidence_ref ?? "").includes("deduped="))).toBe(false);
  });

  it("is accepted by the catalog as ADVISORY, and the descriptor still cannot deny anything", async () => {
    materializeAll();
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");

    // §5.3 rule 1: an ADVISORY tropism may not open must/shall/should/never/
    // always/do-not, or it is REFUSED as `advisory_imperative` and silently
    // dropped. The report opens with a noun phrase, so the whole body — remedy
    // line included — passes.
    expect(new HookCatalog().validateTropism(report())).toBeNull();

    // And the move onto this lane bought no capability. `turn_end` is still
    // absent from both deny lists and the veto-capable lifecycle event is
    // unchanged, so there is nothing here for a turn to be refused by.
    expect(HOOK_VETO_EVENTS).not.toContain("turn_end");
    expect(HOOK_LIFECYCLE_EVENTS).not.toContain("turn_end");
    expect(HOOK_LIFECYCLE_VETO_EVENT).toBe("session_start");
    const catalog = new HookCatalog();
    for (const [hook_id, kind, handler_ref] of [
      ["debt-veto", "veto", "veto.deny-shell-execute"],
      ["debt-lifecycle", "lifecycle", "lifecycle.deny-session-start"],
    ] as const) {
      expect(() => catalog.register(Buffer.from(JSON.stringify({
        schema_version: 1, hook_id, version: "1.0.0", kind, event: "turn_end", handler_ref, why: "why",
      })))).toThrowError(expect.objectContaining({ code: "hook_escalation" }));
    }
  });
});

describe("§5.3 dedupe on the per-turn lane", () => {
  it("suppresses an unchanged derivation and re-renders a moved one", async () => {
    materializeAll();
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const bus = HookBus.fromDirectory(hooksDir);

    expect((await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 1 })).content).toContain("graph debt: 1 path(s) changed");
    // Same intersected set on the next turn: suppressed. Without this a
    // per-turn lane is a per-turn tax.
    expect((await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 2 })).content).toBe("");
    expect(bus.ledger().at(-1)?.evidence_ref).toContain("deduped=vi-graph-debt");

    // The intersection MOVED, so the derivation moved and the report is new
    // information rather than a repeat. A handler that kept a constant
    // derivation would go silent here forever, which is the failure this
    // whole property exists to prevent.
    edit("notes/seed.md");
    dirty("notes/seed.md");
    const moved = await bus.injectTurnEnd({ session_id: "s-dedupe", turn: 3 });
    expect(moved.content).toContain("graph debt: 2 path(s) changed");
    expect(moved.source_paths).not.toEqual([]);
  });

  it("records the derivation on the injected row, so a stopped measurement is visible", async () => {
    materializeAll();
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const bus = HookBus.fromDirectory(hooksDir);

    await bus.injectTurnEnd({ session_id: "s-derived", turn: 1 });

    const row = bus.ledger().find((entry) => entry.hook_id === "vi-graph-debt");
    expect(row).toMatchObject({ kind: "inject", event: "turn_end", decision: "observed" });
    expect(row?.evidence_ref).toContain("injected=vi-graph-debt");
    expect(row?.evidence_ref).toContain("lane=ADVISORY");
    // The observe lane recorded this on the row too, and it is still the only
    // audit a native handler has: `gate:hook-liveness` reads shell stdout and
    // cannot see a handler at all.
    expect(row?.derived_from).toHaveLength(1);
  });
});

describe("the per-turn git work leaves the caller's stack", () => {
  it("has not started any git spawn by the time the caller's next event-loop turn runs", async () => {
    // Only this one descriptor, so a spawn is attributable to it alone: the
    // stop battery shares the same boundary and spawns its own.
    materializeOnlyGraphDebt();
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const bus = HookBus.fromDirectory(hooksDir);

    let firstSpawnAt = Number.POSITIVE_INFINITY;
    const real = GitAdapter.prototype.run;
    vi.spyOn(GitAdapter.prototype, "run").mockImplementation(function spy(this: GitAdapter, args: readonly string[]) {
      if (firstSpawnAt === Number.POSITIVE_INFINITY) firstSpawnAt = performance.now();
      return real.call(this, args);
    });

    // Both lanes are fired, and the assertion is about WHEN, not which: the
    // report must not cost the caller a synchronous millisecond on EITHER.
    const pending = bus.injectTurnEnd({ session_id: "s-oob", turn: 1 });
    bus.observeTurnEnd("s-oob", 1);
    // Registered BEFORE the handler can register its own deferral, so this
    // callback is first in the check queue. If the git work were merely
    // microtask-deferred — or merely wrapped in an `async` function — it would
    // already have run by the time this resolves.
    const callerTurnAt = await new Promise<number>((resolve) => { setImmediate(() => { resolve(performance.now()); }); });

    expect((await pending).content).toContain("graph debt: 1 path(s) changed");
    expect(firstSpawnAt).not.toBe(Number.POSITIVE_INFINITY);
    expect(callerTurnAt).toBeLessThan(firstSpawnAt);
  });
});