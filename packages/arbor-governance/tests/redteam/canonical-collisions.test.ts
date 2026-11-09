/**
 * tests/redteam/canonical-collisions.test.ts — adversarial probes against
 * @arbor/core's `canonicalizeForHash` (packages/arbor-core/src/canonical.ts).
 *
 * Sub-Agent 4 / ADR governance control plane, Part A (canonicalization
 * attacks, items 1-8 of the brief). Every probe is a REAL executable test
 * that runs the attack and asserts the actual outcome — a probe that finds a
 * weakness is a PASSING test documenting that weakness, never a failing one.
 *
 * Verdicts are summarized in this sub-agent's final report; see individual
 * `it()` names and comments for the reasoning behind each one.
 */

import { describe, it, expect } from "vitest";
import { canonicalizeForHash, CanonicalizationError } from "@arbor/core";

describe("redteam/canonical: attack 1 — whitespace-only changes", () => {
  it("HELD: cosmetic JSON formatting differences do not change the hash", () => {
    // Two source documents that differ only in incidental whitespace/newlines
    // parse to the identical JS value; canonicalizeForHash operates on the
    // parsed value, not on source bytes, so they must canonicalize identically.
    const compact = JSON.parse(`{"a":1,"b":"x"}`);
    const spread = JSON.parse(`{\n  "a" : 1,\n  "b" : "x"\n}\n`);
    expect(canonicalizeForHash(compact)).toBe(canonicalizeForHash(spread));
  });

  it("HELD: a real whitespace change inside a string value DOES change the hash", () => {
    // "x" vs "x " is a genuine semantic change (trailing space is real content),
    // not a formatting artifact — the hash must differ.
    const a = { text: "hello world" };
    const b = { text: "hello world " };
    expect(canonicalizeForHash(a)).not.toBe(canonicalizeForHash(b));
  });
});

describe("redteam/canonical: attack 2 — key reordering", () => {
  it("HELD: any permutation of the same key/value pairs hashes identically", () => {
    const orderings = [
      { a: 1, b: 2, c: 3 },
      { c: 3, b: 2, a: 1 },
      { b: 2, a: 1, c: 3 },
      { c: 3, a: 1, b: 2 },
    ];
    const hashes = orderings.map((o) => canonicalizeForHash(o));
    expect(new Set(hashes).size).toBe(1);
  });

  it("HELD: nested key reordering at every depth still hashes identically", () => {
    const a = { outer: { z: 1, y: { q: 1, p: 2 } }, first: true };
    const b = { first: true, outer: { y: { p: 2, q: 1 }, z: 1 } };
    expect(canonicalizeForHash(a)).toBe(canonicalizeForHash(b));
  });
});

describe("redteam/canonical: attack 3 — unicode confusables (NFC vs NFD)", () => {
  it("HELD: NFC and NFD encodings of the same text hash identically", () => {
    const nfc = "café"; // "café" as a single precomposed é (U+00E9)
    const nfd = "café"; // "café" as e + combining acute accent (U+0301)
    expect(nfc).not.toBe(nfd); // different code points as raw JS strings
    expect(canonicalizeForHash(nfc)).toBe(canonicalizeForHash(nfd));
  });

  it("HELD: NFC/NFD equivalence applies to object keys too", () => {
    const a = { [`café`]: 1 };
    const b = { [`café`]: 1 };
    expect(canonicalizeForHash(a)).toBe(canonicalizeForHash(b));
  });

  it("HELD: a genuinely different string (not canonically equivalent) hashes differently", () => {
    const cafe = "café";
    const cafes = "cafés";
    expect(canonicalizeForHash(cafe)).not.toBe(canonicalizeForHash(cafes));
  });
});

describe("redteam/canonical: attack 4 — undefined-valued keys are absent", () => {
  it("HELD: {a:1,b:undefined} hashes identically to {a:1}", () => {
    const withUndefined = { a: 1, b: undefined };
    const without = { a: 1 };
    expect(canonicalizeForHash(withUndefined)).toBe(canonicalizeForHash(without));
  });
});

describe("redteam/canonical: attack 5 — null is a distinct value from absence", () => {
  it("HELD: {a:null} hashes DIFFERENTLY from {}", () => {
    const withNull = { a: null };
    const empty = {};
    expect(canonicalizeForHash(withNull)).not.toBe(canonicalizeForHash(empty));
  });
});

describe("redteam/canonical: attack 6 — collision hunt", () => {
  it("HELD: nested empties — {} vs [] vs {a:{}} vs {a:[]} are all distinct", () => {
    const variants = [{}, [], { a: {} }, { a: [] }, { a: null }];
    const hashes = variants.map((v) => canonicalizeForHash(v));
    expect(new Set(hashes).size).toBe(variants.length);
  });

  it("HELD: string \"1\" and number 1 hash differently", () => {
    expect(canonicalizeForHash("1")).not.toBe(canonicalizeForHash(1));
  });

  it("HELD: dotted-key flat object vs equivalent nested object are distinct", () => {
    const flat = { "a.b": 1 };
    const nested = { a: { b: 1 } };
    expect(canonicalizeForHash(flat)).not.toBe(canonicalizeForHash(nested));
  });

  it("HELD: keys containing quotes/colons/braces serialize honestly and stay distinct", () => {
    const tricky1 = { 'a":1,"b': "x" };
    const tricky2 = { "{a}:1": "x" };
    const plain = { a: "x", b: "x" }; // unrelated shape, sanity control
    const hashes = [tricky1, tricky2, plain].map((v) => canonicalizeForHash(v));
    expect(new Set(hashes).size).toBe(3);
  });

  it("HELD: a key literally equal to another object's serialized form does not collide", () => {
    const nested = { a: { b: 1 } };
    const nestedCanonical = canonicalizeForHash(nested); // {"a":{"b":1}}
    const keyed = { [nestedCanonical]: "x" };
    expect(canonicalizeForHash(keyed)).not.toBe(nestedCanonical);
  });

  it("HELD: -0 and 0 hash identically (JSON has no negative zero) — benign, not a semantic collision", () => {
    // Object.is(-0, 0) is false in JS, but JSON.stringify(-0) === "0", and this
    // module inherits that behavior. Documented here as tested-and-accepted:
    // JSON's number model has no signed zero, so this is standard, not a flaw.
    expect(canonicalizeForHash(-0)).toBe(canonicalizeForHash(0));
  });

  it("FIXED (was VULNERABLE): {__proto__: {...}} literal is now rejected, not silently collided with {}", () => {
    // `{__proto__: X}` written as an object LITERAL sets the object's
    // *prototype* to X rather than creating an own enumerable property named
    // "__proto__". `Object.keys()` (used internally by `write()`) only sees
    // own enumerable properties, so this object has ZERO own keys as far as
    // canonicalizeForHash is concerned.
    //
    // This is a genuine collision between two semantically different values:
    // a caller who builds `{ ...spread, __proto__: someMetadata }` in
    // application code (e.g. constructing an ArtifactIdentity or evidence
    // record programmatically, where a field is named __proto__ — plausible
    // if a schema is generated from untrusted external field names) will
    // silently seal an EMPTY object instead of one carrying someMetadata,
    // with no error and no warning.
    //
    // NOTE ON SCOPE: this does NOT affect the realistic ledger-replay/JSONL
    // attack surface, because `JSON.parse` does NOT trigger the special
    // __proto__ setter — it creates a genuine own property (see the next
    // test). The risk here is narrower: in-process object construction using
    // literal `{ __proto__: ... }` syntax, not untrusted deserialized input.
    const withProtoLiteral = { __proto__: { polluted: true } } as Record<string, unknown>;
    expect(Object.keys(withProtoLiteral)).toEqual([]); // confirms the JS mechanism

    // FIXED, 2026-08-04, as a direct result of this probe. canonicalizeForHash
    // now rejects any object whose prototype is neither Object.prototype nor
    // null, because such a value canonicalized to "{}" and collided with a
    // genuinely empty object — two semantically different values producing
    // identical bytes, exactly what the module exists to prevent.
    //
    // This assertion is deliberately inverted from how the probe was first
    // written: it originally asserted the collision, so that it would FAIL the
    // moment the gap was closed. It has now failed, been reviewed, and is
    // rewritten as a regression guard locking the fix in.
    expect(() => canonicalizeForHash(withProtoLiteral)).toThrow(CanonicalizationError);
  });

  it("HELD: __proto__ arriving via JSON.parse (the realistic untrusted-data path) is an honest own property", () => {
    // JSON.parse never triggers the [[Set]] special-case for "__proto__"; it
    // always creates a genuine own data property. This is the actual shape
    // untrusted ledger/KB JSONL replay takes, and it serializes honestly.
    const viaParse = JSON.parse(`{"__proto__":{"a":1},"z":2}`) as Record<string, unknown>;
    expect(Object.keys(viaParse)).toContain("__proto__");
    expect(canonicalizeForHash(viaParse)).toBe(`{"__proto__":{"a":1},"z":2}`);
    expect(canonicalizeForHash(viaParse)).not.toBe(canonicalizeForHash({ z: 2 }));
  });

  it("HELD: a \"constructor\" key serializes honestly, no prototype-chain leakage", () => {
    const withConstructor = { constructor: { evil: 1 } };
    expect(canonicalizeForHash(withConstructor)).toBe(`{"constructor":{"evil":1}}`);
    expect(canonicalizeForHash(withConstructor)).not.toBe(canonicalizeForHash({}));
  });
});

describe("redteam/canonical: attack 7 — non-parseable output", () => {
  function assertRoundTrips(value: unknown): void {
    const serialized = canonicalizeForHash(value);
    expect(() => JSON.parse(serialized)).not.toThrow();
  }

  it("HELD: control characters in keys and values round-trip as valid JSON", () => {
    assertRoundTrips({ "key\twith\ttabs": "value\nwith\nnewlines\r\n" });
    assertRoundTrips({ " ": " control" });
  });

  it("HELD: embedded quotes and backslashes round-trip as valid JSON", () => {
    assertRoundTrips({ 'key"with"quotes': 'value\\with\\backslashes"and"quotes' });
  });

  it("HELD: lone UTF-16 surrogates round-trip as valid JSON (well-formed JSON.stringify escapes them)", () => {
    // A naive implementation could leave a lone surrogate unescaped in the
    // output string; when that string is later UTF-8 encoded (e.g. for
    // hashing or disk I/O), ALL lone surrogates collapse to the same U+FFFD
    // replacement byte sequence (EF BF BD), which would make two DIFFERENT
    // strings hash identically — a real collision vector. ES2019's
    // "well-formed JSON.stringify" change (which this module relies on via
    // plain JSON.stringify) escapes lone surrogates as literal \uDXXX text
    // instead, which is what we verify here: the escape sequences differ, so
    // no collision.
    const loneHigh = "\ud800";
    const loneLow = "\udc00";
    assertRoundTrips(loneHigh);
    assertRoundTrips(loneLow);
    expect(canonicalizeForHash(loneHigh)).not.toBe(canonicalizeForHash(loneLow));
    // Confirm the escaping actually happened (literal backslash-u present),
    // proving the string is not carrying a raw unescaped surrogate.
    expect(canonicalizeForHash(loneHigh)).toContain("\\ud800");
  });

  it("HELD: lone surrogates do NOT collapse to the same hash after UTF-8 encoding", () => {
    const a = canonicalizeForHash("\ud800");
    const b = canonicalizeForHash("\ud801");
    expect(Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"))).toBe(false);
  });
});

describe("redteam/canonical: attack 8 — prototype pollution via key names", () => {
  it("HELD: __proto__ and constructor keys via JSON.parse never corrupt prototype chain behavior", () => {
    const value = JSON.parse(`{"__proto__":{"admin":true},"constructor":{"evil":1},"safe":1}`) as Record<
      string,
      unknown
    >;
    // The parsed object's actual prototype must remain Object.prototype —
    // JSON.parse never triggers the setter.
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect((value as { admin?: boolean }).admin).toBeUndefined();
    const serialized = canonicalizeForHash(value);
    const reparsed = JSON.parse(serialized) as Record<string, unknown>;
    // Round-tripping through canonicalizeForHash must not introduce pollution
    // either: the reparsed object's prototype must also be untouched.
    expect(Object.getPrototypeOf(reparsed)).toBe(Object.prototype);
    expect(serialized).toContain('"__proto__"');
    expect(serialized).toContain('"constructor"');
  });
});

describe("redteam/canonical: rejected inputs stay rejected (sanity control)", () => {
  it("still rejects NaN/Infinity/bigint/Date/function/symbol as documented", () => {
    expect(() => canonicalizeForHash(NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(-Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(10n)).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(new Date())).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(() => {})).toThrow(CanonicalizationError);
    expect(() => canonicalizeForHash(Symbol("x"))).toThrow(CanonicalizationError);
  });
});
