#!/usr/bin/env -S node
/**
 * scripts/adr-proof.mjs — author-time obligation proof resolver (`bun run proof`).
 *
 * WHY THIS EXISTS. ADR-088 shipped citing `validateAction` (never exported —
 * only `validateTaskComposerProposal` is) and `NativeRepositoryToolHost` (a
 * class name that does not exist; the real exported factory is
 * `createNativeRepositoryToolHost`). Both proofs were hand-typed from memory,
 * both were wrong, and neither was caught until `gate:obligations` ran AFTER
 * the ADR was already allocated and committed — the exact "unfalsifiable
 * claim dressed up as a checkable one" failure `@arbor/governance`'s
 * obligation package exists to prevent, just moved one step later than it
 * needed to be. This script closes that gap by running the SAME resolver at
 * authoring time, before a single character of the proof comment is typed by
 * hand.
 *
 * AGREEMENT WITH THE GATE, BY CONSTRUCTION. This does not reimplement symbol
 * or roundtrip resolution — it calls `resolveProofComment` from
 * `@arbor/governance`, the identical function `scripts/obligations-gate.ts`
 * calls (via `buildObligationCoverageReport` -> `computeObligationCoverage`).
 * A symbol/file/roundtrip triple this script accepts is therefore guaranteed
 * to resolve identically when `gate:obligations` sees it later — there is no
 * second grammar or second resolution path to drift out of sync with the
 * first (see `obligation/proof.ts`'s own header for why a second parser is
 * exactly the kind of duplicated knowledge this repository has been burned
 * by before).
 *
 * WHAT "RESOLVES" MEANS, restated because it is easy to over-claim: a
 * resolving `symbol=` proves the name is declared or re-exported at that
 * file's top level — not that it does what the obligation claims. A
 * resolving `roundtrip=` proves the named test file exists and is collected
 * by vitest — not that it passes, and not that it exercises this obligation.
 * This script is a citation-integrity check, exactly like the gate it mirrors.
 */

import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { findSymbolAcrossRepo, resolveProofComment, resolveRepoRoot } from "@arbor/governance";
import { evidenceTransactionReadStatus } from "./evidence-transaction.mjs";
import { assertGovernanceConsumerReady } from "./lib/governance-plan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function usage() {
  return [
    'usage: bun run proof <symbol> [--file <path>] [--test <path>] [--repo <path>] [--json]',
    "",
    "  <symbol>       the exported symbol name a proof comment will cite",
    "  --file <path>  repo-relative file the symbol must be declared/exported in",
    "                 (omit to search packages/*/src for it; the search must find",
    "                 exactly one match, or the symbol is ambiguous/unresolved)",
    "  --test <path>  repo-relative roundtrip test file (the obligation's --roundtrip=)",
    "",
    "On success, emits the exact `<!-- proof: symbol=X file=Y roundtrip=Z -->` comment",
    "ready to paste under an \"### O<n> — ...\" obligation heading. On failure, exits",
    "non-zero with the specific reason — including the ADR-088 case of a symbol that",
    "exists in source but is not exported at that file's top level.",
  ].join("\n");
}

/**
 * Resolves `symbol` to exactly one repo-relative file when `--file` was not
 * given, by delegating to the SAME repo-wide scan `resolveProofComment` uses
 * internally for a file-less proof (`findSymbolAcrossRepo`). Kept separate
 * from `resolveProofComment` itself only so this script can report "0 matches"
 * vs. "N matches" with the candidate list BEFORE resolution — a clearer
 * author-facing message than the gate's own generic "declared/exported in N
 * files" detail string.
 */
export function autoDetectFile(symbol, repoRoot) {
  const matches = findSymbolAcrossRepo(symbol, repoRoot);
  if (matches.length === 0) {
    return { ok: false, reason: `"${symbol}" is not declared or exported anywhere under packages/*/src` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `"${symbol}" is declared/exported in ${matches.length} files — pass --file to disambiguate:\n    ${matches.join("\n    ")}` };
  }
  return { ok: true, file: matches[0] };
}

/**
 * Runs the full author-time check: resolve `file` (given or auto-detected),
 * then resolve `symbol`/`roundtrip` against it via the gate's own resolver.
 * Never throws — every failure path returns `{ ok: false, reason }`.
 */
export function resolveProof({ symbol, file, roundtrip, repoRoot }) {
  if (!symbol || !symbol.trim()) return { ok: false, reason: "a symbol name is required" };

  let resolvedFile = file ?? null;
  if (!resolvedFile) {
    const detected = autoDetectFile(symbol, repoRoot);
    if (!detected.ok) return detected;
    resolvedFile = detected.file;
  }

  const raw = `symbol=${symbol}${resolvedFile ? ` file=${resolvedFile}` : ""}${roundtrip ? ` roundtrip=${roundtrip}` : ""}`;
  const result = resolveProofComment(
    { raw, symbol, file: resolvedFile ?? undefined, roundtrip: roundtrip ?? undefined },
    { repoRoot, at: new Date().toISOString() },
  );
  if (!result.ok) return { ok: false, reason: result.error.message };

  const resolution = result.value;
  const problems = [];
  if (resolution.symbol.state !== "resolved") problems.push(`symbol: ${resolution.symbol.detail}`);
  if (resolution.file && resolution.file.state !== "resolved") problems.push(`file: ${resolution.file.detail}`);
  if (!roundtrip) problems.push("roundtrip: --test <path> is required (an obligation with no roundtrip cannot be cited as resolving — use <!-- unverifiable: ... --> instead if no test exists yet)");
  else if (resolution.roundtrip.state !== "resolved") problems.push(`roundtrip: ${resolution.roundtrip.detail}`);

  if (problems.length > 0) return { ok: false, reason: problems.join("\n    "), resolution };

  const comment = `<!-- proof: symbol=${symbol} file=${resolvedFile} roundtrip=${roundtrip} -->`;
  return { ok: true, comment, symbol, file: resolvedFile, roundtrip, resolution };
}

function main() {
  const argv = process.argv.slice(2);
  const symbol = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const jsonMode = argv.includes("--json");

  if (!symbol || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exitCode = symbol ? 0 : 1;
    return;
  }

  const repoRoot = resolvePath(argValue(argv, "--repo") ?? resolvePath(__dirname, ".."));
  const file = argValue(argv, "--file");
  const roundtrip = argValue(argv, "--test");
  // resolveRepoRoot() is called only to fail loudly if --repo (or the default)
  // is not actually a repo the governance package can operate on — the same
  // marker check `resolveProofComment` applies internally.
  try {
    resolveRepoRoot(repoRoot);
    assertGovernanceConsumerReady({ consumer: "adr-proof", evidenceStatus: evidenceTransactionReadStatus({ repo: repoRoot }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode) console.log(JSON.stringify({ ok: false, reason: message }, null, 2));
    else console.error(`proof — FAIL: ${message}`);
    process.exitCode = 1;
    return;
  }

  const result = resolveProof({ symbol, file, roundtrip, repoRoot });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`proof — resolved:\n\n  ${result.comment}\n`);
  } else {
    console.error(`proof — FAIL: could not resolve a proof for "${symbol}":\n\n    ${result.reason}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
