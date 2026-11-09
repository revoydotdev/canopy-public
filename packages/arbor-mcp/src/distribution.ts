/**
 * Signed release distribution boundary.
 *
 * A payload only becomes a `VerifiedRelease` after its manifest, channel,
 * version, checksum and Ed25519 signature have all been checked.  The bytes
 * are deliberately held in a module-private WeakMap: activation has no API
 * which accepts arbitrary bytes, so an unpacker cannot accidentally be wired
 * before verification.
 */
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RELEASE_PRODUCT = "revoy" as const;
export const RELEASE_TRUST_STORE_FILENAME = "release-trust-roots.json" as const;
export const RELEASE_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export type ReleaseChannel = "stable" | "beta";

export interface ReleaseManifest {
  readonly schema_version: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly product: typeof RELEASE_PRODUCT;
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly published_at: string;
  readonly artifact: Readonly<{ readonly name: string; readonly format: "tar.gz"; readonly size: number; readonly sha256: string }>;
  readonly signing: Readonly<{ readonly algorithm: "ed25519"; readonly key_id: string; readonly signature: string }>;
}

export interface ReleaseTrustRoot { readonly key_id: string; readonly public_key: string | Uint8Array; }
export interface ReleaseTrustStore {
  readonly schema_version: 1;
  readonly roots: readonly Readonly<{ readonly key_id: string; readonly public_key_pem: string; readonly spki_sha256: string }>[];
}
export interface ReleaseAuditRecord {
  readonly at: string;
  readonly outcome: "verified" | "refused" | "activated" | "rolled_back";
  readonly channel: string;
  readonly version: string | null;
  readonly reason?: string;
}
export interface VerifiedRelease { readonly manifest: Readonly<ReleaseManifest>; readonly verified_at: string; }
export interface ReleaseCandidate { readonly manifest_bytes: Uint8Array; readonly artifact_bytes: Uint8Array; readonly manifest: Readonly<ReleaseManifest>; readonly source_url: string; }
export interface VerifyReleaseOptions {
  readonly channel: ReleaseChannel;
  readonly current_version?: string;
  readonly trust_roots: ReadonlyMap<string, string | Uint8Array> | readonly ReleaseTrustRoot[];
  readonly now?: () => Date;
  /** An append-only JSONL ledger owned by the host, never a release payload. */
  readonly audit_log?: string;
}
export interface ReleaseActivationOptions {
  readonly state_dir: string;
  readonly channel: ReleaseChannel;
  readonly trust_roots: VerifyReleaseOptions["trust_roots"];
  readonly now?: () => Date;
  /** Test/host crash seam: throwing here must leave the old pointer active. */
  readonly before_activate?: (staged_artifact_path: string) => void;
  readonly audit_log?: string;
}
export interface ReleaseActivation { readonly channel: ReleaseChannel; readonly version: string; readonly artifact_path: string; readonly previous_version: string | null; }

const releaseBytes = new WeakMap<object, Uint8Array>();

/** Stable out-of-band identity operators compare before pinning a release key. */
export function releaseTrustRootFingerprint(publicKey: string | Uint8Array): string {
  const key = trustedEd25519Key(publicKey);
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

/**
 * One-time trust bootstrap. The expected fingerprint must arrive through a
 * channel independent of the release payload; an existing store is immutable
 * so an artifact cannot rotate its own verification authority.
 */
export function initializeReleaseTrustStore(stateDir: string, roots: readonly ReleaseTrustRoot[], expectedFingerprints: ReadonlyMap<string, string>): ReleaseTrustStore {
  if (roots.length === 0 || roots.length > 16) throw new Error("release trust bootstrap requires 1..16 roots");
  const root = resolve(stateDir); ensurePrivateDirectory(root);
  const file = join(root, RELEASE_TRUST_STORE_FILENAME); assertSafeFile(file);
  if (existsSync(file)) throw new Error("release trust store already exists; refusing implicit key rotation");
  const seen = new Set<string>();
  const stored = roots.map(({ key_id, public_key }) => {
    if (!identifier(key_id) || seen.has(key_id)) throw new Error("release trust root ids must be unique bounded identifiers");
    seen.add(key_id);
    const key = trustedEd25519Key(public_key);
    const fingerprint = releaseTrustRootFingerprint(public_key);
    if (expectedFingerprints.get(key_id) !== fingerprint) throw new Error(`release trust root fingerprint mismatch for ${key_id}`);
    return Object.freeze({ key_id, public_key_pem: key.export({ type: "spki", format: "pem" }).toString(), spki_sha256: fingerprint });
  });
  const store: ReleaseTrustStore = Object.freeze({ schema_version: 1, roots: Object.freeze(stored) });
  atomicJson(file, store);
  return store;
}

/** Read the host-owned pinned roots; release-supplied keys are never accepted. */
export function loadReleaseTrustStore(stateDir: string): ReadonlyMap<string, string> {
  const root = resolve(stateDir); assertPrivateDirectory(root);
  const file = join(root, RELEASE_TRUST_STORE_FILENAME); assertSafeFile(file);
  if (!existsSync(file)) throw new Error("release trust store is not initialized");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("release trust store is malformed"); }
  if (!record(value) || !exactKeys(value, ["schema_version", "roots"]) || value.schema_version !== 1 || !Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 16) throw new Error("release trust store has an invalid schema");
  const result = new Map<string, string>();
  for (const item of value.roots) {
    if (!record(item) || !exactKeys(item, ["key_id", "public_key_pem", "spki_sha256"]) || !identifier(item.key_id) || typeof item.public_key_pem !== "string" || !sha256(item.spki_sha256) || result.has(item.key_id)) throw new Error("release trust store has an invalid root");
    if (releaseTrustRootFingerprint(item.public_key_pem) !== item.spki_sha256) throw new Error("release trust store fingerprint does not match its public key");
    result.set(item.key_id, item.public_key_pem);
  }
  return result;
}

export function activeReleaseVersion(stateDir: string, channelValue: ReleaseChannel): string | null {
  const root = resolve(stateDir); assertPrivateDirectory(root);
  return readState(join(root, "release-state.json"), channelValue)?.current_version ?? null;
}

export function canonicalReleasePayload(manifest: Omit<ReleaseManifest, "signing"> & { readonly signing: Omit<ReleaseManifest["signing"], "signature"> | ReleaseManifest["signing"] }): Buffer {
  const signing = manifest.signing;
  return Buffer.from(canonicalJson({ ...manifest, signing: { algorithm: signing.algorithm, key_id: signing.key_id } }), "utf8");
}

export function verifyRelease(manifestBytes: Uint8Array | string, artifactBytes: Uint8Array, options: VerifyReleaseOptions): VerifiedRelease {
  const now = options.now ?? (() => new Date());
  let manifest: ReleaseManifest | null = null;
  try {
    manifest = parseReleaseManifest(manifestBytes);
    assertChannel(manifest.channel, options.channel);
    if (options.current_version !== undefined && compareReleaseVersions(manifest.version, options.current_version) <= 0) throw new Error(`release version ${manifest.version} is not newer than installed ${options.current_version}`);
    if (artifactBytes.byteLength !== manifest.artifact.size) throw new Error("release artifact size does not match manifest");
    const checksum = createHash("sha256").update(artifactBytes).digest("hex");
    if (checksum !== manifest.artifact.sha256) throw new Error("release artifact checksum does not match manifest");
    const key = trustRoots(options.trust_roots).get(manifest.signing.key_id);
    if (key === undefined) throw new Error(`release signing key ${manifest.signing.key_id} is not trusted`);
    const signature = Buffer.from(manifest.signing.signature, "base64");
    const publicKey = trustedEd25519Key(key);
    if (signature.byteLength !== 64 || !verifySignature(null, canonicalReleasePayload(manifest), publicKey, signature)) throw new Error("release manifest signature is invalid");
    const release: VerifiedRelease = Object.freeze({ manifest: Object.freeze(manifest), verified_at: now().toISOString() });
    releaseBytes.set(release, new Uint8Array(artifactBytes));
    appendAudit(options.audit_log, { at: release.verified_at, outcome: "verified", channel: manifest.channel, version: manifest.version });
    return release;
  } catch (error) {
    appendAudit(options.audit_log, { at: now().toISOString(), outcome: "refused", channel: manifest?.channel ?? options.channel, version: manifest?.version ?? null, reason: errorMessage(error) });
    throw error;
  }
}

/**
 * Discover one channel candidate over HTTPS. Redirects and cross-origin
 * artifact URLs are refused; signature/trust verification remains the next,
 * mandatory boundary (`verifyRelease`).
 */
export async function fetchReleaseCandidate(manifestUrl: string, channelValue: ReleaseChannel, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ReleaseCandidate> {
  const source = safeReleaseUrl(manifestUrl);
  const manifestResponse = await fetchImpl(source, { redirect: "manual", signal });
  if (!manifestResponse.ok || manifestResponse.status >= 300 && manifestResponse.status < 400) throw new Error(`release manifest fetch failed with HTTP ${manifestResponse.status}`);
  const manifestBytes = await boundedResponseBytes(manifestResponse, 64 * 1024, signal);
  const manifest = parseReleaseManifest(manifestBytes);
  assertChannel(manifest.channel, channelValue);
  if (manifest.artifact.size > RELEASE_ARTIFACT_MAX_BYTES) throw new Error("release artifact exceeds the supported download bound");
  const artifactUrl = safeReleaseUrl(new URL(manifest.artifact.name, source).toString());
  if (artifactUrl.origin !== source.origin) throw new Error("release artifact must share the manifest origin");
  const artifactResponse = await fetchImpl(artifactUrl, { redirect: "manual", signal });
  if (!artifactResponse.ok || artifactResponse.status >= 300 && artifactResponse.status < 400) throw new Error(`release artifact fetch failed with HTTP ${artifactResponse.status}`);
  const artifactBytes = await boundedResponseBytes(artifactResponse, manifest.artifact.size, signal);
  if (artifactBytes.byteLength !== manifest.artifact.size) throw new Error("release artifact download size does not match its manifest");
  return Object.freeze({ manifest_bytes: manifestBytes, artifact_bytes: artifactBytes, manifest, source_url: source.toString() });
}

/** Stage verified bytes then atomically swing the active pointer. */
export function activateVerifiedRelease(release: VerifiedRelease, options: ReleaseActivationOptions): ReleaseActivation {
  const bytes = releaseBytes.get(release);
  if (bytes === undefined) throw refusedActivation(options, releaseVersion(release), "activation requires a release returned by verifyRelease");
  if (release.manifest.channel !== options.channel) throw refusedActivation(options, release.manifest.version, "verified release channel does not match activation channel");
  const root = resolve(options.state_dir); const releases = join(root, "releases"); const stateFile = join(root, "release-state.json");
  ensurePrivateDirectory(root); ensurePrivateDirectory(releases); assertSafeFile(stateFile);
  const prior = readState(stateFile, options.channel);
  if (prior?.current_version === release.manifest.version) throw refusedActivation(options, release.manifest.version, "release version is already active");
  if (prior !== null && compareReleaseVersions(release.manifest.version, prior.current_version) <= 0) throw refusedActivation(options, release.manifest.version, "activation refuses downgrade or replay");
  const target = join(releases, release.manifest.version);
  if (existsSync(target)) throw refusedActivation(options, release.manifest.version, "release version is already staged; refusing to overwrite it");
  const stage = join(root, `.stage-${randomUUID()}`);
  try {
    mkdirSync(stage, { recursive: false });
    writeFileSync(join(stage, "artifact.tar.gz"), bytes, { flag: "wx" });
    writeFileSync(join(stage, "release.json"), `${canonicalJson(release.manifest)}\n`, { encoding: "utf8", flag: "wx" });
    options.before_activate?.(join(stage, "artifact.tar.gz"));
    renameSync(stage, target);
    const next = { schema_version: 1, channel: options.channel, current_version: release.manifest.version, previous_version: prior?.current_version ?? null };
    atomicJson(stateFile, next);
    const result = Object.freeze({ channel: options.channel, version: release.manifest.version, artifact_path: join(target, "artifact.tar.gz"), previous_version: prior?.current_version ?? null });
    appendAudit(options.audit_log, { at: (options.now ?? (() => new Date()))().toISOString(), outcome: "activated", channel: options.channel, version: result.version });
    return result;
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    appendAudit(options.audit_log, { at: (options.now ?? (() => new Date()))().toISOString(), outcome: "refused", channel: options.channel, version: release.manifest.version, reason: errorMessage(error) });
    throw error;
  }
}

/** Restore the last activated, independently re-verified release. */
export function rollbackVerifiedRelease(options: ReleaseActivationOptions): ReleaseActivation {
  let version: string | null = null;
  try {
    const root = resolve(options.state_dir); const stateFile = join(root, "release-state.json"); ensurePrivateDirectory(root); ensurePrivateDirectory(join(root, "releases")); assertSafeFile(stateFile); const state = readState(stateFile, options.channel);
    version = state?.previous_version ?? null;
    if (state?.previous_version === null || state?.previous_version === undefined) throw new Error("no verified rollback release is available");
    const previousDir = join(root, "releases", state.previous_version); assertPrivateDirectory(previousDir);
    const manifestFile = join(previousDir, "release.json"); const artifactFile = join(previousDir, "artifact.tar.gz"); assertSafeFile(manifestFile); assertSafeFile(artifactFile);
    const manifest = readFileSync(manifestFile); const artifact = readFileSync(artifactFile);
    // Verification is repeated even though the bytes were verified when staged:
    // storage mutation must never turn a rollback into execution of new bytes.
    const verified = verifyRelease(manifest, artifact, { channel: options.channel, trust_roots: options.trust_roots, now: options.now, audit_log: options.audit_log });
    if (verified.manifest.version !== state.previous_version) throw new Error("rollback release identity changed on disk");
    // A rollback is a one-way recovery action.  Do not turn it into a replay
    // toggle which could re-activate the rejected newer release indefinitely.
    atomicJson(stateFile, { schema_version: 1, channel: options.channel, current_version: state.previous_version, previous_version: null });
    const result = Object.freeze({ channel: options.channel, version: state.previous_version, artifact_path: artifactFile, previous_version: state.current_version });
    appendAudit(options.audit_log, { at: (options.now ?? (() => new Date()))().toISOString(), outcome: "rolled_back", channel: options.channel, version: result.version });
    return result;
  } catch (error) {
    appendAudit(options.audit_log, { at: (options.now ?? (() => new Date()))().toISOString(), outcome: "refused", channel: options.channel, version, reason: errorMessage(error) });
    throw error;
  }
}

export function parseReleaseManifest(bytes: Uint8Array | string): ReleaseManifest {
  let parsed: unknown;
  try { const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes); if (raw.byteLength === 0 || raw.byteLength > 64 * 1024) throw new Error(); parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new Error("release manifest is not valid UTF-8 JSON"); }
  if (!record(parsed) || !exactKeys(parsed, ["schema_version", "product", "channel", "version", "published_at", "artifact", "signing"])) throw new Error("release manifest must have an exact schema");
  const artifact = parsed.artifact; const signing = parsed.signing;
  if (parsed.schema_version !== 1 || parsed.product !== RELEASE_PRODUCT || !channel(parsed.channel) || !version(parsed.version) || !isoDate(parsed.published_at) || !record(artifact) || !exactKeys(artifact, ["name", "format", "size", "sha256"]) || artifact.format !== "tar.gz" || !artifactName(artifact.name) || !positiveInteger(artifact.size) || artifact.size > RELEASE_ARTIFACT_MAX_BYTES || !sha256(artifact.sha256) || !record(signing) || !exactKeys(signing, ["algorithm", "key_id", "signature"]) || signing.algorithm !== "ed25519" || !identifier(signing.key_id) || !ed25519Signature(signing.signature)) throw new Error("release manifest has an invalid schema");
  return Object.freeze({ schema_version: 1, product: RELEASE_PRODUCT, channel: parsed.channel, version: parsed.version, published_at: parsed.published_at, artifact: Object.freeze({ name: artifact.name, format: "tar.gz", size: artifact.size, sha256: artifact.sha256 }), signing: Object.freeze({ algorithm: "ed25519", key_id: signing.key_id, signature: signing.signature }) });
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) { const delta = compareNumericIdentifier(a.numeric[i]!, b.numeric[i]!); if (delta !== 0) return delta; }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  const longest = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < longest; i += 1) {
    const first = a.pre[i]; const second = b.pre[i];
    if (first === undefined || second === undefined) return first === second ? 0 : first === undefined ? -1 : 1;
    const firstNumeric = /^\d+$/.test(first); const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric && secondNumeric) { const delta = compareNumericIdentifier(first, second); if (delta !== 0) return delta; }
    else if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    else if (first !== second) return first < second ? -1 : 1;
  }
  return 0;
}

function readState(file: string, channelValue: ReleaseChannel): { current_version: string; previous_version: string | null } | null {
  if (!existsSync(file)) return null;
  assertSafeFile(file);
  let value: unknown; try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("release state is corrupt; refusing activation"); }
  if (!record(value) || !exactKeys(value, ["schema_version", "channel", "current_version", "previous_version"]) || value.schema_version !== 1 || value.channel !== channelValue || !version(value.current_version) || (value.previous_version !== null && !version(value.previous_version)) || value.previous_version !== null && compareReleaseVersions(value.previous_version, value.current_version) >= 0) throw new Error("release state is invalid; refusing activation");
  return { current_version: value.current_version, previous_version: value.previous_version };
}
function atomicJson(file: string, value: unknown): void { ensurePrivateDirectory(dirname(file)); assertSafeFile(file); const temp = `${file}.${randomUUID()}.tmp`; try { writeFileSync(temp, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); renameSync(temp, file); } finally { if (existsSync(temp)) rmSync(temp, { force: true }); } }
function appendAudit(file: string | undefined, recordValue: ReleaseAuditRecord): void { if (file === undefined) return; const path = resolve(file); ensurePrivateDirectory(dirname(path)); assertSafeFile(path); appendFileSync(path, `${JSON.stringify(recordValue)}\n`, { encoding: "utf8", mode: 0o600 }); }
function refusedActivation(options: ReleaseActivationOptions, version: string | null, reason: string): Error { appendAudit(options.audit_log, { at: (options.now ?? (() => new Date()))().toISOString(), outcome: "refused", channel: options.channel, version, reason }); return new Error(reason); }
function trustRoots(input: VerifyReleaseOptions["trust_roots"]): ReadonlyMap<string, string | Uint8Array> {
  if (!Array.isArray(input)) return input as ReadonlyMap<string, string | Uint8Array>;
  return new Map((input as readonly ReleaseTrustRoot[]).map((root) => [root.key_id, root.public_key]));
}
function assertChannel(actual: ReleaseChannel, expected: ReleaseChannel): void { if (actual !== expected) throw new Error(`release channel ${actual} is refused by configured ${expected} channel`); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function parseVersion(value: string): { numeric: readonly [string, string, string]; pre: readonly string[] | null } { const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?$/); if (!match) throw new Error(`invalid release version ${value}`); return { numeric: [match[1]!, match[2]!, match[3]!], pre: match[4] === undefined ? null : match[4].split(".") }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === expected.length && actual.every((key, index) => key === expected.slice().sort()[index]); }
function channel(value: unknown): value is ReleaseChannel { return value === "stable" || value === "beta"; }
function version(value: unknown): value is string { if (typeof value !== "string") return false; try { parseVersion(value); return true; } catch { return false; } }
function isoDate(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; const time = Date.parse(value); return !Number.isNaN(time) && new Date(time).toISOString() === value; }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value); }
function artifactName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(value); }
function ed25519Signature(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value); }
function compareNumericIdentifier(left: string, right: string): number { return left.length === right.length ? left === right ? 0 : left < right ? -1 : 1 : left.length < right.length ? -1 : 1; }
function trustedEd25519Key(value: string | Uint8Array) { let key: ReturnType<typeof createPublicKey>; try { key = createPublicKey(typeof value === "string" ? value : Buffer.from(value)); } catch { throw new Error("release trust root is not a valid public key"); } if (key.asymmetricKeyType !== "ed25519") throw new Error("release trust root must be an Ed25519 public key"); return key; }
function releaseVersion(value: unknown): string | null { return record(value) && record(value.manifest) && typeof value.manifest.version === "string" ? value.manifest.version : null; }
function ensurePrivateDirectory(path: string): void { if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 }); assertPrivateDirectory(path); }
function assertPrivateDirectory(path: string): void { const entry = lstatSync(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("release state path must be a non-symlink directory"); }
function assertSafeFile(path: string): void { if (!existsSync(path)) return; const entry = lstatSync(path); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("release state file must be a regular non-symlink file"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "release verification failed"; }
function safeReleaseUrl(value: string): URL { let url: URL; try { url = new URL(value); } catch { throw new Error("release source must be an absolute HTTPS URL"); } if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("release source must be credential-free HTTPS"); return url; }
async function boundedResponseBytes(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> { const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > maximum) throw new Error("release download exceeds its byte bound"); if (response.body === null) return new Uint8Array(); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; try { for (;;) { if (signal?.aborted) throw new Error("release download cancelled"); const { done, value } = await reader.read(); if (done) break; if (!value) continue; total += value.byteLength; if (total > maximum) throw new Error("release download exceeds its byte bound"); chunks.push(value); } } finally { try { await reader.cancel(); } catch {} } const joined = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } return joined; }
