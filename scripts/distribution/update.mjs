#!/usr/bin/env bun
/** Discover, verify, and install the next release from one governed channel. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { activeReleaseVersion, fetchReleaseCandidate, loadReleaseTrustStore, verifyRelease } from "../../packages/arbor-mcp/src/distribution.ts";

const [manifestUrl, channel, stateDir, installRoot] = process.argv.slice(2);
if (!manifestUrl || (channel !== "stable" && channel !== "beta") || !stateDir || !installRoot) {
  throw new Error("usage: bun scripts/distribution/update.mjs <https-release.json> <stable|beta> <state-dir> <install-root>");
}
const state = resolve(stateDir); const trustRoots = loadReleaseTrustStore(state);
const candidate = await fetchReleaseCandidate(manifestUrl, channel);
verifyRelease(candidate.manifest_bytes, candidate.artifact_bytes, {
  channel,
  trust_roots: trustRoots,
  ...(activeReleaseVersion(state, channel) === null ? {} : { current_version: activeReleaseVersion(state, channel) }),
  audit_log: join(state, "release-audit.jsonl"),
});
const download = mkdtempSync(join(state, ".verified-download-"));
try {
  const manifestFile = join(download, "release.json"); const artifactFile = join(download, candidate.manifest.artifact.name);
  writeFileSync(manifestFile, candidate.manifest_bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(artifactFile, candidate.artifact_bytes, { flag: "wx", mode: 0o600 });
  const destination = join(resolve(installRoot), "releases", candidate.manifest.version);
  const installed = spawnSync("bun", [resolve(import.meta.dirname, "install.mjs"), manifestFile, artifactFile, channel, state, destination], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (installed.status !== 0) throw new Error(installed.stderr || "verified release installation failed");
  process.stdout.write(installed.stdout);
} finally {
  rmSync(download, { recursive: true, force: true });
}
