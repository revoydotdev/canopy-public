/**
 * packages/arbor-eval/tests/live-tasks.test.ts — the suite that keeps the
 * ablation's instrument honest.
 *
 * Two directions, and BOTH matter (ADR-157):
 *
 *   1. Every task's shipped broken source must FAIL its own verification. A
 *      task that already passes is a free win handed to every arm, and it
 *      silently inflates all of them equally so nothing looks wrong.
 *   2. Every task must have a reference solution that PASSES. Without this a
 *      task whose spec is self-contradictory, or whose verify script is simply
 *      wrong, would read as "hard" forever and every arm would fail it. That is
 *      the more dangerous direction: an unsolvable task looks exactly like a
 *      difficult one in the aggregate, and it drags every arm's success rate
 *      toward zero while destroying the instrument's ability to separate them.
 *
 * The reference solutions live here rather than beside the tasks deliberately:
 * they are test data, and shipping them next to the prompts would risk them
 * reaching a model.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLiveTasks, summarizeFeedback, type LiveEvalTask } from "../src/live-tasks.js";

/** A known-correct implementation of each task's target file. */
const REFERENCE_SOLUTIONS: Readonly<Record<string, string>> = {
  "live-sort-nomutate": "export function sortAsc(values) {\n  return [...values].sort((a, b) => a - b);\n}\n",
  "live-deep-merge":
    "function isPlain(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }\n" +
    "export function deepMerge(base, override) {\n" +
    "  const out = { ...base };\n" +
    "  for (const key of Object.keys(override)) {\n" +
    "    const o = override[key];\n" +
    "    out[key] = isPlain(o) && isPlain(base[key]) ? deepMerge(base[key], o) : isPlain(o) ? deepMerge({}, o) : o;\n" +
    "  }\n" +
    "  return out;\n" +
    "}\n",
  "live-group-order":
    "export function groupBy(items, keyFn) {\n" +
    "  const out = new Map();\n" +
    "  for (const item of items) {\n" +
    "    const k = keyFn(item);\n" +
    "    if (!out.has(k)) out.set(k, []);\n" +
    "    out.get(k).push(item);\n" +
    "  }\n" +
    "  return out;\n" +
    "}\n",
  "live-clamp-signed-zero":
    "export function clamp(value, min, max) {\n" +
    "  if (Number.isNaN(value)) return min;\n" +
    "  if (value < min || Object.is(value, -0) && min >= 0) return min;\n" +
    "  return value > max ? max : value;\n" +
    "}\n",
  "live-parse-duration":
    "const UNITS = { h: 3600, m: 60, s: 1 };\n" +
    "export function parseDuration(text) {\n" +
    "  if (!/^(\\d+[hms])+$/.test(text)) return null;\n" +
    "  let total = 0;\n" +
    "  for (const m of text.matchAll(/(\\d+)([hms])/g)) total += Number(m[1]) * UNITS[m[2]];\n" +
    "  return total;\n" +
    "}\n",
  "live-interval-merge":
    "export function mergeIntervals(intervals) {\n" +
    "  const sorted = intervals.map((p) => [...p]).sort((a, b) => a[0] - b[0]);\n" +
    "  const out = [];\n" +
    "  for (const [s, e] of sorted) {\n" +
    "    const last = out[out.length - 1];\n" +
    "    if (last && s <= last[1]) last[1] = Math.max(last[1], e);\n" +
    "    else out.push([s, e]);\n" +
    "  }\n" +
    "  return out;\n" +
    "}\n",
  "live-range-exclusive":
    "export function range(start, end) {\n" +
    "  const out = [];\n" +
    "  for (let i = start; i < end; i++) out.push(i);\n" +
    "  return out;\n" +
    "}\n",
  "live-dedupe-linear":
    "export function dedupe(values) {\n" +
    "  const seen = new Set();\n" +
    "  const out = [];\n" +
    "  for (const v of values) if (!seen.has(v)) { seen.add(v); out.push(v); }\n" +
    "  return out;\n" +
    "}\n",
  "live-cross-file-normalize":
    "export function normalizeTag(tag) {\n" +
    "  return tag.trim().toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');\n" +
    "}\n",
  "live-heldout-semver-compare":
    "function cmpIdent(a, b) {\n" +
    "  const na = /^\\d+$/.test(a), nb = /^\\d+$/.test(b);\n" +
    "  if (na && nb) return Number(a) === Number(b) ? 0 : Number(a) < Number(b) ? -1 : 1;\n" +
    "  if (na) return -1;\n" +
    "  if (nb) return 1;\n" +
    "  return a === b ? 0 : a < b ? -1 : 1;\n" +
    "}\n" +
    "export function compareSemver(a, b) {\n" +
    "  const [ca, pa = null] = a.split('-', 2).length > 1 ? [a.slice(0, a.indexOf('-')), a.slice(a.indexOf('-') + 1)] : [a, null];\n" +
    "  const [cb, pb = null] = b.split('-', 2).length > 1 ? [b.slice(0, b.indexOf('-')), b.slice(b.indexOf('-') + 1)] : [b, null];\n" +
    "  const na = ca.split('.').map(Number), nb = cb.split('.').map(Number);\n" +
    "  for (let i = 0; i < 3; i++) { if (na[i] !== nb[i]) return na[i] < nb[i] ? -1 : 1; }\n" +
    "  if (pa === null && pb === null) return 0;\n" +
    "  if (pa === null) return 1;\n" +
    "  if (pb === null) return -1;\n" +
    "  const ia = pa.split('.'), ib = pb.split('.');\n" +
    "  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {\n" +
    "    const c = cmpIdent(ia[i], ib[i]);\n" +
    "    if (c !== 0) return c;\n" +
    "  }\n" +
    "  return ia.length === ib.length ? 0 : ia.length < ib.length ? -1 : 1;\n" +
    "}\n",
  "live-heldout-lru-cache":
    "export function createLRU(capacity) {\n" +
    "  const map = new Map();\n" +
    "  const touch = (key, value) => { map.delete(key); map.set(key, value); };\n" +
    "  return {\n" +
    "    get(key) {\n" +
    "      if (!map.has(key)) return undefined;\n" +
    "      const value = map.get(key);\n" +
    "      touch(key, value);\n" +
    "      return value;\n" +
    "    },\n" +
    "    set(key, value) {\n" +
    "      if (map.has(key)) { touch(key, value); return; }\n" +
    "      if (map.size >= capacity) map.delete(map.keys().next().value);\n" +
    "      map.set(key, value);\n" +
    "    },\n" +
    "  };\n" +
    "}\n",
  "live-heldout-topo-sort":
    "export function topoSort(nodes, edges) {\n" +
    "  const indegree = new Map(nodes.map((n) => [n, 0]));\n" +
    "  const next = new Map(nodes.map((n) => [n, []]));\n" +
    "  for (const [before, after] of edges) {\n" +
    "    next.get(before).push(after);\n" +
    "    indegree.set(after, indegree.get(after) + 1);\n" +
    "  }\n" +
    "  const out = [];\n" +
    "  const done = new Set();\n" +
    "  while (out.length < nodes.length) {\n" +
    "    const ready = nodes.find((n) => !done.has(n) && indegree.get(n) === 0);\n" +
    "    if (ready === undefined) return null;\n" +
    "    done.add(ready);\n" +
    "    out.push(ready);\n" +
    "    for (const m of next.get(ready)) indegree.set(m, indegree.get(m) - 1);\n" +
    "  }\n" +
    "  return out;\n" +
    "}\n",
  "live-heldout-path-normalize":
    "export function normalizePath(path) {\n" +
    "  const absolute = path.startsWith('/');\n" +
    "  const out = [];\n" +
    "  for (const seg of path.split('/')) {\n" +
    "    if (seg === '' || seg === '.') continue;\n" +
    "    if (seg === '..') {\n" +
    "      if (out.length === 0) return null;\n" +
    "      out.pop();\n" +
    "      continue;\n" +
    "    }\n" +
    "    out.push(seg);\n" +
    "  }\n" +
    "  if (out.length === 0) return absolute ? '/' : '.';\n" +
    "  return (absolute ? '/' : '') + out.join('/');\n" +
    "}\n",
};

function runTaskWith(task: LiveEvalTask, targetSource: string): { code: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), `live-task-${task.id}-`));
  try {
    task.setup_fixture(dir);
    writeFileSync(join(dir, task.target_relative_path), targetSource, "utf8");
    const command = task.verification(dir);
    const result = spawnSync(command.cmd, [...command.args], {
      cwd: command.cwd,
      encoding: "utf-8",
      timeout: command.timeout_ms,
    });
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The broken source each task ships, recovered by setting the fixture up untouched. */
function brokenSourceOf(task: LiveEvalTask): string {
  const dir = mkdtempSync(join(tmpdir(), `live-task-src-${task.id}-`));
  try {
    task.setup_fixture(dir);
    return require("node:fs").readFileSync(join(dir, task.target_relative_path), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the live task suite is a usable instrument", () => {
  it("has a held-out subset reserved, and enough of it to compare", () => {
    const heldOut = defaultLiveTasks.filter((task) => task.held_out);
    const calibration = defaultLiveTasks.filter((task) => !task.held_out);
    expect(calibration.length).toBeGreaterThanOrEqual(8);
    expect(heldOut.length).toBeGreaterThanOrEqual(4);
  });

  it("has unique task ids", () => {
    const ids = defaultLiveTasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a reference solution for every task, and no orphan solutions", () => {
    const ids = new Set(defaultLiveTasks.map((task) => task.id));
    for (const id of ids) expect(REFERENCE_SOLUTIONS[id], `missing reference solution for ${id}`).toBeTypeOf("string");
    for (const id of Object.keys(REFERENCE_SOLUTIONS)) expect(ids.has(id), `orphan reference solution ${id}`).toBe(true);
  });
});

describe("every task is genuinely broken", () => {
  // A task that already passes is a free win handed to every arm.
  it.each(defaultLiveTasks.map((task) => [task.id, task] as const))(
    "%s fails verification as shipped",
    (_id, task) => {
      const { code, output } = runTaskWith(task, brokenSourceOf(task));
      expect(code, `expected a non-zero exit, got ${code}. output:\n${output}`).not.toBe(0);
    },
  );
});

describe("every task is genuinely solvable", () => {
  // The more dangerous direction: an unsolvable task is indistinguishable from
  // a hard one in the aggregate, and drags every arm toward zero.
  it.each(defaultLiveTasks.map((task) => [task.id, task] as const))(
    "%s passes verification with its reference solution",
    (id, task) => {
      const { code, output } = runTaskWith(task, REFERENCE_SOLUTIONS[id]);
      expect(code, `reference solution did not pass. output:\n${output}`).toBe(0);
    },
  );
});

describe("failure feedback reaches the next attempt", () => {
  const task = defaultLiveTasks[0];

  it("is absent on the first attempt", () => {
    expect(task.prompt(0, null)).not.toMatch(/previous attempt/i);
  });

  it("carries the failing verification output, so an arm has something to learn from", () => {
    const prompt = task.prompt(1, { attempt: 0, exit_code: 1, stdout: "FAIL numeric order: got [1,10,100,9]", stderr: "" });
    expect(prompt).toContain("FAIL numeric order");
    expect(prompt).toMatch(/previous attempt \(#0\) FAILED/i);
  });

  it("truncates a runaway failure rather than letting it swallow the prompt", () => {
    const huge = "x".repeat(5000);
    const summary = summarizeFeedback({ attempt: 0, exit_code: 1, stdout: huge, stderr: huge });
    expect(summary.length).toBeLessThan(2000);
    expect(summary).toContain("truncated");
  });

  it("says nothing when there is nothing to say", () => {
    expect(summarizeFeedback(null)).toBe("");
  });
});
