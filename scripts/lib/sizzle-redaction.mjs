import { lstatSync, openSync, readFileSync, closeSync, constants } from "node:fs";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const SECRET_PATTERNS = Object.freeze([
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i],
  ["openai_key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{12,}\b/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["authorization_header", /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+\S+/i],
  ["credential_assignment", /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|signing[_-]?secret)\s*[:=]\s*["']?[^\s,"']{6,}/i],
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i],
  ["dotenv_secret", /^\s*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|ARBOR_A2A_SIGNING_SECRET)\s*=/im],
]);

export function scanTextForSecrets(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("secret scanner input must be text");
  const findings = [];
  for (const [code, pattern] of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const prefix = text.slice(0, match.index);
    findings.push(Object.freeze({
      code,
      line: prefix.split("\n").length,
      column: match.index - prefix.lastIndexOf("\n"),
    }));
  }
  if (options.reject_control_characters === true) {
    const match = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
    if (match !== null) findings.push(Object.freeze({ code: "control_character", line: 1, column: match.index + 1 }));
  }
  return Object.freeze(findings);
}

export function assertSecretFree(text, label = "input", options = {}) {
  const findings = scanTextForSecrets(text, options);
  if (findings.length > 0) {
    const summary = findings.map((finding) => `${finding.code}@${finding.line}:${finding.column}`).join(", ");
    throw new Error(`${label} failed publication secret scan: ${summary}`);
  }
  return Object.freeze({ label, bytes: Buffer.byteLength(text), findings: 0 });
}

export function readSecretFreeTextFile(path, options = {}) {
  const maximum = options.max_bytes ?? DEFAULT_MAX_BYTES;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular, non-symlink file`);
  if (stat.size > maximum) throw new Error(`${path} exceeds the ${maximum}-byte publication input limit`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    text = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const report = assertSecretFree(text, options.label ?? path, options);
  return Object.freeze({ text, report });
}

export const publicationSecretPatternCodes = Object.freeze(SECRET_PATTERNS.map(([code]) => code));
