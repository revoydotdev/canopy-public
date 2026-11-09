/**
 * ordering.ts — the deterministic string comparator for every sort whose
 * output anyone depends on.
 *
 * WHY THIS EXISTS. `canonical.ts` documents at length why `localeCompare` must
 * never decide byte order for HASHING: it is locale- and ICU-build-dependent,
 * so the same two strings can compare differently on two machines. That lesson
 * was applied to hashing and never to ORDERING, leaving `localeCompare` as the
 * sort comparator across the codebase — including inside the pure,
 * ledger-derived projectors this repository holds up as its determinism
 * exemplars.
 *
 * The divergence is not theoretical. Under a typical ICU build:
 *
 *     "a".localeCompare("B")  === -1     "a" < "B"   (case-insensitive-ish)
 *     "a" <  "B"              === false  "a" > "B"   (0x61 > 0x42)
 *
 *     "é".localeCompare("z")  === -1     "é" < "z"
 *     "é" <  "z"              === false  "é" > "z"   (0xE9 > 0x7A)
 *
 * Both shapes are reachable here: metric tag values carry provider/model names
 * with mixed case, and governance finding details carry ADR titles written by
 * humans. A projection whose row order depends on the host's ICU tables is not
 * reproducible, which is the one property those projections exist to have.
 *
 * WHY NOT JUST `.sort()`. Array.prototype.sort with no comparator coerces to
 * string and compares by code unit — correct, but only for arrays of bare
 * strings. Every site here sorts objects by one or more string FIELDS, which
 * needs an explicit comparator, and writing `a < b ? -1 : 1` inline at each
 * site is how the codebase ended up with 25 subtly-independent orderings in
 * the first place.
 */

/**
 * Compare two strings by UTF-16 code unit — the same order `canonical.ts`
 * uses for object keys, and the same order a bare `.sort()` produces.
 *
 * Deterministic across machines, locales and ICU versions. Chain it for
 * multi-key ordering exactly as you would chain `localeCompare`:
 *
 *     rows.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.id, b.id));
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
