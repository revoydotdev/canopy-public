// arbor-core/search/rng — seeded, replayable randomness for search decisions.
// Governing records: ADR-186 (search policy core and the @arbor/search-runtime package), ADR-185 (reward is measured and provenance-typed).
//
// Every stochastic search decision draws from a generator whose entire state is
// one uint32. The state a decision started from is written into its replay
// record, so a decision can be re-derived alone, without replaying the stream
// that preceded it.
//
// Algorithms (public, independently implemented here):
//   - FNV-1a 32-bit string hash, used only to turn a seed string into a state.
//   - mulberry32 (a 32-bit counter-based mixer) as the uniform source.
//   - Marsaglia polar method for standard normals.
//   - Marsaglia & Tsang (2000), "A simple method for generating gamma
//     variables", with the u^(1/a) boost for shape < 1.
//   - Beta(a, b) as X / (X + Y), X ~ Gamma(a), Y ~ Gamma(b).
//
// Determinism boundary, stated rather than implied: integer mixing and
// `Math.sqrt` are exact, but ECMA-262 does not require `Math.log`/`Math.exp`
// to be correctly rounded. A Beta draw is therefore bit-for-bit reproducible on
// the same JavaScript engine; across engines a last-place difference is
// possible. Replay compares re-derived draws exactly, so such a difference
// surfaces as a reported mismatch, never as a silently different search.

/** A deterministic uniform source whose full state is one uint32. */
export interface SeededRng {
  /** The current uint32 state; constructing a generator from it continues the same stream. */
  readonly state: () => number;
  /** Next raw uint32. */
  readonly nextUint32: () => number;
  /** Next uniform in the open interval (0, 1). */
  readonly nextUniform: () => number;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const TWO_POW_32 = 4294967296;

/** FNV-1a over the string's UTF-16 code units, as an unsigned 32-bit integer. */
export function hashSeed(seed: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** A generator continuing from an exact uint32 state. */
export function createSeededRng(initialState: number): SeededRng {
  if (!Number.isInteger(initialState) || initialState < 0 || initialState >= TWO_POW_32) {
    throw new RangeError(`rng state must be a uint32, got ${initialState}`);
  }
  let state = initialState;
  const nextUint32 = (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  };
  return {
    state: () => state,
    nextUint32,
    // +0.5 keeps the result strictly inside (0, 1), so log(u) is always finite.
    nextUniform: () => (nextUint32() + 0.5) / TWO_POW_32,
  };
}

/**
 * The state a single search decision starts from. Derived from the search seed,
 * the step and the decision's index, so each decision is independently
 * replayable and two steps sharing a seed never share a stream.
 */
export function deriveDecisionState(seed: string, stepId: string, decisionIndex: number): number {
  return hashSeed(`${seed}\u0000${stepId}\u0000${decisionIndex}`);
}

function sampleStandardNormal(rng: SeededRng): number {
  for (;;) {
    const u = 2 * rng.nextUniform() - 1;
    const v = 2 * rng.nextUniform() - 1;
    const s = u * u + v * v;
    if (s > 0 && s < 1) return u * Math.sqrt((-2 * Math.log(s)) / s);
  }
}

/** One Gamma(shape, 1) variate. */
export function sampleGamma(rng: SeededRng, shape: number): number {
  if (!(shape > 0) || !Number.isFinite(shape)) throw new RangeError(`gamma shape must be finite and > 0, got ${shape}`);
  if (shape < 1) {
    const boosted = sampleGamma(rng, shape + 1);
    return boosted * Math.exp(Math.log(rng.nextUniform()) / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleStandardNormal(rng);
    const base = 1 + c * x;
    if (base <= 0) continue;
    const v = base * base * base;
    const u = rng.nextUniform();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One Beta(alpha, beta) variate in (0, 1). */
export function sampleBeta(rng: SeededRng, alpha: number, beta: number): number {
  const x = sampleGamma(rng, alpha);
  const y = sampleGamma(rng, beta);
  return x / (x + y);
}
