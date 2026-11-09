/**
 * Key-SHAPED credential scrubbing shared by every redaction boundary.
 *
 * `redactNativeText` already removes values the composition root named and
 * `api_key=`/`Bearer` assignments, but a provider or tool error message can
 * echo a credential with no such label ("quota exceeded for key sk-proj-…").
 * Those copies reach the node error, the ledger trace, the failure_mode KB
 * entry and, through KB injection, the next specialist's prompt. This module
 * recognises a credential by its own shape instead of by its label.
 *
 * Two classes of rule:
 *  - vendor shapes: a documented prefix plus a body long enough that prose
 *    cannot plausibly match (sk-/pk-/rk- keys incl. sk-proj-/sk-ant-, AWS
 *    AKIA/ASIA ids, GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, Slack xox*,
 *    JWTs, Google AIza…). These apply anywhere.
 *  - one generic rule: a 32+ character opaque run that mixes letters and
 *    digits, ONLY when it directly follows a key-ish word (key, token,
 *    secret, credential, password, auth). An unlabelled run is left alone so
 *    git SHAs, `sha256:` digests, UUIDs and base64 content an operator asked
 *    to see survive; even after a key-ish word, a bare 40/64-hex digest, a
 *    `sha256:`-prefixed digest and a UUID are never treated as a credential.
 */

const DEFAULT_REPLACEMENT = "[REDACTED]";

/** Vendor key shapes; each body requires both a letter and a digit where the vendor format allows prose-like words. */
const VENDOR_KEY_SHAPES: readonly RegExp[] = Object.freeze([
  // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-…), Stripe (sk_/pk_/rk_ live/test) and similar.
  /\b(?:sk|pk|rk)[-_](?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}/g,
  // AWS access key ids (long-term AKIA, temporary ASIA).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // GitHub classic and fine-grained tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // Slack bot/user/app/refresh tokens.
  /\bxox[abposre]-[A-Za-z0-9-]{10,}/g,
  // JWT: base64url JSON header (always `eyJ`), payload, signature.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
]);

/** A key-ish label, optional short separator, then a 32+ char opaque run. */
const CONTEXTUAL_OPAQUE_RUN = /\b((?:api[-_]?key|access[-_]?key|key|token|secret|credentials?|password|passwd|auth)\b["'`\s:=]{1,4})((?:sha256:)?[A-Za-z0-9+/_=-]{32,})(?![A-Za-z0-9+/_=-])/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function isCredentialRun(run: string): boolean {
  if (run.toLowerCase().startsWith("sha256:")) return false;
  if (UUID.test(run) || HEX_DIGEST.test(run)) return false;
  return /\d/.test(run) && /[A-Za-z]/.test(run);
}

/**
 * Replace every key-shaped credential in `value` with `replacement`. Pure and
 * idempotent; the replacement never matches a rule itself.
 */
export function redactCredentialShapes(value: string, replacement: string = DEFAULT_REPLACEMENT): string {
  let result = value;
  for (const shape of VENDOR_KEY_SHAPES) result = result.replace(shape, replacement);
  return result.replace(CONTEXTUAL_OPAQUE_RUN, (whole, label: string, run: string) => isCredentialRun(run) ? `${label}${replacement}` : whole);
}
