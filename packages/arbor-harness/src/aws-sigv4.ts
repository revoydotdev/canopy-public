/**
 * AWS Signature Version 4 request signing, hand-rolled against `node:crypto`.
 *
 * `arbor-harness/package.json` declares no `@aws-sdk/*` dependency (ADR-100);
 * this module exists specifically so the Bedrock adapter can sign requests
 * without one. The canonical-request/string-to-sign/signing-key algorithm is
 * implemented directly from AWS's own published specification:
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * ("Create a signed AWS API request", fetched 2026-08-26) and verified
 * byte-for-byte against AWS's own SigV4 conformance test-suite vectors
 * (`aws/aws-sdk-ruby`'s `gems/aws-sigv4/spec/suite/`, `get-vanilla`/
 * `post-vanilla`/`get-vanilla-query-order-key-case`) in
 * `packages/arbor-harness/tests/aws-sigv4.test.ts`.
 *
 * Scope: header-based SigV4 (`Authorization` header), not query-string
 * (presigned URL) signing -- Bedrock's `InvokeModel*` operations are always
 * called with header auth.
 */
import { createHash, createHmac } from "node:crypto";

export interface AwsSigV4Credentials {
  readonly access_key_id: string;
  readonly secret_access_key: string;
  /** Present only for AWS STS temporary credentials. */
  readonly session_token?: string;
}

export interface AwsSigV4RequestToSign {
  readonly method: string;
  /** Absolute URL. Only its path and query string are signed; scheme/host come from `url`'s own host, which must equal the `host` header AWS will see. */
  readonly url: string | URL;
  readonly region: string;
  readonly service: string;
  /**
   * Extra headers to include in the signature, beyond `host` and
   * `x-amz-date`/`x-amz-security-token` (which this module adds itself).
   * Header names are case-insensitive; values are used verbatim after
   * trimming, per the spec's `Trim()` step.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request payload. Absent/undefined is treated as an empty body. */
  readonly body?: string | Uint8Array;
  /** Defaults to `new Date()`. Exposed for deterministic tests. */
  readonly date?: Date;
}

export interface AwsSigV4SignedRequest {
  /**
   * Headers to add to the outgoing request: `host`, `x-amz-date`,
   * `x-amz-security-token` (only with a session token), and `authorization`.
   * The caller merges these into its own header set.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly canonical_request: string;
  readonly string_to_sign: string;
  readonly signature: string;
  readonly credential_scope: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

export function signAwsSigV4Request(request: AwsSigV4RequestToSign, credentials: AwsSigV4Credentials): AwsSigV4SignedRequest {
  nonEmpty(credentials.access_key_id, "access_key_id");
  nonEmpty(credentials.secret_access_key, "secret_access_key");
  nonEmpty(request.region, "region");
  nonEmpty(request.service, "service");
  const url = request.url instanceof URL ? request.url : new URL(request.url);
  const date = request.date ?? new Date();
  const amzDate = toAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = hashHex(request.body ?? "");
  const extraHeaders = lowercasedTrimmedHeaders(request.headers ?? {});
  const signedHeaderEntries: Array<readonly [string, string]> = [
    ["host", url.host],
    ...extraHeaders,
    ["x-amz-date", amzDate],
    ...(credentials.session_token === undefined ? [] : [["x-amz-security-token", credentials.session_token] as const]),
  ];
  // Canonical headers must be sorted by lowercase header name; duplicates are
  // rejected rather than silently merged (a caller error, not ours to guess).
  const byName = new Map<string, string>();
  for (const [name, value] of signedHeaderEntries) {
    if (byName.has(name)) throw new AwsSigV4Error(`duplicate header in signed set: ${name}`);
    byName.set(name, value);
  }
  const sortedNames = [...byName.keys()].sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${byName.get(name)}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashHex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey(credentials.secret_access_key, dateStamp, request.region, request.service);
  const signature = hmacHex(signingKey, stringToSign);

  const authorization = `${ALGORITHM} Credential=${credentials.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return Object.freeze({
    headers: Object.freeze({
      host: url.host,
      "x-amz-date": amzDate,
      ...(credentials.session_token === undefined ? {} : { "x-amz-security-token": credentials.session_token }),
      authorization,
    }),
    canonical_request: canonicalRequest,
    string_to_sign: stringToSign,
    signature,
    credential_scope: credentialScope,
  });
}

export class AwsSigV4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsSigV4Error";
  }
}

function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const dateRegionKey = hmac(dateKey, region);
  const dateRegionServiceKey = hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, "aws4_request");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function hashHex(data: string | Uint8Array): string {
  return createHash("sha256").update(data as never).digest("hex");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Per the spec: URI-encode every byte except A-Z a-z 0-9 - . _ ~; uppercase hex; '/' preserved as a path separator. */
function uriEncode(value: string, preserveSlash: boolean): string {
  return [...Buffer.from(value, "utf8")].map((byte) => {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
    if (preserveSlash && ch === "/") return ch;
    return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function canonicalUri(pathname: string): string {
  if (pathname.length === 0) return "/";
  // Normalize each segment (decode then strictly re-encode) so a caller
  // that already percent-encoded a path component is not double-encoded,
  // while '/' itself is never encoded.
  return pathname.split("/").map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* leave as-is if not valid percent-encoding */ }
    return uriEncode(decoded, false);
  }).join("/");
}

function canonicalQueryString(params: URLSearchParams): string {
  const pairs: Array<readonly [string, string]> = [];
  for (const [key, value] of params.entries()) pairs.push([uriEncode(key, false), uriEncode(value, false)]);
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function lowercasedTrimmedHeaders(headers: Readonly<Record<string, string>>): Array<readonly [string, string]> {
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), trimHeaderValue(value)] as const);
}

/** Trim leading/trailing whitespace and collapse internal runs, per the spec's `Trim()` step. */
function trimHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new AwsSigV4Error(`${label} must be non-empty`);
}
