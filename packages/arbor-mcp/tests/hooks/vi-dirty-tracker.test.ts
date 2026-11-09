/**
 * `observe.vi-dirty-tracker` — the native writer for
 * `.visual-intelligence/.dirty`, the state file the deleted
 * `vi-dirty-track.sh` was the SOLE writer of.
 *
 * WHY THIS FILE IS ENTIRELY ON DISK. `.dirty` has two readers
 * (`inject.vi-freshness`'s `dirty_count`, `inject.vi-graph-debt`'s debt
 * count) and
 * every other gate in this repository reads a verdict, never a side effect. A
 * tracker that stopped writing would leave both readers reporting "clean"
 * forever, which is the exact defect class this devolution exists to stop —
 * and it is invisible to every assertion that checks "the handler was called".
 * So the acceptance criterion here is the FILE: read `.dirty` off disk after a
 * real tool call and assert its bytes.
 *
 * THE CALLS ARE REAL. `file.write` and `file.patch` are the actual
 * `NativeRepositoryToolHost` ports, wrapped by the actual `HookBus` and driven
 * through the actual `preflight` + `execute` a session performs. The catalog is
 * loaded with `HookCatalog.fromDirectory` over the shipped
 * `DEFAULT_HOOK_DESCRIPTORS` materialized into a real `.arbor/hooks`, which is
 * the production activation path — a catalog built in memory could not catch a
 * descriptor that does not exist, and an unregistered handler would leave this
 * file green over a tracker nothing dispatches.
 *
 * The cwd seam is stubbed rather than changed: vitest runs in a worker thread
 * where `process.chdir` does not exist.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeToolPort, NativeToolPreflightResult, NativeToolRequest } from "@arbor/harness";
import { HookBus } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { HOOK_HANDLERS } from "../../src/hooks/handlers.js";
import { HOOK_MAX_DETAIL_VALUE_BYTES, type HookHandlerRegistry, type HookObserveContext } from "../../src/hooks/contracts.js";
import { nativeRepositoryToolPorts, type NativeHighRiskToolScope } from "../../src/native-tool-host.js";

const VI_DIR = ".visual-intelligence";
const DIRTY = ".dirty";
const GENERATED = { tag: "generated", generator: "vi-dirty-tracker-test", input_hash: "fixture" } as const;

let root = "";
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
const dirtyPath = (): string => join(root, VI_DIR, DIRTY);
const dirtyLines = (): readonly string[] => readFileSync(dirtyPath(), "utf8").split("\n").filter((line) => line !== "");
/** `file.write` on an existing file requires the caller's observed content hash, in the host's own `sha256:<hex>` form. */
const sha256 = (contents: string): string => `sha256:${createHash("sha256").update(contents).digest("hex")}`;

/** The shipped default hook set, materialized on disk and loaded the way the composition root loads it. */
const productionBus = (handlers?: HookHandlerRegistry): HookBus =>
  new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks"), handlers === undefined ? {} : { handlers }) });

/** The real `file.write`/`file.patch` port, wrapped by the real bus, scoped the way a composition root scopes it. */
const realPort = (bus: HookBus, tool: string, sessionId: string, writePaths: readonly string[]): NativeToolPort => {
  const scope: NativeHighRiskToolScope = {
    scope_id: "vi-dirty-tracker-scope", campaign_id: "c-1", node_id: "n-1", session_id: sessionId,
    worktree_root: root, provenance: GENERATED, write_paths: writePaths, command_argv: [],
  };
  const ports = nativeRepositoryToolPorts({
    filesystem: "workspace_write",
    workspace_roots: [root],
    resolve_intent: () => ({ purpose: "record the paths this session edited", provenance: GENERATED }),
    resolve_high_risk_scope: () => scope,
  });
  const port = ports.find((candidate) => candidate.tool === tool);
  if (port === undefined) throw new Error(`no real repository port for ${tool}`);
  return bus.wrapToolPort(port);
};

const request = (sessionId: string, input: unknown): NativeToolRequest => Object.freeze({
  session_id: sessionId, turn: 1, call_id: "c-1", input, workspace_roots: [root],
  filesystem: "workspace_write", network_allowed: false, intent_evidence: [],
});

/** Preflight then execute, exactly as the worker does; a refusal is the test's failure, not a branch. */
const dispatch = async (port: NativeToolPort, req: NativeToolRequest): Promise<void> => {
  expect(port.preflight?.(req)).toEqual({ allowed: true });
  const response = await port.execute(req, null, new AbortController().signal);
  expect(response.evidence.outcome).toBe("succeeded");
};

/**
 * A port whose own preflight allows, for the two cases the real host cannot
 * reach: a path outside the workspace is refused by the host before any hook
 * sees it, so the tracker's containment rule is only reachable through a port
 * that admits the call. The rule under test is the HANDLER's, so the handler is
 * what this exercises.
 */
const admittingPort = (tool: string): NativeToolPort => Object.freeze({
  tool,
  preflight: (): NativeToolPreflightResult => ({ allowed: true }),
  execute: (): Promise<never> => Promise.reject(new Error("this test asserts on the preflight seam only")),
});

const CAPTURE_DESCRIPTOR = {
  schema_version: 1, hook_id: "capture-write", version: "1.0.0", kind: "observe", event: "tool_write",
  handler_ref: "observe.capture-write", why: "capture what the tool_write lane carries",
} as const;

/** The shipped default set PLUS a capture handler, so one bus fires both the tracker and the probe. */
const capturingBus = (seen: HookObserveContext[]): HookBus => {
  writeFileSync(join(root, ".arbor", "hooks", `${CAPTURE_DESCRIPTOR.hook_id}@1.0.0.json`), JSON.stringify(CAPTURE_DESCRIPTOR, null, 2));
  const capture: HookHandlerRegistry = {
    "observe.capture-write": { kind: "observe", handler: (context) => { seen.push(context); return { note: "captured" }; } },
  };
  return new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks"), { handlers: { ...HOOK_HANDLERS, ...capture } }) });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-hooks-dirty-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  mkdirSync(join(root, VI_DIR), { recursive: true });
  mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
  mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents);
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("observe.vi-dirty-tracker — the paths land in .dirty on disk", () => {
  it("records a real file.write's repo-relative path", async () => {
    const bus = productionBus();
    const port = realPort(bus, "file.write", "s-1", ["packages/x/src/b.ts"]);

    await dispatch(port, request("s-1", { path: "packages/x/src/b.ts", content: "export const b = 2;\n", create: true }));

    // The write really happened AND the tracker really recorded it: both read
    // off disk, because a tracker that silently stopped writing is precisely
    // the failure this file exists to catch.
    expect(readFileSync(join(root, "packages", "x", "src", "b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(dirtyLines()).toEqual(["packages/x/src/b.ts"]);
  });

  it("records a real file.patch's path the same way", async () => {
    const bus = productionBus();
    const port = realPort(bus, "file.patch", "s-2", ["packages/x/src/a.ts"]);

    await dispatch(port, request("s-2", { path: "packages/x/src/a.ts", expected: "1", replacement: "2" }));

    expect(readFileSync(join(root, "packages", "x", "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(dirtyLines()).toEqual(["packages/x/src/a.ts"]);
  });

  it("appends each distinct path once, in call order, never sorted", async () => {
    const bus = productionBus();
    const writePaths = ["packages/x/src/b.ts", "packages/x/src/c.ts"];
    const port = realPort(bus, "file.write", "s-3", writePaths);

    await dispatch(port, request("s-3", { path: "packages/x/src/b.ts", content: "b\n", create: true }));
    await dispatch(port, request("s-3", { path: "packages/x/src/c.ts", content: "c\n", create: true }));
    // A second write of the SAME path must not add a second line: the readers
    // count lines, so a duplicate is a double-counted path.
    await dispatch(port, request("s-3", { path: "packages/x/src/b.ts", content: "b2\n", expected_sha256: sha256("b\n") }));

    expect(readFileSync(join(root, "packages", "x", "src", "b.ts"), "utf8")).toBe("b2\n");
    expect(dirtyLines()).toEqual(writePaths);
  });

  it("writes nothing at all in a repository that does not use the skill", async () => {
    // The script's own safety property: global installation must be inert
    // outside a repository that has `.visual-intelligence/`. Without this a
    // globally installed tracker would create `.dirty` in every clone.
    rmSync(join(root, VI_DIR), { recursive: true, force: true });
    const bus = productionBus();
    const port = realPort(bus, "file.write", "s-4", ["packages/x/src/b.ts"]);

    await dispatch(port, request("s-4", { path: "packages/x/src/b.ts", content: "b\n", create: true }));

    expect(readFileSync(join(root, "packages", "x", "src", "b.ts"), "utf8")).toBe("b\n");
    expect(() => readFileSync(dirtyPath(), "utf8")).toThrow();
  });
});

describe("observe.vi-dirty-tracker — the graph's own output is not drift", () => {
  it("skips a write under .visual-intelligence/", async () => {
    mkdirSync(join(root, VI_DIR, "graph"), { recursive: true });
    const bus = productionBus();
    const port = realPort(bus, "file.write", "s-5", [`${VI_DIR}/graph/nodes.jsonl`]);

    await dispatch(port, request("s-5", { path: `${VI_DIR}/graph/nodes.jsonl`, content: "{}\n", create: true }));

    expect(readFileSync(join(root, VI_DIR, "graph", "nodes.jsonl"), "utf8")).toBe("{}\n");
    expect(() => readFileSync(dirtyPath(), "utf8")).toThrow();
  });

  it("skips a path that escapes the repository, even by traversal", () => {
    const bus = productionBus();
    const port = bus.wrapToolPort(admittingPort("file.write"));

    // The real host refuses a traversal outright, so the rule is only
    // reachable through a port that admits the call. The direction matters:
    // recording a path outside the repository would put a line in `.dirty`
    // that `git status` can never intersect, which reads as drift forever.
    for (const path of ["../elsewhere.md", "/etc/elsewhere.md", `${VI_DIR}/../../elsewhere.md`]) {
      expect(port.preflight?.(request("s-6", { path, content: "x" }))).toEqual({ allowed: true });
    }
    expect(() => readFileSync(dirtyPath(), "utf8")).toThrow();
  });
});

describe("observe.vi-dirty-tracker — the carried path is redacted and bounded", () => {
  it("carries the redacted form of a secret-shaped path, and never the raw one", () => {
    const seen: HookObserveContext[] = [];
    const port = capturingBus(seen).wrapToolPort(admittingPort("file.write"));

    port.preflight?.(request("s-7", { path: "notes/api_key=sk-live-9f3a2b7c1d8e4f60a5b6c7d8e9f00112.md", content: "x" }));

    const carried = seen.at(-1)?.detail.path ?? "";
    expect(carried).toContain("[REDACTED]");
    expect(carried).not.toContain("sk-live-9f3a2b7c1d8e4f60a5b6c7d8e9f00112");
    // And the file records the redacted form, so a secret-shaped path never
    // reaches a file the operator reads. The secret-suffix is consumed whole by
    // `redactNativeText`, extension included — the tracker records the redacted
    // string verbatim rather than trying to re-attach the tail.
    expect(dirtyLines()).toEqual(["notes/api_key=[REDACTED]"]);
  });

  it("bounds the carried path at the bound the file tools already enforce on their own `path`", () => {
    const seen: HookObserveContext[] = [];
    const port = capturingBus(seen).wrapToolPort(admittingPort("file.write"));
    const path = `${"deep/".repeat(400)}leaf.md`;

    expect(path.length).toBeGreaterThan(HOOK_MAX_DETAIL_VALUE_BYTES);
    port.preflight?.(request("s-8", { path, content: "x" }));

    const carried = seen.at(-1)?.detail.path ?? "";
    expect(carried.length).toBe(HOOK_MAX_DETAIL_VALUE_BYTES);
    // The 1024 is not chosen: it is what `stringField(value, "path", 1, 1_024)`
    // already enforces in native-tool-host, so the bus never truncates a path
    // the tool itself would have accepted.
    expect(HOOK_MAX_DETAIL_VALUE_BYTES).toBe(1_024);
  });

  it("refuses to record a path it cannot prove is whole, rather than recording a truncated one", () => {
    const bus = productionBus();
    const port = bus.wrapToolPort(admittingPort("file.write"));

    // A truncated path in `.dirty` is a line that can never intersect
    // `git status`, so it is drift that reports as permanent cleanliness. The
    // tool itself refuses a `path` this long, so this is the belt to that
    // braces: the tracker drops what it cannot vouch for instead of guessing.
    const atBound = "d".repeat(HOOK_MAX_DETAIL_VALUE_BYTES);
    port.preflight?.(request("s-9", { path: atBound, content: "x" }));

    expect(() => readFileSync(dirtyPath(), "utf8")).toThrow();
  });

  it("records nothing for a tool that writes no file, even when its payload carries a path", () => {
    const bus = productionBus();
    // Fields populate BY TOOL NAME, never by payload key, so a shell command
    // carrying `path` must not be read as a file write.
    const port = bus.wrapToolPort(admittingPort("shell.execute"));

    port.preflight?.(request("s-10", { argv: ["git", "status"], path: "packages/x/src/a.ts" }));

    expect(() => readFileSync(dirtyPath(), "utf8")).toThrow();
  });
});

describe("the shipped default hook set activates the tracker", () => {
  it("ships a descriptor for it, and the registry entry it names is an observe handler", () => {
    const catalog = HookCatalog.fromDirectory(join(root, ".arbor", "hooks"));
    expect(catalog.diagnostics()).toEqual([]);
    expect(catalog.list().map((hook) => hook.handler_ref)).toContain("observe.vi-dirty-tracker");
    expect(new HookCatalog().resolveHandler("observe.vi-dirty-tracker")?.kind).toBe("observe");
  });
});
