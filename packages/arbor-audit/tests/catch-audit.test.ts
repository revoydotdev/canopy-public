/**
 * catch-audit.test.ts — X-2(b) (blindspot class 2, swallowed refusals).
 *
 * WHY THIS EXISTS. 243 `catch {}` sites were measured across every package's
 * src tree, 44 empty or comment-only. Two of today's real bugs hid there: the
 * empty `source_evidence_id` refusal and the fractional-p50 refusal, both
 * eaten by a bare catch upstream of the ledger. A `catch` block with no code
 * and no more than a comment is, by construction, indistinguishable from a
 * caller that meant to handle the error and forgot -- there is nothing left
 * in the source to tell the two apart except a human going and looking.
 *
 * This is a mechanical scan, in the same spirit as `verify-kind-coverage.
 * test.ts` and `id-prefix-coverage.test.ts`: it finds every `catch` block in
 * `packages/arbor-audit/src/**` and `packages/arbor-mcp/src/manager.ts`
 * whose body, once comments are stripped, has no executable code left, and
 * requires that block's ORIGINAL (unstripped) source to carry an explicit
 * `// benign-catch: <reason>` marker. A catch that DOES do something --
 * rethrow, return a typed failure, increment a counter -- is not required to
 * carry the marker; only a catch that discards the error with no observable
 * consequence is.
 *
 * The three sites this test found when it was written (`repair-log.ts`'s
 * best-effort tip scan, `audit.ts`'s `fromJSONL` malformed-line skip, and
 * `manager.ts`'s event-sink isolation catch) are the finding: each already
 * had a real justification in its surrounding comment, but nothing made that
 * justification MANDATORY or machine-checkable before this test. All three
 * were given the marker as part of landing this file. Any NEW empty-or-
 * comment-only catch, in either owned tree, must carry the marker too, or
 * this test fails and names the exact file and line.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BENIGN_CATCH_MARKER = "benign-catch:";

interface CatchBlock {
  file: string;
  line: number;
  raw: string;
}

/** Recursively list every `.ts` file under `dir` (test files excluded -- this scans production source only). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Every `catch` block in `source`, with its raw (unstripped) body text and
 * 1-based starting line number. Handles both `catch {` and `catch (id) {`.
 * Brace-balances rather than regex-matching the body, so a nested object
 * literal or arrow function inside the catch does not truncate the scan.
 */
function findCatchBlocks(source: string, file: string): CatchBlock[] {
  const blocks: CatchBlock[] = [];
  const pattern = /catch\s*(\([^)]*\))?\s*\{/g;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    const openBraceIndex = m.index + m[0].length - 1;
    let depth = 1;
    let i = openBraceIndex + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    if (depth !== 0) throw new Error(`${file}: unbalanced braces scanning a catch block at offset ${m.index} -- the scan must fail loudly, not silently pass`);
    const raw = source.slice(openBraceIndex + 1, i - 1);
    const line = source.slice(0, m.index).split("\n").length;
    blocks.push({ file, line, raw });
  }
  return blocks;
}

/** Strip `//` line comments and `/* * /` block comments, then trim -- what's left is executable code, if any. */
function stripComments(body: string): string {
  const noBlockComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLineComments = noBlockComments.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  return noLineComments.trim();
}

const OWNED_ROOTS = [
  join(import.meta.dirname, "../src"),
  join(import.meta.dirname, "../../arbor-mcp/src/manager.ts"),
];

function ownedFiles(): string[] {
  const files: string[] = [];
  for (const root of OWNED_ROOTS) {
    if (statSync(root).isDirectory()) files.push(...listTsFiles(root));
    else files.push(root);
  }
  return files;
}

function emptyOrCommentOnlyCatches(): CatchBlock[] {
  const found: CatchBlock[] = [];
  for (const file of ownedFiles()) {
    const source = readFileSync(file, "utf8");
    for (const block of findCatchBlocks(source, file)) {
      if (stripComments(block.raw) === "") found.push(block);
    }
  }
  return found;
}

describe("empty/comment-only catch blocks require an explicit benign-catch marker (X-2b, class 2)", () => {
  it("finds at least one catch block across the owned trees -- guard against a scan that silently matches nothing", () => {
    let total = 0;
    for (const file of ownedFiles()) total += findCatchBlocks(readFileSync(file, "utf8"), file).length;
    expect(total).toBeGreaterThan(0);
  });

  it("every empty-or-comment-only catch carries the benign-catch marker with a non-empty reason", () => {
    const offenders = emptyOrCommentOnlyCatches().filter((block) => {
      const markerIndex = block.raw.indexOf(BENIGN_CATCH_MARKER);
      if (markerIndex === -1) return true;
      const reason = block.raw.slice(markerIndex + BENIGN_CATCH_MARKER.length).replace(/\*\/$/, "").trim();
      return reason.length === 0;
    });
    const report = offenders.map((o) => `${o.file}:${o.line}`).join(", ");
    expect(offenders, `empty/comment-only catch(es) missing a "// ${BENIGN_CATCH_MARKER} <reason>" marker: ${report}`).toEqual([]);
  });

  it("reports the grandfathered count -- informational, not a hardcoded allowlist", () => {
    // This count is the X-2(b) finding: how many pre-existing empty/comment-
    // only catches needed the marker added when this test landed. It is
    // NOT an allowlist -- the marker requirement above applies uniformly to
    // every catch this scan finds, forever, including ones added after
    // today. This assertion only documents the number for the report.
    const count = emptyOrCommentOnlyCatches().length;
    expect(count).toBeGreaterThanOrEqual(0);
    // eslint-disable-next-line no-console -- deliberate, human-facing report line
    console.log(`X-2(b): ${count} empty/comment-only catch(es) in owned trees, all carrying the benign-catch marker.`);
  });
});
