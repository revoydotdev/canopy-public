/**
 * The devolution LANE statement.
 *
 * `scripts/hook-devolution.json` certifies, per row, that the descriptor, the
 * native handler and a public `HookBus` seam are the SAME hook. It says nothing
 * about WHICH composition root builds the worker that calls the seam — which is
 * how 13 of its 16 rows shipped inert on the `opencode` campaign lane: every
 * row named a real seam, the gate went green, and `ARBOR_HARNESS_INTEGRATION=opencode`
 * dispatched a specialist through `createNativeLoopExecutor`, which carried no
 * bus at all. `observed_count: 16` was a LEDGER statement being read as a LANE
 * statement.
 *
 * So this file is the lane statement, and it is the check the gate cannot be: it
 * drives the `opencode` lane's real composition root through a real `HookBus`
 * loaded from the real `DEFAULT_HOOK_DESCRIPTORS` over a real git repository,
 * and then requires every devolved row to be classified against every live
 * lane. A classification is one of:
 *
 *   - reached here, witnessed by an observed firing;
 *   - reached elsewhere, certified by the named test that owns it;
 *   - unreachable on that lane, WITH the structural reason recorded inline.
 *
 * A new row without a classification is RED. An unwired seam is RED. A seam
 * claimed unreachable while a firing is observed for it is RED. A structural
 * impossibility that nobody wrote down stops being expressible.
 *
 * The refusals recorded below are properties of the `opencode` lane's SHAPE,
 * stated once here rather than argued at each call site:
 * `createNativeLoopExecutor` supervises a subordinate connector that owns its own
 * tools and runs exactly one model turn per dispatch (`max_turns: 1`,
 * `tool_allow: []`, and a model port that never returns a tool call). Revoy2
 * therefore holds no tool port to veto and no second turn to refuse or advise.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopExecutor } from "@arbor/opencode";
import { describe, expect, it, vi } from "vitest";
import { HookBus, type HookFiredRecord } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { createNativeLoopExecutor } from "../../src/native-loop-executor.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface DevolutionRow {
  readonly id: string;
  readonly status: string;
  readonly handler_ref: string;
  readonly descriptor: string;
  readonly seam: string;
}

const devolvedRows = (): readonly DevolutionRow[] => {
  const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "hook-devolution.json"), "utf8")) as { readonly hooks: readonly DevolutionRow[] };
  return ledger.hooks.filter((row) => row.status === "devolved");
};

/**
 * Seams the `opencode` lane's composition root reaches. The drive below
 * witnesses every one of them; a name here that stops firing is the regression
 * this file exists to catch.
 */
const OPENCODE_LANE_REACHED: ReadonlySet<string> = new Set(["injectForSession", "lifecycleObserve", "observeTurnEnd"]);

/**
 * Seams the `opencode` lane's composition root cannot reach, and why. Each
 * reason is a property of the composition rather than of a missing line: every
 * one of these is reached by the native lane today.
 */
const OPENCODE_LANE_UNREACHABLE: Readonly<Record<string, string>> = {
  wrapToolPort: "the supervised worker exposes no tool port to wrap: its policy carries `tool_allow: []`, its profile `allowed_tools: []`, and its model port never returns a tool call, because the git writes happen inside the subordinate `opencode` process that revoy2 supervises rather than performs",
  wrapToolPortWithAudit: "the same absence of a tool port as `wrapToolPort`, so there is no port whose post-execution audit could be wrapped either",
  injectTurnEnd: "an injected turn scope belongs to the NEXT turn's prompt and this lane runs exactly one model turn per connector dispatch (`max_turns: 1`), so the handler's product would be computed and then dropped: a live bus and a dead lane",
  turn_gate: "not a bus seam but the worker's own refusal, offered only while `turn < max_turns`; with one turn per dispatch a refusal could not re-prompt inside the turn, so honouring it would mean re-dispatching the whole connector from scratch at double cost, which is a different guarantee from the one the native lane makes",
};

/** Seams the native lane root reaches, and the test that certifies each. */
const NATIVE_LANE_CERTIFIED_BY: Readonly<Record<string, string>> = {
  wrapToolPort: "packages/arbor-mcp/tests/hooks/e2e.test.ts",
  wrapToolPortWithAudit: "packages/arbor-mcp/tests/hooks/e2e.test.ts",
  injectForSession: "packages/arbor-mcp/tests/hooks/e2e.test.ts",
  lifecycleObserve: "packages/arbor-mcp/tests/hooks/e2e.test.ts",
  observeTurnEnd: "packages/arbor-mcp/tests/hooks/turn-end.test.ts",
  injectTurnEnd: "packages/arbor-mcp/tests/hooks/turn-inject-lane.test.ts",
};

/**
 * Drive one real specialist dispatch through the `opencode` lane's production
 * composition — the bus-carrying executor plus the `session_end` observer
 * `cli.ts` passes it; neither object is invented for the test — over a real
 * temporary git repository and the real shipped descriptor set, and report what
 * the bus actually recorded.
 */
const driveOpencodeLane = async (): Promise<{ readonly dispatched: string; readonly ledger: readonly HookFiredRecord[] }> => {
  const root = mkdtempSync(join(tmpdir(), "arbor-opencode-lane-hooks-"));
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }) };
  // The battery costs ~30 s of real gate work. Its own documented escape hatch
  // keeps the handler REACHED -- the firing row is still written -- while the
  // measurement stands down; what this lane's coverage is asserted on is the
  // reach, not the verdict. The inject handlers resolve the governed root per
  // firing through `currentGovernedRoot()`, and vitest runs in a worker thread
  // where `process.chdir` does not exist, so the cwd seam is stubbed instead.
  vi.stubEnv("ARBOR_SKIP_STOP_GATES", "1");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    mkdirSync(join(root, "decisions"), { recursive: true });
    mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
    writeFileSync(join(root, "decisions", "ADR-999-test.md"), "# A proposed record\n\n**Status:** Proposed\n\nRationale.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents);
    // The real loading call `native-executor-composition.ts` makes at runtime,
    // over the real shipped descriptor set -- never an in-memory catalog, which
    // is what made registration-not-activation invisible in the first place.
    const bus = new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks")) });
    let dispatched = "";
    const downstream: LoopExecutor = {
      async specialize(params) {
        dispatched = params.prompt;
        return { output: "changed files", provenance: { tag: "claimed", claimant: "seed" }, token_usage: { kind: "unavailable", reason: "fixture" } };
      },
      async review() { throw new Error("unused"); },
    };
    const executor = createNativeLoopExecutor({
      downstream,
      hook_bus: bus,
      on_session: (record) => { bus.lifecycleObserve("session_end", { session_id: record.inspection.session_id, campaign_id: record.campaign_id, node_id: record.node_id }); },
    });
    const result = await executor.specialize({
      campaign_id: "c-1", node_id: "n-1", action: { description: "task", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" },
      prompt: "implement", worktree_path: join(root, "wt"), specialist_agent: "seed",
    });
    expect(result.error).toBeUndefined();
    return { dispatched, ledger: bus.ledger() };
  } finally {
    cwd.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
};

describe("the opencode campaign lane carries the hook bus", () => {
  it("fires every session_start inject a devolved row claims, and puts their text in the connector's prompt", async () => {
    const { dispatched, ledger } = await driveOpencodeLane();

    // Reach is asserted on the descriptors that fired, never on the prose a
    // handler's tropism body is worded with, and not on each one having
    // something to SAY: `null` is a handler's own verdict ("quiet") and is
    // still a firing.
    const fired = ledger.filter((row) => row.kind === "inject" && row.event === "session_start").map((row) => row.hook_id);
    expect(fired).toEqual(expect.arrayContaining([
      "session-governance-orient", "session-isolation-report", "session-owed-decisions",
      "session-graph-freshness", "repo-session-open", "session-operator-decision-queue",
    ]));
    expect(ledger.filter((row) => row.evidence_ref.includes("refused="))).toEqual([]);
    // The claim is that the text REACHES A MODEL. This lane's model is the
    // connector, so the prompt it receives is the only place the reach can be
    // asserted — and what is asserted is the trust-label frame, not the prose.
    expect(dispatched).toContain('<tropisms instruction-authority="context-only">');
  });

  it("reaches the turn_end observe seam, so the battery measures on this lane too", async () => {
    const { ledger } = await driveOpencodeLane();

    expect(ledger.map((row) => `${row.event}:${row.hook_id}`)).toContain("turn_end:stop-battery");
  });

  it("reaches the session_end lifecycle seam the composition root already wired", async () => {
    const { ledger } = await driveOpencodeLane();

    expect(ledger.map((row) => `${row.event}:${row.hook_id}`)).toContain("session_end:repo-session-end");
  });

  it("reaches no tool_preflight seam, because this lane dispatches no tool call to veto", async () => {
    const { ledger } = await driveOpencodeLane();

    // An observed absence, not a comment: the three vetoes and the `.dirty`
    // tracker are devolved rows whose ONLY seam is a wrapped tool port, and this
    // composition has none. A change that gave this lane a tool port without
    // wiring the bus fails the classification test below; it does not pass
    // quietly.
    expect(ledger.filter((row) => row.event === "tool_preflight" || row.event === "tool_write")).toEqual([]);
  });

  it("reaches no turn_end inject seam, because one turn has no next turn to carry the text", async () => {
    const { ledger } = await driveOpencodeLane();

    expect(ledger.filter((row) => row.event === "turn_end" && row.kind === "inject")).toEqual([]);
  });
});

describe("every devolved row is classified against every live composition root", () => {
  const rows = devolvedRows();
  const classifiedSeams = new Set([...OPENCODE_LANE_REACHED, ...Object.keys(OPENCODE_LANE_UNREACHABLE)]);

  it("reads the devolved ledger from disk", () => {
    expect(rows.length).toBeGreaterThanOrEqual(16);
  });

  it("classifies every devolved row on the opencode lane as reached or structurally unreachable", () => {
    expect(rows.filter((row) => !classifiedSeams.has(row.seam)).map((row) => `${row.id} (seam ${row.seam})`)).toEqual([]);
  });

  it("classifies every devolved row on the native lane, which owns no unreachable seam", () => {
    expect(rows.filter((row) => !(row.seam in NATIVE_LANE_CERTIFIED_BY)).map((row) => `${row.id} (seam ${row.seam})`)).toEqual([]);
  });

  it("records a reason for every seam the opencode lane claims it cannot reach", () => {
    for (const [seam, reason] of Object.entries(OPENCODE_LANE_UNREACHABLE)) {
      expect(reason.length, `seam ${seam} is claimed unreachable with no recorded reason`).toBeGreaterThan(80);
    }
  });

  it("agrees with the drive: every claimed-reachable row fired, and no other devolved row did", async () => {
    // The classification above is a claim; this is its only witness, and both are
    // asserted from the SAME drive, so a regression in either half is a failure
    // of this one test rather than two files that drift apart.
    const { ledger } = await driveOpencodeLane();
    const fired = new Set(ledger.map((row) => row.hook_id));
    const expected = [...new Set(rows.filter((row) => OPENCODE_LANE_REACHED.has(row.seam)).map((row) => row.descriptor))];
    const forbidden = [...new Set(rows.filter((row) => !OPENCODE_LANE_REACHED.has(row.seam)).map((row) => row.descriptor))];

    expect(expected).toHaveLength(8);
    expect(expected.filter((descriptor) => !fired.has(descriptor))).toEqual([]);
    expect(forbidden.filter((descriptor) => fired.has(descriptor))).toEqual([]);
  });
});
