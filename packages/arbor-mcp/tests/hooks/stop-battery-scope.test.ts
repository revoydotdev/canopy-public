/**
 * Arboretum M2's two rules, proven against real git repositories in temp
 * directories: a stop gate is scheduled out only when it DECLARES inputs and
 * none of them (nor its implementation) changed, and a red is attributed to the
 * baseline only through an owned, validated debt entry.
 *
 * Each failure direction is asserted on its own, because each half of this is
 * a relaxation: scheduling out a gate that should have run, or attributing a
 * session's red to the baseline, is the defect, and both must fail toward
 * running and blocking.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitAdapter } from "../../src/git-workspace-projection.js";
import {
  STOP_DEBT_KIND,
  STOP_DEBT_PATH,
  attributeBaselineDebt,
  changedPathsSince,
  gateImplicitInputs,
  inputGlobToRegExp,
  loadBaselineDebt,
  matchesAnyInput,
  parsePorcelainZ,
  renderOwnedDebt,
  scheduleStopGates,
  type ChangedPathSet,
  type StopScopeProfile,
} from "../../src/hooks/stop-battery-scope.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DEBT_CLI = join(REPO_ROOT, "scripts", "stop-guard-debt.mjs");

let root = "";
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const commitAll = (message: string): string => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arbor-stop-scope-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write("package.json", `${JSON.stringify({
    name: "fixture",
    workspaces: ["packages/lib"],
    scripts: {
      "gate:docs": "bun scripts/docs-gate.mjs",
      "gate:code": "bun scripts/code-gate.mjs",
      "gate:undeclared": "bun scripts/undeclared-gate.mjs",
      "gate:red": "node -e \"process.exit(3)\"",
      "gate:green": "true",
    },
  }, null, 2)}\n`);
  write("packages/lib/package.json", `${JSON.stringify({ name: "@arbor/lib" })}\n`);
  write("packages/lib/src/index.ts", "export const x = 1;\n");
  write("scripts/docs-gate.mjs", 'import { helper } from "./helper.mjs";\nhelper();\n');
  write("scripts/helper.mjs", "export function helper() {}\n");
  write("scripts/code-gate.mjs", 'import { x } from "@arbor/lib";\nconsole.log(x);\n');
  write("scripts/undeclared-gate.mjs", "\n");
  write("docs/a.md", "a\n");
  write("decisions/ADR-001-owner.md", "# ADR-001: owner\n");
  commitAll("root");
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PROFILE: StopScopeProfile = {
  gates: {
    "gate:docs": { contexts: { stop: true }, inputs: ["docs/**"] },
    "gate:code": { contexts: { stop: true }, inputs: ["src-config.json"] },
    "gate:undeclared": { contexts: { stop: true } },
    "gate:not-stop": { contexts: { stop: false }, inputs: ["docs/**"] },
  },
};

const pkg = () => JSON.parse(execFileSync("cat", ["package.json"], { cwd: root, encoding: "utf8" })) as { scripts: Record<string, string>; workspaces: string[] };
const changed = (paths: readonly string[], complete = true): ChangedPathSet => ({ paths, complete, problems: complete ? [] : ["git status failed"] });
const skipped = (paths: readonly string[], complete = true): string[] =>
  scheduleStopGates({ root, profile: PROFILE, packageJson: pkg(), changed: changed(paths, complete) }).skip.map((entry) => entry.gate);

describe("input globs", () => {
  it("** crosses directories, * and ? do not, and a literal covers its subtree", () => {
    expect(inputGlobToRegExp("decisions/**").test("decisions/ADR-001-x.md")).toBe(true);
    expect(inputGlobToRegExp("decisions/**").test("decisions/sub/deep.md")).toBe(true);
    expect(inputGlobToRegExp("packages/*/package.json").test("packages/arbor-core/package.json")).toBe(true);
    expect(inputGlobToRegExp("packages/*/package.json").test("packages/arbor-core/src/package.json")).toBe(false);
    expect(inputGlobToRegExp("scripts/**/x.mjs").test("scripts/x.mjs")).toBe(true);
    expect(inputGlobToRegExp("package.json").test("package.json")).toBe(true);
    expect(inputGlobToRegExp("package.json").test("packages/a/package.json")).toBe(false);
    expect(inputGlobToRegExp("scripts/lib").test("scripts/lib/a.mjs")).toBe(true);
    expect(inputGlobToRegExp("a.b").test("aXb")).toBe(false);
    expect(matchesAnyInput(["docs/**", "bun.lock"], "bun.lock")).toBe(true);
  });
});

describe("the changed-path set", () => {
  it("parses porcelain -z, keeping both sides of a rename", () => {
    expect(parsePorcelainZ(" M a.txt\0R  new.txt\0old.txt\0?? u.txt\0")).toEqual(["a.txt", "new.txt", "old.txt", "u.txt"]);
  });

  it("unions uncommitted, untracked, committed-since-base, and the native .dirty record", () => {
    const base = git("rev-parse", "HEAD").trim();
    write("docs/committed.md", "c\n");
    const head = commitAll("after base");
    write("docs/a.md", "edited\n");
    write("untracked/new.txt", "n\n");
    write(".visual-intelligence/.dirty", "scripts/attempted.mjs\n");
    const set = changedPathsSince(new GitAdapter(root), root, base, head);
    expect(set.complete).toBe(true);
    expect(set.paths).toEqual(expect.arrayContaining(["docs/committed.md", "docs/a.md", "untracked/new.txt", "scripts/attempted.mjs"]));
  });

  it("reports itself incomplete when the base cannot be diffed, rather than dropping that source", () => {
    const head = git("rev-parse", "HEAD").trim();
    const set = changedPathsSince(new GitAdapter(root), root, "0".repeat(40), head);
    expect(set.complete).toBe(false);
    expect(set.problems.join(" ")).toContain("git diff");
  });
});

describe("scheduling by declared inputs", () => {
  it("an untouched declared gate is scheduled out; an undeclared one never is; a non-stop gate is not considered", () => {
    expect(skipped([])).toEqual(["gate:code", "gate:docs"]);
    const schedule = scheduleStopGates({ root, profile: PROFILE, packageJson: pkg(), changed: changed([]) });
    expect(schedule.undeclared).toEqual(["gate:undeclared"]);
  });

  it("a change under a declared input schedules the gate in", () => {
    expect(skipped(["docs/a.md"])).toEqual(["gate:code"]);
  });

  it("a change to the gate's own script or its relative import closure schedules it in", () => {
    expect(skipped(["scripts/docs-gate.mjs"])).not.toContain("gate:docs");
    expect(skipped(["scripts/helper.mjs"])).not.toContain("gate:docs");
  });

  it("a workspace import widens to the whole package", () => {
    expect(gateImplicitInputs(root, "bun scripts/code-gate.mjs", new Map([["@arbor/lib", "packages/lib"]]))).toContain("packages/lib/**");
    expect(skipped(["packages/lib/src/index.ts"])).not.toContain("gate:code");
  });

  it("a change to the roster, the profile or the shared libraries schedules every declared gate in", () => {
    for (const path of ["package.json", "scripts/execution-profile.json", "scripts/lib/any.mjs"]) expect(skipped([path])).toEqual([]);
  });

  it("an incomplete changed set schedules nothing out", () => {
    const schedule = scheduleStopGates({ root, profile: PROFILE, packageJson: pkg(), changed: changed([], false) });
    expect(schedule.skip).toEqual([]);
    expect(schedule.ran_everything_because).toContain("incomplete");
  });
});

describe("owned baseline debt", () => {
  const head = (): string => git("rev-parse", "HEAD").trim();
  const writeDebt = (entries: unknown[]): void => write(STOP_DEBT_PATH, `${JSON.stringify({ schema_version: 1, kind: STOP_DEBT_KIND, entries })}\n`);
  const entry = (over: Record<string, unknown> = {}) => ({ gate: "gate:red", owner: "ADR-001", reason: "pre-existing", opened_at: "2026-10-06T00:00:00.000Z", opened_at_revision: head(), observed_exit_code: 3, ...over });

  it("an absent record is no debt and no problem", () => {
    expect(loadBaselineDebt(root)).toEqual({ entries: [], problems: [] });
  });

  it("accepts a valid entry and drops each invalid one with a problem line", () => {
    writeDebt([
      entry(),
      entry({ gate: "gate:orphan", owner: "ADR-999" }),
      entry({ gate: "gate:noreason", reason: " " }),
      entry({ gate: "gate:shortrev", opened_at_revision: "abc" }),
      entry({ gate: "gate:green-claimed", observed_exit_code: 0 }),
      entry(),
    ]);
    const debt = loadBaselineDebt(root);
    expect(debt.entries.map((value) => value.gate)).toEqual(["gate:red"]);
    expect(debt.problems).toHaveLength(5);
    expect(debt.problems.join("\n")).toContain("ADR-999 does not name an existing decisions/ record");
  });

  it("a malformed record contributes no debt", () => {
    write(STOP_DEBT_PATH, "{ not json");
    expect(loadBaselineDebt(root).entries).toEqual([]);
    writeDebt([]);
    write(STOP_DEBT_PATH, JSON.stringify({ schema_version: 2, kind: STOP_DEBT_KIND, entries: [entry()] }));
    expect(loadBaselineDebt(root).entries).toEqual([]);
  });

  it("attributes only the reds an entry owns; every other red stays the session's", () => {
    const { owned, unowned } = attributeBaselineDebt(
      [{ gate: "gate:red", exit_code: "3" }, { gate: "gate:new", exit_code: "1" }],
      [entry() as never],
    );
    expect(owned.map((red) => red.gate)).toEqual(["gate:red"]);
    expect(unowned.map((red) => red.gate)).toEqual(["gate:new"]);
    expect(renderOwnedDebt(owned)).toContain("gate:red (exit 3) owned by ADR-001");
  });

  describe("the writer, scripts/stop-guard-debt.mjs", () => {
    const cli = (...args: string[]) => spawnSync("bun", [DEBT_CLI, ...args, "--repo", root], { encoding: "utf8" });

    it("opens debt only on a clean tree for a gate it observes red, and the reader accepts what it wrote", () => {
      const opened = cli("open", "gate:red", "--owner", "ADR-001", "--reason", "red before this session");
      expect(opened.status, opened.stderr).toBe(0);
      const debt = loadBaselineDebt(root);
      expect(debt.problems).toEqual([]);
      expect(debt.entries).toEqual([expect.objectContaining({ gate: "gate:red", owner: "ADR-001", observed_exit_code: 3, opened_at_revision: head() })]);
    });

    it("refuses a green gate, a dirty tree, and an owner that does not exist", () => {
      expect(cli("open", "gate:green", "--owner", "ADR-001", "--reason", "r").stderr).toContain("green at HEAD");
      expect(cli("open", "gate:red", "--owner", "ADR-404", "--reason", "r").stderr).toContain("ADR-404");
      write("docs/a.md", "dirty\n");
      expect(cli("open", "gate:red", "--owner", "ADR-001", "--reason", "r").stderr).toContain("dirty");
      expect(loadBaselineDebt(root).entries).toEqual([]);
    });

    it("closes an entry", () => {
      expect(cli("open", "gate:red", "--owner", "ADR-001", "--reason", "r").status).toBe(0);
      commitAll("own the debt");
      expect(cli("close", "gate:red").status).toBe(0);
      expect(loadBaselineDebt(root).entries).toEqual([]);
    });
  });
});
