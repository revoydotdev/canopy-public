#!/usr/bin/env node
/**
 * scripts/adr-resolve.mjs — which decision governs these paths?
 *
 *   bun run adr:resolve -- <path>...          # ranked candidates per path, and one suggested trailer
 *   bun run adr:resolve -- --staged           # the paths staged for the next commit
 *   bun run adr:resolve -- --staged --trailer # print only the trailer line (empty when none is confident)
 *   bun run adr:resolve -- --json ...
 *
 * WHY THIS EXISTS. The commit-msg guard (adr-trailer-check.mjs) and
 * gate:adr-trace both demand that a commit touching a governed path cite the
 * decision that governs it, and both answer "which one?" with a `git log`
 * incantation the author runs by hand. A harness working on its own
 * repository — or any agent working on any governed repository — cannot run
 * an incantation and read the answer with judgement. It needs a function.
 *
 * WHAT GOVERNS A PATH, in this repository's own terms, is never declared in an
 * ADR body (there is no file list by design, ADR-trace manifest §1.1). It is
 * observable from three substrates, all of which already exist:
 *
 *   1. history — the ADRs cited by commits that touched the path, most recent
 *      commit weighted highest (`buildTraceIndex`, plus the path's latest
 *      claiming commit);
 *   2. proofs — an ADR whose obligation proof names the path as `file=` or
 *      `roundtrip=` has bound itself to that file explicitly;
 *   3. neighbourhood — when a path has never been committed under any ADR,
 *      the ADRs claimed for its nearest ancestor directory, weakest evidence.
 *
 * Records whose status is Superseded or Rejected are never suggested; the
 * successor is what governs now. Numbers that resolve to no registry
 * allocation are dropped (ADR-155).
 *
 * GENERALIST POSTURE. A repository with no decision registry, or no decisions
 * directory, is not governed by ADRs: the resolver reports `ungoverned` and an
 * empty trailer, and every caller treats that as "nothing to cite". It does
 * not manufacture a demand the repository never made. The governed prefixes
 * come from the project profile (or its defaults) exactly as the gate reads
 * them, so the resolver and the gate cannot disagree about scope.
 *
 * CONFIDENCE. A suggestion is `unique` only when every governed path has one
 * clear top candidate (score >= 3 with a margin over the runner-up). The
 * commit-msg guard auto-fills the trailer only then; anything weaker is shown
 * as candidates for the author to choose from. A wrong citation is worse than
 * a missing one — it survives every gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTraceIndex, governedPathPrefixes, knownAdrNumbers, parseAdrReferences } from "./adr-trace.mjs";
import { profileOrDefaults } from "./lib/project-profile.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Scores; the thresholds below are in the same units. */
export const WEIGHTS = Object.freeze({
  latest_history: 4,   // the most recent commit touching the path cites it
  history: 3,          // some commit touching the path cites it (once per ADR)
  proof: 3,            // an obligation proof names the path
  ancestor: 1.5,       // an ADR claimed for a sibling under the nearest ancestor
});
export const CONFIDENT_SCORE = 3;
export const CONFIDENT_MARGIN = 1;

function git(repo, args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

export function stagedPaths(repo = REPO_ROOT) {
  return git(repo, ["diff", "--cached", "--name-only"]).split("\n").map((line) => line.trim()).filter(Boolean);
}

export function isGoverned(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** `**Status:** Accepted` per record, keyed by number; absent when the file has no such line. */
export function recordStatuses(repo, decisionsDir) {
  const dir = join(repo, decisionsDir);
  const statuses = new Map();
  if (!existsSync(dir)) return statuses;
  for (const name of readdirSync(dir)) {
    const match = /^ADR-(\d{1,4})-.*\.md$/u.exec(name);
    if (!match) continue;
    const text = readFileSync(join(dir, name), "utf-8");
    const status = /^\*\*Status:\*\*\s*([A-Za-z]+)/mu.exec(text);
    statuses.set(Number(match[1]), status ? status[1].toLowerCase() : "unknown");
  }
  return statuses;
}

/** Paths each ADR binds itself to through `<!-- proof: ... file=X ... roundtrip=Y -->` comments. */
export function proofPaths(repo, decisionsDir) {
  const dir = join(repo, decisionsDir);
  const bound = new Map();
  if (!existsSync(dir)) return bound;
  for (const name of readdirSync(dir)) {
    const match = /^ADR-(\d{1,4})-.*\.md$/u.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    const text = readFileSync(join(dir, name), "utf-8");
    for (const comment of text.matchAll(/<!--\s*proof:([^>]*)-->/gu)) {
      for (const field of comment[1].matchAll(/\b(?:file|roundtrip)=(\S+)/gu)) {
        if (!bound.has(number)) bound.set(number, new Set());
        bound.get(number).add(field[1]);
      }
    }
  }
  return bound;
}

/** The ADRs cited by the most recent commit that touched `path`, if any. */
function latestClaim(repo, path) {
  const message = git(repo, ["log", "-1", "--format=%B", "--", path]);
  return parseAdrReferences(message);
}

/**
 * Ancestor directories to consult for a path with no history of its own,
 * nearest first, stopping BEFORE a governed prefix root: everything under
 * `packages/` is claimed by nearly every record, so that level is noise, not
 * evidence.
 */
function ancestors(path, prefixes) {
  const out = [];
  let current = dirname(path);
  while (current && current !== "." && current !== "/" && !prefixes.includes(current)) {
    out.push(current);
    current = dirname(current);
  }
  return out;
}

/**
 * Rank the candidate ADRs for one path. Every reason is kept so the author (or
 * the commit-msg guard's refusal text) can see why a number was suggested.
 */
export function rankCandidates({ repo, path, index, proofs, statuses, known, prefixes = [] }) {
  const scores = new Map();
  const add = (adr, weight, reason) => {
    if (known !== null && !known.has(adr)) return;
    const status = statuses.get(adr);
    if (status === "superseded" || status === "rejected") return;
    const entry = scores.get(adr) ?? { adr, score: 0, reasons: [] };
    entry.score += weight;
    entry.reasons.push(reason);
    scores.set(adr, entry);
  };
  for (const adr of latestClaim(repo, path)) add(adr, WEIGHTS.latest_history, "cited by the latest commit touching this path");
  for (const [key, entry] of Object.entries(index)) {
    if (!entry.files.includes(path)) continue;
    // A record cited by eighty commits on a path governs it more surely than
    // one cited by two; the bonus is logarithmic and capped so volume alone
    // never outranks the latest commit plus a proof.
    const volume = Math.min(2, Math.log10(Math.max(1, entry.commits.length)));
    add(Number(key), WEIGHTS.history + volume, `cited by ${entry.commits.length} commit(s) touching this path`);
  }
  for (const [adr, paths] of proofs) {
    if (paths.has(path)) add(adr, WEIGHTS.proof, "an obligation proof names this path");
  }
  if (scores.size === 0) {
    for (const ancestor of ancestors(path, prefixes)) {
      let found = false;
      for (const [key, entry] of Object.entries(index)) {
        const siblings = entry.files.filter((file) => file.startsWith(`${ancestor}/`)).length;
        if (siblings === 0) continue;
        found = true;
        add(Number(key), WEIGHTS.ancestor, `claimed for ${siblings} path(s) under ${ancestor}/`);
      }
      if (found) break;
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.adr - b.adr);
}

export function resolveAdrsForPaths({ repo = REPO_ROOT, paths, since = null } = {}) {
  const profile = profileOrDefaults(repo);
  const decisionsDir = profile.governance.decisions_dir;
  const known = knownAdrNumbers(repo);
  const prefixes = governedPathPrefixes(repo);
  const governedPaths = paths.filter((path) => isGoverned(path, prefixes));
  if (known === null || !existsSync(join(repo, decisionsDir))) {
    return {
      governed: false,
      reason: known === null ? "no decision registry in this repository" : `no ${decisionsDir}/ directory in this repository`,
      prefixes,
      per_path: paths.map((path) => ({ path, governed: false, candidates: [] })),
      suggestion: { adrs: [], confidence: "ungoverned", trailer: null },
    };
  }
  const index = buildTraceIndex({ repo, since });
  const proofs = proofPaths(repo, decisionsDir);
  const statuses = recordStatuses(repo, decisionsDir);
  const perPath = paths.map((path) => ({
    path,
    governed: isGoverned(path, prefixes),
    candidates: isGoverned(path, prefixes) ? rankCandidates({ repo, path, index, proofs, statuses, known, prefixes }) : [],
  }));
  const chosen = new Set();
  let confidence = governedPaths.length === 0 ? "none" : "unique";
  for (const entry of perPath) {
    if (!entry.governed) continue;
    const [top, next] = entry.candidates;
    if (top === undefined) { confidence = "ambiguous"; continue; }
    // Equal-scoring co-leaders are all chosen: a path that two accepted records
    // both claim through history is governed by both, and the trailer may
    // list both.
    const leaders = entry.candidates.filter((candidate) => candidate.score === top.score);
    const runnerUp = entry.candidates.find((candidate) => candidate.score < top.score);
    const margin = runnerUp === undefined ? Infinity : top.score - runnerUp.score;
    if (top.score >= CONFIDENT_SCORE && margin >= CONFIDENT_MARGIN && leaders.length <= 2) {
      for (const leader of leaders) chosen.add(leader.adr);
    } else {
      confidence = "ambiguous";
      void next;
    }
  }
  const adrs = [...chosen].sort((a, b) => a - b);
  return {
    governed: true,
    reason: null,
    prefixes,
    per_path: perPath,
    suggestion: {
      adrs,
      confidence,
      trailer: confidence === "unique" && adrs.length > 0 ? `ADR: ${adrs.map((n) => String(n).padStart(3, "0")).join(", ")}` : null,
    },
  };
}

export function formatResolution(result) {
  const lines = [];
  if (!result.governed) {
    lines.push(`ungoverned: ${result.reason}. Nothing to cite.`);
    return lines.join("\n");
  }
  for (const entry of result.per_path) {
    if (!entry.governed) { lines.push(`${entry.path}: not a governed path`); continue; }
    if (entry.candidates.length === 0) { lines.push(`${entry.path}: no candidate (never committed under an ADR; no proof names it)`); continue; }
    lines.push(`${entry.path}:`);
    for (const candidate of entry.candidates.slice(0, 4)) {
      lines.push(`  ADR-${String(candidate.adr).padStart(3, "0")}  ${candidate.score.toFixed(1)}  ${candidate.reasons.join("; ")}`);
    }
  }
  lines.push("");
  if (result.suggestion.trailer) lines.push(`suggested trailer (${result.suggestion.confidence}): ${result.suggestion.trailer}`);
  else lines.push(`no confident trailer (${result.suggestion.confidence}); choose from the candidates above or allocate a record.`);
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const trailerOnly = argv.includes("--trailer");
  const staged = argv.includes("--staged");
  const repoFlag = argv.indexOf("--repo");
  const repo = repoFlag === -1 ? REPO_ROOT : resolve(argv[repoFlag + 1]);
  const paths = argv.filter((arg, i) => !arg.startsWith("--") && !(i > 0 && argv[i - 1] === "--repo"));
  const targets = staged ? [...paths, ...stagedPaths(repo)] : paths;
  if (targets.length === 0) {
    console.error("usage: adr-resolve.mjs [--staged] [--json] [--trailer] [--repo PATH] [<path>...]");
    process.exit(2);
  }
  const result = resolveAdrsForPaths({ repo, paths: [...new Set(targets)] });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (trailerOnly) console.log(result.suggestion.trailer ?? "");
  else console.log(formatResolution(result));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
