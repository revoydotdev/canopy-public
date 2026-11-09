import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { activateVerifiedRelease, canonicalReleasePayload, compareReleaseVersions, fetchReleaseCandidate, initializeReleaseTrustStore, loadReleaseTrustStore, releaseTrustRootFingerprint, rollbackVerifiedRelease, verifyRelease } from "../src/distribution.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version = "1.1.0", channel: "stable" | "beta" = "stable", signer?: ReturnType<typeof generateKeyPairSync>) {
  const activeSigner = signer ?? generateKeyPairSync("ed25519"); const artifact = Buffer.from(`verified artifact ${version}`); const publicKey = activeSigner.publicKey.export({ type: "spki", format: "pem" }).toString();
  const unsigned = { schema_version: 1 as const, product: "revoy" as const, channel: channel as "stable" | "beta", version, published_at: "2026-08-24T00:00:00.000Z", artifact: { name: `revoy-${version}.tar.gz`, format: "tar.gz" as const, size: artifact.byteLength, sha256: createHash("sha256").update(artifact).digest("hex") }, signing: { algorithm: "ed25519" as const, key_id: "release-key" } };
  return { artifact, publicKey, signer: activeSigner, manifest: Buffer.from(JSON.stringify({ ...unsigned, signing: { ...unsigned.signing, signature: sign(null, canonicalReleasePayload(unsigned), activeSigner.privateKey).toString("base64") } })) };
}

describe("signed release distribution", () => {
  it("verifies then atomically stages and activates a configured-channel release with an audit trail", () => {
    const release = fixture(); const state = mkdtempSync(join(tmpdir(), "revoy-release-")); roots.push(state); const audit = join(state, "audit.jsonl");
    const verified = verifyRelease(release.manifest, release.artifact, { channel: "stable", current_version: "1.0.0", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit });
    const activation = activateVerifiedRelease(verified, { state_dir: state, channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit });
    expect(activation).toMatchObject({ version: "1.1.0", previous_version: null }); expect(readFileSync(activation.artifact_path)).toEqual(release.artifact);
    expect(() => activateVerifiedRelease(verified, { state_dir: state, channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit })).toThrow(/already active/);
    expect(readFileSync(audit, "utf8")).toContain('"outcome":"verified"'); expect(readFileSync(audit, "utf8")).toContain('"outcome":"activated"'); expect(readFileSync(audit, "utf8")).toContain('"outcome":"refused"');
  });

  it("refuses tampering, an untrusted key, replay/downgrade, and another channel before bytes can be activated", () => {
    const release = fixture(); const state = mkdtempSync(join(tmpdir(), "revoy-release-refusal-")); roots.push(state); const audit = join(state, "audit.jsonl");
    expect(() => verifyRelease(release.manifest, Buffer.from("tampered"), { channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit })).toThrow(/size|checksum/);
    expect(() => verifyRelease(release.manifest, release.artifact, { channel: "stable", trust_roots: new Map([["wrong-key", release.publicKey]]), audit_log: audit })).toThrow(/not trusted/);
    expect(() => verifyRelease(release.manifest, release.artifact, { channel: "stable", current_version: "1.1.0", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit })).toThrow(/not newer/);
    expect(() => verifyRelease(release.manifest, release.artifact, { channel: "beta", trust_roots: new Map([["release-key", release.publicKey]]), audit_log: audit })).toThrow(/channel/);
    expect(existsSync(join(state, "releases"))).toBe(false); expect(readFileSync(audit, "utf8").match(/"outcome":"refused"/g)?.length).toBe(4);
  });

  it("rejects non-canonical manifests, non-Ed25519 roots, huge SemVer identifiers, and symlinked state", () => {
    const release = fixture("1.0.0-10"); const state = mkdtempSync(join(tmpdir(), "revoy-release-hardening-")); roots.push(state);
    const withExtra = JSON.parse(release.manifest.toString()) as Record<string, unknown>; withExtra.untrusted = true;
    expect(() => verifyRelease(Buffer.from(JSON.stringify(withExtra)), release.artifact, { channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]) })).toThrow(/exact schema/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }); const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyRelease(release.manifest, release.artifact, { channel: "stable", trust_roots: new Map([["release-key", rsaPem]]) })).toThrow(/Ed25519/);
    expect(compareReleaseVersions("1.0.0-10", "1.0.0-2")).toBeGreaterThan(0);
    const verified = verifyRelease(release.manifest, release.artifact, { channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]) });
    symlinkSync(tmpdir(), join(state, "releases"));
    expect(() => activateVerifiedRelease(verified, { state_dir: state, channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]) })).toThrow(/non-symlink directory/);
  });

  it("pins release trust out of band once and refuses a swapped key or implicit rotation", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-release-trust-")); roots.push(root);
    const trusted = generateKeyPairSync("ed25519"); const attacker = generateKeyPairSync("ed25519");
    const trustedPem = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
    const attackerPem = attacker.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = releaseTrustRootFingerprint(trustedPem);
    expect(() => initializeReleaseTrustStore(root, [{ key_id: "release-key", public_key: attackerPem }], new Map([["release-key", fingerprint]]))).toThrow(/fingerprint mismatch/);
    initializeReleaseTrustStore(root, [{ key_id: "release-key", public_key: trustedPem }], new Map([["release-key", fingerprint]]));
    expect(loadReleaseTrustStore(root).get("release-key")).toContain("BEGIN PUBLIC KEY");
    expect(() => initializeReleaseTrustStore(root, [{ key_id: "release-key", public_key: attackerPem }], new Map([["release-key", releaseTrustRootFingerprint(attackerPem)]]))).toThrow(/already exists/);
  });

  it("discovers a bounded same-origin HTTPS candidate before signature verification", async () => {
    const release = fixture(); const requests: string[] = [];
    const fetched = await fetchReleaseCandidate("https://releases.example.test/stable/release.json", "stable", async (input) => {
      const url = String(input); requests.push(url);
      if (url.endsWith("release.json")) return new Response(release.manifest, { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("revoy-1.1.0.tar.gz")) return new Response(release.artifact, { status: 200, headers: { "content-length": String(release.artifact.byteLength) } });
      return new Response("missing", { status: 404 });
    });
    expect(requests).toEqual(["https://releases.example.test/stable/release.json", "https://releases.example.test/stable/revoy-1.1.0.tar.gz"]);
    expect(() => verifyRelease(fetched.manifest_bytes, fetched.artifact_bytes, { channel: "stable", trust_roots: new Map([["release-key", release.publicKey]]) })).not.toThrow();
    await expect(fetchReleaseCandidate("http://releases.example.test/release.json", "stable", fetch)).rejects.toThrow(/credential-free HTTPS/);
    await expect(fetchReleaseCandidate("https://releases.example.test/release.json", "stable", async () => new Response(null, { status: 302, headers: { location: "https://evil.test/release.json" } }))).rejects.toThrow(/HTTP 302/);
  });

  it("fails closed on interruption and can only roll back to independently re-verified bytes", () => {
    const signer = generateKeyPairSync("ed25519"); const first = fixture("1.1.0", "stable", signer); const second = fixture("1.2.0", "stable", signer); const state = mkdtempSync(join(tmpdir(), "revoy-release-rollback-")); roots.push(state); const rootsByKey = new Map([["release-key", first.publicKey]]);
    const v1 = verifyRelease(first.manifest, first.artifact, { channel: "stable", trust_roots: rootsByKey }); activateVerifiedRelease(v1, { state_dir: state, channel: "stable", trust_roots: rootsByKey });
    const v2 = verifyRelease(second.manifest, second.artifact, { channel: "stable", current_version: "1.1.0", trust_roots: rootsByKey });
    expect(() => activateVerifiedRelease(v2, { state_dir: state, channel: "stable", trust_roots: rootsByKey, before_activate: () => { throw new Error("simulated interruption"); } })).toThrow(/interruption/);
    expect(JSON.parse(readFileSync(join(state, "release-state.json"), "utf8"))).toMatchObject({ current_version: "1.1.0" }); expect(existsSync(join(state, "releases", "1.2.0"))).toBe(false);
    activateVerifiedRelease(v2, { state_dir: state, channel: "stable", trust_roots: rootsByKey });
    expect(rollbackVerifiedRelease({ state_dir: state, channel: "stable", trust_roots: rootsByKey })).toMatchObject({ version: "1.1.0", previous_version: "1.2.0" });
    expect(() => rollbackVerifiedRelease({ state_dir: state, channel: "stable", trust_roots: rootsByKey })).toThrow(/no verified rollback/);
  });

  it("runs the supported installer end-to-end and refuses signed link archives before state activation", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-release-installer-")); roots.push(root); const signer = generateKeyPairSync("ed25519"); const publicKey = signer.publicKey.export({ type: "spki", format: "pem" }).toString(); const keyFile = join(root, "release-key.pem"); writeFileSync(keyFile, publicKey);
    const safeSource = join(root, "safe-source"); const safeArtifact = join(root, "safe.tar.gz"); const safeManifest = join(root, "safe.json");
    mkdirSync(safeSource); writeFileSync(join(safeSource, "README"), "safe"); expect(spawnSync("tar", ["-czf", safeArtifact, "-C", safeSource, "."]).status).toBe(0);
    writeSignedManifest(safeManifest, safeArtifact, signer);
    bootstrapTrust(join(root, "state"), keyFile, publicKey);
    const install = spawnSync("bun", ["scripts/distribution/install.mjs", safeManifest, safeArtifact, "stable", join(root, "state"), join(root, "installed")], { cwd: process.cwd(), encoding: "utf8" });
    expect(install.status, install.stderr).toBe(0); expect(readFileSync(join(root, "installed", "README"), "utf8")).toBe("safe");

    const badSource = join(root, "bad-source"); const badArtifact = join(root, "bad.tar.gz"); const badManifest = join(root, "bad.json"); mkdirSync(badSource); symlinkSync("/tmp", join(badSource, "escape")); expect(spawnSync("tar", ["-czf", badArtifact, "-C", badSource, "."]).status).toBe(0);
    writeSignedManifest(badManifest, badArtifact, signer);
    bootstrapTrust(join(root, "bad-state"), keyFile, publicKey);
    const refused = spawnSync("bun", ["scripts/distribution/install.mjs", badManifest, badArtifact, "stable", join(root, "bad-state"), join(root, "bad-installed")], { cwd: process.cwd(), encoding: "utf8" });
    expect(refused.status).not.toBe(0); expect(refused.stderr).toMatch(/unsupported entry types/); expect(existsSync(join(root, "bad-state", "release-state.json"))).toBe(false); expect(existsSync(join(root, "bad-installed"))).toBe(false);
  });

  it("builds byte-reproducible, independently verifiable release artifacts and refuses output overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-release-builder-")); roots.push(root); const signer = generateKeyPairSync("ed25519"); const privateKey = signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); const publicKey = signer.publicKey.export({ type: "spki", format: "pem" }).toString(); const environment = { ...process.env, REVOY_RELEASE_PRIVATE_KEY: privateKey, REVOY_RELEASE_KEY_ID: "release-key", REVOY_RELEASE_PUBLISHED_AT: "2026-08-24T00:00:00.000Z" };
    const first = join(root, "first"); const second = join(root, "second");
    expect(spawnSync("bun", ["scripts/distribution/release.mjs", "stable", first], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 60_000 }).status).toBe(0);
    expect(spawnSync("bun", ["scripts/distribution/release.mjs", "stable", second], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 60_000 }).status).toBe(0);
    const artifactName = "revoy-0.2.0-stable.tar.gz"; const firstArtifact = readFileSync(join(first, artifactName)); const secondArtifact = readFileSync(join(second, artifactName)); expect(firstArtifact.equals(secondArtifact)).toBe(true);
    const contents = spawnSync("tar", ["-tzf", join(first, artifactName)], { encoding: "utf8" }).stdout; expect(contents).toContain("decisions/"); expect(contents).toContain("vitest.config.ts");
    expect(() => verifyRelease(readFileSync(join(first, "release.json")), firstArtifact, { channel: "stable", trust_roots: new Map([["release-key", publicKey]]) })).not.toThrow();
    const publicKeyFile = join(root, "release-key.pem"); writeFileSync(publicKeyFile, publicKey); const installRoot = join(root, "installed"); const installed = join(installRoot, "releases", "0.2.0"); bootstrapTrust(join(root, "state"), publicKeyFile, publicKey); const install = spawnSync("bun", ["scripts/distribution/install.mjs", join(first, "release.json"), join(first, artifactName), "stable", join(root, "state"), installed], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 }); expect(install.status, install.stderr).toBe(0); expect(existsSync(join(installed, "decisions", "registry.json"))).toBe(true);
    const launched = spawnSync("bun", ["scripts/distribution/launch.mjs", "stable", join(root, "state"), installRoot, "--version"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 }); expect(launched.status, launched.stderr).toBe(0); expect(launched.stdout).toContain("arbor 0.2.0");
    const overwrite = spawnSync("bun", ["scripts/distribution/release.mjs", "stable", first], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 60_000 }); expect(overwrite.status).not.toBe(0); expect(overwrite.stderr).toMatch(/refusing to overwrite/);
  });
});

function writeSignedManifest(manifestFile: string, artifactFile: string, signer: ReturnType<typeof generateKeyPairSync>): void {
  const artifact = readFileSync(artifactFile); const unsigned = { schema_version: 1 as const, product: "revoy" as const, channel: "stable" as const, version: manifestFile.includes("bad") ? "1.2.0" : "1.1.0", published_at: "2026-08-24T00:00:00.000Z", artifact: { name: "revoy-fixture.tar.gz", format: "tar.gz" as const, size: artifact.byteLength, sha256: createHash("sha256").update(artifact).digest("hex") }, signing: { algorithm: "ed25519" as const, key_id: "release-key" } };
  writeFileSync(manifestFile, JSON.stringify({ ...unsigned, signing: { ...unsigned.signing, signature: sign(null, canonicalReleasePayload(unsigned), signer.privateKey).toString("base64") } }));
}

function bootstrapTrust(stateDir: string, keyFile: string, publicKey: string): void {
  const result = spawnSync("bun", ["scripts/distribution/trust.mjs", stateDir, "release-key", keyFile, releaseTrustRootFingerprint(publicKey)], { cwd: process.cwd(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
