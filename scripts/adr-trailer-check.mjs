#!/usr/bin/env node
/**
 * scripts/adr-trailer-check.mjs — refuse a governed-path commit whose message
 * carries no `ADR:` trailer, at the moment the message is written.
 *
 * Usage (from the commit-msg hook):
 *   node scripts/adr-trailer-check.mjs <path-to-commit-message-file>
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `gate:adr-trace`.
 * `gate:adr-trace` already enforces this rule, and enforces it correctly — but
 * it inspects COMMITTED history (`master..HEAD`), so it can only ever report a
 * commit that already exists, and it runs in the stop tier rather than at
 * commit time. That combination has a specific, repeatable cost:
 *
 *   1. commit source touching a governed path, with no trailer
 *   2. run `evidence:rebind` (~6 minutes) — it binds the VI graph to that commit's OID
 *   3. run the stop battery; adr-trace finally reports the missing trailer
 *   4. reword the commit — its OID changes
 *   5. `gate:vi-freshness` now fails: "graph revision is not an ancestor of HEAD"
 *   6. rebind again, for the same six minutes
 *
 * That loop cost three full rebinds in one session on 2026-08-29/30. The rule
 * was never in doubt; only its timing was. A commit-msg hook is the one place
 * that sees both the message and the staged paths BEFORE the commit exists, so
 * the trailer is fixed while fixing it is free.
 *
 * This does not replace `gate:adr-trace`. The gate remains the authority over
 * history — it catches commits made with hooks bypassed (`--no-verify`),
 * commits pulled from elsewhere, and anything this check let through. This is
 * the cheap early guard; the gate is the proof.
 *
 * The governed-path list is IMPORTED from adr-trace.mjs rather than restated.
 * Two copies of a path list is how the guard and the gate come to disagree
 * about what is governed, and the disagreement would surface as a commit this
 * check passed and the gate then refused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { governedPathPrefixes, knownAdrNumbers, parseAdrReferences } from "./adr-trace.mjs";
import { formatResolution, resolveAdrsForPaths } from "./adr-resolve.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * Staged paths for the commit being written. During a merge or a commit with
 * nothing staged this is empty, and an empty set means "nothing governed is
 * changing" — the check passes rather than guessing.
 */
export function stagedPaths() {
  return git(["diff", "--cached", "--name-only"]).split("\n").map((line) => line.trim()).filter(Boolean);
}

export function governedStagedPaths(paths, prefixes) {
  return paths.filter((file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
}

/**
 * True when the message carries a real `ADR:` trailer. Deliberately matches the
 * same shape `gate:adr-trace` accepts — a trailer line, not a mention of an ADR
 * anywhere in the prose, because a commit body that merely discusses ADR-149 is
 * not a claim that ADR-149 governs the change.
 */
export function hasAdrTrailer(message) {
  return message
    .split("\n")
    .some((line) => /^\s*ADR:\s*\d{1,3}(\s*,\s*\d{1,3})*\s*$/u.test(line));
}

/**
 * The trailer's numbers that resolve to no allocated or reserved record.
 *
 * The trailer regex accepts any one-to-three digit number, so `ADR: 999` used
 * to satisfy this guard and `gate:adr-trace` alike. Both proved a trailer had
 * been typed, never that the change was governed. Thirteen commits in this
 * repository carry `ADR: 148`, which has no file, no allocation and no index
 * row, and every layer passed them.
 *
 * Resolution is checked HERE as well as in the gate for the reason the gate's
 * own header gives about the trailer itself: fixing it before the commit
 * exists is free, and discovering it afterwards costs a reword plus a second
 * evidence rebind.
 */
export function unresolvedAdrReferences(message, known) {
  return parseAdrReferences(message).filter((number) => !known.has(number));
}

/** A merge commit's parentage is not the author's authorship claim; skip it. */
function isMerge() {
  return git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).trim() !== "";
}

function main() {
  const messagePath = process.argv[2];
  if (!messagePath) {
    console.error("adr-trailer-check: expected a commit message file path");
    process.exit(2);
  }
  if (isMerge()) process.exit(0);

  const message = readFileSync(messagePath, "utf-8");
  // A comment-only message means the commit is being aborted anyway.
  const body = message.split("\n").filter((line) => !line.startsWith("#")).join("\n");
  if (body.trim() === "") process.exit(0);

  const prefixes = governedPathPrefixes(REPO_ROOT);
  const governed = governedStagedPaths(stagedPaths(), prefixes);

  if (hasAdrTrailer(body)) {
    // A trailer is present. It is only a citation if something answers to it.
    if (governed.length === 0) process.exit(0);
    const known = knownAdrNumbers(REPO_ROOT);
    const cited = parseAdrReferences(body);
    if (cited.some((number) => known.has(number))) process.exit(0);
    const unresolved = unresolvedAdrReferences(body, known);
    console.error("");
    console.error("Commit refused: the ADR trailer names no decision that exists.");
    console.error("");
    for (const number of unresolved) console.error(`  ADR-${String(number).padStart(3, "0")} — not allocated, not reserved`);
    console.error("");
    console.error("A trailer is not a citation unless it resolves. Allocate the record first,");
    console.error("or cite the one that already governs this area:");
    console.error("");
    console.error("    bun scripts/adr-registry.mjs new <slug> --title \"...\"");
    console.error("    bun run adr:allocate <slug>");
    console.error("");
    if (governed.length > 0) {
      console.error(`    git log --format='%h|%s|%(trailers:key=ADR,valueonly)' -20 -- ${governed[0]}`);
      console.error("");
    }
    process.exit(1);
  }

  if (governed.length === 0) process.exit(0);

  // No trailer on a governed change. Before refusing, ask the resolver: when
  // history and proofs name one governing record beyond doubt, write the
  // trailer now and say so. An author who disagrees rewords in place; a
  // harness working on its own repository never has to guess. Set
  // ARBOR_ADR_AUTOFILL=0 to keep the refusal-only behaviour.
  if (process.env.ARBOR_ADR_AUTOFILL !== "0") {
    let resolution = null;
    try { resolution = resolveAdrsForPaths({ repo: REPO_ROOT, paths: governed }); } catch { resolution = null; }
    if (resolution !== null && resolution.suggestion.trailer !== null) {
      const trailer = resolution.suggestion.trailer;
      const trimmed = message.replace(/\s+$/u, "");
      writeFileSync(messagePath, `${trimmed}\n\n${trailer}\n`, "utf-8");
      console.error(`adr-trailer-check: added \`${trailer}\` (resolved from history and proofs for ${governed.length} governed path(s); set ARBOR_ADR_AUTOFILL=0 to disable).`);
      process.exit(0);
    }
    if (resolution !== null && resolution.governed) {
      console.error("");
      console.error("Commit refused: this change touches governed paths but claims no ADR, and no single record resolves for every path.");
      console.error("");
      console.error(formatResolution(resolution));
      console.error("");
      console.error("Add a trailer naming the governing ADR(s) as the last line of the message, e.g. `ADR: 149` or `ADR: 037, 149`.");
      console.error("");
      process.exit(1);
    }
  }

  const shown = governed.slice(0, 8);
  console.error("");
  console.error("Commit refused: this change touches governed paths but claims no ADR.");
  console.error("");
  for (const file of shown) console.error(`  ${file}`);
  if (governed.length > shown.length) console.error(`  … and ${governed.length - shown.length} more`);
  console.error("");
  console.error(`Governed prefixes: ${prefixes.join(", ")}`);
  console.error("");
  console.error("Add a trailer naming the governing ADR(s) as the last line of the message:");
  console.error("");
  console.error("    ADR: 149");
  console.error("    ADR: 037, 149");
  console.error("");
  console.error("Find the one that governs this area:");
  console.error("");
  console.error(`    git log --format='%h|%s|%(trailers:key=ADR,valueonly)' -20 -- ${shown[0]}`);
  console.error("");
  console.error("Fixing it now is free. gate:adr-trace catches it later instead — after");
  console.error("evidence:rebind has already bound the VI graph to this commit, so the");
  console.error("reword then costs a second ~6-minute rebind.");
  console.error("");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
