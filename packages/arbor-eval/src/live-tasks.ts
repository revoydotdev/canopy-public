/**
 * arbor-eval/live-tasks — the live lane's real, verifiable task suite
 * (ADR-095 Decision 1: "a suite of real, verifiable coding problems ...
 * SWE-bench-style").
 *
 * Each task is a real, on-disk Node.js fixture with a genuinely broken
 * function and a real verification command (`node verify.mjs`) that exits 0
 * only when the fix is correct. Nothing here is scripted or hash-seeded:
 * `live-ablation.ts` writes whatever the model actually returns into
 * `target_relative_path` and then spawns `verification` for real
 * (`live-verification.ts`).
 *
 * WHY THE SUITE WAS REBUILT (ADR-157). The first suite was ten single-function
 * exercises: an off-by-one in a sum, a `reverse` whose broken body returned its
 * input unchanged, FizzBuzz with swapped conditions. A mid-tier model solves
 * essentially all of them on attempt 0. That is a ceiling effect, and it makes
 * the ablation unable to detect the thing it exists to detect: when attempt 0
 * succeeds there is nothing to backtrack from and no sibling branch to select
 * between, so every arm converges by construction and a null result says
 * nothing about search or governance. An instrument that cannot separate its
 * arms is not a weak instrument, it is not an instrument.
 *
 * WHAT MAKES A TASK DISCRIMINATING HERE. Difficulty alone is not enough; a task
 * nobody solves is as uninformative as one everybody solves. Each task below is
 * built for TENSION: an obvious fix that satisfies the headline requirement and
 * fails a second requirement the tests also check. That shape is what gives a
 * second attempt somewhere useful to go, and what lets an arm that carries
 * failure information forward beat one that does not.
 *
 * The patterns used, each represented more than once so no single trick carries
 * the suite:
 *   - a stated invariant the obvious implementation violates (no mutation)
 *   - a language trap (lexicographic `sort`, integer-like object keys, `-0`)
 *   - a second bug behind the first
 *   - a requirement stated only in the tests, contradicting the doc comment
 *   - a complexity bound enforced by a real timeout
 *   - a symptom in one file whose cause is in another
 *
 * A held-out subset (`held_out: true`) is reserved by ADR-095 Decision 3 to
 * never tune scoring constants (`exploration_constant`, `NO_BASELINE_EPSILON`
 * in `@arbor/core`'s `scoring.ts`) — this module makes no use of task outcomes
 * to adjust those constants, so the reservation is satisfied structurally;
 * `live-ablation.ts`'s report keeps held-out results segregated so nothing
 * downstream can quietly blur the line.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationCommand } from "./live-verification.js";

/**
 * What a previous failed attempt actually produced.
 *
 * WHY THIS EXISTS. Before it, `prompt(attempt)` appended only "a previous
 * attempt did not pass verification; try a different fix" — no failing output,
 * no diff, no indication of WHICH case broke. Every attempt was therefore a
 * near-independent draw, which makes all arms blind repeated sampling and
 * leaves tree search selecting between options it has no information to
 * distinguish. The comparison could not have come out any way but null.
 *
 * Feedback is given IDENTICALLY to every arm. It is not a thumb on the scale
 * for the governed or tree arms; it is the precondition for any arm to be able
 * to do better than chance, and withholding it equally from all of them is what
 * made the old instrument inert.
 */
export interface AttemptFeedback {
  readonly attempt: number;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LiveEvalTask {
  readonly id: string;
  readonly description: string;
  readonly held_out: boolean;
  /** File the model's returned text replaces, relative to the fixture root. */
  readonly target_relative_path: string;
  /** Writes the real, broken fixture files (including the verify script) into `dir`. */
  readonly setup_fixture: (dir: string) => void;
  /** The real command run against the fixture root after the fix is written. */
  readonly verification: (dir: string) => VerificationCommand;
  /**
   * `attempt` (0-based) lets arms request diverse branches from the same task;
   * `feedback` carries the failing output of the attempt this one follows FROM,
   * which for a tree arm is its selected branch's own lineage rather than
   * whatever failed most recently anywhere in the tree; `current_source` is the
   * CURRENT content of the target file in that branch's own workspace.
   *
   * `current_source` is what makes backtracking expressible. With one shared
   * directory and a full-file rewrite per attempt, every attempt is an i.i.d.
   * draw from the same pristine starting point, branches are indistinguishable,
   * and a tree arm has nothing to return TO. Per-branch workspaces give each
   * branch its own partial progress, so abandoning a poisoned line for a
   * different one is a real move with a different starting state.
   */
  readonly prompt: (attempt: number, feedback: AttemptFeedback | null, current_source?: string) => string;
}

const PROMPT_CONTRACT =
  "Reply with ONLY the corrected file's complete source text — no markdown fences, no commentary, no explanation.";

/** Keep a failing tail informative without letting one verbose run dominate the prompt. */
export function summarizeFeedback(feedback: AttemptFeedback | null): string {
  if (feedback === null) return "";
  const clip = (text: string, limit: number): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}\n…(truncated)`;
  const out = clip(feedback.stdout.trim(), 800);
  const err = clip(feedback.stderr.trim(), 400);
  const parts = [
    `Your previous attempt (#${feedback.attempt}) FAILED verification (exit ${feedback.exit_code}).`,
  ];
  if (out) parts.push(`Verification stdout:\n${out}`);
  if (err) parts.push(`Verification stderr:\n${err}`);
  parts.push("Read the failing case carefully and fix the ROOT cause. Do not repeat the same approach.");
  return `\n\n${parts.join("\n\n")}`;
}

function fixtureTask(input: {
  readonly id: string;
  readonly description: string;
  readonly held_out: boolean;
  readonly broken_source: string;
  readonly verify_source: string;
  readonly task_prompt: string;
  /** Extra read-only files written beside the target, shown to the model verbatim. */
  readonly support_files?: Readonly<Record<string, string>>;
}): LiveEvalTask {
  const targetFile = "broken.mjs";
  const verifyFile = "verify.mjs";
  const support = input.support_files ?? {};
  const supportBlock = Object.entries(support)
    .map(([name, body]) => `\n\nFor reference, ${name} (you may NOT edit this file):\n\n${body}`)
    .join("");
  return Object.freeze({
    id: input.id,
    description: input.description,
    held_out: input.held_out,
    target_relative_path: targetFile,
    setup_fixture: (dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, targetFile), input.broken_source, "utf8");
      writeFileSync(join(dir, verifyFile), input.verify_source, "utf8");
      for (const [name, body] of Object.entries(support)) {
        writeFileSync(join(dir, name), body, "utf8");
      }
    },
    verification: (dir: string) =>
      Object.freeze({ cmd: process.execPath, args: [verifyFile], cwd: dir, timeout_ms: 20_000 }),
    prompt: (attempt: number, feedback: AttemptFeedback | null, currentSource?: string) =>
      `${input.task_prompt}\n\nThe current contents of ${targetFile}:\n\n${currentSource ?? input.broken_source}` +
      supportBlock +
      summarizeFeedback(feedback) +
      (feedback === null && attempt > 0
        ? `\n\nA previous attempt (#${attempt}) did not pass verification; try a different approach.`
        : "") +
      `\n\n${PROMPT_CONTRACT}`,
  });
}

/** Assert helper shared by every verify script, so failures print the failing case. */
const HARNESS = (body: string): string =>
  "let failures = 0;\n" +
  "function check(name, got, expected) {\n" +
  "  const g = JSON.stringify(got), e = JSON.stringify(expected);\n" +
  "  if (g !== e) { failures++; console.log(`FAIL ${name}: got ${g}, expected ${e}`); }\n" +
  "}\n" +
  `${body}\n` +
  "if (failures > 0) { console.log(`${failures} check(s) failed`); process.exit(1); }\n" +
  "console.log('all checks passed'); process.exit(0);\n";

export const defaultLiveTasks: readonly LiveEvalTask[] = Object.freeze([
  // --- pattern: a stated invariant the obvious implementation violates -------
  fixtureTask({
    id: "live-sort-nomutate",
    description: "Sort numbers ascending without mutating the caller's array.",
    held_out: false,
    task_prompt:
      "The exported function `sortAsc(values)` in broken.mjs must return a NEW array of the numbers " +
      "sorted in ascending NUMERIC order. It must NOT modify the array it was given. Fix it.",
    broken_source: "export function sortAsc(values) {\n  return values.sort();\n}\n",
    verify_source:
      "import { sortAsc } from './broken.mjs';\n" +
      HARNESS(
        "const input = [10, 9, 100, 1];\n" +
        "check('numeric order', sortAsc(input), [1, 9, 10, 100]);\n" +
        "check('input not mutated', input, [10, 9, 100, 1]);\n" +
        "check('negatives', sortAsc([3, -1, -20, 2]), [-20, -1, 2, 3]);\n" +
        "check('empty', sortAsc([]), []);\n",
      ),
  }),
  fixtureTask({
    id: "live-deep-merge",
    description: "Deep-merge two objects without mutating either, with array replacement.",
    held_out: false,
    task_prompt:
      "The exported function `deepMerge(base, override)` in broken.mjs must return a NEW deeply-merged " +
      "object. Nested plain objects merge recursively. Arrays are REPLACED wholesale, never concatenated. " +
      "An explicit null in `override` overwrites the base value. Neither argument may be mutated. Fix it.",
    broken_source:
      "export function deepMerge(base, override) {\n" +
      "  for (const key of Object.keys(override)) {\n" +
      "    if (typeof override[key] === 'object' && override[key] !== null) {\n" +
      "      base[key] = deepMerge(base[key] || {}, override[key]);\n" +
      "    } else {\n" +
      "      base[key] = override[key];\n" +
      "    }\n" +
      "  }\n" +
      "  return base;\n" +
      "}\n",
    verify_source:
      "import { deepMerge } from './broken.mjs';\n" +
      HARNESS(
        "const base = { a: 1, n: { x: 1, y: 2 }, list: [1, 2], keep: 'k' };\n" +
        "const over = { n: { y: 9, z: 3 }, list: [7] };\n" +
        "check('merged', deepMerge(base, over), { a: 1, n: { x: 1, y: 9, z: 3 }, list: [7], keep: 'k' });\n" +
        "check('base untouched', base, { a: 1, n: { x: 1, y: 2 }, list: [1, 2], keep: 'k' });\n" +
        "check('override untouched', over, { n: { y: 9, z: 3 }, list: [7] });\n" +
        "check('null overwrites', deepMerge({ a: { b: 1 } }, { a: null }), { a: null });\n",
      ),
  }),

  // --- pattern: a language trap --------------------------------------------
  fixtureTask({
    id: "live-group-order",
    description: "Group items by key preserving first-seen key order despite integer-like keys.",
    held_out: false,
    task_prompt:
      "The exported function `groupBy(items, keyFn)` in broken.mjs must group items into a Map whose " +
      "keys appear in FIRST-SEEN order. Note the keys here are numeric strings. Fix it.",
    broken_source:
      "export function groupBy(items, keyFn) {\n" +
      "  const out = {};\n" +
      "  for (const item of items) {\n" +
      "    const k = keyFn(item);\n" +
      "    (out[k] = out[k] || []).push(item);\n" +
      "  }\n" +
      "  return new Map(Object.entries(out));\n" +
      "}\n",
    verify_source:
      "import { groupBy } from './broken.mjs';\n" +
      HARNESS(
        "const items = ['30a', '10b', '30c', '2d'];\n" +
        "const g = groupBy(items, (s) => s.slice(0, -1));\n" +
        "check('is a Map', g instanceof Map, true);\n" +
        "check('first-seen key order', [...g.keys()], ['30', '10', '2']);\n" +
        "check('grouped values', [...g.values()], [['30a', '30c'], ['10b'], ['2d']]);\n",
      ),
  }),
  fixtureTask({
    id: "live-clamp-signed-zero",
    description: "Clamp a number with explicit NaN and negative-zero behaviour.",
    held_out: false,
    task_prompt:
      "The exported function `clamp(value, min, max)` in broken.mjs must clamp `value` into [min, max]. " +
      "If `value` is NaN it must return `min`. Clamping -0 up to a min of 0 must return positive 0. Fix it.",
    broken_source:
      "export function clamp(value, min, max) {\n" +
      "  return value < min ? min : value > max ? max : value;\n" +
      "}\n",
    verify_source:
      "import { clamp } from './broken.mjs';\n" +
      HARNESS(
        "check('below', clamp(-5, 0, 10), 0);\n" +
        "check('above', clamp(50, 0, 10), 10);\n" +
        "check('inside', clamp(4, 0, 10), 4);\n" +
        "check('NaN returns min', Number.isNaN(clamp(NaN, 3, 10)) ? 'nan' : clamp(NaN, 3, 10), 3);\n" +
        "check('minus zero becomes plus zero', Object.is(clamp(-0, 0, 10), 0), true);\n",
      ),
  }),

  // --- pattern: a second bug behind the first -------------------------------
  fixtureTask({
    id: "live-parse-duration",
    description: "Parse a duration string; the visible bug hides a second one.",
    held_out: false,
    task_prompt:
      "The exported function `parseDuration(text)` in broken.mjs must parse strings like '1h30m', '45s', " +
      "'2h', '90m' into a total number of SECONDS. Unknown or malformed input must return null. Fix it.",
    broken_source:
      "const UNITS = { h: 3600, m: 60, s: 1 };\n" +
      "export function parseDuration(text) {\n" +
      "  let total = 0;\n" +
      "  for (const m of text.matchAll(/(\\d+)([hms])/g)) {\n" +
      "    total += Number(m[1]) * UNITS[m[2]];\n" +
      "  }\n" +
      "  return total;\n" +
      "}\n",
    verify_source:
      "import { parseDuration } from './broken.mjs';\n" +
      HARNESS(
        "check('1h30m', parseDuration('1h30m'), 5400);\n" +
        "check('45s', parseDuration('45s'), 45);\n" +
        "check('2h', parseDuration('2h'), 7200);\n" +
        "check('garbage is null', parseDuration('banana'), null);\n" +
        "check('empty is null', parseDuration(''), null);\n" +
        "check('partial garbage is null', parseDuration('1h!!'), null);\n",
      ),
  }),
  fixtureTask({
    id: "live-interval-merge",
    description: "Merge overlapping intervals; touching intervals also merge.",
    held_out: false,
    task_prompt:
      "The exported function `mergeIntervals(intervals)` in broken.mjs takes an UNSORTED array of " +
      "[start, end] pairs and returns them merged and sorted ascending. Intervals that merely TOUCH " +
      "(e.g. [1,3] and [3,5]) must merge into one. The input must not be mutated. Fix it.",
    broken_source:
      "export function mergeIntervals(intervals) {\n" +
      "  const out = [];\n" +
      "  for (const [s, e] of intervals) {\n" +
      "    const last = out[out.length - 1];\n" +
      "    if (last && s < last[1]) last[1] = Math.max(last[1], e);\n" +
      "    else out.push([s, e]);\n" +
      "  }\n" +
      "  return out;\n" +
      "}\n",
    verify_source:
      "import { mergeIntervals } from './broken.mjs';\n" +
      HARNESS(
        "const input = [[5, 7], [1, 3], [3, 5], [10, 12]];\n" +
        "check('merged+sorted', mergeIntervals(input), [[1, 7], [10, 12]]);\n" +
        "check('input not mutated', input, [[5, 7], [1, 3], [3, 5], [10, 12]]);\n" +
        "check('contained', mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]);\n" +
        "check('empty', mergeIntervals([]), []);\n",
      ),
  }),

  // --- pattern: a requirement the doc comment contradicts -------------------
  fixtureTask({
    id: "live-range-exclusive",
    description: "A range function whose doc comment disagrees with its contract.",
    held_out: false,
    task_prompt:
      "The exported function `range(start, end)` in broken.mjs must return the integers from `start` " +
      "up to but NOT including `end`, and an empty array when `end <= start`. The existing doc comment " +
      "in the file is WRONG and must not be trusted. Fix the implementation.",
    broken_source:
      "/** Returns the integers from start to end, inclusive of both ends. */\n" +
      "export function range(start, end) {\n" +
      "  const out = [];\n" +
      "  for (let i = start; i <= end; i++) out.push(i);\n" +
      "  return out;\n" +
      "}\n",
    verify_source:
      "import { range } from './broken.mjs';\n" +
      HARNESS(
        "check('exclusive end', range(1, 5), [1, 2, 3, 4]);\n" +
        "check('empty when equal', range(3, 3), []);\n" +
        "check('empty when reversed', range(5, 2), []);\n" +
        "check('negative start', range(-2, 2), [-2, -1, 0, 1]);\n",
      ),
  }),

  // --- pattern: a complexity bound enforced by a real timeout ---------------
  fixtureTask({
    id: "live-dedupe-linear",
    description: "Deduplicate preserving order, fast enough for a large input.",
    held_out: false,
    task_prompt:
      "The exported function `dedupe(values)` in broken.mjs must return the values with duplicates " +
      "removed, preserving first-occurrence order. It must handle 200000 elements quickly — the " +
      "verification has a time limit, so a quadratic solution will fail. Fix it.",
    broken_source:
      "export function dedupe(values) {\n" +
      "  const out = [];\n" +
      "  for (const v of values) if (!out.includes(v)) out.push(v);\n" +
      "  return out;\n" +
      "}\n",
    verify_source:
      "import { dedupe } from './broken.mjs';\n" +
      HARNESS(
        "check('order preserved', dedupe([3, 1, 3, 2, 1]), [3, 1, 2]);\n" +
        "check('empty', dedupe([]), []);\n" +
        "const big = [];\n" +
        "for (let i = 0; i < 200000; i++) big.push(i % 50000);\n" +
        "const started = Date.now();\n" +
        "const got = dedupe(big);\n" +
        "const elapsed = Date.now() - started;\n" +
        "check('large input length', got.length, 50000);\n" +
        "if (elapsed > 2000) { failures++; console.log(`FAIL too slow: ${elapsed}ms for 200000 elements (limit 2000ms)`); }\n",
      ),
  }),

  // --- pattern: symptom in one file, cause in another ----------------------
  fixtureTask({
    id: "live-cross-file-normalize",
    description: "A formatter is wrong because the helper it calls is wrong.",
    held_out: false,
    task_prompt:
      "Running verify.mjs shows `formatTags` producing the wrong output. `formatTags` lives in " +
      "format.mjs and is CORRECT and must not change; the bug is in `normalizeTag` in broken.mjs. " +
      "`normalizeTag` must lowercase, trim surrounding whitespace, collapse internal runs of " +
      "whitespace to a single hyphen, and drop any character that is not a letter, digit or hyphen. Fix it.",
    broken_source:
      "export function normalizeTag(tag) {\n" +
      "  return tag.toLowerCase().replace(/\\s/g, '-');\n" +
      "}\n",
    support_files: {
      "format.mjs":
        "import { normalizeTag } from './broken.mjs';\n" +
        "export function formatTags(tags) {\n" +
        "  return tags.map(normalizeTag).filter((t) => t.length > 0).join(',');\n" +
        "}\n",
    },
    verify_source:
      "import { formatTags } from './format.mjs';\n" +
      HARNESS(
        "check('basic', formatTags(['  Hello World  ', 'C++']), 'hello-world,c');\n" +
        "check('collapses runs', formatTags(['a   b']), 'a-b');\n" +
        "check('keeps digits and hyphens', formatTags(['Node-18 LTS!']), 'node-18-lts');\n" +
        "check('drops empties', formatTags(['   ', 'ok']), 'ok');\n",
      ),
  }),

  // --- held-out set ---------------------------------------------------------
  // Reserved by ADR-095 Decision 3, and never read while tuning anything.
  //
  // These are deliberately the HARDEST tasks in the suite. The held-out set is
  // where the verdict is read, so it is the set whose power actually matters. A
  // first pass at this suite left the held-out four solvable on attempt 0 by a
  // mid-tier model, which made the held-out rate a constant 1.0 and every arm
  // indistinguishable there — the ceiling effect reproduced in the one place it
  // does the most damage. Each task below needs several interacting constraints
  // to be satisfied at once, which is the property that empirically separated
  // the three genuinely hard calibration tasks from the rest.
  fixtureTask({
    id: "live-heldout-semver-compare",
    description: "[held-out] Compare semantic versions including prerelease precedence.",
    held_out: true,
    task_prompt:
      "The exported function `compareSemver(a, b)` in broken.mjs must return -1, 0 or 1 ordering two " +
      "semantic version strings. Rules: compare major, minor, patch numerically. A version WITH a " +
      "prerelease ranks LOWER than the same version without one. Prerelease identifiers are compared " +
      "left to right: numeric identifiers compare numerically, purely numeric ranks lower than " +
      "alphanumeric, alphanumeric compare lexically, and if all compared identifiers are equal the " +
      "version with MORE identifiers ranks higher. Fix it.",
    broken_source:
      "export function compareSemver(a, b) {\n" +
      "  const pa = a.split('.').map(Number);\n" +
      "  const pb = b.split('.').map(Number);\n" +
      "  for (let i = 0; i < 3; i++) {\n" +
      "    if (pa[i] > pb[i]) return 1;\n" +
      "    if (pa[i] < pb[i]) return -1;\n" +
      "  }\n" +
      "  return 0;\n" +
      "}\n",
    verify_source:
      "import { compareSemver } from './broken.mjs';\n" +
      HARNESS(
        "check('major', compareSemver('2.0.0', '1.9.9'), 1);\n" +
        "check('patch', compareSemver('1.0.1', '1.0.2'), -1);\n" +
        "check('equal', compareSemver('1.2.3', '1.2.3'), 0);\n" +
        "check('prerelease ranks lower', compareSemver('1.0.0-alpha', '1.0.0'), -1);\n" +
        "check('numeric identifiers numeric', compareSemver('1.0.0-2', '1.0.0-10'), -1);\n" +
        "check('numeric below alphanumeric', compareSemver('1.0.0-1', '1.0.0-alpha'), -1);\n" +
        "check('alpha before beta', compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);\n" +
        "check('more identifiers rank higher', compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);\n" +
        "check('symmetry', compareSemver('1.0.0', '1.0.0-alpha'), 1);\n",
      ),
  }),
  fixtureTask({
    id: "live-heldout-lru-cache",
    description: "[held-out] An LRU cache with correct eviction and a real performance bound.",
    held_out: true,
    task_prompt:
      "The exported function `createLRU(capacity)` in broken.mjs must return an object with `get(key)` " +
      "and `set(key, value)`. `get` returns the value or undefined, and COUNTS AS A USE. `set` on an " +
      "existing key updates it and counts as a use. When the cache is at capacity, adding a new key " +
      "evicts the LEAST recently used one. It must also stay fast: the verification runs 200000 " +
      "operations under a time limit, so anything that scans the whole cache per operation will fail. Fix it.",
    broken_source:
      "export function createLRU(capacity) {\n" +
      "  const store = {};\n" +
      "  return {\n" +
      "    get(key) { return store[key]; },\n" +
      "    set(key, value) { store[key] = value; },\n" +
      "  };\n" +
      "}\n",
    verify_source:
      "import { createLRU } from './broken.mjs';\n" +
      HARNESS(
        "const c = createLRU(2);\n" +
        "c.set('a', 1); c.set('b', 2);\n" +
        "check('gets a', c.get('a'), 1);\n" +
        "c.set('c', 3);\n" +
        "check('b evicted as least recently used', c.get('b'), undefined);\n" +
        "check('a survived because get counted as use', c.get('a'), 1);\n" +
        "check('c present', c.get('c'), 3);\n" +
        "const d = createLRU(2);\n" +
        "d.set('x', 1); d.set('y', 2); d.set('x', 9); d.set('z', 3);\n" +
        "check('set counted as a use, so y evicted', d.get('y'), undefined);\n" +
        "check('x updated and kept', d.get('x'), 9);\n" +
        "const big = createLRU(1000);\n" +
        "const started = Date.now();\n" +
        "for (let i = 0; i < 200000; i++) { big.set(i % 5000, i); big.get(i % 5000); }\n" +
        "const elapsed = Date.now() - started;\n" +
        "if (elapsed > 2000) { failures++; console.log(`FAIL too slow: ${elapsed}ms for 200000 operations (limit 2000ms)`); }\n",
      ),
  }),
  fixtureTask({
    id: "live-heldout-topo-sort",
    description: "[held-out] Topological sort with stable order and cycle detection.",
    held_out: true,
    task_prompt:
      "The exported function `topoSort(nodes, edges)` in broken.mjs takes an array of node names and " +
      "an array of [before, after] dependency pairs, and returns the nodes in an order where every " +
      "`before` precedes its `after`. When several nodes are simultaneously ready, they must appear in " +
      "their original `nodes` order. If the graph contains a cycle it must return null. Fix it.",
    broken_source:
      "export function topoSort(nodes, edges) {\n" +
      "  const out = [];\n" +
      "  const deps = new Map(nodes.map((n) => [n, []]));\n" +
      "  for (const [before, after] of edges) deps.get(after).push(before);\n" +
      "  const visit = (n) => {\n" +
      "    if (out.includes(n)) return;\n" +
      "    for (const d of deps.get(n)) visit(d);\n" +
      "    out.push(n);\n" +
      "  };\n" +
      "  for (const n of nodes) visit(n);\n" +
      "  return out;\n" +
      "}\n",
    verify_source:
      "import { topoSort } from './broken.mjs';\n" +
      HARNESS(
        "check('simple chain', topoSort(['a','b','c'], [['a','b'],['b','c']]), ['a','b','c']);\n" +
        "check('stable among ready nodes', topoSort(['x','y','z'], [['z','y']]), ['x','z','y']);\n" +
        "check('diamond', topoSort(['a','b','c','d'], [['a','b'],['a','c'],['b','d'],['c','d']]), ['a','b','c','d']);\n" +
        "check('cycle returns null', topoSort(['a','b'], [['a','b'],['b','a']]), null);\n" +
        "check('self cycle returns null', topoSort(['a'], [['a','a']]), null);\n" +
        "check('no edges keeps input order', topoSort(['q','p'], []), ['q','p']);\n",
      ),
  }),
  fixtureTask({
    id: "live-heldout-path-normalize",
    description: "[held-out] Normalize a POSIX path, rejecting escapes above the root.",
    held_out: true,
    task_prompt:
      "The exported function `normalizePath(path)` in broken.mjs must normalize a POSIX-style path: " +
      "collapse repeated slashes, drop '.' segments, resolve '..' against the preceding segment, and " +
      "preserve whether the path was absolute (leading '/'). An ABSOLUTE path that tries to go above " +
      "the root, and a RELATIVE path that ends up above its starting point, must both return null. A " +
      "path that normalizes to nothing returns '/' when absolute and '.' when relative. Never return " +
      "a trailing slash except for the root itself. Fix it.",
    broken_source:
      "export function normalizePath(path) {\n" +
      "  return path.split('/').filter((s) => s !== '' && s !== '.').join('/');\n" +
      "}\n",
    verify_source:
      "import { normalizePath } from './broken.mjs';\n" +
      HARNESS(
        "check('collapses slashes', normalizePath('/a//b/'), '/a/b');\n" +
        "check('drops dot', normalizePath('/a/./b'), '/a/b');\n" +
        "check('resolves dotdot', normalizePath('/a/b/../c'), '/a/c');\n" +
        "check('relative stays relative', normalizePath('a/b/../c'), 'a/c');\n" +
        "check('absolute escape is null', normalizePath('/a/../..'), null);\n" +
        "check('relative escape is null', normalizePath('a/../..'), null);\n" +
        "check('empty absolute is root', normalizePath('/'), '/');\n" +
        "check('empty relative is dot', normalizePath('a/..'), '.');\n",
      ),
  }),
]);
