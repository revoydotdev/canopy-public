import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function hashFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`manifest asset must be a regular, non-symlink file: ${path}`);
  return Object.freeze({ sha256: sha256Bytes(readFileSync(path)), bytes: stat.size });
}

function safeRelative(root, path) {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === ".." || value.startsWith(`..${sep}`) || value.startsWith(sep)) throw new Error(`asset is outside run directory: ${path}`);
  return value.split(sep).join("/");
}

export function buildAssetRecords(runDirectory, paths) {
  return Object.freeze(paths.map((path) => {
    const identity = hashFile(path);
    return Object.freeze({ path: safeRelative(runDirectory, path), bytes: identity.bytes, sha256: identity.sha256 });
  }).sort((a, b) => a.path.localeCompare(b.path, "en")));
}

export function writeManifestAndChecksums(runDirectory, manifest, assetPaths) {
  const assets = buildAssetRecords(runDirectory, assetPaths);
  const manifestPath = resolve(runDirectory, "manifest.json");
  const body = `${JSON.stringify({ ...manifest, assets }, null, 2)}\n`;
  writeFileSync(manifestPath, body, { encoding: "utf8", flag: "wx" });
  const manifestIdentity = hashFile(manifestPath);
  const checksumPath = resolve(runDirectory, "SHA256SUMS");
  const lines = [
    ...assets.map((asset) => `${asset.sha256.slice("sha256:".length)}  ${asset.path}`),
    `${manifestIdentity.sha256.slice("sha256:".length)}  ${basename(manifestPath)}`,
  ];
  writeFileSync(checksumPath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ manifest_path: manifestPath, checksums_path: checksumPath, assets, manifest_sha256: manifestIdentity.sha256 });
}
