/**
 * canonical.ts — the single canonical serializer for every hashed value in revoy2.
 *
 * WHY THIS EXISTS. Before this module there were four independently-written
 * canonicalizers (`arbor-audit/src/audit.ts`, `arbor-audit/src/output-evidence.ts`,
 * and `arbor-kb/src/kb.ts`),
 * and two of them disagreed by construction:
 *
 *   input                | audit.ts          | output-evidence.ts
 *   ---------------------|-------------------|---------------------------
 *   {a:1, b:undefined}   | {"a":1}           | {"a":1,"b":undefined}   <- NOT VALID JSON
 *   {z:1, "é":2}         | {"z":1,"é":2}     | {"é":2,"z":1}           <- ICU-dependent
 *
 * `output-evidence.ts` sorted with `localeCompare` (locale- and ICU-build-dependent,
 * so the same record could seal to different bytes on different machines) and did not
 * drop `undefined`-valued keys, so it could emit a byte string that cannot be re-parsed
 * as JSON. In a system whose premise is deterministic replay, that is a defect in the
 * evidence-sealing path, not a style nit.
 *
 * THE RULE: every hash in this repository goes through this function. Adding a fifth
 * implementation is a governance violation, not a refactor.
 *
 * Semantics are the strict superset of the previously-correct `audit.ts` behaviour:
 *   - object keys sorted by UTF-16 code unit (`.sort()`), never `localeCompare`
 *   - `undefined`-valued keys dropped entirely (absent), `null` preserved and distinct
 *   - arrays hashed in order; a caller needing set semantics must sort before
 *     calling (there is no way to infer set-ness from a JS array, and guessing
 *     is how hash instability gets introduced)
 *   - strings NFC-normalized so visually identical text hashes identically
 *   - non-finite numbers rejected rather than silently serialized as `null`
 *   - functions/symbols/bigint rejected rather than silently dropped
 *
 * Governing decision: ADR-027 (draft, this branch).
 */

/** Thrown when a value cannot be canonicalized deterministically. */
export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalizationError";
  }
}

/**
 * Deterministic JSON serialization suitable for hashing.
 *
 * Two semantically identical values MUST produce identical bytes; any meaningful
 * semantic change MUST change the bytes. Both properties are covered by
 * `tests/canonical.test.ts`, including a property-based key-order test.
 */
export function canonicalizeForHash(value: unknown): string {
  return write(value, "");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      // NFC so that visually identical strings with different Unicode composition
      // (e.g. "é" as U+00E9 vs U+0065 U+0301) hash identically.
      return JSON.stringify(value.normalize("NFC"));

    case "number":
      if (!Number.isFinite(value)) {
        // JSON.stringify turns these into `null`, silently collapsing three distinct
        // states into one. Reject instead of hashing a lie.
        throw new CanonicalizationError(`non-finite number ${String(value)}`, path);
      }
      return JSON.stringify(value);

    case "boolean":
      return value ? "true" : "false";

    case "undefined":
      // Only reachable at the root or inside an array; object properties are filtered
      // by the caller below. An array hole is a real ambiguity, so surface it.
      throw new CanonicalizationError("undefined is not canonicalizable in this position", path);

    case "bigint":
      throw new CanonicalizationError("bigint has no canonical JSON form", path);

    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} cannot be canonicalized`, path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => write(item, `${path}[${index}]`)).join(",")}]`;
  }

  if (value instanceof Date) {
    // Dates are ambiguous under hashing (local vs UTC, ms precision). Callers must
    // convert explicitly so the intended precision is visible at the call site.
    throw new CanonicalizationError("Date must be converted to an ISO string by the caller", path);
  }

  // Reject anything that is not a plain object. `{__proto__: X}` in literal
  // syntax SETS THE PROTOTYPE rather than creating an own property, so
  // Object.keys() sees zero keys and it canonicalizes to "{}" — colliding with a
  // genuinely empty object. Two semantically different values producing identical
  // bytes is precisely what this module exists to prevent, so reject rather than
  // silently collide. Class instances are rejected for the related reason that
  // their getters and methods are invisible to Object.keys and would be dropped.
  // Object.create(null) is allowed: it is a plain dictionary with no prototype.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(
      "only plain objects can be canonicalized (got an object with a non-Object prototype — "
        + "note that `{__proto__: x}` in literal syntax sets the prototype and creates no own property)",
      path,
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const entries = Object.keys(descriptors)
    .map((key) => ({ key, descriptor: descriptors[key]! }))
    .filter(({ key, descriptor }) => {
      if (!("value" in descriptor)) throw new CanonicalizationError("accessor properties are not canonicalizable", path ? `${path}.${key}` : key);
      return descriptor.value !== undefined;
    })
    .map(({ key, descriptor }) => ({ key, normalized: key.normalize("NFC"), value: descriptor.value }))
    .sort((left, right) => left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.normalized === entries[index]!.normalized) {
      throw new CanonicalizationError("object keys collide after NFC normalization", path);
    }
  }
  const body = entries
    .map(({ key, normalized, value: entryValue }) => `${JSON.stringify(normalized)}:${write(entryValue, path ? `${path}.${key}` : key)}`)
    .join(",");

  return `{${body}}`;
}
