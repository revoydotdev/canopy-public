/**
 * scripts/lib/hollow-parity/branch-coverage.mjs — item 5, branch-coverage
 * signal (T5.2, 2026-08-23 remediation).
 *
 * Every other wiring gate in this repository proves a symbol was reached at
 * all; none of them prove every BRANCH inside a reached symbol was
 * exercised. WA-12 (audit/2026-08-23-50-defects.md) was exactly this shape:
 * `deriveTerminalOutcome`'s `switch` had no `cancelled` arm, so a cancelled
 * campaign fell through to the wrong terminal outcome — `deriveTerminalOutcome`
 * itself was fully "reachable" and its tests were green throughout. This
 * module is a REPORT, not a gate: it lists reachable production functions
 * whose v8 coverage shows an uncovered `if`/`switch` branch, ranked by
 * uncovered-branch count, so a human can decide which gaps are worth a test
 * versus acceptable debt. It never fails the build on its own.
 */

/**
 * Resolve, for one V8/istanbul coverage-final.json file entry, which
 * function (by `fnMap` id) encloses each `branchMap` entry, using start-line
 * containment (branch decl always sits inside its enclosing function's
 * source range in the instrumented output).
 */
function enclosingFunctionId(fnMap, branchStartLine) {
  let bestId = null;
  let bestStart = -1;
  for (const [id, fn] of Object.entries(fnMap)) {
    const start = fn.decl?.start?.line ?? fn.loc?.start?.line;
    const end = fn.loc?.end?.line ?? Infinity;
    if (start === undefined) continue;
    if (start <= branchStartLine && branchStartLine <= end && start > bestStart) {
      bestId = id;
      bestStart = start;
    }
  }
  return bestId;
}

/**
 * @param {object} coverageFinal - parsed coverage-final.json (istanbul/v8 shape)
 * @param {(filePath: string) => boolean} isProductionSourceFile - e.g. `packages/*\/src/**\/*.ts`, no `tests/`
 * @returns {Array<{file:string, function:string, line:number, uncoveredBranches:number, totalBranches:number}>}
 */
export function listUncoveredBranchFunctions(coverageFinal, isProductionSourceFile) {
  const results = [];
  for (const [filePath, fileCoverage] of Object.entries(coverageFinal)) {
    if (!isProductionSourceFile(filePath)) continue;
    const { fnMap, branchMap, b, f } = fileCoverage;
    if (!fnMap || !branchMap || !b) continue;
    /** @type {Map<string, {uncovered:number, total:number}>} */
    const perFunction = new Map();
    for (const [branchId, branch] of Object.entries(branchMap)) {
      if (branch.type !== "if" && branch.type !== "switch") continue;
      const startLine = branch.loc?.start?.line ?? branch.locations?.[0]?.start?.line;
      if (startLine === undefined) continue;
      const fnId = enclosingFunctionId(fnMap, startLine);
      if (fnId === null) continue;
      const counts = b[branchId] ?? [];
      const uncovered = counts.filter((count) => count === 0).length;
      const entry = perFunction.get(fnId) ?? { uncovered: 0, total: 0 };
      entry.uncovered += uncovered;
      entry.total += counts.length;
      perFunction.set(fnId, entry);
    }
    for (const [fnId, counts] of perFunction) {
      if (counts.uncovered === 0) continue;
      const fn = fnMap[fnId];
      const name = fn.name && fn.name.length > 0 ? fn.name : `<anonymous:${fnId}>`;
      // Reachability's checklist only tracks exported (named, non-anonymous) symbols.
      if (!fn.name) continue;
      const reachedAtAll = (f?.[fnId] ?? 0) > 0;
      if (!reachedAtAll) continue; // an unreached function is reachability's problem, not this report's
      results.push({
        file: filePath,
        function: name,
        line: fn.decl?.start?.line ?? fn.loc?.start?.line ?? 0,
        uncoveredBranches: counts.uncovered,
        totalBranches: counts.total,
      });
    }
  }
  return results;
}

/**
 * Keep only functions the reachability gate proved are reachable production
 * code, then sort descending by uncovered-branch count and cap at `limit`.
 * `reachableIndex` maps `${normalizedFile}::${name}` -> true (built from
 * `scripts/reachability.mjs --json`'s `checklist`).
 */
export function rankReachableUncoveredBranchFunctions(candidates, reachableIndex, limit = 50) {
  return candidates
    .filter((c) => reachableIndex.has(`${c.file}::${c.function}`))
    .sort((a, b) => b.uncoveredBranches - a.uncoveredBranches || a.file.localeCompare(b.file))
    .slice(0, limit);
}

/** Build the `${file}::${name}` reachable index from `scripts/reachability.mjs --json`'s `checklist`. */
export function buildReachableIndex(checklist) {
  const index = new Set();
  for (const entry of checklist) {
    if (entry.reachable) index.add(`${entry.file}::${entry.name}`);
  }
  return index;
}
