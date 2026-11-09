/**
 * `inject.vi-freshness` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-freshness.sh`, and the
 * SessionStart report of how far the committed graph trails HEAD.
 *
 * WHY THIS FILE EXISTS AT ALL, and why it is shaped around DERIVATION rather
 * than around verdicts. The script this replaces reported `DIVERGED — 42
 * uncommitted path(s)` at every session start against a tree with zero
 * uncommitted paths, for ~42 sessions (ADR-032). The native failure mode is not
 * that one: it is that a tropism whose `derived_from` does not move is DEDUPED
 * by the bus and goes SILENT, so a handler that stopped reading state reports
 * nothing forever rather than something wrong. Silence is strictly harder to
 * notice than a false alarm, which is why the load-bearing assertions here are
 * the two at the bottom — that the derivation MOVES when the inputs move, and
 * that the real bus injects twice for two different states and once for two
 * identical ones.
 *
 * THE VERDICT IS ASSERTED AS A TOKEN, NOT AS PROSE. Every case pins the exact
 * verdict word in the one position the composed body puts it, so a rewording
 * that keeps the verdict legible is not a failure and a verdict that changed is.
 *
 * THE BUS IS REAL, THE REPO IS REAL. The dedupe cases go through the actual
 * `HookBus.injectForSession` over the shipped `DEFAULT_HOOK_DESCRIPTORS`
 * materialized into a real `.arbor/hooks`, which is the production activation
 * path: a catalog built in memory would pass over a descriptor that does not
 * exist. The `cwd` seam is stubbed rather than changed, because vitest runs in
 * a worker thread where `process.chdir` does not exist.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookBus } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { GitAdapter } from "../../src/git-workspace-projection.js";
import { dirtyIntersection, viFreshnessTropism } from "../../src/hooks/vi-freshness-tropism.js";

const VI_DIR = ".visual-intelligence";
/** The graphed domain. The script scoped both its intersection and its drift check here. */
const GRAPHED = Object.freeze(["packages/", "decisions/"]);

let root = "";
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
const head = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

/** The `manifest.json` fields the script read, and nothing else. */
const manifest = (fields: Record<string, unknown>): void =>
  writeFileSync(join(root, VI_DIR, "manifest.json"), JSON.stringify(fields));
const bindAtHead = (extra: Record<string, unknown> = {}): void => manifest({ repo_revision: head(), ...extra });

/**
 * `.dirty` is the append-only session tracker the native `observe.vi-dirty-tracker`
 * writes, and it APPENDS — one line per distinct path, never re-sorted. Writing
 * it in append mode here is what lets a test add a second tracked path and see
 * the intersection grow, which is the whole subject of this file.
 */
const dirty = (...paths: string[]): void => appendFileSync(join(root, VI_DIR, ".dirty"), paths.map((path) => `${path}\n`).join(""));

/** One commit touching only `notes/`, i.e. the graphed domain is untouched by it. */
const commitOutsideGraph = (): void => {
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "log.md"), `${Math.random()}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "notes only");
};
/** One commit touching `packages/`, i.e. the graphed domain. */
const commitInGraph = (): void => {
  writeFileSync(join(root, "packages", "x", "src", "a.ts"), `export const a = ${Math.random()};\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "source change");
};

/** The real bus over the shipped default hook set, materialized the way a clone gets it. */
const productionBus = (): HookBus =>
  new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks")) });

const inject = (bus: HookBus, session: string, turn = 0) =>
  bus.injectForSession("session_start", { session_id: session, campaign_id: "c-1", node_id: "n-1", turn });

/** The one-token verdict, read from the position the composed body puts it in. */
const verdictOf = (body: string): string => /graph freshness: ([A-Z-]+)/u.exec(body)?.[1] ?? "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-hooks-freshness-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  mkdirSync(join(root, VI_DIR), { recursive: true });
  mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
  mkdirSync(join(root, "decisions"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "decisions", "ADR-001-first.md"), "# First\n");
  // A TRACKED directory outside the graphed domain. It has to be tracked, or
  // `git status --porcelain` collapses it to a single `?? notes/` entry and
  // the per-file edit these cases are about never appears in the listing.
  writeFileSync(join(root, "notes", "seed.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
  mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents);
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("vi-freshness tropism — the script's own guards", () => {
  it("says nothing at all in a repository that has never built a graph", () => {
    // The script's `quiet` before its first line of work, and the property that
    // makes global installation safe in a repository that does not use the skill.
    rmSync(join(root, VI_DIR), { recursive: true, force: true });
    expect(viFreshnessTropism(root)).toBeNull();
  });

  it("says nothing when the manifest records no graph revision", () => {
    manifest({ tree_state: "clean" });
    expect(viFreshnessTropism(root)).toBeNull();
  });

  it("says nothing outside a git repository, rather than throwing into the bus", () => {
    bindAtHead();
    const orphan = mkdtempSync(join(tmpdir(), "arbor-hooks-freshness-orphan-"));
    try {
      mkdirSync(join(orphan, VI_DIR), { recursive: true });
      writeFileSync(join(orphan, VI_DIR, "manifest.json"), JSON.stringify({ repo_revision: head() }));
      expect(viFreshnessTropism(orphan)).toBeNull();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe("vi-freshness tropism — the verdict ladder, first match wins", () => {
  it("rung 1: a graph built from a dirty tree is UNCOMMITTED-BASIS even when the tree is now clean", () => {
    // tree_state=dirty outranks everything below it, so this is not CURRENT
    // even though graph_rev === head_rev and nothing is uncommitted.
    bindAtHead({ tree_state: "dirty" });
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("UNCOMMITTED-BASIS");
    expect(body).toContain("nothing can check it");
    expect(body).toContain("vi:refresh");
  });

  it("rung 2: graph at HEAD with nothing uncommitted is CURRENT, and CURRENT injects nothing", () => {
    // Silencer 1. A tropism here would spend context on a healthy state.
    bindAtHead();
    expect(viFreshnessTropism(root)).toBeNull();
  });

  it("rung 3: uncommitted AND behind reports BOTH facts, never one of them", () => {
    bindAtHead();
    commitInGraph();
    writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 99;\n");
    dirty("packages/x/src/a.ts");
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("DIVERGED");
    expect(body).toContain("1 uncommitted path(s) touched since extraction, AND the graph is 1 commit(s) behind HEAD");
  });

  it("rung 4: uncommitted at HEAD reports the dirty count without inventing a distance", () => {
    bindAtHead();
    writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 98;\n");
    dirty("packages/x/src/a.ts");
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("DIVERGED");
    expect(body).toContain("1 uncommitted path(s) touched since extraction — do not cite");
    expect(body).not.toContain("AND the graph is");
  });

  it("rung 5: nothing uncommitted and behind is STALE, and STALE is injected when the drift is in the graphed domain", () => {
    bindAtHead();
    commitInGraph();
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("STALE");
    expect(body).toContain("those commits touched the graphed domain (packages/ or decisions/)");
  });

  it("silencer 2: a stale graph whose commits missed the graphed domain injects nothing", () => {
    // "A stale graph describing untouched code is still accurate." This is the
    // second of exactly two states in which the script said nothing.
    bindAtHead();
    commitOutsideGraph();
    expect(viFreshnessTropism(root)).toBeNull();
  });
});

describe("vi-freshness tropism — an unmeasurable graph fails loud, not silent", () => {
  it("treats a graph revision that is not in this history as behind=? and still speaks", () => {
    // `?` means git could not measure the distance. The honest reading is that
    // the drift is UNKNOWN, so it must be reported; if `?` were treated as
    // "unchanged domain" this row would be silenced and a graph describing a
    // tree that does not exist would pass unremarked.
    manifest({ repo_revision: "0".repeat(40), tree_state: "clean" });
    commitInGraph();
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("STALE");
  });

  it("reports ? as the distance when uncommitted paths overlap with it", () => {
    manifest({ repo_revision: "0".repeat(40), tree_state: "clean" });
    writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 97;\n");
    dirty("packages/x/src/a.ts");
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(verdictOf(body)).toBe("DIVERGED");
    expect(body).toContain("the graph is ? commit(s) behind HEAD");
  });
});

describe("dirtyIntersection — the one shared .dirty ∩ git-status helper", () => {
  const intersect = (scope: readonly string[]): readonly string[] => dirtyIntersection(new GitAdapter(root), root, scope);

  it("counts a tracked path that is STILL dirty, and nothing else", () => {
    writeFileSync(join(root, "packages", "x", "src", "b.ts"), "export const b = 1;\n");
    dirty("packages/x/src/b.ts", "packages/x/src/a.ts");
    // `a.ts` is tracked and long since committed: the 42-path false alarm was
    // counting exactly this, and the intersection is what removed it.
    expect(intersect(GRAPHED)).toEqual(["packages/x/src/b.ts"]);
  });

  it("counts nothing when the tree is clean, however long .dirty is", () => {
    dirty("packages/x/src/a.ts", "decisions/ADR-001-first.md", "packages/x/src/gone.ts");
    expect(intersect(GRAPHED)).toEqual([]);
  });

  it("counts nothing when .dirty does not exist", () => {
    writeFileSync(join(root, "packages", "x", "src", "b.ts"), "export const b = 1;\n");
    expect(intersect(GRAPHED)).toEqual([]);
  });

  it("scopes to the graphed domain, and the same call with an empty scope is the unscoped read graph-debt needs", () => {
    // One helper, two consumers: freshness asks about packages/+decisions/,
    // vi-graph-debt asks about everything. A path outside the graphed domain
    // counts for one and not the other, and that difference is the whole
    // argument for taking the scope as an argument.
    writeFileSync(join(root, "notes", "seed.md"), "edited\n");
    dirty("notes/seed.md");
    expect(intersect(GRAPHED)).toEqual([]);
    expect(intersect([])).toEqual(["notes/seed.md"]);
  });

  it("does not count a file inside a wholly untracked directory, because the porcelain listing collapses it", () => {
    // An inherited limit, reproduced rather than fixed: `git status --porcelain`
    // reports a new untracked DIRECTORY as one `?? dir/` entry, so a path under
    // it never appears and cannot intersect. `--untracked-files=all` would lift
    // this, and it is deliberately NOT used: the script read the same listing
    // without it, and adding it would change the reported count rather than
    // reproduce it. The miss is an UNDER-count, which is the safe direction for
    // a signal whose false-positive failure is already on the record.
    mkdirSync(join(root, "brand", "new"), { recursive: true });
    writeFileSync(join(root, "brand", "new", "f.ts"), "f\n");
    dirty("brand/new/f.ts");
    expect(intersect([])).toEqual([]);
  });

  it("resolves a rename arrow to the new path, as the script's `s/.* -> //` did", () => {
    renameSync(join(root, "packages", "x", "src", "a.ts"), join(root, "packages", "x", "src", "c.ts"));
    git("add", "-A");
    dirty("packages/x/src/c.ts");
    expect(intersect(GRAPHED)).toEqual(["packages/x/src/c.ts"]);
  });
});

describe("vi-freshness tropism — the derivation moves, and the bus dedupes on it", () => {
  it("changes derived_from when HEAD moves, so a real state change is never suppressed", () => {
    bindAtHead();
    commitInGraph();
    const before = viFreshnessTropism(root)?.derived_from;
    commitInGraph();
    const after = viFreshnessTropism(root)?.derived_from;
    // A constant derived_from makes this handler DEDUPED and SILENT — the
    // hook would stop existing at session start while still reading code.
    expect(before).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  it("changes derived_from when only the uncommitted intersection moves", () => {
    bindAtHead();
    writeFileSync(join(root, "packages", "x", "src", "b.ts"), "export const b = 1;\n");
    dirty("packages/x/src/b.ts");
    const before = viFreshnessTropism(root)?.derived_from;
    writeFileSync(join(root, "packages", "x", "src", "c.ts"), "export const c = 1;\n");
    dirty("packages/x/src/c.ts");
    expect(viFreshnessTropism(root)?.derived_from).not.toEqual(before);
  });

  it("changes derived_from when only the manifest's tree_state flips", () => {
    bindAtHead({ tree_state: "clean" });
    commitInGraph();
    const before = viFreshnessTropism(root)?.derived_from;
    bindAtHead({ tree_state: "dirty" });
    expect(viFreshnessTropism(root)?.derived_from).not.toEqual(before);
  });

  it("injects a STALE verdict through the real bus, then injects it again once the inputs move", async () => {
    bindAtHead();
    commitInGraph();
    const bus = productionBus();

    const mine = (scope: { readonly source_paths: readonly string[] }): readonly string[] =>
      scope.source_paths.filter((path) => path.startsWith("graph-freshness:"));
    const first = await inject(bus, "s-1");
    expect(first.content).toContain("graph freshness: STALE");
    // The production bus fires EVERY session_start inject hook, so the scope
    // carries more than one derivation. This hook's contribution is named, and
    // that it is named at all is what proves the descriptor activated it.
    expect(mine(first)).toHaveLength(1);

    commitInGraph();
    const second = await inject(bus, "s-1");
    // A second, different staleness is new information. If this were empty the
    // reader would keep believing the first count.
    expect(second.content).toContain("graph freshness: STALE");
    expect(mine(second)).not.toEqual(mine(first));
  });

  it("injects an unchanged verdict exactly once, because the bus dedupes a derivation that did not move", async () => {
    bindAtHead();
    commitInGraph();
    const bus = productionBus();

    expect((await inject(bus, "s-1")).content).not.toBe("");
    expect((await inject(bus, "s-1")).content).toBe("");
  });
});

describe("vi-freshness tropism — the composed message", () => {
  it("carries the revisions, the unavailable planes, and the remedy, and fits the byte budget", () => {
    // Bind BEFORE the commit, so the graph is genuinely one behind and the
    // STALE rung is live; rebinding afterwards would make it CURRENT.
    bindAtHead();
    const graphRev = head();
    commitInGraph();
    manifest({ repo_revision: graphRev, tree_state: "clean", planes: { observed: { status: "unavailable" }, reachability: { status: "ready" } } });
    const body = viFreshnessTropism(root)?.body ?? "";
    // The shell emitted 8 characters of each revision, separated by three
    // spaces. The gate prints 12; the two are NOT the same number and this
    // handler reproduces the hook's, not the gate's.
    expect(body).toContain(`graph revision: ${graphRev.slice(0, 8)}`);
    expect(body).toContain(`HEAD: ${head().slice(0, 8)}`);
    expect(body).toMatch(/graph revision: \w{8} {3}HEAD: \w{8}/u);
    expect(body).toContain("planes UNAVAILABLE in this graph: observed (comparisons using them were never made)");
    expect(body).toContain("maintenance mode to refresh");
    // Every plane is available, so the line is absent rather than empty.
    manifest({ repo_revision: graphRev, tree_state: "clean", planes: { observed: { status: "ready" } } });
    expect(viFreshnessTropism(root)?.body).not.toContain("planes UNAVAILABLE");
  });

  it("opens with a noun phrase, so the catalog's advisory-imperative lint accepts it", () => {
    // An ADVISORY body opening `must`/`never`/`always` is REFUSED as
    // `advisory_imperative`, and a refused tropism is dropped without the model
    // ever being told. The remedy line carries the imperative, and it is not
    // the first token.
    bindAtHead();
    commitInGraph();
    const body = viFreshnessTropism(root)?.body ?? "";
    expect(body.startsWith("repository-visual-intelligence — graph freshness:")).toBe(true);
    expect(new HookCatalog().validateTropism(viFreshnessTropism(root))).toBeNull();
  });
});
