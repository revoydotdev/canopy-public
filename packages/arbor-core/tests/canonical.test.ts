import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalizeForHash } from "../src/canonical.js";

describe("canonicalizeForHash — determinism", () => {
  it("is independent of object key insertion order", () => {
    const a = { zeta: 1, alpha: { y: 2, x: 3 }, mid: [1, 2] };
    const b = { mid: [1, 2], alpha: { x: 3, y: 2 }, zeta: 1 };
    expect(canonicalizeForHash(a)).toBe(canonicalizeForHash(b));
  });

  it("sorts keys by UTF-16 code unit, not by locale collation", () => {
    // The exact defect that made audit.ts and output-evidence.ts disagree:
    // localeCompare puts "é" before "z"; code-unit order puts it after.
    expect(canonicalizeForHash({ z: 1, "é": 2 })).toBe('{"z":1,"é":2}');
  });

  it("uppercase sorts before lowercase (code-unit order is stable across ICU builds)", () => {
    expect(canonicalizeForHash({ b: 1, A: 2 })).toBe('{"A":2,"b":1}');
  });

  it("preserves array order (arrays are sequences, not sets)", () => {
    expect(canonicalizeForHash([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalizeForHash([1, 2, 3])).not.toBe(canonicalizeForHash([3, 2, 1]));
  });

  it("produces byte-identical output across repeated calls", () => {
    const value = { a: [1, { b: null, c: "x" }], d: true };
    const runs = Array.from({ length: 50 }, () => canonicalizeForHash(value));
    expect(new Set(runs).size).toBe(1);
  });
});

describe("canonicalizeForHash — absent vs null vs present", () => {
  it("drops undefined-valued keys entirely", () => {
    expect(canonicalizeForHash({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("never emits the token `undefined` (the output-evidence.ts defect)", () => {
    // The old output-evidence.ts produced {"a":1,"b":undefined}, which is not
    // parseable JSON. Guard the invariant directly rather than the symptom.
    const out = canonicalizeForHash({ a: 1, b: undefined, c: { d: undefined } });
    expect(out).not.toContain("undefined");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("keeps null distinct from absent", () => {
    expect(canonicalizeForHash({ a: null })).toBe('{"a":null}');
    expect(canonicalizeForHash({ a: null })).not.toBe(canonicalizeForHash({}));
  });

  it("always emits parseable JSON for JSON-representable input", () => {
    const cases: unknown[] = [
      {},
      [],
      { a: undefined },
      { a: [null, 0, false, ""] },
      { nested: { deep: { deeper: [1, "two", false, null] } } },
    ];
    for (const value of cases) {
      expect(() => JSON.parse(canonicalizeForHash(value))).not.toThrow();
    }
  });
});

describe("canonicalizeForHash — Unicode", () => {
  it("NFC-normalizes values so visually identical strings hash identically", () => {
    const composed = "café"; // é as a single code point U+00E9
    const decomposed = "café"; // e + COMBINING ACUTE ACCENT U+0301
    // Prove the two really are distinct pre-normalization, so the assertion
    // below cannot pass tautologically if the source is ever normalized.
    expect(composed).not.toBe(decomposed);
    expect(composed.length).toBe(4);
    expect(decomposed.length).toBe(5);
    expect(canonicalizeForHash({ v: composed })).toBe(canonicalizeForHash({ v: decomposed }));
  });

  it("NFC-normalizes keys too", () => {
    expect(canonicalizeForHash({ "café": 1 })).toBe(canonicalizeForHash({ "café": 1 }));
  });
});

describe("canonicalizeForHash — rejects what it cannot hash honestly", () => {
  it("rejects NaN and Infinity rather than serializing them as null", () => {
    expect(() => canonicalizeForHash({ a: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash({ a: Infinity })).toThrow(CanonicalizationError);
  });

  it("rejects bigint, functions and symbols", () => {
    expect(() => canonicalizeForHash({ a: 1n })).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash({ a: () => 1 })).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash({ a: Symbol("s") })).toThrow(CanonicalizationError);
  });

  it("rejects Date so the caller must choose a precision explicitly", () => {
    expect(() => canonicalizeForHash({ at: new Date(0) })).toThrow(CanonicalizationError);
  });

  it("reports the path of the offending value", () => {
    expect(() => canonicalizeForHash({ outer: { inner: [1, NaN] } })).toThrow(/outer\.inner\[1\]/);
  });
});

describe("canonicalizeForHash — semantic change alters the bytes", () => {
  it("distinguishes every single-field mutation", () => {
    const base = { a: 1, b: "x", c: [1, 2], d: { e: true } };
    const mutations: unknown[] = [
      { a: 2, b: "x", c: [1, 2], d: { e: true } },
      { a: 1, b: "y", c: [1, 2], d: { e: true } },
      { a: 1, b: "x", c: [2, 1], d: { e: true } },
      { a: 1, b: "x", c: [1, 2], d: { e: false } },
      { a: 1, b: "x", c: [1, 2] },
      { a: "1", b: "x", c: [1, 2], d: { e: true } }, // type change
    ];
    const baseline = canonicalizeForHash(base);
    for (const mutated of mutations) {
      expect(canonicalizeForHash(mutated)).not.toBe(baseline);
    }
  });

  it("does not collide numeric and string representations", () => {
    expect(canonicalizeForHash({ a: 1 })).not.toBe(canonicalizeForHash({ a: "1" }));
  });
});


describe("canonicalizeForHash — plain-object guard (red-team finding)", () => {
  it("rejects `{__proto__: x}` literal instead of colliding with `{}`", () => {
    // Found by adversarial probe: the literal sets the prototype and creates no
    // own property, so Object.keys sees nothing and it used to canonicalize to
    // "{}" — identical to a genuinely empty object.
    expect(() => canonicalizeForHash({ __proto__: { polluted: true } })).toThrow(CanonicalizationError);
  });

  it("still accepts an honest __proto__ own-property from JSON.parse", () => {
    // The real ledger-replay path. JSON.parse creates a genuine own property,
    // which must serialize honestly rather than being rejected.
    const parsed = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(canonicalizeForHash(parsed)).toBe('{"__proto__":{"polluted":true}}');
    expect(canonicalizeForHash(parsed)).not.toBe(canonicalizeForHash({}));
  });

  it("accepts Object.create(null) dictionaries", () => {
    const dict = Object.create(null) as Record<string, unknown>;
    dict.a = 1;
    expect(canonicalizeForHash(dict)).toBe('{"a":1}');
  });

  it("rejects class instances, whose getters Object.keys cannot see", () => {
    class Thing { constructor(readonly a: number) {} get derived() { return this.a * 2; } }
    expect(() => canonicalizeForHash(new Thing(1))).toThrow(CanonicalizationError);
  });
});
