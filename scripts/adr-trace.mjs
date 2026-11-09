#!/usr/bin/env node
/**
 * scripts/adr-trace.mjs — derived ADR↔file traceability, detection not a lock.
 *
 * Usage:
 *   bun scripts/adr-trace.mjs                     # unclaimed commits in the range this run is accountable for
 *   bun scripts/adr-trace.mjs --range <b>..<a>    # audit exactly that pushed range
 *   bun scripts/adr-trace.mjs --json               # machine-readable report
 *   bun scripts/adr-trace.mjs --repo <path>        # act on a different checkout (tests)
 *   bun scripts/adr-trace.mjs --backfill-report     # report-only: existing unclaimed history
 *   bun scripts/adr-trace.mjs --backfill-report --since <ref>
 *   bun run gate:adr-trace                          # wired via package.json + GATE_TIERS
 *
 * WHY THIS EXISTS (see decisions manifest for the full incident list — ADR-074's
 * gate-roster drift is the closest sibling). Work in this repository is not
 * reliably traceable to the decision that authorizes it: 44 of 74 ADRs sat
 * `Proposed` while describing shipped behavior, and nobody noticed because no
 * step forced the connection between a commit and its governing decision to be
 * recorded at all.
 *
 * WHY DERIVED, NOT DECLARED. The originating design had an ADR declare the
 * files it governs, and a write-time lock enforce it. That is rejected here
 * (see the manifest §1 for the full argument): a declared file list is a
 * prediction that immediately drifts, cardinality collapses under files like
 * `manager.ts` that nearly every ADR eventually touches, and write-time
 * blocking gets bypassed with `--no-verify` the first time it fires on
 * legitimate work — which this repo has already measured happening twice.
 *
 * So the ADR↔file map is derived from git history after the fact
 * (`buildTraceIndex`), never read from a declared list, and enforcement is
 * detection at push/CI time (this gate), not prevention at write time — the
 * same "detection and remediation are different authorities" split already
 * established by `worktree-hygiene.mjs` and `branch-accounting.mjs`.
 *
 * THE GRAMMAR IS FIT TO THE REAL CORPUS, NOT IMPOSED. Before writing
 * `parseAdrReferences`, `git log --all --format='%B'` was inspected end to
 * end. Findings: no repository history anywhere uses a dedicated `ADR:`
 * trailer line — every existing claim is inline, in the commit SUBJECT, in
 * one of a small number of shapes: a conventional-commit scope
 * (`docs(ADR-074): …`), a trailing parenthetical (`… (ADR-032 through
 * ADR-035)`, `… (ADR-069, X-2)`), a slash shorthand (`ADR-001/ADR-005`,
 * `ADR-048/051`), or a bare mention in an authoring commit (`docs: allocate
 * ADR-073 …`, which is `scripts/lib/adr-registry.mjs`'s own auto-generated
 * message). `parseAdrReferences` recognizes all of those, PLUS the `ADR:`
 * trailer as a forward-looking convention this gate's remedy text recommends,
 * because it is the only form immune to the ambiguity below.
 *
 * WHY SUBJECT-LINE ONLY FOR INLINE FORMS. Commit BODIES in this repository
 * routinely discuss OTHER ADRs at length without implementing them — e.g. "…
 * cited ADR-024's boundary-2 discussion …" inside a commit whose actual
 * subject names a different ADR entirely. Treating every body mention as a
 * claim would over-attribute unrelated files to ADRs the commit never
 * authored under, which is exactly the fabricated-trace risk `--backfill-
 * report` exists to refuse. The `ADR:` trailer is the one body-level
 * exception, because it is a deliberate, unambiguous declaration line, not
 * incidental prose — the same reasoning that makes it the recommended remedy.
 *
 * GOVERNED PATHS ARE DERIVED, NOT HARDCODED. `arbor.profile.jsonc` (ADR-073,
 * `scripts/lib/project-profile.mjs`) exposes `source_roots` and
 * `governance.decisions_dir`, but no "governed paths for traceability"
 * concept — so `governedPathPrefixes()` documents its own default rather than
 * inventing a profile field this repo does not have: `source_roots` (the
 * code an ADR is normally about) plus `decisions_dir` (the ADRs themselves,
 * needed for `--backfill-report`'s unambiguous-evidence rule) plus `scripts`
 * (this repo's own gates/tooling, added because every motivating incident in
 * the manifest — the gate roster, the VI graph, the reservation ledger — is a
 * `scripts/`-owned change; excluding it would make a traceability gate blind
 * to its own kind).
 *
 * EXIT CODE POLICY. `gate:adr-trace` audits exactly ONE range — the range this
 * run is accountable for — and never full history. So a branch's own unclaimed
 * commits fail it (exit 1) while commits that already existed at the boundary
 * structurally never enter the computation, regardless of how large or old that
 * backlog is. This is proved in `scripts/tests/adr-trace.test.mjs` with a repo
 * whose `master` already carries an old unclaimed commit: a fresh clean branch
 * off it still exits 0.
 *
 * WHICH RANGE (R2-03). The range used to be derived only from a local `master`
 * ref: `merge-base(HEAD, master)..HEAD`. That is wrong for the push this gate
 * actually exists to police. `ci.yml` runs this gate on `push: master`, where
 * the checkout is detached at the pushed tip and the local `master` ref is
 * whatever the fetch left behind — it is not the range that was pushed. Worse,
 * on a push to `master` the two are frequently IDENTICAL: committing on master
 * moves the local `master` ref to HEAD, so `merge-base(HEAD, master) == HEAD`,
 * the audited range is empty, and the gate reported PASS over zero commits. A
 * governed-path commit with no `ADR:` trailer could therefore pass in CI
 * precisely because the range the gate looked at never contained it. Locally
 * the same commit is judged by a range that is behind (or ahead of) the pushed
 * one, so a local run and a CI run disagree about the same commit.
 *
 * So the range now comes from the CI event, in this precedence order:
 *
 *   1. `--range <before>..<after>` — an explicitly supplied pushed range. This
 *      is what a human runs to reproduce a CI judgement by hand.
 *   2. The GitHub Actions event payload, read from `GITHUB_EVENT_PATH` — the
 *      platform's own convention, and the same `process.env.GITHUB_*` surface
 *      `scripts/enforcement-attestation.mjs` already consumes for
 *      `GITHUB_REPOSITORY` / `GITHUB_WORKFLOW_REF` / `GITHUB_SHA` / `GITHUB_RUN_ID`.
 *      A `push` event carries `before`/`after`; a `pull_request` event carries
 *      `pull_request.base.sha` / `pull_request.head.sha`. No workflow change is
 *      needed: GitHub sets both variables for every step, and `ci.yml` already
 *      checks out with `fetch-depth: 0`, so the endpoints resolve.
 *   3. `merge-base(HEAD, master)..HEAD` — a LOCAL DERIVATION, reported as
 *      `range_source: "derived_merge_base"`. This is a guess about what would be
 *      pushed, not knowledge of what was pushed, and it is never reported as
 *      the pushed range.
 *
 * AN ABSENT RANGE IS NOT A PASS. When the derived range is empty (`master`
 * exists but HEAD IS master — the ordinary state of a synced master checkout,
 * and exactly the state that hid the defect above) or unavailable (no `master`
 * ref at all: a throwaway repo, or a repo mid-bootstrap), the gate has NOT
 * measured anything. It exits non-zero with `unresolved_range`, naming
 * `--range` as the remedy. The earlier behaviour — "no boundary, report clean"
 * — was the fail-open this gate now refuses: a missing boundary must never
 * manufacture a pass either. Only an authoritative range (1 or 2) that is
 * genuinely empty (`before == after`, i.e. a push that carried no commits) is a
 * real pass, because there the emptiness is a fact about the push rather than
 * an absence of information.
 *
 * `--backfill-report` is a SEPARATE, always-report-only mode: it never
 * affects the gate's exit code and NEVER writes a claim it inferred anywhere
 * — not to the commit, not to a file. A fabricated trace is worse than a
 * missing one (manifest A-3). Its only output is candidate ADR numbers for a
 * human to act on, and only where the evidence is unambiguous: the commit
 * itself touched `decisions/ADR-0NN-*.md`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { readRegistry } from "./lib/adr-registry.mjs";
import { fileURLToPath } from "node:url";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Control-character delimiters: never appear in a commit message or a file
// path, so splitting on them is safe regardless of what prose or blank lines
// a commit body contains (the same reasoning `union-sorted-jsonl-merge.mjs`-
// class code in this repo already leans on for `\x1f`/`\x1e`-delimited git
// output).
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
// `git log --format=%B` reads the complete reachable commit corpus. The
// default child-process capture ceiling is 1 MiB, which current history can
// legitimately exceed; keep a finite, explicit bound rather than converting
// a successful Git exit into ENOBUFS/empty JSON under CI.
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_GIT_OUTPUT_BYTES });
}

function gitOrNull(repo, args) {
  try {
    return git(repo, args).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A-1: parseAdrReferences, buildTraceIndex, unclaimedCommits
// ---------------------------------------------------------------------------

/**
 * The ADR numbers a single commit CLAIMS, normalized/deduped/sorted
 * ascending. Unparseable input, or a message naming no ADR, is not an
 * error — it is "no claim" (empty array). See the header for the full
 * grammar rationale.
 */
export function parseAdrReferences(commitMessage) {
  if (!commitMessage) return [];
  const numbers = new Set();

  // Trailer form, anywhere in the message: "ADR: 074" / "ADR: 074, 062".
  // Not observed anywhere in this repo's history today, but the deliberate,
  // unambiguous form this gate's remedy text recommends going forward.
  for (const line of commitMessage.split("\n")) {
    const trailer = /^ADR:\s*(.+)$/i.exec(line.trim());
    if (!trailer) continue;
    for (const token of trailer[1].split(/[,\s]+/)) {
      const digits = token.match(/\d{1,4}/);
      if (digits) numbers.add(Number(digits[0]));
    }
  }

  // Inline forms — SUBJECT LINE ONLY (see header WHY). The subject is
  // whatever precedes the first newline of the full message.
  const subject = commitMessage.split("\n", 1)[0] ?? "";
  for (const n of extractSubjectReferences(subject)) numbers.add(n);

  return [...numbers].sort((a, b) => a - b);
}

function extractSubjectReferences(subject) {
  const numbers = new Set();

  // Range form: "ADR-032 through ADR-035" / "ADR-032 to ADR-035". Bounded to
  // 50 so a typo ("through ADR-9999") cannot silently manufacture thousands
  // of false claims.
  for (const match of subject.matchAll(/ADR-(\d{1,4})\s+(?:through|to)\s+ADR-(\d{1,4})/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end >= start && end - start <= 50) {
      for (let n = start; n <= end; n++) numbers.add(n);
    }
  }

  // Slash shorthand: "ADR-048/051" — a second bare number reusing the
  // first's "ADR-" prefix, distinct from the fully-repeated form
  // "ADR-001/ADR-005" (which the generic scan below already covers on its
  // own, each half independently).
  for (const match of subject.matchAll(/ADR-(\d{1,4})\/(\d{1,4})\b/gi)) {
    numbers.add(Number(match[1]));
    numbers.add(Number(match[2]));
  }

  // Generic mentions: covers the conventional-commit scope form
  // "type(ADR-NNN): …", trailing parentheticals, comma lists, and bare
  // "docs: allocate ADR-NNN …" authoring commits, all in one pass.
  for (const match of subject.matchAll(/ADR-(\d{1,4})\b/gi)) {
    numbers.add(Number(match[1]));
  }

  return numbers;
}

/**
 * Default governed-path prefixes: derived from the project profile
 * (`source_roots`, `governance.decisions_dir`) plus `scripts` — see header
 * for why the third is a documented default rather than a profile field.
 */
export function governedPathPrefixes(repo) {
  const profile = profileOrDefaults(repo);
  return [...profile.source_roots, profile.governance.decisions_dir, "scripts"];
}

function touchesGovernedPath(files, prefixes) {
  return files.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
}

/** Commit hash -> full raw message (`%B`, subject + body), for the given rev range. */
function commitMessages(repo, revRangeArgs) {
  const out = git(repo, ["log", ...revRangeArgs, `--format=${RECORD_SEP}COMMIT${FIELD_SEP}%H${FIELD_SEP}%B`]);
  const map = new Map();
  const order = [];
  for (const chunk of out.split(RECORD_SEP)) {
    if (!chunk) continue;
    const parts = chunk.split(FIELD_SEP);
    // parts[0] === "COMMIT", parts[1] === hash, the rest (rejoined) is %B.
    const hash = parts[1];
    const body = parts.slice(2).join(FIELD_SEP);
    map.set(hash, body);
    order.push(hash);
  }
  return { map, order };
}

/** Commit hash -> files touched (`--name-only`), for the given rev range. */
function commitFiles(repo, revRangeArgs) {
  const out = git(repo, ["log", ...revRangeArgs, "--name-only", `--format=${RECORD_SEP}COMMIT${FIELD_SEP}%H`]);
  const map = new Map();
  for (const chunk of out.split(RECORD_SEP)) {
    if (!chunk) continue;
    const lines = chunk.split("\n");
    const hash = lines[0].split(FIELD_SEP)[1];
    const files = lines.slice(1).map((line) => line.trim()).filter(Boolean);
    map.set(hash, files);
  }
  return map;
}

/**
 * `since`/`until` are either null (unbounded: full history reachable from HEAD,
 * or everything up to `until`) or commit-ish boundaries, interpreted as the
 * exclusive lower bound `since..until` — the same convention
 * `branch-accounting.mjs` uses for `--not <ref>` boundaries. `until` exists so
 * the gate can audit the pushed range `before..after` rather than
 * `before..HEAD`: on a push those coincide, but a range that can only be
 * expressed as "up to whatever HEAD happens to be" is a range that measures
 * something other than what was pushed.
 */
function revRangeArgs(since, until) {
  if (since && until) return [`${since}..${until}`];
  if (since) return [`${since}..HEAD`];
  if (until) return [until];
  return ["HEAD"];
}

/**
 * For each ADR claimed by at least one commit in range, the set of files
 * touched by commits claiming it, and the claiming commits themselves.
 * Returns a plain object keyed by ADR number (as a string, for JSON safety),
 * sorted ascending; each value's `files` list is sorted and deduplicated.
 *
 * Never reads a declared file list from an ADR body — there is none by
 * design (manifest §1.1).
 */
export function buildTraceIndex({ repo, since = null, until = null } = {}) {
  const range = revRangeArgs(since, until);
  const { map: messages, order } = commitMessages(repo, range);
  const files = commitFiles(repo, range);

  const index = new Map();
  for (const hash of order) {
    const message = messages.get(hash) ?? "";
    const adrs = parseAdrReferences(message);
    if (adrs.length === 0) continue;
    const subject = message.split("\n", 1)[0] ?? "";
    const touched = files.get(hash) ?? [];
    for (const adr of adrs) {
      if (!index.has(adr)) index.set(adr, { files: new Set(), commits: [] });
      const entry = index.get(adr);
      for (const file of touched) entry.files.add(file);
      entry.commits.push({ hash, subject });
    }
  }

  const result = {};
  for (const adr of [...index.keys()].sort((a, b) => a - b)) {
    const entry = index.get(adr);
    result[String(adr)] = {
      files: [...entry.files].sort(),
      commits: entry.commits,
    };
  }
  return result;
}

/**
 * Commits in range that touch a governed path but claim no ADR. This is the
 * raw signal both the gate and `--backfill-report` build on.
 */
export function unclaimedCommits({ repo, since = null, until = null } = {}) {
  const range = revRangeArgs(since, until);
  const { map: messages, order } = commitMessages(repo, range);
  const files = commitFiles(repo, range);
  const prefixes = governedPathPrefixes(repo);

  const result = [];
  for (const hash of order) {
    const message = messages.get(hash) ?? "";
    if (parseAdrReferences(message).length > 0) continue;
    const touched = files.get(hash) ?? [];
    const governedTouched = touched.filter((file) => prefixes.some((p) => file === p || file.startsWith(`${p}/`)));
    if (governedTouched.length === 0) continue;
    const subject = message.split("\n", 1)[0] ?? "";
    result.push({ hash, subject, files: governedTouched });
  }
  return result;
}

/**
 * The ADR numbers a commit may legitimately cite: every allocated record, plus
 * the registry's `reserved` set. Reserved numbers are deliberate
 * cross-namespace citations to another repository's decisions (see
 * `reserved_reason`), so they are real references even though no local file
 * carries them.
 *
 * WHY THIS EXISTS. Until it did, both this gate and the commit-msg guard
 * checked only that a trailer had been TYPED — `parseAdrReferences(...).length
 * > 0`. `ADR: 999` satisfied them. That is not a hypothetical: 13 commits in
 * this repository's recent history carry `ADR: 148`, and ADR-148 has no file,
 * no allocation, and no index row. The traceability apparatus proved a trailer
 * existed; it never proved the change was governed by a real decision.
 */
export function knownAdrNumbers(repo) {
  let registry;
  try {
    registry = readRegistry(repo);
  } catch {
    registry = null;
  }
  // No registry means no boundary to judge a citation against. Return null so
  // the caller reports nothing rather than reporting EVERY citation as bogus —
  // the same posture this gate takes when there is no `master` ref: a missing
  // boundary must never manufacture a false failure. `gate:adr-registry` is
  // what proves the registry exists; this gate does not duplicate it.
  if (!registry || !Array.isArray(registry.allocations)) return null;
  const known = new Set();
  for (const allocation of registry?.allocations ?? []) {
    if (Number.isInteger(allocation?.number)) known.add(allocation.number);
  }
  for (const number of registry?.reserved ?? []) {
    if (Number.isInteger(number)) known.add(number);
  }
  return known;
}

/**
 * Governed-path commits in range that DO cite an ADR, but whose every citation
 * resolves to no allocated or reserved record.
 *
 * A commit citing one real record and one bogus number is not reported here:
 * it is governed, and the real citation is what this gate exists to establish.
 * The failure this catches is a commit governed by NOTHING that still looks
 * claimed to every reader and to the gate itself.
 */
export function miscitedCommits({ repo, since = null, until = null } = {}) {
  const range = revRangeArgs(since, until);
  const { map: messages, order } = commitMessages(repo, range);
  const files = commitFiles(repo, range);
  const prefixes = governedPathPrefixes(repo);
  const known = knownAdrNumbers(repo);
  if (known === null) return [];

  const result = [];
  for (const hash of order) {
    const message = messages.get(hash) ?? "";
    const cited = parseAdrReferences(message);
    if (cited.length === 0) continue;
    if (cited.some((number) => known.has(number))) continue;
    const touched = files.get(hash) ?? [];
    const governedTouched = touched.filter((file) => prefixes.some((p) => file === p || file.startsWith(`${p}/`)));
    if (governedTouched.length === 0) continue;
    const subject = message.split("\n", 1)[0] ?? "";
    result.push({ hash, subject, files: governedTouched, cited });
  }
  return result;
}

// ---------------------------------------------------------------------------
// A-3: --backfill-report — report only, never writes an inferred claim.
// ---------------------------------------------------------------------------

const DECISION_FILE_RE = /^decisions\/ADR-(\d+)-[^/]+\.md$/;

/**
 * For every unclaimed, governed-path-touching commit in range, a candidate
 * ADR list populated ONLY when the commit itself touched
 * `decisions/ADR-0NN-*.md` — the one form of evidence unambiguous enough to
 * name a specific ADR without inferring intent. Everything else gets an
 * empty candidate list: "unclaimed, no unambiguous candidate" is itself
 * useful output, not a gap to paper over with a guess.
 */
export function backfillCandidates({ repo, since = null } = {}) {
  return unclaimedCommits({ repo, since }).map((commit) => {
    const candidates = [
      ...new Set(
        commit.files
          .map((file) => file.match(DECISION_FILE_RE))
          .filter(Boolean)
          .map((match) => Number(match[1])),
      ),
    ].sort((a, b) => a - b);
    return {
      hash: commit.hash,
      subject: commit.subject,
      files: commit.files,
      candidate_adrs: candidates,
      evidence:
        candidates.length > 0
          ? `commit directly touches decisions/ADR-0NN-*.md for: ${candidates.map((n) => `ADR-${String(n).padStart(3, "0")}`).join(", ")}`
          : null,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The pushed range (R2-03)
// ---------------------------------------------------------------------------

/**
 * The pushed range, or the reason there isn't one. Exported so a test can prove
 * the precedence without a GitHub event on the machine running it.
 *
 * Precedence, highest first:
 *
 *  1. `explicit` — `--range <before>..<after>` on argv. The reproduction path:
 *     an operator who has a CI run in hand can re-derive the exact same
 *     judgement locally.
 *  2. `env.GITHUB_EVENT_PATH` — GitHub Actions writes the event payload to a
 *     file and points this variable at it, for every step, with no workflow
 *     cooperation required. `push` carries `before`/`after`; `pull_request`
 *     carries `pull_request.base.sha` / `pull_request.head.sha`. `ci.yml`
 *     triggers on both, so both are read.
 *  3. `merge-base(HEAD, master)..HEAD`, a local derivation. Reported as
 *     `derived_merge_base`, never as the pushed range, because it is a guess.
 *
 * Why not `REVOY_ENFORCEMENT_CONTEXT`: it names the profile context ("ci",
 * "stop"), not a revision range. It cannot distinguish one push from the next,
 * which is the entire defect.
 *
 * WHY THE ZERO-SHA CHECK. GitHub sends `before: 0000…` for the first push to a
 * new branch. That is not a resolvable boundary, so it must not be handed to
 * `git log` as one — an all-zero rev makes the range silently empty, which is
 * the fail-open this whole change exists to remove. A range whose endpoint does
 * not resolve is `unresolved`, not empty.
 */
export function pushedRange({ repo, explicit = null, env = process.env } = {}) {
  const resolve = (candidate) => {
    if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
    const rev = candidate.trim();
    // All-zero is what GitHub sends for "the branch did not exist before this
    // push". It is not a revision, and handing it to `git log` yields a
    // silently EMPTY range — the fail-open this change exists to remove.
    if (/^0+$/.test(rev)) return null;
    return gitOrNull(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) ? rev : null;
  };

  if (explicit !== null) {
    const parts = String(explicit).split("..");
    if (parts.length !== 2) return { kind: "unresolved", source: "explicit_range", detail: `--range must be <before>..<after>, got ${explicit}` };
    const before = resolve(parts[0]);
    const after = resolve(parts[1]);
    if (!before || !after) return { kind: "unresolved", source: "explicit_range", detail: `--range ${explicit} does not resolve to a commit in this repository` };
    return { kind: "resolved", source: "explicit_range", before, after };
  }

  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
    } catch (error) {
      return { kind: "unresolved", source: "ci_event", detail: `GITHUB_EVENT_PATH (${eventPath}) is not readable JSON: ${error.message}` };
    }
    const before = payload?.before;
    const after = payload?.after ?? payload?.pull_request?.head?.sha;
    const base = payload?.pull_request?.base?.sha ?? before;
    const resolvedBefore = resolve(base);
    const resolvedAfter = resolve(after);
    if (!resolvedBefore || !resolvedAfter) {
      return {
        kind: "unresolved",
        source: "ci_event",
        detail: `CI event ${env.GITHUB_EVENT_NAME ?? "(unnamed)"} carries no resolvable before..after (before=${String(base)}, after=${String(after)})`,
      };
    }
    return { kind: "resolved", source: "ci_event", before: resolvedBefore, after: resolvedAfter };
  }

  // Local derivation. Reported honestly, and refused below when it is empty.
  const master = gitOrNull(repo, ["rev-parse", "--verify", "--quiet", "master"]) ? "master" : null;
  if (!master) return { kind: "unresolved", source: "derived_merge_base", detail: "no `master` ref and no CI event payload — nothing establishes what range this run is accountable for" };
  const mergeBase = gitOrNull(repo, ["merge-base", "HEAD", master]);
  const head = gitOrNull(repo, ["rev-parse", "HEAD"]);
  if (!mergeBase || !head) return { kind: "unresolved", source: "derived_merge_base", detail: "`master` and HEAD do not share a merge base in this repository" };
  if (mergeBase === head) {
    return {
      kind: "unresolved",
      source: "derived_merge_base",
      detail: "HEAD IS master — the derived range is empty because nothing has diverged, not because there is nothing to audit. On `push: master` this local `master` ref moves with every commit, which is what let an unclaimed governed commit pass CI unnoticed.",
    };
  }
  return { kind: "resolved", source: "derived_merge_base", before: mergeBase, after: head, ref: master };
}

function printRemedy() {
  console.log("  Remedy: add a trailer to the commit message naming the governing ADR(s), e.g.:");
  console.log("");
  console.log("    ADR: 074");
  console.log("    ADR: 074, 062");
  console.log("");
  console.log("  then `git commit --amend` (or, for an older commit in the range,");
  console.log("  `git rebase -i <parent> --autosquash` / `git commit --fixup` followed by");
  console.log("  an interactive rebase) to attach the trailer to the commit that needs it.");
}

function runGate(repoRoot, jsonMode, explicitRange) {
  const range = pushedRange({ repo: repoRoot, explicit: explicitRange });
  const authoritative = range.kind === "resolved" && range.source !== "derived_merge_base";
  const span = range.kind === "resolved" ? `${range.before}..${range.after}` : null;

  const commits = range.kind === "resolved" ? unclaimedCommits({ repo: repoRoot, since: range.before, until: range.after }) : [];
  const miscited = range.kind === "resolved" ? miscitedCommits({ repo: repoRoot, since: range.before, until: range.after }) : [];

  const report = {
    ok: range.kind === "resolved" && commits.length === 0 && miscited.length === 0,
    range: span,
    range_source: range.kind === "resolved" ? range.source : null,
    range_resolved: range.kind === "resolved",
    unresolved_detail: range.kind === "resolved" ? null : range.detail,
    boundary: range.kind === "resolved" ? range.before : null,
    boundary_ref: range.kind === "resolved" ? (range.ref ?? (authoritative ? range.source : null)) : null,
    unclaimed_commit_count: commits.length,
    unclaimed_commits: commits,
    miscited_commit_count: miscited.length,
    miscited_commits: miscited,
    // How many commits this run actually audited, and the structured counterpart
    // to the text path's `observed_count: N` line. Null when no range resolved,
    // which is the case a `observes.min` declaration must read as "measured
    // nothing" rather than "measured zero of a correctly-scoped range".
    audited_commit_count:
      range.kind === "resolved"
        ? Number(gitOrNull(repoRoot, ["rev-list", "--count", `${range.before}..${range.after}`]) ?? "0")
        : null,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (range.kind === "unresolved") {
    console.log(`gate:adr-trace — UNRESOLVED: no range to audit. ${range.detail}\n`);
    console.log("  This is not a pass. A gate that measured nothing has not established that the commits it");
    console.log("  exists to police are traceable, and reporting green here is how an unclaimed governed");
    console.log("  commit reaches `master` unnoticed.\n");
    console.log("  In CI this means the event payload did not supply a before..after range.");
    console.log("  Locally, name the range explicitly:");
    console.log("");
    console.log("    bun run gate:adr-trace -- --range <before>..<after>");
    console.log("");
    console.log("  (On a real push, `git rev-parse HEAD~1..HEAD` is the range for a one-commit push.)");
  } else if (report.ok) {
    console.log(
      `gate:adr-trace — PASS: no unclaimed or miscited governed-path commits in ${span}${range.source === "derived_merge_base" ? " (locally derived merge-base against master; this is NOT a known pushed range)" : ""}.`
    );
  } else {
    if (commits.length > 0) {
      console.log(`gate:adr-trace — FAIL: ${commits.length} commit(s) in ${span} touch governed paths and claim no ADR:\n`);
      for (const commit of commits) {
        console.log(`  ${commit.hash.slice(0, 12)}  ${commit.subject}`);
        console.log(`    governed files: ${commit.files.join(", ")}`);
      }
      console.log("");
    }
    if (miscited.length > 0) {
      console.log(`gate:adr-trace — FAIL: ${miscited.length} commit(s) cite an ADR that does not exist. A trailer is not a citation unless it resolves:\n`);
      for (const commit of miscited) {
        console.log(`  ${commit.hash.slice(0, 12)}  ${commit.subject}`);
        console.log(`    cites: ${commit.cited.map((n) => `ADR-${String(n).padStart(3, "0")}`).join(", ")} — none allocated or reserved`);
        console.log(`    governed files: ${commit.files.join(", ")}`);
      }
      console.log("");
    }
    printRemedy();
  }

  // The control plane's observation convention (`observed_count: N`, parsed by
  // `parseGateObservedCount`): how many commits this run actually audited. A
  // declared `observes.min` above N is then `unresolved` rather than `passed`,
  // so "measured nothing" can never be reported as green. Printed on every path
  // that resolved a range, including a clean one — silence is not a result.
  //
  // TEXT PATH ONLY. In --json mode the report above is the entire stdout
  // contract: `gate:adr-trace --json | jq` is how the pre-push profile and the
  // tests consume this gate, and a line appended after the JSON object makes it
  // unparseable ("Unexpected non-whitespace character after JSON"). A JSON
  // consumer gets the count as `report.audited_commit_count` instead, which is
  // where a structured reader should be looking for it anyway.
  if (!jsonMode && range.kind === "resolved") {
    const audited = Number(gitOrNull(repoRoot, ["rev-list", "--count", `${range.before}..${range.after}`]) ?? "0");
    console.log(`observed_count: ${audited}`);
  }

  process.exitCode = report.ok ? 0 : 1;
}

function runBackfillReport(repoRoot, jsonMode, since) {
  const candidates = backfillCandidates({ repo: repoRoot, since });
  const withEvidence = candidates.filter((c) => c.candidate_adrs.length > 0);
  const report = {
    total_unclaimed: candidates.length,
    with_unambiguous_candidate: withEvidence.length,
    candidates,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`adr-trace --backfill-report — ${candidates.length} unclaimed governed-path commit(s) found${since ? ` since ${since}` : " (full history)"}.`);
    console.log(`  ${withEvidence.length} of them have an unambiguous candidate (they directly touched decisions/ADR-0NN-*.md).`);
    console.log("  This is a REPORT for a human to act on — nothing is written anywhere.\n");
    for (const c of candidates) {
      console.log(`  ${c.hash.slice(0, 12)}  ${c.subject}`);
      if (c.candidate_adrs.length > 0) {
        console.log(`    candidate: ${c.evidence}`);
      } else {
        console.log("    candidate: (none unambiguous — needs human investigation)");
      }
    }
  }

  // Report-only mode never fails the battery — it is explicitly not the
  // gate; it is the tool a human runs to work the backlog down.
  process.exitCode = 0;
}

/**
 * `--trace` — emit the derived ADR->work map that this script already builds.
 *
 * WHY THIS MODE EXISTS. `buildTraceIndex` has always computed exactly the
 * forward mapping an auditor wants — which files and commits were produced
 * under which decision — but only ever consumed it to compute the violation
 * set, then discarded it. The gate could say "this commit claims no ADR" and
 * could not answer "what was built under ADR-076?", even though the answer was
 * in memory a moment earlier.
 *
 * It stays DERIVED, which is ADR-075's whole point: no ADR declares a file
 * list, so no file list can drift. This mode reads git history and prints; it
 * writes nothing and introduces no store.
 *
 * `--since <ref>` scopes it, which is what makes a session-shaped answer
 * possible: `--trace --since <ref-at-session-start>` yields "these decisions
 * were worked, and these files were produced for each."
 */
function runTrace(repo, jsonMode, since, adrFilter) {
  const index = buildTraceIndex({ repo, since });
  const selected = adrFilter === null
    ? index
    : Object.fromEntries(Object.entries(index).filter(([adr]) => Number(adr) === adrFilter));

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, since: since ?? null, adr: adrFilter, trace: selected }, null, 2));
    return;
  }

  const adrs = Object.keys(selected);
  const scope = since ? `since ${since}` : "full history";
  if (adrs.length === 0) {
    console.log(`adr-trace --trace — no claimed work found (${scope}${adrFilter === null ? "" : `, ADR-${adrFilter}`}).`);
    return;
  }

  console.log(`adr-trace --trace — ${adrs.length} decision(s) with claimed work (${scope})\n`);
  for (const adr of adrs) {
    const entry = selected[adr];
    console.log(`ADR-${String(adr).padStart(3, "0")} — ${entry.commits.length} commit(s), ${entry.files.length} file(s)`);
    for (const c of entry.commits) console.log(`    ${c.hash.slice(0, 12)}  ${c.subject}`);
    for (const f of entry.files) console.log(`      · ${f}`);
    console.log("");
  }
}

function main() {
  const argv = process.argv.slice(2);
  const repoRoot = resolvePath(argValue(argv, "--repo") ?? resolvePath(__dirname, ".."));
  const jsonMode = argv.includes("--json");
  const backfillMode = argv.includes("--backfill-report");
  const traceMode = argv.includes("--trace");

  if (traceMode) {
    const adrRaw = argValue(argv, "--adr");
    runTrace(repoRoot, jsonMode, argValue(argv, "--since"), adrRaw === null ? null : Number(adrRaw));
  } else if (backfillMode) {
    runBackfillReport(repoRoot, jsonMode, argValue(argv, "--since"));
  } else {
    runGate(repoRoot, jsonMode, argValue(argv, "--range"));
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
