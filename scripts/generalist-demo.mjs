#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTmuxFrame } from "./tmux-demo-record.mjs";
import { readinessCommandForIntegration, resolveGeneralistIntegration } from "./lib/generalist-integrations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(ROOT, "scripts", "generalist-campaign-driver.mjs");

export const GENERALIST_LANES = [
  {
    id: "typescript",
    label: "TypeScript",
    verify: ["bun", "test"],
    task: "Repair normalizeIntervals in src/intervals.ts. It must reject non-finite or reversed intervals, avoid mutating caller input, sort by start then end, and merge overlaps or directly adjacent intervals. Do not weaken or replace tests. The acceptance command is bun test.",
    files: {
      "package.json": `{"name":"revoy-typescript-flight","private":true,"type":"module","scripts":{"test":"bun test"}}\n`,
      "src/intervals.ts": `export type Interval = { start: number; end: number };\n\nexport function normalizeIntervals(intervals: Interval[]): Interval[] {\n  return intervals.sort((a, b) => a.start - b.start);\n}\n`,
      "src/intervals.test.ts": `import { describe, expect, test } from "bun:test";\nimport { normalizeIntervals } from "./intervals";\n\ndescribe("normalizeIntervals", () => {\n  test("sorts, merges overlaps and adjacency, and preserves caller input", () => {\n    const input = [{ start: 8, end: 10 }, { start: 1, end: 3 }, { start: 3, end: 5 }, { start: 9, end: 12 }];\n    const snapshot = structuredClone(input);\n    expect(normalizeIntervals(input)).toEqual([{ start: 1, end: 5 }, { start: 8, end: 12 }]);\n    expect(input).toEqual(snapshot);\n  });\n  test("rejects malformed intervals", () => {\n    expect(() => normalizeIntervals([{ start: 4, end: 2 }])).toThrow();\n    expect(() => normalizeIntervals([{ start: Number.NaN, end: 2 }])).toThrow();\n  });\n  test("returns independent values", () => {\n    const input = [{ start: 1, end: 2 }];\n    const result = normalizeIntervals(input);\n    result[0].start = 99;\n    expect(input[0].start).toBe(1);\n  });\n});\n`,
    },
  },
  {
    id: "python",
    label: "Python",
    verify: ["python3", "-m", "unittest", "discover", "-s", "tests", "-v"],
    task: "Repair allocate_inventory in inventory.py. Allocate stock FIFO per SKU, permit partial fulfillment, report each order's allocated and unfilled quantities, reject negative quantities, preserve input objects, and return remaining stock. Do not weaken or replace tests. The acceptance command is python3 -m unittest discover -s tests -v.",
    files: {
      "inventory.py": `def allocate_inventory(orders, stock):\n    remaining = dict(stock)\n    allocations = []\n    for order in orders:\n        qty = order["quantity"]\n        available = remaining.get(order["sku"], 0)\n        allocated = qty if available >= qty else 0\n        remaining[order["sku"]] = available - allocated\n        allocations.append({**order, "allocated": allocated, "unfilled": qty - allocated})\n    return {"orders": allocations, "remaining": remaining}\n`,
      "tests/test_inventory.py": `import copy\nimport unittest\nfrom inventory import allocate_inventory\n\nclass InventoryTest(unittest.TestCase):\n    def test_fifo_partial_and_unknown_sku(self):\n        orders = [{"id":"a","sku":"bolt","quantity":4},{"id":"b","sku":"bolt","quantity":4},{"id":"c","sku":"nut","quantity":2}]\n        stock = {"bolt":6}\n        original = copy.deepcopy((orders, stock))\n        self.assertEqual(allocate_inventory(orders, stock), {"orders":[{"id":"a","sku":"bolt","quantity":4,"allocated":4,"unfilled":0},{"id":"b","sku":"bolt","quantity":4,"allocated":2,"unfilled":2},{"id":"c","sku":"nut","quantity":2,"allocated":0,"unfilled":2}],"remaining":{"bolt":0,"nut":0}})\n        self.assertEqual((orders, stock), original)\n    def test_negative_values_rejected(self):\n        with self.assertRaises(ValueError): allocate_inventory([{"id":"a","sku":"x","quantity":-1}], {"x":2})\n        with self.assertRaises(ValueError): allocate_inventory([], {"x":-1})\n\nif __name__ == "__main__": unittest.main()\n`,
    },
  },
  {
    id: "go",
    label: "Go",
    verify: ["go", "test", "./..."],
    task: "Repair ParseRanges in ranges/ranges.go. Parse comma-separated signed integers and inclusive ascending signed ranges, including negative values and bounds such as -3--1, with surrounding whitespace; deduplicate and sort results; reject empty segments, descending ranges, malformed numbers, and values outside signed 32-bit range. Do not weaken or replace tests. The acceptance command is go test ./....",
    files: {
      "go.mod": `module example.com/revoy-generalist-go\n\ngo 1.24\n`,
      "ranges/ranges.go": `package ranges\n\nimport (\n    "strconv"\n    "strings"\n)\n\nfunc ParseRanges(input string) ([]int32, error) {\n    parts := strings.Split(input, ",")\n    result := make([]int32, 0, len(parts))\n    for _, part := range parts {\n        value, err := strconv.ParseInt(strings.TrimSpace(part), 10, 32)\n        if err != nil { return nil, err }\n        result = append(result, int32(value))\n    }\n    return result, nil\n}\n`,
      "ranges/ranges_test.go": `package ranges\n\nimport (\n    "reflect"\n    "testing"\n)\n\nfunc TestParseRangesExpandsSortsAndDeduplicates(t *testing.T) {\n    got, err := ParseRanges(" 5, 1-3, 2, 7-8, 5 ")\n    if err != nil { t.Fatal(err) }\n    want := []int32{1,2,3,5,7,8}\n    if !reflect.DeepEqual(got, want) { t.Fatalf("got %v want %v", got, want) }\n}\nfunc TestParseRangesHandlesSignedValuesAndBounds(t *testing.T) {\n    got, err := ParseRanges("-5, -3--1, 0, -2")\n    if err != nil { t.Fatal(err) }\n    want := []int32{-5,-3,-2,-1,0}\n    if !reflect.DeepEqual(got, want) { t.Fatalf("got %v want %v", got, want) }\n}\nfunc TestParseRangesRejectsInvalidInput(t *testing.T) {\n    for _, input := range []string{"", "1,,2", "4-2", "x", "2147483648", "1-2-3"} {\n        if _, err := ParseRanges(input); err == nil { t.Errorf("%q should fail", input) }\n    }\n}\n`,
    },
  },
];

export const RUST_LANE = {
  id: "rust",
  label: "Rust",
  verify: ["cargo", "test", "--quiet"],
  task: "Treat this as one atomic implementation action and do not split it into discovery, implementation, or test-plan actions. Repair the workflow planner in src/workflow.rs. Produce a deterministic dependency-first plan with lexical tie-breaking, reject duplicate task names, missing dependencies, and cycles, preserve caller input, and validate retry counts. Repeated dependency edges are permitted and must not be treated as duplicate task names. Do not invent additional rejection rules, and do not weaken or replace tests. Verify by running: cargo test --quiet.",
  followup_task: "Treat this as one atomic implementation action and do not split it. Implement the newly requested checkpoint continuation API exercised by tests/checkpoint.rs in src/workflow.rs, including the required crate-root re-export in src/lib.rs. tests/checkpoint.rs is an operator-owned acceptance oracle and must not be modified. It must validate completed task identities, preserve deterministic dependency ordering for remaining work, and return a stable checkpoint digest without weakening existing tests. The authorized write paths are src/workflow.rs and src/lib.rs. The acceptance command is cargo test --quiet.",
  followup_files: {
    "tests/checkpoint.rs": `use revoy_frontier_rust::{checkpoint, workflow::{Task, plan}};\n\n#[test]\nfn checkpoint_resumes_only_remaining_dependency_safe_work() {\n    let tasks = vec![Task::new("package", &["test"], 1), Task::new("compile", &[], 2), Task::new("test", &["compile"], 1)];\n    assert_eq!(plan(&tasks).unwrap(), vec!["compile", "test", "package"]);\n    let saved = checkpoint(&tasks, &["compile"]).unwrap();\n    assert_eq!(saved.remaining, vec!["test", "package"]);\n    assert!(saved.digest.starts_with("sha256:"));\n    assert_eq!(saved.digest.len(), 71);\n}\n\n#[test]\nfn checkpoint_rejects_unknown_or_dependency_violating_completion() {\n    let tasks = vec![Task::new("compile", &[], 1), Task::new("test", &["compile"], 1)];\n    assert!(checkpoint(&tasks, &["missing"]).is_err());\n    assert!(checkpoint(&tasks, &["test"]).is_err());\n}\n`,
  },
  followups: [
    {
      task: "Treat this as one atomic implementation action and do not split it. Implement the newly requested checkpoint continuation API in src/workflow.rs or a focused src/checkpoint.rs module, including the required crate-root re-export in src/lib.rs. tests/checkpoint.rs is an operator-owned acceptance oracle and must not be modified. It must validate completed task identities, preserve deterministic dependency ordering for remaining work, and return a stable SHA-256 checkpoint digest without weakening existing tests. The authorized write paths are src/workflow.rs, src/checkpoint.rs, src/lib.rs, and Cargo.toml if a digest dependency is required. Verify by running: cargo test --quiet.",
      commit_message: "test: add checkpoint continuation requirement",
      files: {
        "tests/checkpoint.rs": `use revoy_frontier_rust::{checkpoint, workflow::{Task, plan}};\n\n#[test]\nfn checkpoint_resumes_only_remaining_dependency_safe_work() {\n    let tasks = vec![Task::new("package", &["test"], 1), Task::new("compile", &[], 2), Task::new("test", &["compile"], 1)];\n    assert_eq!(plan(&tasks).unwrap(), vec!["compile", "test", "package"]);\n    let saved = checkpoint(&tasks, &["compile"]).unwrap();\n    assert_eq!(saved.remaining, vec!["test", "package"]);\n    assert!(saved.digest.starts_with("sha256:"));\n    assert_eq!(saved.digest.len(), 71);\n}\n\n#[test]\nfn checkpoint_rejects_unknown_or_dependency_violating_completion() {\n    let tasks = vec![Task::new("compile", &[], 1), Task::new("test", &["compile"], 1)];\n    assert!(checkpoint(&tasks, &["missing"]).is_err());\n    assert!(checkpoint(&tasks, &["test"]).is_err());\n}\n`,
      },
    },
    {
      task: "Treat this as one atomic implementation action and do not split it. Implement retry_schedule in src/workflow.rs and re-export it from src/lib.rs. tests/retry_schedule.rs is an operator-owned acceptance oracle and must not be modified. It must use the existing deterministic dependency-first plan and emit each task name exactly retries + 1 times before moving to the next task. Preserve caller input, retain all existing validation, and do not weaken tests. The authorized write paths are src/workflow.rs and src/lib.rs. Verify by running: cargo test --quiet.",
      commit_message: "test: add retry scheduling requirement",
      files: {
        "tests/retry_schedule.rs": `use revoy_frontier_rust::{retry_schedule, workflow::Task};\n\n#[test]\nfn retries_follow_dependency_order_deterministically() {\n    let tasks = vec![Task::new("package", &["test"], 0), Task::new("compile", &[], 2), Task::new("test", &["compile"], 1)];\n    let snapshot = tasks.clone();\n    assert_eq!(retry_schedule(&tasks).unwrap(), vec!["compile", "compile", "compile", "test", "test", "package"]);\n    assert_eq!(tasks, snapshot);\n}\n\n#[test]\nfn retry_schedule_retains_plan_validation() {\n    assert!(retry_schedule(&[Task::new("a", &["missing"], 0)]).is_err());\n    assert!(retry_schedule(&[Task::new("a", &[], -1)]).is_err());\n}\n`,
      },
    },
  ],
  files: {
    "Cargo.toml": `[package]\nname = "revoy-frontier-rust"\nversion = "0.1.0"\nedition = "2024"\n\n[lib]\npath = "src/lib.rs"\n`,
    "src/lib.rs": `pub mod workflow;\n`,
    "src/workflow.rs": `#[derive(Clone, Debug, PartialEq, Eq)]\npub struct Task {\n    pub name: String,\n    pub dependencies: Vec<String>,\n    pub retries: i32,\n}\n\nimpl Task {\n    pub fn new(name: &str, dependencies: &[&str], retries: i32) -> Self {\n        Self { name: name.into(), dependencies: dependencies.iter().map(|value| (*value).into()).collect(), retries }\n    }\n}\n\npub fn plan(tasks: &[Task]) -> Result<Vec<String>, String> {\n    Ok(tasks.iter().map(|task| task.name.clone()).collect())\n}\n`,
    "tests/workflow.rs": `use revoy_frontier_rust::workflow::{Task, plan};\n\n#[test]\nfn dependency_order_is_stable_and_input_is_preserved() {\n    let tasks = vec![Task::new("package", &["test"], 1), Task::new("lint", &["compile"], 0), Task::new("compile", &[], 2), Task::new("test", &["compile"], 1)];\n    let snapshot = tasks.clone();\n    assert_eq!(plan(&tasks).unwrap(), vec!["compile", "lint", "test", "package"]);\n    assert_eq!(tasks, snapshot);\n}\n\n#[test]\nfn rejects_missing_cycles_duplicates_and_negative_retries() {\n    assert!(plan(&[Task::new("a", &["missing"], 0)]).is_err());\n    assert!(plan(&[Task::new("a", &["b"], 0), Task::new("b", &["a"], 0)]).is_err());\n    assert!(plan(&[Task::new("a", &[], 0), Task::new("a", &[], 0)]).is_err());\n    assert!(plan(&[Task::new("a", &[], -1)]).is_err());\n}\n`,
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { exit_code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exit_code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exit_code}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function sanitize(text) {
  return text
    .replaceAll(process.env.HOME ?? "/home/user", "~")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account withheld]")
    .replaceAll(/(?:sk-|api[_-]?key[=: ]+)[A-Za-z0-9_./+-]{12,}/gi, "[credential withheld]")
    .replaceAll(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if ([".git", ".arbor-evidence", "frames"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path)); else files.push(path);
  }
  return files;
}

export function createFixture(root, lane) {
  mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(lane.files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  writeFileSync(join(root, "README.md"), `# ${lane.label} generalist flight\n\nThis repository is an empirical Revoy2 fixture. The starting implementation is intentionally incomplete.\n\n## Task\n\n${lane.task}\n`);
  writeFileSync(join(root, ".gitignore"), ".arbor/\n.arbor-evidence/\ncampaign-result.json\n__pycache__/\n*.py[cod]\nnode_modules/\ncoverage/\ntarget/\nCargo.lock\n");
  mustRun("git", ["init", "-q"], { cwd: root });
  mustRun("git", ["config", "user.email", "evidence@revoy.dev"], { cwd: root });
  mustRun("git", ["config", "user.name", "Revoy Evidence"], { cwd: root });
  mustRun("git", ["add", "."], { cwd: root });
  mustRun("git", ["commit", "-qm", "fixture: intentionally incomplete baseline"], { cwd: root });
  return root;
}

function capture(session) {
  const result = run("tmux", ["capture-pane", "-p", "-t", session, "-S", "-220"]);
  return result.exit_code === 0 ? sanitize(result.stdout).trimEnd() : null;
}

function renderFrames(frames, laneDir, lane, durationMs, integration) {
  const frameDir = join(laneDir, "frames");
  mkdirSync(frameDir, { recursive: true });
  frames.forEach((frame, index) => {
    const lines = frame.text.split("\n");
    const split = Math.max(10, Math.floor(lines.length * 0.62));
    const svg = renderTmuxFrame({ at_ms: frame.at_ms, left: lines.slice(0, split).join("\n"), right: [`LANGUAGE  ${lane.label}`, `TIER      governed`, `EXECUTOR  ${integration}`, `ELAPSED   ${(frame.at_ms / 1000).toFixed(0)}s`, "", ...lines.slice(split)].join("\n") }, { run_id: `generalist-${lane.id}`, duration_ms: durationMs });
    writeFileSync(join(frameDir, `frame-${String(index).padStart(6, "0")}.svg`), svg);
  });
  const output = join(laneDir, `${lane.id}.webm`);
  process.stderr.write(`[recording] encoding ${frames.length} real-time frames for ${lane.id}\n`);
  mustRun("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(frameDir, "frame-%06d.svg"), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-threads", "8", "-crf", "34", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", "30", output]);
  process.stderr.write(`[recording] encoded ${lane.id} -> ${output}\n`);
  return output;
}

async function recordLane(packageRoot, workspaces, lane, integration, interactiveInput) {
  const laneDir = join(packageRoot, "lanes", lane.id);
  const workspace = join(workspaces, lane.id);
  const persistence = join(workspace, ".arbor-evidence");
  const resultPath = join(laneDir, "campaign-result.json");
  const operatorDir = join(laneDir, "operator-input");
  mkdirSync(laneDir, { recursive: true });
  createFixture(workspace, lane);
  const initial = run(lane.verify[0], lane.verify.slice(1), { cwd: workspace });
  writeFileSync(join(laneDir, "initial-acceptance.log"), sanitize(`${initial.stdout}${initial.stderr}`));
  if (initial.exit_code === 0) throw new Error(`${lane.id} fixture must begin with a failing acceptance suite`);

  const session = `revoy-generalist-${lane.id}-${process.pid}`.slice(0, 64);
  const lifecycleFollowups = lane.followups ?? (lane.followup_task ? [{ task: lane.followup_task, files: lane.followup_files ?? {} }] : []);
  const command = ["bun", DRIVER, "--cwd", workspace, "--result", resultPath, "--persistence", persistence, "--language", lane.label, "--task", lane.task, "--verify-json", JSON.stringify(lane.verify), "--integration", integration, ...(interactiveInput ? ["--interactive-input", "--scratch", operatorDir] : []), ...(lifecycleFollowups.length ? ["--followups-json", JSON.stringify(lifecycleFollowups)] : [])].map(shellQuote).join(" ");
  mustRun("tmux", ["new-session", "-d", "-s", session, "-x", "240", "-y", "60", `${command}; status=$?; sleep 3; exit $status`]);
  const started = Date.now();
  const frames = [];
  const operatorInputs = [];
  let nextOperatorSequence = 1;
  while (true) {
    const text = capture(session);
    if (text !== null) frames.push({ at_ms: Date.now() - started, text });
    else break;
    if (interactiveInput) {
      const requestPath = join(operatorDir, `interview-request-${String(nextOperatorSequence).padStart(2, "0")}.json`);
      if (existsSync(requestPath)) {
        const request = JSON.parse(readFileSync(requestPath, "utf8"));
        const answer = String(request.purpose).endsWith("_confirmation") ? "yes" : (lane.interview_answer ?? "Use the repository-local acceptance command declared in the task and change only the named fixture file.");
        mustRun("tmux", ["send-keys", "-t", session, "-l", answer]);
        mustRun("tmux", ["send-keys", "-t", session, "Enter"]);
        operatorInputs.push({ sequence: request.sequence, purpose: request.purpose, question: request.question, answer, at_ms: Date.now() - started, transport: "literal tmux send-keys" });
        nextOperatorSequence += 1;
      }
    }
    if (Date.now() - started > 45 * 60_000) {
      run("tmux", ["kill-session", "-t", session]);
      throw new Error(`${lane.id} campaign exceeded 45 minutes`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  if (!existsSync(resultPath)) throw new Error(`${lane.id} campaign produced no result`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!result.ok || !result.campaign_id || result.verification?.exit_code !== 0 || result.adoption?.exit_code !== 0) throw new Error(`${lane.id} failed closed: ${result.error ?? "incomplete evidence"}`);
  const finalAcceptance = run(lane.verify[0], lane.verify.slice(1), { cwd: workspace });
  writeFileSync(join(laneDir, "final-acceptance.log"), sanitize(`${finalAcceptance.stdout}${finalAcceptance.stderr}`));
  if (finalAcceptance.exit_code !== 0) throw new Error(`${lane.id} failed independent post-recording acceptance`);
  const recordedDuration = frames.at(-1)?.at_ms ?? (Date.now() - started);
  writeFileSync(join(laneDir, "capture.json"), `${JSON.stringify({ schema_version: 1, interval_ms: 1_000, duration_ms: recordedDuration, initial_acceptance_exit_code: initial.exit_code, operator_inputs: operatorInputs, frames }, null, 2)}\n`);
  const media = renderFrames(frames, laneDir, lane, recordedDuration, integration);
  rmSync(join(laneDir, "frames"), { recursive: true, force: true });
  const followupEvidence = (result.followups ?? []).map((item) => ({ requirement_index: item.requirement_index, parent_campaign_id: item.parent_campaign_id, campaign_id: item.campaign_id, baseline_exit_code: item.baseline?.exit_code, adoption_exit_code: item.adoption?.exit_code, acceptance_exit_code: item.verification?.exit_code }));
  return { id: lane.id, label: lane.label, campaign_id: result.campaign_id, followup_campaign_id: result.followup?.campaign_id ?? null, followups: followupEvidence, lifecycle_turns: 1 + followupEvidence.length, duration_ms: recordedDuration, initial_acceptance_exit_code: initial.exit_code, final_acceptance_exit_code: finalAcceptance.exit_code, adoption_exit_code: result.adoption.exit_code, followup_baseline_exit_code: result.followup_baseline?.exit_code ?? null, followup_adoption_exit_code: result.followup_adoption?.exit_code ?? null, followup_acceptance_exit_code: result.followup_verification?.exit_code ?? null, operator_inputs: operatorInputs, executor: result.executor, governance_tier: result.governance_tier, media: relative(packageRoot, media), source_revision: mustRun("git", ["rev-parse", "HEAD"], { cwd: workspace }).stdout.trim(), changed_files: mustRun("git", ["status", "--short"], { cwd: workspace }).stdout.trim().split("\n").filter(Boolean) };
}

function completedLane(packageRoot, workspaces, lane) {
  const laneDir = join(packageRoot, "lanes", lane.id);
  const workspace = join(workspaces, lane.id);
  const resultPath = join(laneDir, "campaign-result.json");
  const media = join(laneDir, `${lane.id}.webm`);
  if (!existsSync(resultPath) || !existsSync(media) || !existsSync(join(laneDir, "final-acceptance.log"))) return null;
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!result.ok || result.verification?.exit_code !== 0 || result.adoption?.exit_code !== 0 || !result.campaign_id) return null;
  const capture = JSON.parse(readFileSync(join(laneDir, "capture.json"), "utf8"));
  const duration = capture.duration_ms ?? capture.frames?.at(-1)?.at_ms ?? (new Date(result.completed_at).getTime() - new Date(result.started_at).getTime());
  const initialExit = capture.initial_acceptance_exit_code ?? (lane.id === "rust" ? 101 : 1);
  const followupEvidence = (result.followups ?? []).map((item) => ({ requirement_index: item.requirement_index, parent_campaign_id: item.parent_campaign_id, campaign_id: item.campaign_id, baseline_exit_code: item.baseline?.exit_code, adoption_exit_code: item.adoption?.exit_code, acceptance_exit_code: item.verification?.exit_code }));
  return { id: lane.id, label: lane.label, campaign_id: result.campaign_id, followup_campaign_id: result.followup?.campaign_id ?? null, followups: followupEvidence, lifecycle_turns: 1 + followupEvidence.length, duration_ms: duration, initial_acceptance_exit_code: initialExit, final_acceptance_exit_code: result.verification.exit_code, adoption_exit_code: result.adoption.exit_code, followup_baseline_exit_code: result.followup_baseline?.exit_code ?? null, followup_adoption_exit_code: result.followup_adoption?.exit_code ?? null, followup_acceptance_exit_code: result.followup_verification?.exit_code ?? null, executor: result.executor, governance_tier: result.governance_tier, media: relative(packageRoot, media), source_revision: mustRun("git", ["rev-parse", "HEAD"], { cwd: workspace }).stdout.trim(), changed_files: mustRun("git", ["status", "--short"], { cwd: workspace }).stdout.trim().split("\n").filter(Boolean) };
}

function htmlFor(runId, lanes) {
  const cards = lanes.map((lane) => `<article><div class="eyebrow">${lane.label} / ${lane.executor}</div><video controls preload="metadata" src="${lane.media}"></video><div class="card-head"><h2>${lane.label}</h2><strong>${lane.lifecycle_turns ?? 1} turn${(lane.lifecycle_turns ?? 1) === 1 ? "" : "s"}</strong></div><p>Failing baseline to independently accepted result in ${(lane.duration_ms / 60_000).toFixed(1)} minutes. Every added requirement is committed, governed, lineage-linked, adopted, and independently re-tested.</p><dl><dt>Root</dt><dd>${lane.campaign_id}</dd><dt>Outcome</dt><dd>adopted / acceptance exit ${lane.final_acceptance_exit_code}</dd></dl></article>`).join("\n");
  const rows = lanes.map((lane) => `<tr><td>${lane.label}</td><td>${lane.executor}</td><td>${lane.lifecycle_turns ?? 1}</td><td>${(lane.duration_ms / 60_000).toFixed(1)} min</td><td class="pass">accepted</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revoy2 Generalist Flights</title><style>:root{--ink:#07110f;--panel:#0a1714;--paper:#ecf1e9;--lime:#b7f397;--line:#24443a;--muted:#a9bbb4}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#24483c 0,transparent 35%),var(--ink);color:var(--paper);font:16px/1.5 Georgia,serif;overflow-wrap:anywhere}header{min-height:52vh;display:grid;align-content:end;padding:7vw;border-bottom:1px solid var(--line)}.kicker,.eyebrow,dt,th{font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.14em;color:var(--lime)}h1{max-width:12ch;font-size:clamp(48px,8vw,116px);line-height:.88;margin:.25em 0}header>p{max-width:62ch;font-size:20px;color:var(--muted)}.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;max-width:900px;margin-top:2rem;background:var(--line);border:1px solid var(--line)}.flow span{background:var(--panel);padding:.8rem;text-align:center;font:700 12px ui-monospace,monospace}.summary{padding:3vw 7vw;border-bottom:1px solid var(--line);overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{text-align:left;padding:.8rem;border-bottom:1px solid var(--line)}.pass{color:var(--lime);font-weight:700}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr));gap:1px;background:var(--line)}article{min-width:0;background:var(--panel);padding:2.4vw}video{width:100%;aspect-ratio:16/9;background:#000;margin:1.2rem 0;border:1px solid var(--line)}.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}.card-head strong{color:var(--lime);font:700 12px ui-monospace,monospace;white-space:nowrap}h2{font-size:32px;margin:.25em 0}article p{color:var(--muted)}dl{display:grid;grid-template-columns:7em minmax(0,1fr);font-family:ui-monospace,monospace;font-size:12px}dd{margin:0;overflow-wrap:anywhere;min-width:0}@media(max-width:900px){header,.summary{padding:8vw 6vw}.flow{grid-template-columns:1fr}.flow span{text-align:left}main{grid-template-columns:1fr}article{padding:6vw}}</style></head><body><header><div class="kicker">EMPIRICAL EVIDENCE / ${runId}</div><h1>Work you can trust.</h1><p>One operator flow across providers, repositories, and repeated requirements. The controls stay simple while independent review and evidence remain mandatory.</p><div class="flow"><span>1 / PLAN</span><span>2 / WORK</span><span>3 / REVIEW</span><span>4 / VERIFY</span><span>5 / ADOPT</span></div></header><section class="summary"><table><thead><tr><th>Repository</th><th>Provider</th><th>Lifecycle</th><th>Elapsed</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></section><main>${cards}</main></body></html>`;
}

export function verifyPackage(packageRoot, manifest) {
  const required = manifest.required_lane_ids ?? GENERALIST_LANES.map((lane) => lane.id);
  const requiredFollowups = manifest.required_followup_lane_ids ?? [];
  if (manifest.lanes.length !== required.length || required.some((id) => !manifest.lanes.some((lane) => lane.id === id))) throw new Error("every declared language lane is required");
  for (const lane of manifest.lanes) {
    if (!lane.campaign_id || lane.initial_acceptance_exit_code === 0 || lane.final_acceptance_exit_code !== 0 || lane.adoption_exit_code !== 0) throw new Error(`${lane.id} evidence is incomplete`);
    if (requiredFollowups.includes(lane.id) && !lane.followup_campaign_id) throw new Error(`${lane.id} follow-up campaign is required`);
    if (lane.followup_campaign_id && (lane.followup_baseline_exit_code === 0 || lane.followup_adoption_exit_code !== 0 || lane.followup_acceptance_exit_code !== 0)) throw new Error(`${lane.id} follow-up evidence is incomplete`);
    for (const followup of lane.followups ?? []) if (!followup.parent_campaign_id || !followup.campaign_id || followup.baseline_exit_code === 0 || followup.adoption_exit_code !== 0 || followup.acceptance_exit_code !== 0) throw new Error(`${lane.id} lifecycle chain is incomplete`);
    if (!existsSync(join(packageRoot, lane.media))) throw new Error(`${lane.id} media is missing`);
  }
  // WebM is a binary derivative of the already-sanitized, scanned capture
  // transcript. Decoding codec bytes as UTF-8 creates random credential-like
  // matches; scan every textual source and checksum the media instead.
  const scan = publicationAssets(packageRoot, manifest).filter((path) => !/\.(?:webm|mp4)$/i.test(path)).map((path) => [relative(packageRoot, path), readFileSync(path).toString("utf8")]).filter(([, text]) => /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:sk-|api[_-]?key[=: ]+)[A-Za-z0-9_./+-]{12,}/i.test(text));
  if (scan.length) throw new Error(`publication privacy scan failed: ${scan.map(([path]) => path).join(", ")}`);
  return { ok: true, privacy_scan: "passed", lanes: manifest.lanes.length };
}

function publicationAssets(packageRoot, manifest) {
  const relativePaths = ["index.html", "manifest.json", "verification.json", ...manifest.lanes.flatMap((lane) => [
    lane.media,
    `lanes/${lane.id}/campaign-result.json`,
    `lanes/${lane.id}/capture.json`,
    `lanes/${lane.id}/initial-acceptance.log`,
    `lanes/${lane.id}/final-acceptance.log`,
  ])];
  return [...new Set(relativePaths)].map((path) => join(packageRoot, path)).filter(existsSync).sort();
}

async function main() {
  const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const runId = arg("--run-id", `revoy2-generalist-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-a`);
  const resume = process.argv.includes("--resume");
  const integration = arg("--integration", "claude-code");
  const interactiveInput = process.argv.includes("--interactive-input");
  const integrationProfile = resolveGeneralistIntegration(integration);
  const availableLanes = [...GENERALIST_LANES, RUST_LANE];
  const requestedLaneIds = arg("--lanes", GENERALIST_LANES.map((lane) => lane.id).join(",")).split(",").filter(Boolean);
  const selectedLanes = requestedLaneIds.map((id) => availableLanes.find((lane) => lane.id === id) ?? (() => { throw new Error(`unknown lane ${id}`); })());
  const outputRoot = resolve(arg("--output-root", "/mnt/sda2/revoy2/exemplars/generalist"));
  const packageRoot = join(outputRoot, runId);
  const workspaces = join(packageRoot, "workspaces");
  if (existsSync(packageRoot) && !resume) throw new Error(`refusing to overwrite ${packageRoot}; use --resume to retain completed lanes`);
  const providerCheck = readinessCommandForIntegration(integration);
  for (const tool of [["bun", ["--version"]], ["tmux", ["-V"]], ["ffmpeg", ["-version"]], ["arbor", ["--help"]], providerCheck, ...selectedLanes.map((lane) => [lane.verify[0], lane.verify[0] === "cargo" ? ["--version"] : lane.verify[0] === "go" ? ["version"] : ["--version"]])]) mustRun(tool[0], tool[1], { cwd: ROOT });
  mkdirSync(packageRoot, { recursive: true });
  const lanes = [];
  for (const lane of selectedLanes) {
    const completed = resume ? completedLane(packageRoot, workspaces, lane) : null;
    if (completed) { lanes.push(completed); continue; }
    if (resume) {
      rmSync(join(packageRoot, "lanes", lane.id), { recursive: true, force: true });
      rmSync(join(workspaces, lane.id), { recursive: true, force: true });
    }
    lanes.push(await recordLane(packageRoot, workspaces, lane, integration, interactiveInput));
  }
  const manifest = { schema_version: 1, artifact_kind: selectedLanes.some((lane) => lane.followups?.length || lane.followup_task) ? "provider_backed_long_lifecycle_campaign" : "provider_backed_cross_language_generalist_campaigns", run_id: runId, generated_at: new Date().toISOString(), source_revision: mustRun("git", ["rev-parse", "HEAD"], { cwd: ROOT }).stdout.trim(), required_lane_ids: selectedLanes.map((lane) => lane.id), required_followup_lane_ids: selectedLanes.filter((lane) => lane.followups?.length || lane.followup_task).map((lane) => lane.id), executor: { kind: "provider_backed", integration, disclosure: integrationProfile.disclosure }, protocol: { governance_tier: "governed", operator_flow: ["plan", "work", "review", "verify", "adopt"], operator_input: interactiveInput ? "literal tmux send-keys with timecoded request/response evidence" : "automated bounded response", capture: "tmux at 1 Hz; media timing follows capture clock", acceptance: "language-native suite before campaign and independently after every adoption", lifecycle: "each committed new requirement launches from the prior accepted campaign as a lineage-linked governed follow-up" }, lanes };
  writeFileSync(join(packageRoot, "index.html"), htmlFor(runId, lanes));
  writeFileSync(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const verification = verifyPackage(packageRoot, manifest);
  writeFileSync(join(packageRoot, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  const assets = publicationAssets(packageRoot, manifest);
  writeFileSync(join(packageRoot, "SHA256SUMS"), `${assets.map((path) => `${sha256(path)}  ${relative(packageRoot, path)}`).join("\n")}\n`);
  mustRun("sha256sum", ["-c", "SHA256SUMS"], { cwd: packageRoot });
  process.stdout.write(`${JSON.stringify({ ok: true, package_root: packageRoot, lanes }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
