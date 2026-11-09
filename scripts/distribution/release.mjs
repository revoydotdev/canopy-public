#!/usr/bin/env bun
/** Build a deterministic, signed source release for the supported channel. */
import { createHash, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalReleasePayload } from "../../packages/arbor-mcp/src/distribution.ts";

const [channel, outDir] = process.argv.slice(2);
if (channel !== "stable" && channel !== "beta" || !outDir) throw new Error("usage: bun scripts/distribution/release.mjs <stable|beta> <output-dir>");
const privateKey = process.env.REVOY_RELEASE_PRIVATE_KEY;
const keyId = process.env.REVOY_RELEASE_KEY_ID;
const publishedAt = process.env.REVOY_RELEASE_PUBLISHED_AT;
if (!privateKey || !keyId || !publishedAt) throw new Error("REVOY_RELEASE_PRIVATE_KEY, REVOY_RELEASE_KEY_ID, and REVOY_RELEASE_PUBLISHED_AT are required");
if (Number.isNaN(Date.parse(publishedAt))) throw new Error("REVOY_RELEASE_PUBLISHED_AT must be an ISO timestamp");
const root = resolve(import.meta.dirname, "../.."); const output = resolve(outDir); mkdirSync(output, { recursive: true });
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const artifactName = `revoy-${version}-${channel}.tar.gz`; const artifact = join(output, artifactName);
const manifestFile = join(output, "release.json");
if (existsSync(artifact) || existsSync(manifestFile)) throw new Error("release output already exists; refusing to overwrite a signed artifact or manifest");
// GNU tar flags pin traversal order, timestamps, and ownership.  The release
// deliberately contains source plus lockfile: installation builds only after
// signature/checksum verification and a frozen dependency resolution.
const tarProbe = spawnSync("tar", ["--version"], { encoding: "utf8" });
if (tarProbe.status !== 0 || !/^tar \(GNU tar\)/m.test(tarProbe.stdout)) throw new Error("the supported release builder requires GNU tar");
const tar = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--exclude=.git", "--exclude=node_modules", "--exclude=dist", "-C", root, "-czf", artifact, "AGENTS.md", "LICENSE", "README.md", "bun.lock", "package.json", "tsconfig.json", "vitest.config.ts", "decisions", "packages", "scripts"], { encoding: "utf8" });
if (tar.status !== 0) throw new Error(tar.stderr || "tar failed");
const bytes = readFileSync(artifact);
const unsigned = { schema_version: 1, product: "revoy", channel, version, published_at: publishedAt, artifact: { name: artifactName, format: "tar.gz", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }, signing: { algorithm: "ed25519", key_id: keyId } };
const manifest = { ...unsigned, signing: { ...unsigned.signing, signature: sign(null, canonicalReleasePayload(unsigned), privateKey).toString("base64") } };
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(`${manifestFile}\n`);
