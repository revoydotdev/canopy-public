#!/usr/bin/env bun
/** Verify first, activate atomically, then unpack the activated copy. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { activateVerifiedRelease, loadReleaseTrustStore, verifyRelease } from "../../packages/arbor-mcp/src/distribution.ts";

const [manifestFile, artifactFile, channel, stateDir, installDir] = process.argv.slice(2);
if (!manifestFile || !artifactFile || (channel !== "stable" && channel !== "beta") || !stateDir || !installDir) throw new Error("usage: bun scripts/distribution/install.mjs <release.json> <artifact.tar.gz> <stable|beta> <state-dir> <install-dir>");
const manifest = readFileSync(resolve(manifestFile)); const artifact = readFileSync(resolve(artifactFile));
const resolvedState = resolve(stateDir); const auditLog = join(resolvedState, "release-audit.jsonl");
// The release cannot supply its own verification key. Operators bootstrap
// this host-owned store separately with trust.mjs and an out-of-band digest.
const trustRoots = loadReleaseTrustStore(resolvedState);
const release = verifyRelease(manifest, artifact, { channel, trust_roots: trustRoots, audit_log: auditLog });
const destination = resolve(installDir);
if (existsSync(destination)) throw new Error("install destination already exists; refusing to merge a release into existing files");
assertGnuTar();
// Inspect and unpack only the verified caller bytes, but do not swing the
// active release state until a complete installation exists. A crash before
// activation can leave at most an inert orphan directory, never an active
// pointer to missing files.
inspectArchive(resolve(artifactFile));
const parent = dirname(destination); mkdirSync(parent, { recursive: true });
const stage = join(parent, `.${basename(destination)}.stage-${randomUUID()}`);
let installed = false;
let activated = false;
try {
  mkdirSync(stage, { mode: 0o700 });
  const unpack = runTar(["-xzf", resolve(artifactFile), "--no-same-owner", "--no-same-permissions", "--delay-directory-restore", "-C", stage]);
  if (unpack.status !== 0) throw new Error(unpack.stderr || "release extraction failed");
  // A source release becomes launchable only after its verified frozen lock
  // is provisioned. Lifecycle scripts stay disabled: installation may fetch
  // lock-pinned packages, but it never executes dependency-controlled code.
  if (existsSync(join(stage, "bun.lock")) && existsSync(join(stage, "packages", "arbor-mcp", "bin", "arbor-mcp.mjs"))) {
    const provision = spawnSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: stage, encoding: "utf8" });
    if (provision.status !== 0) throw new Error(provision.stderr || "verified release dependency provisioning failed");
  }
  // The destination was checked immediately before creating the sibling stage;
  // refuse a concurrent replacement rather than merging into it.
  if (existsSync(destination)) throw new Error("install destination appeared during extraction; refusing non-atomic activation");
  renameSync(stage, destination);
  installed = true;
  const activation = activateVerifiedRelease(release, { channel, state_dir: resolvedState, trust_roots: trustRoots, audit_log: auditLog });
  activated = true;
  process.stdout.write(`Installed verified Revoy ${activation.version} (${channel}) at ${destination}\n`);
} catch (error) {
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  if (installed && !activated && existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  throw error;
}

function runTar(args) { return spawnSync("tar", args, { encoding: "utf8" }); }
function assertGnuTar() { const probe = runTar(["--version"]); if (probe.status !== 0 || !/^tar \(GNU tar\)/m.test(probe.stdout)) throw new Error("the supported release installer requires GNU tar"); }
function inspectArchive(artifactPath) {
  const listing = runTar(["-tvzf", artifactPath]);
  if (listing.status !== 0) throw new Error(listing.stderr || "verified release archive cannot be listed");
  // Only regular files and directories are accepted.  Refusing links, devices,
  // fifos, and unknown entry types prevents an archive from escaping staging.
  if (listing.stdout.split("\n").filter(Boolean).some((line) => !/^[\-d]/.test(line))) throw new Error("verified release archive contains unsupported entry types");
  const names = runTar(["-tzf", artifactPath]);
  if (names.status !== 0 || names.stdout.split("\n").filter(Boolean).some(unsafeArchivePath)) throw new Error("verified release archive has unsafe member paths");
}
function unsafeArchivePath(name) {
  if (name === "." || name === "./") return false;
  const normalized = name.startsWith("./") ? name.slice(2) : name;
  return normalized.length === 0 || normalized.startsWith("/") || normalized.startsWith("\\") || normalized.includes("\\") || normalized.split("/").includes("..");
}
