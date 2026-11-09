import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const TOOL_FILES = new Set([
  "scripts/vi-refresh.mjs",
  "scripts/vi-emit.ts",
  "scripts/vi-lsp-facts.mjs",
  "scripts/vi-findings.mjs",
  "scripts/vi-observed-compare.mjs",
  "scripts/vi-finding-id.mjs",
  "scripts/lib/vi-input-binding.mjs",
  "scripts/lib/project-profile.mjs",
]);

function trackedPaths(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
}

function targetInput(path, profile) {
  const sourceRoots = profile?.source_roots ?? ["packages"];
  // The intent extractor scans citation_roots independently of source_roots.
  // A citation added under scripts/ can mint a file node and `justifies` edge
  // even though scripts/ is not a package/source root. Omitting those bytes
  // let freshness bless a graph that full reproduction proved was stale.
  const citationRoots = profile?.citation_roots ?? sourceRoots;
  const decisionsDir = profile?.governance?.decisions_dir ?? "decisions";
  const allowlistPath = profile?.governance?.allowlist_path ?? "scripts/reachability/allowlist.json";
  if (sourceRoots.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  if (citationRoots.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  if (path === decisionsDir || path.startsWith(`${decisionsDir}/`)) return true;
  return path === "ROADMAP.md"
    || path === "arbor.profile.jsonc"
    || path === "package.json"
    || path === "bun.lock"
    || path === "scripts/reachability.mjs"
    || path === "scripts/reachability/entry-points.json"
    || path === allowlistPath;
}

function toolInput(path) {
  return TOOL_FILES.has(path)
    || path.startsWith(".claude/skills/repository-visual-intelligence/")
    || path.startsWith(".claude/skills/revoy2-visual-intelligence/");
}

function records(root, prefix, predicate) {
  return trackedPaths(root)
    .filter(predicate)
    .map((path) => ({ key: `${prefix}:${path}`, bytes: readFileSync(join(root, path)) }));
}

/**
 * Exact content identity for every declared VI producer input. Generated
 * evidence outputs are absent by construction, so committing the graph never
 * makes its own binding stale.
 */
export function computeViInputBinding(repo, { profile, toolRoot = repo } = {}) {
  const targetRoot = resolve(repo);
  const producerRoot = resolve(toolRoot);
  const inputRecords = records(targetRoot, "target", (path) => targetInput(path, profile));
  const toolRecords = producerRoot === targetRoot
    ? records(producerRoot, "tool", toolInput).filter((record) => !inputRecords.some((input) => input.key.slice(7) === record.key.slice(5)))
    : records(producerRoot, "tool", toolInput);
  const all = [...inputRecords, ...toolRecords].sort((left, right) => left.key.localeCompare(right.key));
  const content = createHash("sha256");
  const names = createHash("sha256");
  for (const record of all) {
    names.update(record.key).update("\0");
    content.update(record.key).update("\0").update(record.bytes).update("\0");
  }
  return Object.freeze({
    schema_version: 1,
    algorithm: "sha256",
    content_hash: `sha256:${content.digest("hex")}`,
    paths_digest: `sha256:${names.digest("hex")}`,
    path_count: all.length,
  });
}

export function viProducerChangedPaths(paths) {
  return paths.filter((path) => toolInput(path)
    || path === "arbor.profile.jsonc"
    || path === "scripts/reachability.mjs"
    || path.startsWith("scripts/reachability/"));
}

/**
 * THE EXTRACTION SCOPE, exposed as a predicate (CD-BR-05).
 *
 * `vi-refresh.mjs` refuses to extract from a tree with uncommitted changes in
 * this scope. It has to ask the same question this module already answers when
 * it hashes `manifest.input_binding` — "is this path an input to extraction?" —
 * so the answer lives here once. A second definition of the scope, written into
 * the refusal, is a second thing that can drift from the binding the
 * `gate:vi-freshness` comparison is made against: the guard would then bless or
 * block a different file set than the one that actually determines the graph.
 *
 * Exported as TWO predicates rather than one union because the two halves are
 * computed over DIFFERENT checkouts when `--root` names a foreign project: the
 * target's own source against `targetInput`, and this checkout's toolchain
 * against `toolInput` (matching how `computeViInputBinding` splits
 * `repo` from `toolRoot`). Unioning them would make a foreign run refuse
 * because of a dirty file in revoy2's own `packages/`, which the foreign
 * graph does not read.
 */
export { targetInput, toolInput };
