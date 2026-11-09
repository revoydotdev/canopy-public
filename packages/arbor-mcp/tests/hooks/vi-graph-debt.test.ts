/**
 * `inject.vi-graph-debt` — the native replacement for the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-graph-debt.sh`, and the
 * per-turn report of graph debt accrued during the session.
 *
 * WHAT IS ASSERTED HERE AND WHY IT IS SHAPED THIS WAY. The shell hook's whole
 * product was prose printed at Stop time and handed to the MODEL, so this file
 * is about the report's CONTENT; the model-facing half — that the text actually
 * reaches a prompt, that §5.3 dedupe still holds, and that the per-turn `git`
 * work leaves the caller's stack — is in `vi-graph-debt-turn-inject.test.ts`.
 * Three content properties this repository has already been bitten by:
 *
 *  1. The SCOPE. The script intersected `.dirty` with UNSCOPED
 *     `git status --porcelain`, deliberately — its sibling `vi-freshness.sh`
 *     scopes to `packages/ decisions/`. A path outside the graphed domain must
 *     therefore count HERE and not there. A port that quietly adopted the
 *     sibling's scope would under-report the debt the hook exists to show, and
 *     the mistake would read as "the graph is clean".
 *  2. The DERIVATION. This repository has a recorded ~42-session instance of a
 *     hook emitting a confident fixed verdict after it stopped measuring
 *     (ADR-032), and on the inject lane the native form of that is a
 *     `derived_from` that does not move and is therefore DEDUPED into silence —
 *     invisible rather than wrong, which is worse. So the derivation is asserted
 *     here to be a function of the live intersection: identical inputs give an
 *     identical derivation, a changed SET or COUNT changes it.
 *  3. The SILENCES. The script exited 0 with no output in five states, and a
 *     port that reports in a sixth state (an empty intersection, a repository
 *     that does not use the skill) is not a port — it is a per-turn tax.
 *
 * THE REPO IS REAL, THE BUS IS REAL, THE CWD IS STUBBED. The `cwd` seam is
 * spied rather than changed because vitest runs in worker threads, where
 * `process.chdir` does not exist, and the derivation cases go through the actual
 * `HookBus.injectTurnEnd` over the shipped `DEFAULT_HOOK_DESCRIPTORS`
 * materialized into a real `.arbor/hooks` — the production activation path.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookBus, type HookFiredRecord } from "../../src/hooks/bus.js";
import { DEFAULT_HOOK_DESCRIPTORS, HookCatalog } from "../../src/hooks/catalog.js";
import { HOOK_MAX_NOTE_BYTES } from "../../src/hooks/contracts.js";
import { GitAdapter } from "../../src/git-workspace-projection.js";
import { dirtyIntersection } from "../../src/hooks/vi-freshness-tropism.js";
import { viGraphDebtTropism } from "../../src/hooks/vi-graph-debt.js";

const VI_DIR = ".visual-intelligence";
/** The graphed domain — the scope vi-freshness uses and this hook deliberately does NOT. */
const GRAPHED = Object.freeze(["packages/", "decisions/"]);

let root = "";
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };

/** The append-only session tracker the native `observe.vi-dirty-tracker` writes. */
const dirty = (...paths: string[]): void => appendFileSync(join(root, VI_DIR, ".dirty"), paths.map((path) => `${path}\n`).join(""));
/** A tracked path, edited in the working tree so `git status` reports it. */
const edit = (path: string): void => writeFileSync(join(root, path), `// edited\n`);
const report = () => viGraphDebtTropism(root);

const productionBus = (): HookBus => new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks")) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-hooks-graph-debt-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  mkdirSync(join(root, VI_DIR), { recursive: true });
  mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
  mkdirSync(join(root, "decisions"), { recursive: true });
  // Tracked on purpose: an untracked directory is collapsed to one `?? dir/`
  // entry by `--porcelain`, and a per-file edit under it would never appear.
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "packages", "x", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "decisions", "ADR-001-first.md"), "# First\n");
  writeFileSync(join(root, "notes", "seed.md"), "seed\n");
  writeFileSync(join(root, "docs", "readme.md"), "readme\n");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
  mkdirSync(join(root, ".arbor", "hooks"), { recursive: true });
  for (const descriptor of DEFAULT_HOOK_DESCRIPTORS) writeFileSync(join(root, ".arbor", "hooks", descriptor.filename), descriptor.contents);
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("vi-graph-debt — the intersection is the UNSCOPED one", () => {
  it("counts a live path outside packages/ and decisions/, which its freshness sibling deliberately does not", () => {
    edit("docs/readme.md");
    dirty("docs/readme.md");
    // The contrast IS the point: the same file, the same .dirty line, two
    // different questions. Freshness asks "did the GRAPHED domain drift"; this
    // asks "did anything change that the graph would have to be re-derived
    // from". A port that borrowed the sibling's scope would report nothing.
    expect(dirtyIntersection(new GitAdapter(root), root, GRAPHED)).toEqual([]);
    expect(dirtyIntersection(new GitAdapter(root), root, [])).toEqual(["docs/readme.md"]);
    expect(report()?.body).toContain("1 path(s) changed, graph not refreshed");
    expect(report()?.body).toContain("    docs/readme.md");
  });

  it("counts a graphed-domain path too, so the unscoped read is a superset and not a different question", () => {
    edit("packages/x/src/a.ts");
    edit("docs/readme.md");
    dirty("packages/x/src/a.ts", "docs/readme.md");
    expect(report()?.body).toContain("2 path(s) changed");
  });

  it("counts a path touched and then COMMITTED as clean, because the worktree no longer holds it", () => {
    // The script's own comment: "Paths that were touched and then committed are
    // not graph debt; the graph's distance from HEAD covers those." Counting
    // `.dirty` directly is what produced the permanent 42-path banner (ADR-032).
    dirty("packages/x/src/a.ts");
    expect(report()).toBeNull();
  });
});

describe("vi-graph-debt — the composed report", () => {
  it("reproduces the script's header, four-space sample rows, and the remedy line", () => {
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    expect(report()?.body.split("\n")).toEqual([
      "repository-visual-intelligence — graph debt: 1 path(s) changed, graph not refreshed",
      "    packages/x/src/a.ts",
      "  Refresh with maintenance mode, or clear .visual-intelligence/.dirty if the changes are irrelevant to the graph.",
    ]);
  });

  it("samples at most five rows and says how many it did not show", () => {
    const paths = ["a", "b", "c", "d", "e", "f", "g"];
    for (const name of paths) { edit(`notes/${name}.md`); }
    // Six files under one tracked directory, so `--porcelain` lists each.
    mkdirSync(join(root, "notes", "many"), { recursive: true });
    for (const name of paths) { writeFileSync(join(root, "notes", "many", `${name}.md`), "x\n"); dirty(`notes/many/${name}.md`); }
    git("add", "-A");
    git("commit", "-q", "-m", "seed many");
    for (const name of paths) { writeFileSync(join(root, "notes", "many", `${name}.md`), "edited\n"); }

    const note = report()?.body ?? "";
    expect(note).toContain("7 path(s) changed, graph not refreshed");
    const rows = note.split("\n").filter((line) => line.startsWith("    ") && !line.includes("... and"));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.startsWith("    ")).toBe(true);
    expect(note).toContain("    ... and 2 more");
  });

  it("omits the '... and N more' row at exactly the sample size", () => {
    const names = ["a", "b", "c", "d", "e"];
    mkdirSync(join(root, "notes", "many"), { recursive: true });
    for (const name of names) writeFileSync(join(root, "notes", "many", `${name}.md`), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed five");
    for (const name of names) { writeFileSync(join(root, "notes", "many", `${name}.md`), "edited\n"); dirty(`notes/many/${name}.md`); }

    const note = report()?.body ?? "";
    expect(note).toContain("5 path(s) changed");
    expect(note).not.toContain("... and");
  });

  it("never overflows its own byte bound, and sheds SAMPLE rows rather than the remedy when paths are long", () => {
    // The bound is a HEAD slice — so a head-5 sample of long paths would eat
    // the one actionable line in the message. The header's count is never
    // reduced; only the sample is, and what it no longer shows is counted in
    // the '... and N more' row.
    const long = `${"n".repeat(120)}.md`;
    for (let index = 0; index < 5; index += 1) {
      const path = `notes/${index}-${long}`;
      writeFileSync(join(root, path), "x\n");
      dirty(path);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "seed long");
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `notes/${index}-${long}`), "edited\n");

    const note = report()?.body ?? "";
    expect(note.length).toBeLessThanOrEqual(HOOK_MAX_NOTE_BYTES);
    expect(note).toContain("5 path(s) changed, graph not refreshed");
    expect(note).toContain("Refresh with maintenance mode");
    expect(note).toContain("... and");
  });
});

describe("vi-graph-debt — every silence is the script's own", () => {
  it("says nothing when .dirty does not exist, which is what makes global installation safe", () => {
    edit("packages/x/src/a.ts");
    expect(report()).toBeNull();
  });

  it("says nothing when the worktree is clean, however long .dirty is", () => {
    dirty("packages/x/src/a.ts", "decisions/ADR-001-first.md", "notes/seed.md", "docs/readme.md");
    expect(report()).toBeNull();
  });

  it("says nothing when .dirty is present but empty", () => {
    writeFileSync(join(root, VI_DIR, ".dirty"), "");
    edit("packages/x/src/a.ts");
    expect(report()).toBeNull();
  });

  it("says nothing outside a git repository, rather than throwing into the bus", () => {
    const orphan = mkdtempSync(join(tmpdir(), "arbor-hooks-graph-debt-orphan-"));
    try {
      mkdirSync(join(orphan, VI_DIR), { recursive: true });
      writeFileSync(join(orphan, VI_DIR, ".dirty"), "packages/x/src/a.ts\n");
      expect(viGraphDebtTropism(orphan)).toBeNull();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe("vi-graph-debt — the derivation is a function of the live intersection", () => {
  it("changes derived_from when the intersected set changes", () => {
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const before = report()?.derived_from;
    expect(before).toHaveLength(1);

    edit("docs/readme.md");
    dirty("docs/readme.md");
    // A constant derivation is the shape of the 42-session false alarm: the
    // handler keeps answering from memory while the repository moves on. On the
    // inject lane it is worse than that — §5.3 would dedupe it and the report
    // would simply never reach the model again.
    expect(report()?.derived_from).not.toEqual(before);
  });

  it("keeps the same derivation for the same intersected set, and a different one for a different COUNT at the same paths", () => {
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const one = report()?.derived_from;
    expect(report()?.derived_from).toEqual(one);

    edit("docs/readme.md");
    dirty("docs/readme.md");
    edit("notes/seed.md");
    dirty("notes/seed.md");
    // The count is in the body, so it is in the derivation: two files cannot
    // share a fingerprint with one.
    expect(report()?.derived_from).not.toEqual(one);
  });

  it("re-measures on every turn rather than answering from the previous one", async () => {
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const rows: HookFiredRecord[] = [];
    const bus = new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks")), on_fired: (row) => rows.push(row) });

    await bus.injectTurnEnd({ session_id: "s-1", turn: 4 });
    // A file written during the turn must appear in the NEXT turn's report, or
    // a per-turn lane is measuring once and reporting forever.
    edit("docs/readme.md");
    dirty("docs/readme.md");
    const second = await bus.injectTurnEnd({ session_id: "s-1", turn: 5 });

    // The second report's derivation is the one the live intersection produces
    // NOW, which is a different string from the first's — the handler measured
    // again rather than answering from its previous answer.
    expect(second.source_paths).toEqual([report()?.derived_from?.[0]]);
    const debt = rows.filter((row) => row.hook_id === "vi-graph-debt");
    expect(debt).toHaveLength(2);
    expect(debt[0]?.derived_from?.[0]).not.toEqual(debt[1]?.derived_from?.[0]);
    expect(debt[1]?.derived_from).toEqual(report()?.derived_from);
  });

  it("a firing with no debt records the note alone, never an empty or invented verdict", async () => {
    dirty("packages/x/src/a.ts");
    const rows: HookFiredRecord[] = [];
    const bus = new HookBus({ catalog: HookCatalog.fromDirectory(join(root, ".arbor", "hooks")), on_fired: (row) => rows.push(row) });
    await bus.injectTurnEnd({ session_id: "s-1", turn: 1 });
    const debt = rows.filter((row) => row.hook_id === "vi-graph-debt");
    expect(debt).toHaveLength(1);
    // `null` IS the handler's verdict, and silence is a verdict: the healthy
    // case must cost one row and no prompt bytes.
    expect(debt[0]?.evidence_ref).toBe("turn_end note=-");
    expect(debt[0]?.derived_from).toBeUndefined();
  });

  it("does not fire on the observe lane, because its descriptor names an inject handler", async () => {
    edit("packages/x/src/a.ts");
    dirty("packages/x/src/a.ts");
    const bus = productionBus();

    bus.observeTurnEnd("s-observe-only", 1);
    // The observe lane records a SYNC handler's row before it returns, so this
    // is already decisive; the tick is only so a late settlement cannot race
    // the assertion. If the descriptor were still `observe`, the row would be
    // here by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bus.ledger().filter((row) => row.hook_id === "vi-graph-debt")).toHaveLength(0);
    expect((await bus.injectTurnEnd({ session_id: "s-observe-only", turn: 1 })).content).toContain("graph debt: 1 path(s) changed");
  });
});
