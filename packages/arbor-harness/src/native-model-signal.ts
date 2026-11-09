/** Typed, provider-neutral observations exposed by native model adapters. Governing record: ADR-120 (typed failure signals survive routing). */
export type NativeModelSignal = NativeContextOverflowSignal;

/** A provider explicitly rejected the request because its context was too large. */
export interface NativeContextOverflowSignal {
  readonly kind: "context_overflow";
  /** Stable provider error code, when the wire protocol supplied one. */
  readonly provider_code: string | null;
  /** Provider-reported prompt size, when its semantics are unambiguous. */
  readonly observed_tokens?: number;
  /** Provider-reported context ceiling, when its semantics are unambiguous. */
  readonly context_limit?: number;
}

/**
 * Recognize only explicit context-limit rejections from a bounded, already
 * extracted provider error detail. Arbitrary HTTP 400s and generic token
 * mentions are deliberately not treated as overflow.
 */
export function nativeContextOverflowSignal(detail: string | null): NativeContextOverflowSignal | null {
  if (detail === null || detail.length === 0) return null;
  const normalized = detail.toLowerCase().replace(/[\s-]+/g, "_");
  const codeMatch = normalized.match(/(?:^|[^a-z0-9_])(context_length_exceeded|max_context_length_exceeded|input_too_long|prompt_too_long)(?:$|[^a-z0-9_])/);
  const providerCode = codeMatch?.[1] ?? null;
  const phrase = /(?:prompt|input|request)(?:_token(?:_count)?)?_(?:is_)?too_long|(?:context_length|context_window|context_size|maximum_context_length)_?(?:has_been_)?exceeded|exceeds?_the_(?:maximum_)?context_(?:length|window)|(?:input_)?token_count_\([^)]*\)_exceeds?_the_maximum_number_of_tokens|maximum_context_length_is_[0-9]+_tokens.*requested_[0-9]+_tokens/.test(normalized);
  if (providerCode === null && !phrase) return null;
  return Object.freeze({ kind: "context_overflow", provider_code: providerCode });
}
