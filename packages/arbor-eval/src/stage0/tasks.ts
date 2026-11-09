/**
 * arbor-eval/stage0/tasks — systematic task generation and fixture proofs.
 *
 * Tasks come from two preregistered generators (see stage0-preregistration.md):
 *
 * - body_stub: one upstream function body is replaced by a stub that keeps the
 *   signature and documentation. Candidates are enumerated mechanically from
 *   the pinned source (`stubs.ts`), filtered by fixed eligibility rules, and
 *   taken in a fixed seeded order until the member's quota of ADMITTED tasks
 *   is met. The removed body is the reference fix; upstream tests are the
 *   specification.
 * - feature_injection: yocto-queue's authored requests (`yocto-tasks.ts`).
 *
 * A task is admitted only if its fixture is red (the acceptance command
 * fails on the fixture) and green (it passes once the reference fix is
 * applied, run inside the production verification sandbox with the network
 * denied). Fixtures are single-commit repositories with no upstream history,
 * so the removed body cannot be recovered with `git log`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { hashSeed } from "@arbor/core";
import { SandboxedVerificationCommandPort } from "@arbor/mcp";
import { runLogged } from "./proc.js";
import { applyStub, insertBeforeClassEnd, jsMethodStubCandidate, pythonAllNames, pythonStubCandidates, rustStubCandidates, wordOccurrences } from "./stubs.js";
import type { StubCandidate } from "./stubs.js";
import type { Stage0FixtureProof, Stage0Member, Stage0Split, Stage0Task } from "./types.js";
import { YOCTO_FEATURE_TASKS, YOCTO_STUB_MEMBERS } from "./yocto-tasks.js";

export const STAGE0_GENERATOR_VERSION = "stage0-tasks-v1";

export interface CohortSource {
  readonly member: Stage0Member;
  /** A local clone containing the pinned revision. */
  readonly repo: string;
  readonly revision: string;
}

/** Preregistered quotas of admitted tasks per member. */
export const STAGE0_QUOTAS: Readonly<Record<Stage0Member, number>> = { "yocto-queue": 12, "more-itertools": 28, semver: 20 };

export const MEMBER_ACCEPTANCE: Readonly<Record<Stage0Member, readonly string[]>> = {
  "yocto-queue": ["npm", "test"],
  "more-itertools": ["python3", "-m", "unittest"],
  semver: ["cargo", "test", "--quiet"],
};

const RUST_FILES = ["lib", "eval", "display", "parse", "impls", "error"] as const;

/** Deterministic preregistered order key. */
export const orderKey = (id: string): number => hashSeed(`${STAGE0_GENERATOR_VERSION}:order:${id}`);

/** Deterministic 2:1 calibration/held-out split. */
export function splitOf(id: string): Stage0Split {
  return hashSeed(`${STAGE0_GENERATOR_VERSION}:split:${id}`) % 3 === 0 ? "held_out" : "calibration";
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const SUFFIX_PY = " The existing tests in tests/ (including the doctests they load) specify the behaviour; make `python3 -m unittest` pass. Do not weaken, skip, or remove any test.";
const SUFFIX_RS = " The existing tests under tests/ and the crate's doc tests specify the behaviour; make `cargo test --quiet` pass. Do not weaken, skip, or remove any test.";
const SUFFIX_JS = " The existing tests in test.js specify the behaviour; make `npm test` pass. Do not weaken, skip, or remove any test.";

/** A candidate task plus how to build its fixture and its reference fix. */
export interface TaskCandidate {
  readonly task: Stage0Task;
  /** Path → new contents applied to the pristine tree to make the fixture. */
  readonly fixture_edits: Readonly<Record<string, string>>;
  /** Path → contents applied on top of the fixture for the reference fix. */
  readonly reference_edits: Readonly<Record<string, string>>;
}

function makeTask(fields: Omit<Stage0Task, "split">): Stage0Task {
  return { ...fields, split: splitOf(fields.id) };
}

/** Enumerate every candidate for one member, in preregistered order. */
export function enumerateCandidates(member: Stage0Member, readPristine: (path: string) => string, listPristine: (dir: string) => string[]): TaskCandidate[] {
  const out: TaskCandidate[] = [];
  if (member === "more-itertools") {
    const path = "more_itertools/more.py";
    const more = readPristine(path);
    const tests = readPristine("tests/test_more.py");
    const exported = new Set(pythonAllNames(more));
    for (const candidate of pythonStubCandidates(more)) {
      if (!exported.has(candidate.name)) continue;
      if (candidate.body_lines < 4 || candidate.body_lines > 30) continue;
      if (wordOccurrences(tests, candidate.name) === 0) continue;
      const id = `more-itertools-${slug(candidate.name)}`;
      out.push({
        task: makeTask({
          id,
          member,
          language: "python",
          generator: "body_stub",
          symbol: candidate.symbol,
          edit_paths: [path],
          task_text: `Edit exactly ${path}; The function more_itertools.${candidate.name} in ${path} currently raises NotImplementedError after its docstring. Implement it so it behaves as its docstring describes.${SUFFIX_PY}`,
          acceptance: MEMBER_ACCEPTANCE[member],
          protected_paths: listPristine("tests"),
        }),
        fixture_edits: { [path]: applyStub(more, candidate) },
        reference_edits: { [path]: more },
      });
    }
  } else if (member === "semver") {
    for (const file of RUST_FILES) {
      const path = `src/${file}.rs`;
      const source = readPristine(path);
      for (const candidate of rustStubCandidates(source)) {
        if (candidate.body_lines < 3 || candidate.body_lines > 70) continue;
        const where = candidate.context === "module level" ? `the module-level function \`fn ${candidate.name}\`` : `\`fn ${candidate.name}\` in \`${candidate.context}\``;
        const id = `semver-${file}-${slug(candidate.context === "module level" ? candidate.name : `${candidate.context}-${candidate.name}`)}`;
        out.push(rustCandidate(id, path, source, candidate, where));
      }
    }
  } else {
    const index = readPristine("index.js");
    const dts = readPristine("index.d.ts");
    for (const feature of YOCTO_FEATURE_TASKS) {
      out.push({
        task: makeTask({
          id: `yocto-queue-${feature.name}`,
          member,
          language: "javascript",
          generator: "feature_injection",
          symbol: feature.symbol,
          edit_paths: feature.edit_paths,
          task_text: feature.task_text,
          acceptance: MEMBER_ACCEPTANCE[member],
          protected_paths: ["test.js", "index.test-d.ts", feature.test_path],
        }),
        fixture_edits: { [feature.test_path]: feature.test_contents },
        reference_edits: { "index.js": insertBeforeClassEnd(index, feature.reference_js), "index.d.ts": insertBeforeClassEnd(dts, feature.reference_dts) },
      });
    }
    for (const memberName of YOCTO_STUB_MEMBERS) {
      const candidate = jsMethodStubCandidate(index, memberName);
      if (candidate === null) continue;
      const id = `yocto-queue-stub-${slug(memberName)}`;
      out.push({
        task: makeTask({
          id,
          member,
          language: "javascript",
          generator: "body_stub",
          symbol: candidate.symbol,
          edit_paths: ["index.js"],
          task_text: `Edit exactly index.js; The method ${candidate.symbol} in index.js currently throws 'Not implemented'. Implement it as its declaration and documentation in index.d.ts and readme.md describe.${SUFFIX_JS}`,
          acceptance: MEMBER_ACCEPTANCE[member],
          protected_paths: ["test.js", "index.test-d.ts"],
        }),
        fixture_edits: { "index.js": applyStub(index, candidate) },
        reference_edits: { "index.js": index },
      });
    }
  }
  return out.sort((a, b) => orderKey(a.task.id) - orderKey(b.task.id) || a.task.id.localeCompare(b.task.id));
}

function rustCandidate(id: string, path: string, source: string, candidate: StubCandidate, where: string): TaskCandidate {
  return {
    task: makeTask({
      id,
      member: "semver",
      language: "rust",
      generator: "body_stub",
      symbol: `${path}:${candidate.context}:${candidate.name}`,
      edit_paths: [path],
      task_text: `Edit exactly ${path}; In ${path}, the body of ${where} is currently \`unimplemented!()\`. Implement it so the crate behaves as its documentation describes. Keep no_std support and all other behaviour unchanged.${SUFFIX_RS}`,
      acceptance: MEMBER_ACCEPTANCE.semver,
      protected_paths: [],
    }),
    fixture_edits: { [path]: applyStub(source, candidate) },
    reference_edits: { [path]: source },
  };
}

// ---------------------------------------------------------------- fixtures

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFilesRecursive(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const full = join(absolute, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(root, relative(root, full)));
    else out.push(relative(root, full));
  }
  return out.sort();
}

export interface FixtureEnvironment {
  readonly fixtures_root: string;
  /** member → pristine export directory (git archive of the pinned revision). */
  readonly pristine: Readonly<Record<Stage0Member, string>>;
  /** yocto-queue's installed node_modules, hardlink-copied into every working tree. */
  readonly node_modules_cache: string;
  /** A Cargo.lock resolved for semver's pinned revision (semver gitignores it; see D3). */
  readonly cargo_lock: string;
}

/** Export the pinned revision of a source clone to `dest` (no history). */
export function exportPristine(source: CohortSource, dest: string, logs: string): void {
  mkdirSync(dest, { recursive: true });
  const archive = runLogged(logs, `archive-${source.member}`, ["sh", "-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", source.repo, source.revision, dest], dest, { timeoutMs: 120_000 });
  if (archive.exit_code !== 0) throw new Error(`git archive failed for ${source.member}`);
}

/** Provide a working tree's dependencies without touching the network. */
export function provisionDependencies(member: Stage0Member, tree: string, env: FixtureEnvironment, logs: string): void {
  if (member === "yocto-queue" && !existsSync(join(tree, "node_modules"))) {
    const copy = runLogged(logs, "deps-node-modules", ["cp", "-al", env.node_modules_cache, join(tree, "node_modules")], tree, { timeoutMs: 300_000 });
    if (copy.exit_code !== 0) throw new Error("node_modules provisioning failed");
  }
}

function writeEdits(root: string, edits: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(edits)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

const OPERATIONAL_EXCLUDES = "\n.arbor/\n.worktrees/\narbor.profile.jsonc\ndecisions/\n.claim-ledger/\n.completion-depth/\n.determinism-baseline/\n.visual-intelligence/\n__pycache__/\ntarget/\nnode_modules/\n";

/** Build one fixture repository and prove it red and green. Never deletes anything. */
export async function buildFixture(candidate: TaskCandidate, env: FixtureEnvironment): Promise<Stage0FixtureProof> {
  const { task } = candidate;
  const dir = join(env.fixtures_root, task.id);
  const repo = join(dir, "repo");
  const logs = join(dir, "logs");
  mkdirSync(repo, { recursive: true });
  const pristine = env.pristine[task.member];
  const copy = runLogged(logs, "copy-pristine", ["cp", "-a", `${pristine}/.`, repo], dir);
  if (copy.exit_code !== 0) throw new Error(`copy failed for ${task.id}`);
  writeEdits(repo, candidate.fixture_edits);
  if (task.member === "semver") copyFileSync(env.cargo_lock, join(repo, "Cargo.lock"));
  const git = (name: string, args: string[]) => runLogged(logs, name, ["git", ...args], repo);
  git("init", ["init", "-q", "-b", "stage0"]);
  git("config-email", ["config", "user.email", "stage0@revoy.invalid"]);
  git("config-name", ["config", "user.name", "Revoy Stage0"]);
  git("add", ["add", "-A"]);
  if (task.member === "semver") git("add-lock", ["add", "-f", "Cargo.lock"]);
  git("commit", ["commit", "-q", "-m", `stage0 fixture ${task.id}`]);
  const commit = git("rev-parse", ["rev-parse", "HEAD"]).stdout.trim();
  const protectedPaths = task.protected_paths.length > 0 ? task.protected_paths : listFilesRecursive(repo, "tests");
  const protectedSha: Record<string, string> = {};
  for (const path of protectedPaths) protectedSha[path] = sha256File(join(repo, path));

  // Red: the fixture as given fails its acceptance command.
  const red = join(dir, "red");
  runLogged(logs, "clone-red", ["git", "clone", "-q", repo, red], dir);
  provisionDependencies(task.member, red, env, logs);
  const baseline = runLogged(logs, "baseline-acceptance", [...task.acceptance], red, { timeoutMs: 600_000 });

  // Green: the reference fix passes inside the production verification sandbox, network denied.
  const green = join(dir, "green");
  runLogged(logs, "clone-green", ["git", "clone", "-q", repo, green], dir);
  provisionDependencies(task.member, green, env, logs);
  writeEdits(green, candidate.reference_edits);
  const sandboxed = await new SandboxedVerificationCommandPort().run({
    argv: [task.acceptance[0], ...task.acceptance.slice(1)],
    cwd: green,
    context_root: green,
    network: "enforced_denied",
    timeout_ms: 600_000,
    max_output_bytes: 4 * 1024 * 1024,
    signal: new AbortController().signal,
  });
  const referenceExit = sandboxed.kind === "exited" ? sandboxed.exit : null;
  writeFileSync(join(logs, "reference-acceptance.sandbox.json"), `${JSON.stringify({ kind: sandboxed.kind, exit: referenceExit }, null, 2)}\n`);
  if ("stdout" in sandboxed) writeFileSync(join(logs, "reference-acceptance.stdout.log"), sandboxed.stdout);
  if ("stderr" in sandboxed) writeFileSync(join(logs, "reference-acceptance.stderr.log"), sandboxed.stderr);

  const baselineExit = baseline.exit_code;
  const reason = baselineExit === 0 ? "baseline already green"
    : baselineExit === null ? "baseline did not exit"
      : referenceExit !== 0 ? `reference fix not green in sandbox (${sandboxed.kind} ${String(referenceExit)})`
        : null;
  appendFileSync(join(repo, ".git", "info", "exclude"), OPERATIONAL_EXCLUDES);
  return {
    task_id: task.id,
    fixture_repo: repo,
    fixture_commit: commit,
    baseline_exit: baselineExit,
    reference_exit: referenceExit,
    protected_sha256: protectedSha,
    admitted: reason === null,
    reason,
  };
}

export { OPERATIONAL_EXCLUDES, listFilesRecursive };
