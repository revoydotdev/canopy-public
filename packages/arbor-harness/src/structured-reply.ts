/**
 * Provider-neutral recovery of a structured-output reply.
 *
 * Real providers occasionally wrap a schema-conformant JSON value in
 * reasoning preamble or a Markdown code fence even when strict structured
 * output was requested (`response_format: json_schema, strict: true` and
 * Anthropic's `output_config.format` are provider conveniences, never
 * guarantees), and a reply cut off at the output-token limit carries no
 * closed value at all. Recovery makes exactly one bounded, deterministic
 * attempt and never widens what counts as valid JSON: the recovered text
 * still has to parse, and the caller still runs it through the exact same
 * closed contract validation.
 *
 * A reply with no recoverable value is NOT a protocol failure. It is the
 * model missing the contract, the same kind of miss as JSON the contract
 * rejects, so it is reported as `unparsed` with a bounded reason and the
 * native worker spends its bounded structured-output corrections on it.
 */
export type NativeStructuredReply =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "unparsed"; readonly reason: string };

export function recoverStructuredReply(content: string): NativeStructuredReply {
  if (content.trim().length === 0) return Object.freeze({ kind: "unparsed", reason: "the reply was empty" });
  try {
    return Object.freeze({ kind: "parsed", value: JSON.parse(content.trim()) as unknown });
  } catch {
    const extracted = extractJsonValue(content);
    if (extracted === null) {
      return Object.freeze({ kind: "unparsed", reason: /[{[]/.test(content) ? "the reply held no complete JSON value" : "the reply was prose with no JSON value" });
    }
    return Object.freeze({ kind: "parsed", value: JSON.parse(extracted) as unknown });
  }
}

/**
 * Attempts, in order, to recover a JSON value from content that already
 * failed a direct parse: (1) a single leading/trailing Markdown code fence,
 * then (2) the first balanced top-level JSON object/array anywhere in the
 * content. Returns null -- never throws -- if neither strategy yields
 * parseable JSON; the caller decides what to do with that.
 */
export function extractJsonValue(content: string): string | null {
  const fenced = stripCodeFence(content);
  if (fenced !== null && isParsableJson(fenced)) return fenced;
  const balanced = extractBalancedJson(content);
  if (balanced !== null && isParsableJson(balanced)) return balanced;
  return null;
}

/** Strips one fence -- ```json ... ``` or ``` ... ``` -- spanning the entire trimmed content. */
function stripCodeFence(content: string): string | null {
  const trimmed = content.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match === null ? null : match[1].trim();
}

/**
 * Finds the first balanced JSON object/array starting at the first `{` or
 * `[` in content, and returns the substring through its matching close.
 * The depth counter treats string literals as opaque -- a `{`, `}`, `[`, or
 * `]` inside a JSON string value (including an escaped `"` or `\`) never
 * changes depth -- so it cannot be fooled by structural characters that are
 * really just string content. A single linear pass over content that the
 * adapter has already length-capped; returns null on an unbalanced scan
 * (e.g. a truncated value) rather than guessing.
 */
function extractBalancedJson(content: string): string | null {
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" || content[i] === "[") { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

function isParsableJson(candidate: string): boolean {
  try { JSON.parse(candidate); return true; } catch { return false; }
}
