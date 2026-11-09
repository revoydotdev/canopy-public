/**
 * scripts/tests/hook-devolution-gate.test.mjs
 *
 * WHY THE SPAWNED TESTS ARE THE POINT OF THIS FILE.
 *
 * The defect this gate exists to prevent was not a wrong answer, it was three
 * green checks that could not fail:
 *
 *   - `arbor hook validate` printed "All hook descriptors are valid." and
 *     exited 0 over ZERO descriptors.
 *   - `gate:hook-liveness` went green across four hook deletions, because it
 *     only asks whether a hook's OUTPUT stopped varying and deleting a hook
 *     removes it from the manifest it walks.
 *   - `HookBus.wrapToolPort` returns `port` unchanged when no veto hook is
 *     declared, so a veto that never wraps is indistinguishable from one that
 *     passed.
 *
 * A gate written to the same shape would inherit it. So the load-bearing
 * assertions here drive the real script as a subprocess and read its EXIT
 * CODE, not an exported predicate — a test that only calls `auditDevolution()`
 * proves the classifier and nothing about whether the process refuses.
 * `runGate()` below is the only helper the anti-vacuity cases use.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptFromCommand, parseHandlerRefs, parseDefaultHookIds, parseHookBusMethods, parseSeamDispatch } from "../hook-devolution-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO_ROOT, "scripts", "hook-devolution-gate.mjs");

/**
 * Minimal stand-ins for the three native source files the gate parses. They
 * carry the exact shape the real files have at the three sites the gate reads
 * (the `HOOK_HANDLERS` registry literal, the `DEFAULT_HOOK_SET` array, and
 * `HookBus`'s method list) and nothing else, so a fixture failure means the
 * gate moved, not that a stub drifted.
 */
const HANDLERS_TS = `export const HOOK_HANDLERS: HookHandlerRegistry = Object.freeze({
  "veto.git-write-guard": Object.freeze({ kind: "veto", handler: gitWriteGuard }),
  "inject.governance-orient": Object.freeze({ kind: "inject", handler: governanceOrient }),
  "observe.tool-audit-notes": Object.freeze({ kind: "observe", handler: toolAuditNotes }),
  "observe.stop-battery": Object.freeze({ kind: "observe", handler: stopBattery }),
  "inject.turn-end": Object.freeze({ kind: "inject", handler: viGraphDebt }),
}) satisfies HookHandlerRegistry;
`;

const CATALOG_TS = `const DEFAULT_HOOK_SET: readonly HookDescriptor[] = Object.freeze([
  Object.freeze({
    schema_version: 1, hook_id: "git-write-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.git-write-guard",
    why: "refuse a git write issued from subagent context",
  }),
]);

export const DEFAULT_HOOK_DESCRIPTORS: readonly DefaultHookDescriptor[] = Object.freeze(
  DEFAULT_HOOK_SET.map((descriptor) => Object.freeze({
    filename: \`\${descriptor.hook_id}@\${descriptor.version}.json\`,
    contents: "placeholder",
  })),
);
`;

/**
 * The event name sets `contracts.ts` declares. The gate reads them to learn
 * WHICH events a seam that takes an `event` parameter can dispatch, so the
 * stub carries them rather than letting the gate assume a table.
 */
const CONTRACTS_TS = `export const HOOK_VETO_EVENTS = Object.freeze(["tool_preflight"] as const);
export const HOOK_OBSERVE_EVENTS = Object.freeze(["tool_audit", "tool_write", "phase", "ledger_transition", "user_prompt_submit", "pre_compact", "notification", "turn_end"] as const);
export const HOOK_LIFECYCLE_EVENTS = Object.freeze(["session_start", "session_end", "node_start", "node_end", "plan_confirm", "interruption"] as const);
export const HOOK_INJECT_EVENTS = Object.freeze([...HOOK_LIFECYCLE_EVENTS, "turn_end"] as const);
export const HOOK_LIFECYCLE_VETO_EVENT: HookLifecycleEvent = "session_start";
export type HookKind = "observe" | "veto" | "lifecycle" | "inject";
`;

/**
 * `HookBus`, carrying the shape the gate reads at three sites now: the public
 * method list (check (d)); inside each of those methods, WHICH event it
 * dispatches — an event literal passed to a fire/inject call, a
 * `hook.event === "<literal>"` filter, or an `event` parameter typed with one
 * of `contracts.ts`'s event sets; and WHICH hook KIND it dispatches for, which
 * is the `hook.kind` its dispatch site filters on. A method that dispatches no
 * event at all (`diagnostics`, `ledger`) derives two empty sets.
 *
 * The two `turn_end` seams are the reason the KIND derivation exists and are
 * deliberately indistinguishable by event: both name the literal `"turn_end"`,
 * and `turn_end` is in both `HOOK_OBSERVE_EVENTS` and `HOOK_INJECT_EVENTS`. They
 * differ only in which dispatch site runs — `fireObserve`, which admits
 * `hook.kind === "observe"`, and `TropismInjector.inject`, which admits
 * `hook.kind === "inject"` (in the `inject.ts` stub below).
 */
const BUS_TS = `export class HookBus {
  static fromDirectory(directory: string): HookBus { return new HookBus(); }

  wrapToolPort(port: NativeToolPort): NativeToolPort {
    const vetoHooks = this.catalog.list().filter((hook) => hook.kind === "veto" && hook.event === "tool_preflight");
    void vetoHooks;
    return port;
  }

  observeToolAudit(record: NativeToolAuditRecord): void { this.fireObserve("tool_audit", record.session_id, record.tool, {}); }

  observeTurnEnd(sessionId: string | null, turn: number): void { this.fireObserve("turn_end", sessionId, \`turn_end turn=\${turn}\`, { turn: String(turn) }); }

  lifecycleObserve(event: Exclude<HookLifecycleEvent, "session_start">, input: unknown): void { this.catalog.list().filter((hook) => hook.kind === "lifecycle" && hook.event === event); void input; }

  async injectForSession(event: HookLifecycleEvent, input: unknown): Promise<TropismScope> { return this.injector.inject(event, input); }

  async injectTurnEnd(input: unknown): Promise<TropismScope> { return this.injector.inject("turn_end", input); }

  private fireObserve(event: HookObserveEvent, sessionId: string | null, summary: string, detail: Readonly<Record<string, string>>): void {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "observe" && hook.event === event);
    void hooks; void sessionId; void summary; void detail;
  }

  private runBounded<T>(fn: () => T): BoundedOutcome<T> { return { ok: true, value: fn() }; }
}
`;

/**
 * `TropismInjector`, read for one thing: the `hook.kind` the `inject` lane
 * filters on. It lives in a different file from `HookBus` — `HookBus` holds an
 * instance as a field and delegates to it — which is the only reason this file
 * is a fixture at all.
 */
const INJECT_TS = `export class TropismInjector {
  async inject(event: HookInjectEvent, context: unknown): Promise<TropismScope> {
    const hooks = this.catalog.list().filter((hook) => hook.kind === "inject" && hook.event === event);
    void hooks; void context;
    return { source_paths: [], content: "", truncated: false };
  }
}
`;

/**
 * A seam whose dispatch was FACTORED out of its own body — into a class this
 * derivation does not resolve (not `HookBus`, not `TropismInjector`), so it is
 * a seam the gate genuinely cannot read. It must be reported as unreadable, not
 * as a seam that dispatches nothing.
 */
const FACTORED_BUS_TS = `export class HookBus {
  static fromDirectory(directory: string): HookBus { return new HookBus(); }

  wrapToolPort(port: NativeToolPort): NativeToolPort { return new ToolPortComposer(this.catalog).compose(port); }

  private runBounded<T>(fn: () => T): BoundedOutcome<T> { return { ok: true, value: fn() }; }
}
`;

/**
 * `DEFAULT_HOOK_SET` carrying a SECOND descriptor on the event both turn_end
 * seams dispatch: `turn-end`, kind `inject`, event `turn_end`. The pair under
 * test is a row naming `injectTurnEnd` against it (correct) and against an
 * `observe` row naming `observeTurnEnd` (also correct) — the two are separated
 * only by their descriptor's `kind`, because `turn_end` is in both the observe
 * and the inject event set.
 */
const TURN_END_CATALOG_TS = `const DEFAULT_HOOK_SET: readonly HookDescriptor[] = Object.freeze([
  Object.freeze({
    schema_version: 1, hook_id: "git-write-guard", version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: "veto.git-write-guard",
    why: "refuse a git write issued from subagent context",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "turn-end", version: "1.0.0", kind: "inject", event: "turn_end",
    handler_ref: "inject.turn-end",
    why: "prose the model must read at the turn boundary",
  }),
  Object.freeze({
    schema_version: 1, hook_id: "turn-end-observe", version: "1.0.0", kind: "observe", event: "turn_end",
    handler_ref: "observe.stop-battery",
    why: "observe the turn boundary",
  }),
]);

export const DEFAULT_HOOK_DESCRIPTORS: readonly DefaultHookDescriptor[] = Object.freeze(
  DEFAULT_HOOK_SET.map((descriptor) => Object.freeze({
    filename: \`\${descriptor.hook_id}@\${descriptor.version}.json\`,
    contents: "placeholder",
  })),
);
`;

const CLAUDE_SETTINGS = {
  hooks: {
    PreToolUse: [
      { hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.hook-liveness/wrap.sh --mode conditional --log $CLAUDE_PROJECT_DIR/.hook-liveness/invocations.jsonl $CLAUDE_PROJECT_DIR/scripts/hooks/git-write-guard.sh # revoy2-hook:claude-code.pretooluse.git-write-guard" }] },
    ],
  },
};

const HOST_CONTROLS = {
  schemaVersion: 1,
  adapters: [
    {
      host: "claude-code",
      configPath: ".claude/settings.json",
      events: [
        {
          event: "PreToolUse",
          groups: [
            {
              hooks: [
                {
                  id: "claude-code.pretooluse.git-write-guard",
                  command: "$CLAUDE_PROJECT_DIR/.hook-liveness/wrap.sh --mode conditional --log $CLAUDE_PROJECT_DIR/.hook-liveness/invocations.jsonl $CLAUDE_PROJECT_DIR/scripts/hooks/git-write-guard.sh",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const DEVOLVED_ROW = {
  id: "claude-code.pretooluse.git-write-guard",
  event: "PreToolUse",
  source: "scripts/hooks/git-write-guard.sh",
  status: "devolved",
  handler_ref: "veto.git-write-guard",
  descriptor: "git-write-guard",
  seam: "wrapToolPort",
};

function write(root, relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

/** A fixture repository root, parameterised only by what each case is testing. */
function fixture({ ledger, settings = CLAUDE_SETTINGS, hostControls = HOST_CONTROLS, handlers = HANDLERS_TS, catalog = CATALOG_TS, contracts = CONTRACTS_TS, bus = BUS_TS, inject = INJECT_TS, liveScripts = ["scripts/hooks/git-write-guard.sh"], materialized = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hook-devolution-"));
  if (ledger !== null) write(root, "scripts/hook-devolution.json", { schema_version: 1, hooks: ledger });
  if (settings !== null) write(root, ".claude/settings.json", settings);
  if (hostControls !== null) write(root, "scripts/host-controls.json", hostControls);
  write(root, "packages/arbor-mcp/src/hooks/handlers.ts", handlers);
  write(root, "packages/arbor-mcp/src/hooks/catalog.ts", catalog);
  write(root, "packages/arbor-mcp/src/hooks/contracts.ts", contracts);
  write(root, "packages/arbor-mcp/src/hooks/bus.ts", bus);
  write(root, "packages/arbor-mcp/src/hooks/inject.ts", inject);
  for (const relative of liveScripts) write(root, relative, "#!/bin/sh\nexit 0\n");
  for (const filename of materialized) write(root, `.arbor/hooks/${filename}`, "{}\n");
  return root;
}

/** Spawn the real gate and hand back its exit code and combined output. */
function runGate(root) {
  const result = spawnSync("bun", [GATE, "--repo", root], { encoding: "utf8", cwd: REPO_ROOT });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function withFixture(options, body) {
  const root = fixture(options);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("hook-devolution-gate: reading the real surfaces", () => {
  it("reads the registration's script, not the liveness wrapper it is invoked through", () => {
    // Both are `.sh`; taking the first path-shaped token would audit
    // `.hook-liveness/wrap.sh` and call every registration healthy.
    expect(scriptFromCommand(CLAUDE_SETTINGS.hooks.PreToolUse[0].hooks[0].command)).toBe("scripts/hooks/git-write-guard.sh");
  });

  it("reads a codex registration's script through its `bun` prefix", () => {
    expect(scriptFromCommand('repo_root="$(git rev-parse --show-toplevel)" && cd "$repo_root" && bun scripts/hooks/codex-session-lifecycle.mjs')).toBe("scripts/hooks/codex-session-lifecycle.mjs");
  });

  it("parses the closed handler registry, and does not invent a key from a comment", () => {
    expect([...parseHandlerRefs(`export const HOOK_HANDLERS = Object.freeze({\n  // "veto.not-real": a comment\n  "veto.git-write-guard": Object.freeze({ kind: "veto" }),\n}) satisfies X;`)]).toEqual(["veto.git-write-guard"]);
  });

  it("parses the default hook set, stopping before the projection that re-lists it", () => {
    const ids = parseDefaultHookIds(CATALOG_TS);
    expect(ids).toEqual(new Set(["git-write-guard"]));
  });

  it("reports HookBus's public dispatch seams and not its private or static members", () => {
    expect([...parseHookBusMethods(BUS_TS)].sort()).toEqual(["injectForSession", "injectTurnEnd", "lifecycleObserve", "observeToolAudit", "observeTurnEnd", "wrapToolPort"]);
  });

  it("derives which event each seam dispatches FROM THE BUS SOURCE — literal, filter, or typed event parameter", () => {
    // A hand-typed seam→event table in this gate would be the same drift class
    // the gate exists to catch: a second list that can disagree with the one
    // `HookBus` actually implements. So the relation is read out of `bus.ts`,
    // with `contracts.ts` supplying the event sets its parameters are typed
    // with.
    const seams = parseSeamDispatch(BUS_TS, CONTRACTS_TS, INJECT_TS);
    expect([...seams.get("wrapToolPort").events].sort()).toEqual(["tool_preflight"]);
    expect([...seams.get("observeToolAudit").events]).toEqual(["tool_audit"]);
    // `injectForSession(event: HookLifecycleEvent)` dispatches every lifecycle
    // event, and NOT `turn_end` — that one is `injectTurnEnd`'s alone.
    expect(seams.get("injectForSession").events.has("session_start")).toBe(true);
    expect(seams.get("injectForSession").events.has("turn_end")).toBe(false);
  });

  it("derives which hook KIND each seam dispatches for, and separates two seams whose events are identical", () => {
    // THE DEFECT THIS EXISTS FOR. `turn_end` is in both `HOOK_OBSERVE_EVENTS` and
    // `HOOK_INJECT_EVENTS`, so `observeTurnEnd` and `injectTurnEnd` derive the
    // SAME event set — and an event-only check therefore cannot tell them
    // apart. What separates them at runtime is the `hook.kind` each dispatch
    // site filters on, and the derivation follows the dispatch: `observeTurnEnd`
    // calls `HookBus.fireObserve` (`hook.kind === "observe"`), and
    // `injectTurnEnd` calls `TropismInjector.inject` in another file
    // (`hook.kind === "inject"`). Neither kind is typed here.
    const seams = parseSeamDispatch(BUS_TS, CONTRACTS_TS, INJECT_TS);
    expect([...seams.get("observeTurnEnd").events]).toEqual([...seams.get("injectTurnEnd").events]);
    expect([...seams.get("observeTurnEnd").kinds]).toEqual(["observe"]);
    expect([...seams.get("injectTurnEnd").kinds]).toEqual(["inject"]);
    // And the direct cases: the lane's own filter, and a seam that inherits the
    // kind from the helper it calls.
    expect([...seams.get("lifecycleObserve").kinds]).toEqual(["lifecycle"]);
    expect([...seams.get("observeToolAudit").kinds]).toEqual(["observe"]);
  });

  it("reports a seam whose dispatch was factored out as underivable, never as dispatching nothing", () => {
    // A slice that yields neither events nor kinds is not an absence — it is
    // something this derivation could not read, which is what factoring a
    // dispatch into an unresolvable helper produces. The gate must say so
    // rather than assert the seam fires nothing, the same false-negative class
    // as the earlier `async` regex reporting `seam_unknown` for a method that
    // existed and was public.
    const seams = parseSeamDispatch(FACTORED_BUS_TS, CONTRACTS_TS, INJECT_TS);
    expect(seams.get("wrapToolPort").events.size).toBe(0);
    expect(seams.get("wrapToolPort").kinds.size).toBe(0);
    // `diagnostics()` is genuinely inert and derives identically; the
    // distinction is not claimed, it is refused.
    expect(seams.get("wrapToolPort").events.size).toBe(seams.get("diagnostics")?.events.size ?? 0);
  });
});

describe("hook-devolution-gate: a seam's LANE is part of what the row claims", () => {
  const TURN_END_ROW = {
    id: "claude-code.pretooluse.git-write-guard",
    event: "PreToolUse",
    source: "scripts/hooks/git-write-guard.sh",
    status: "devolved",
    handler_ref: "inject.turn-end",
    descriptor: "turn-end",
    seam: "injectTurnEnd",
  };
  const OBSERVE_TURN_END_ROW = { ...TURN_END_ROW, handler_ref: "observe.stop-battery", descriptor: "turn-end-observe", seam: "observeTurnEnd" };

  it("PASSES a `kind: \"inject\"` row naming `injectTurnEnd` — the seam that dispatches `turn_end` for inject", () => {
    withFixture({ ledger: [TURN_END_ROW], catalog: TURN_END_CATALOG_TS, materialized: ["turn-end@1.0.0.json", "turn-end-observe@1.0.0.json", "git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    });
  });

  it("PASSES a `kind: \"observe\"` row naming `observeTurnEnd` — the seam that dispatches `turn_end` for observe", () => {
    withFixture({ ledger: [OBSERVE_TURN_END_ROW], catalog: TURN_END_CATALOG_TS, materialized: ["turn-end@1.0.0.json", "turn-end-observe@1.0.0.json", "git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    });
  });

  it("FAILS a `kind: \"inject\"` row naming `observeTurnEnd` — the two differ ONLY in kind", () => {
    // `observeTurnEnd` dispatches `turn_end`, `injectTurnEnd` dispatches
    // `turn_end`, both are public methods of `HookBus`, and `turn_end` is in
    // both event sets. Every set-membership test this gate ran before was
    // satisfied by this row: check (d) names a real method, the descriptor is in
    // `DEFAULT_HOOK_SET`, and the event matches. At runtime `fireObserve`
    // filters `hook.kind === "observe"` and this descriptor is `inject`, so the
    // handler is never reached — the row describes three true halves and a
    // claim that is false.
    withFixture({ ledger: [{ ...TURN_END_ROW, seam: "observeTurnEnd" }], catalog: TURN_END_CATALOG_TS }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("seam_does_not_dispatch_kind");
      expect(out).toContain("observeTurnEnd");
      expect(out).toContain("`inject`");
      expect(out).toContain("`observe`");
      expect(out).toContain("Remedy:");
    });
  });

  it("FAILS a `kind: \"observe\"` row naming `injectTurnEnd` — the symmetric case", () => {
    withFixture({ ledger: [{ ...OBSERVE_TURN_END_ROW, seam: "injectTurnEnd" }], catalog: TURN_END_CATALOG_TS }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("seam_does_not_dispatch_kind");
      expect(out).toContain("injectTurnEnd");
      expect(out).toContain("`observe`");
      expect(out).toContain("`inject`");
      expect(out).toContain("Remedy:");
    });
  });

  it("REPORTS a factored seam as underivable rather than asserting it dispatches nothing", () => {
    // The other defect in the same derivation: the event set went empty because
    // the dispatch moved into a helper this walk cannot follow, and the finding
    // said the seam "dispatches no hook event" — blaming the seam for a
    // factoring decision it did not make. It still BLOCKS, because a devolved
    // claim the gate cannot verify is not a certified claim; what it stops
    // doing is assert an absence it never observed.
    withFixture({ ledger: [DEVOLVED_ROW], bus: FACTORED_BUS_TS }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("seam_dispatch_underivable");
      expect(out).not.toContain("dispatches no hook event");
      expect(out).toContain("not a finding that the seam dispatches nothing");
      expect(out).toContain("Remedy:");
    });
  });
});

describe("hook-devolution-gate: a devolved hook must be proven, not asserted", () => {
  it("PASSES when the handler exists, the descriptor activates it, and the seam dispatches it", () => {
    withFixture({ ledger: [DEVOLVED_ROW], materialized: ["git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    });
  });

  it("FAILS a devolved row whose descriptor no DEFAULT_HOOK_SET entry names — the exact 2026-09-30 incident", () => {
    // A native handler registered in handlers.ts, a descriptor nobody ships,
    // and a ledger row claiming `devolved`. Three vacuous greens let this ship
    // once; this is the case that must never pass again.
    withFixture({ ledger: [{ ...DEVOLVED_ROW, descriptor: "not-in-default-set" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("devolved but no descriptor activates it");
      expect(out).toContain("Remedy:");
    });
  });

  it("FAILS a devolved row whose handler_ref is not in the closed registry", () => {
    withFixture({ ledger: [{ ...DEVOLVED_ROW, handler_ref: "veto.never-written" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("is not a key in the closed HOOK_HANDLERS registry");
    });
  });

  it("FAILS a devolved row missing handler_ref/descriptor/seam, naming which field", () => {
    for (const field of ["handler_ref", "descriptor", "seam"]) {
      withFixture({ ledger: [{ ...DEVOLVED_ROW, [field]: null }] }, (root) => {
        const { code, out } = runGate(root);
        expect(code, `dropping ${field} must fail`).not.toBe(0);
        expect(out).toContain(field);
        expect(out).toContain("Remedy:");
      });
    }
  });

  it("FAILS a row whose seam names a method HookBus does not have", () => {
    withFixture({ ledger: [{ ...DEVOLVED_ROW, seam: "wrapToolPortAndTea" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("wrapToolPortAndTea");
    });
  });

  it("FAILS a devolved row whose handler_ref is a REAL registry key the descriptor does not bind", () => {
    // Checks (a), (c) and (d) are all satisfied here: `observe.tool-audit-notes`
    // IS a key in the closed registry, `git-write-guard` IS in
    // DEFAULT_HOOK_SET, and `wrapToolPort` IS a public HookBus method. What is
    // false is the only thing that matters — that descriptor binds
    // `veto.git-write-guard`, not this row's handler, so the row's three halves
    // describe THREE DIFFERENT hooks and the certified claim is about none of
    // them. Independent set membership cannot see that; this is the same F1
    // shape one level down.
    withFixture({ ledger: [{ ...DEVOLVED_ROW, handler_ref: "observe.tool-audit-notes" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("descriptor_handler_mismatch");
      expect(out).toContain("observe.tool-audit-notes");
      expect(out).toContain("veto.git-write-guard");
      expect(out).toContain("Remedy:");
    });
  });

  it("FAILS a devolved row whose seam is a real HookBus method that dispatches a DIFFERENT event", () => {
    // `observeToolAudit` is a genuine public seam, so check (d) is satisfied —
    // and it dispatches `tool_audit`, never the `tool_preflight` this
    // descriptor is bound to. A seam that exists is not a seam that fires this
    // handler: naming it is exactly how a handler nothing dispatches gets
    // certified green.
    withFixture({ ledger: [{ ...DEVOLVED_ROW, seam: "observeToolAudit" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("seam_does_not_dispatch_event");
      expect(out).toContain("tool_preflight");
      expect(out).toContain("observeToolAudit");
      expect(out).toContain("Remedy:");
    });
  });
});

describe("hook-devolution-gate: a deleted hook is the defect, not a pass", () => {
  it("FAILS a registration whose script was deleted and whose row claims no native replacement", () => {
    // The literal case: the script is gone from disk, the host still runs it,
    // and the ledger admits there is no replacement. Nothing else in this
    // repository notices — deleting a hook removes it from the liveness
    // manifest, so `gate:hook-liveness` stays green.
    withFixture({ ledger: [{ ...DEVOLVED_ROW, status: "pending_activation", handler_ref: null, descriptor: null, seam: null, reason: "no native replacement written yet" }], liveScripts: [] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("registered but its script does not exist on disk");
      expect(out).toContain("git checkout HEAD -- scripts/hooks/git-write-guard.sh");
    });
  });

  it("FAILS a registration with no ledger row at all", () => {
    withFixture({ ledger: [] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("is a live registration with no row in scripts/hook-devolution.json");
      expect(out).toContain("Remedy:");
    });
  });

  it("FAILS a row that is `retained` while its hook is still a live registration", () => {
    // The operator's ruling is zero retentions. `retained` is only legible on
    // something that is not registered, and this gate is what stops the word
    // from being used as a quiet third option.
    withFixture({ ledger: [{ ...DEVOLVED_ROW, status: "retained", handler_ref: null, descriptor: null, seam: null, reason: "still useful" }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("retained");
      expect(out).toContain("zero retentions");
    });
  });

  it("ALLOWS `retained` on a row whose hook is not a live registration", () => {
    withFixture({
      ledger: [DEVOLVED_ROW, { id: "claude-code.sessionstart.retired-thing", event: "SessionStart", source: "scripts/hooks/retired-thing.sh", status: "retained", handler_ref: null, descriptor: null, seam: null, reason: "not a live registration; kept for the record" }],
    }, (root) => {
      const { code, out } = runGate(root);
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    });
  });

  it("FAILS a non-devolved row with no reason — a status without a reason is a shrug", () => {
    withFixture({ ledger: [{ ...DEVOLVED_ROW, status: "pending_activation", reason: "   " }] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("requires a non-empty reason");
    });
  });
});

describe("hook-devolution-gate: fails closed, and reports drift without blocking", () => {
  it("PASSES the programme's TERMINAL state — no host hook registered, every ledger row devolved", () => {
    // The zero-registration state is the operator's ruling made real: every
    // registered host hook ends devolved-and-deleted or replaced by a native
    // equivalent. A gate that failed here could never go green, which is the
    // mirror of the vacuous green this gate exists to end — a check that can
    // never PASS, reported forever as if it were a finding.
    //
    // So it PASSES, and it says so in the output rather than going quiet: the
    // invariant is vacuous for registrations, and what remains certified is
    // that every devolved row's three halves still resolve.
    withFixture({ ledger: [DEVOLVED_ROW], settings: null, hostControls: null, materialized: ["git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).toBe(0);
      expect(out).toContain("0 live registration(s)");
      expect(out).toContain("0 registered-and-pending");
      expect(out).toContain("PASS");
    });
  });

  it("STILL FAILS CLOSED in the empty state when a ledger row is not devolved", () => {
    // The rule that replaces "empty walk ⇒ fail", and it is one only this
    // state can reach. With nothing registered there is no registration left
    // to activate and none to create, so a row still marked pending is a
    // devolution permanently owed and permanently invisible — the
    // inert-handler defect in its final form.
    withFixture({
      ledger: [{ ...DEVOLVED_ROW, status: "pending_activation", reason: "no native replacement activated yet" }],
      settings: null, hostControls: null, materialized: ["git-write-guard@1.0.0.json"],
    }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("unactivated_after_devolution");
      expect(out).toContain("nothing would ever report it");
    });
  });

  it("STILL FAILS CLOSED when a registration source cannot be parsed", () => {
    // Trustworthiness of the walk is enforced separately from its emptiness: a
    // source that is present but unreadable is a broken walk, and must never
    // read as an empty one.
    withFixture({ ledger: [DEVOLVED_ROW], settings: "{ not json", materialized: ["git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("could not be read");
    });
  });

  it("FAILS when the ledger itself is absent", () => {
    withFixture({ ledger: null, materialized: ["git-write-guard@1.0.0.json"] }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("no scripts/hook-devolution.json");
    });
  });

  it("FAILS when a registration source exists but cannot be parsed", () => {
    withFixture({ ledger: [DEVOLVED_ROW], hostControls: "{ not json" }, (root) => {
      const { code, out } = runGate(root);
      expect(code).not.toBe(0);
      expect(out).toContain("could not be read");
    });
  });

  it("REPORTS an unactivated-but-shipped descriptor as drift WITHOUT blocking — `.arbor/` is per-clone local", () => {
    withFixture({ ledger: [DEVOLVED_ROW] }, (root) => {
      const { code, out } = runGate(root);
      expect(out).toContain("REPORTED-WITH-REMEDY");
      expect(out).toContain("project repair");
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    });
  });
});

describe("hook-devolution-gate: the real repository", () => {
  it("is green on the real tree, and reports the four unactivated native handlers as debt rather than as a pass", () => {
    // The real tree is the only place the seeded ledger's honesty is checked.
    // If this ever goes red, the ledger and the source have diverged — which is
    // the whole point of the artifact.
    const { code, out } = runGate(REPO_ROOT);
    expect(out).toContain("observed_count:");
    expect(code).toBe(0);
  });
});
