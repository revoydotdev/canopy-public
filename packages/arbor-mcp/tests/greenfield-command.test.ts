/**
 * ADR-114 Decision §1 — `arbor greenfield <intent>` runs EVERY preflight
 * blocker (target isolation safety, the dirty-tree probe, tier validity)
 * ONCE and reports them TOGETHER, rather than the fix-one/re-run/hit-the-
 * next cycle the ADR's Context traces through four sequential refusals
 * against a fresh `.demo-astro` checkout. These tests drive the real CLI
 * entrypoint (`main`), not `greenfieldCommand`'s internals, per this repo's
 * "test through the real surface" convention (see cli-flag-position-
 * independence.test.ts's own header for the established pattern).
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { ArborRuntime } from "../src/runtime.js";
import { TaskComposer } from "../src/task-composer.js";
import { CampaignManager } from "../src/manager.js";

function makeEnv(cwd: string, overrides: Partial<{ persistence_dir: string; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; runtime_factory: (cwd: string, persistenceDir?: string) => ArborRuntime; isolation_guard: { harness_checkout?: string | null } }> = {}) {
  return {
    cwd,
    persistence_dir: overrides.persistence_dir,
    stdin: overrides.stdin ?? new PassThrough(),
    stdout: overrides.stdout ?? new PassThrough(),
    stderr: overrides.stderr ?? new PassThrough(),
    runtime_factory: overrides.runtime_factory,
    ...(overrides.isolation_guard === undefined ? {} : { isolation_guard: overrides.isolation_guard }),
  };
}

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

/** Same deterministic, instantly-admittable stub runtime cli-flag-position-independence.test.ts uses. */
function confirmableStubRuntime(cwd: string, persistenceDir?: string): ArborRuntime {
  const dir = resolvePersistenceDir(cwd, persistenceDir);
  const proposal = JSON.stringify({
    summary: "implement the requested change", assumptions: [], questions: [],
    root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
    actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
    acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
  });
  const manager = new CampaignManager({ persistence_dir: dir });
  const taskComposer = new TaskComposer({
    manager, persistence_dir: dir,
    planner: { plan: async () => ({ raw_proposal: proposal, session_id: "plan-session", model_identity: "native-test", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } }) },
    admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: `job-${campaign_id}` }) },
  });
  return new ArborRuntime({ persistence_dir: dir, workspace_root: cwd, manager, task_composer: taskComposer });
}

/** A real, throwaway git repo with a clean committed tree. */
function makeCleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arbor-greenfield-clean-"));
  spawnSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "greenfield fixture\n");
  spawnSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
  return repo;
}

/** A real, throwaway git repo with an uncommitted product change on top of a committed tree. */
function makeDirtyRepo(): string {
  const repo = makeCleanRepo();
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  return repo;
}

describe("ADR-114 Decision §1: arbor greenfield collects every blocker before dispatch", () => {
  it("reports MULTIPLE simultaneous blockers together, not first-failure — a dirty tree AND an invalid --tier", async () => {
    const repo = makeDirtyRepo();
    try {
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(
        ["greenfield", "--tier", "bogus-tier", "build an astro site"],
        makeEnv(repo, { stderr: err }),
      );
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const text = errText.text();
      // Both blockers are named in the SAME report — proof this is a
      // collect-then-report design, not a first-failure exit.
      expect(text).toContain("--tier requires one of: direct, reviewed, governed");
      expect(text).toContain("worktree:");
      expect(text).toContain("uncommitted product changes");
      expect(text).toContain("hello.txt");
      const blockerCountLine = text.split("\n")[0] ?? "";
      expect(blockerCountLine).toContain("2 blockers");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("collects the isolation blocker together with the dirty-tree blocker (three blockers at once)", async () => {
    const repo = makeDirtyRepo();
    try {
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(
        ["greenfield", "bogus-tier-two", "--tier", "not-a-real-tier"],
        makeEnv(repo, { stderr: err, isolation_guard: { harness_checkout: realpathSync(repo) } }),
      );
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const text = errText.text();
      expect(text).toContain("isolation:");
      expect(text).toContain("worktree:");
      expect(text).toContain("--tier requires one of");
      const blockerCountLine = text.split("\n")[0] ?? "";
      expect(blockerCountLine).toContain("3 blockers");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a clean repo with a valid intent reaches dispatch — the same bare-submit path `arbor task` uses", async () => {
    const repo = makeCleanRepo();
    try {
      const out = new PassThrough();
      const outText = collect(out);
      const code = await main(
        ["greenfield", "build an astro site", "--plan", "--json"],
        makeEnv(repo, { stdout: out, runtime_factory: confirmableStubRuntime }),
      );
      expect(code).toBe(EXIT_CODES.SUCCESS);
      const result = JSON.parse(outText.text());
      expect(result).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "proposed" } } });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("confirms on stderr that the preflight ran when it finds nothing — a silent success reads the same as no check at all", async () => {
    const repo = makeCleanRepo();
    try {
      const out = new PassThrough();
      const err = new PassThrough();
      const outText = collect(out);
      const errText = collect(err);
      const code = await main(
        ["greenfield", "build an astro site", "--plan", "--json"],
        makeEnv(repo, { stdout: out, stderr: err, runtime_factory: confirmableStubRuntime }),
      );
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(errText.text()).toContain("3 preflight checks passed");
      expect(errText.text()).toContain("dispatching at tier direct");
      // The --json contract still holds: stdout carries only the document.
      expect(outText.text()).not.toContain("preflight checks passed");
      expect(() => JSON.parse(outText.text())).not.toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("defaults the tier to 'direct' when --tier is omitted, matching Decision §1", async () => {
    const repo = makeCleanRepo();
    try {
      const out = new PassThrough();
      const code = await main(
        ["greenfield", "build an astro site", "--plan", "--json"],
        makeEnv(repo, { stdout: out, runtime_factory: confirmableStubRuntime }),
      );
      expect(code).toBe(EXIT_CODES.SUCCESS);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ADR-116 machinery reused: --tier is position-independent — leading and trailing placement reach the identical dispatch", async () => {
    const leadingRoot = makeCleanRepo();
    const trailingRoot = makeCleanRepo();
    try {
      const leadingOut = new PassThrough();
      const leading = collect(leadingOut);
      const leadingCode = await main(
        ["greenfield", "--tier", "direct", "build an astro site", "--plan", "--json"],
        makeEnv(leadingRoot, { stdout: leadingOut, runtime_factory: confirmableStubRuntime }),
      );

      const trailingOut = new PassThrough();
      const trailing = collect(trailingOut);
      const trailingCode = await main(
        ["greenfield", "build an astro site", "--tier", "direct", "--plan", "--json"],
        makeEnv(trailingRoot, { stdout: trailingOut, runtime_factory: confirmableStubRuntime }),
      );

      expect(leadingCode).toBe(EXIT_CODES.SUCCESS);
      expect(trailingCode).toBe(EXIT_CODES.SUCCESS);
      const leadingResult = JSON.parse(leading.text());
      const trailingResult = JSON.parse(trailing.text());
      expect(leadingResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "proposed" } } });
      expect(trailingResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "proposed" } } });
      expect(Object.keys(leadingResult.value.draft)).toEqual(Object.keys(trailingResult.value.draft));
    } finally {
      rmSync(leadingRoot, { recursive: true, force: true });
      rmSync(trailingRoot, { recursive: true, force: true });
    }
  });

  it("an unknown flag is refused BY NAME, wherever it appears in the argument list", async () => {
    const repo = makeCleanRepo();
    try {
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(
        ["greenfield", "build an astro site", "--nonexistent-flag"],
        makeEnv(repo, { stderr: err }),
      );
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(errText.text()).toContain("Unknown greenfield option: --nonexistent-flag");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("(--json safety) the blocker-report path writes nothing to stdout except the JSON document, and only when --json was passed", async () => {
    const repo = makeDirtyRepo();
    try {
      const outNoJson = new PassThrough();
      const outNoJsonText = collect(outNoJson);
      const errNoJson = new PassThrough();
      const codeNoJson = await main(["greenfield", "build an astro site"], makeEnv(repo, { stdout: outNoJson, stderr: errNoJson }));
      expect(codeNoJson).toBe(EXIT_CODES.VIOLATION);
      expect(outNoJsonText.text()).toBe("");

      const outJson = new PassThrough();
      const outJsonText = collect(outJson);
      const codeJson = await main(["greenfield", "build an astro site", "--json"], makeEnv(repo, { stdout: outJson }));
      expect(codeJson).toBe(EXIT_CODES.VIOLATION);
      const text = outJsonText.text();
      const parsed = JSON.parse(text);
      expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      expect(parsed).toMatchObject({ ok: false });
      expect(Array.isArray(parsed.blockers)).toBe(true);
      expect(parsed.blockers.length).toBeGreaterThan(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("no intent text is its own collected blocker, reported with usage", async () => {
    const repo = makeCleanRepo();
    try {
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(["greenfield"], makeEnv(repo, { stderr: err }));
      expect(code).toBe(EXIT_CODES.VIOLATION);
      expect(errText.text()).toContain("no intent text supplied");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--help prints usage and exits 0 without touching the filesystem gates", async () => {
    const repo = makeDirtyRepo();
    try {
      const out = new PassThrough();
      const outText = collect(out);
      const code = await main(["greenfield", "--help"], makeEnv(repo, { stdout: out }));
      expect(code).toBe(EXIT_CODES.SUCCESS);
      expect(outText.text()).toContain("Usage: arbor greenfield <intent>");
      expect(outText.text()).toContain("ADR-114");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
