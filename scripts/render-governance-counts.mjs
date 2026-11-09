#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRepositoryCounts } from "../packages/arbor-governance/src/counts/derive.ts";
import { profileOrDefaults } from "./lib/project-profile.mjs";

export const ADR_COUNT_DOCUMENTS = [
  "AGENTS.md",
  "docs/release-readiness.md",
  ".claude/skills/revoy2-implementation-audit/SKILL.md",
];

const OPEN = "<!-- governance:adr_total -->";
const CLOSE = "<!-- /governance:adr_total -->";

// `ADR_COUNT_DOCUMENTS` above is revoy2's own hardcoded document set (this
// script's job is rendering THESE specific files, not a generic per-project
// list), so this script is not itself retargetable to a foreign project the
// way vi-emit.ts is. But `deriveRepositoryCounts` underneath it now reads
// `arbor.profile.jsonc`'s `governance.decisions_dir`, `governance.allowlist_path`,
// and `source_roots` (Roadmap 23 B2) rather than the four literals it used
// to hardcode, and this repo's own profile is the source of truth for those
// same four values — reading it here instead of re-hardcoding them removes
// the last duplicate copy of "packages"/"decisions"/the allowlist path that
// lived in this file, and means a future edit to `arbor.profile.jsonc`
// changes what gets counted without a matching edit here.
export function renderedGovernanceCounts(repoRoot, derive = deriveRepositoryCounts) {
  const profile = profileOrDefaults(repoRoot);
  const counts = derive(repoRoot, {
    sourceRoots: profile.source_roots,
    decisionsDir: profile.governance.decisions_dir,
    allowlistPath: profile.governance.allowlist_path,
  });
  if (counts.unmeasured.includes("adr_total")) throw new Error("adr_total is unmeasured; refusing to render a fabricated zero");
  return ADR_COUNT_DOCUMENTS.map((path) => {
    const absolute = join(repoRoot, path);
    const before = readFileSync(absolute, "utf8");
    const pattern = new RegExp(`${OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*${CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    const matches = before.match(pattern) ?? [];
    if (matches.length !== 1) throw new Error(`${path} must contain exactly one governance:adr_total marker pair`);
    const after = before.replace(pattern, `${OPEN}${counts.adr_total} ADRs${CLOSE}`);
    return { path, before, after, changed: before !== after };
  });
}

export function renderGovernanceCounts(repoRoot, { check = false } = {}) {
  const files = renderedGovernanceCounts(repoRoot);
  const changed = files.filter((file) => file.changed);
  if (!check) for (const file of changed) writeFileSync(join(repoRoot, file.path), file.after, "utf8");
  return { ok: changed.length === 0, changed: changed.map((file) => file.path) };
}

function main() {
  // `--root` is a reporting seam only, inert when the flag is absent: it
  // selects which tree the counts are derived from, so `guard:canaries` can
  // point this gate at a fixture. The derived numbers still come from the same
  // `renderGovernanceCounts` body either way.
  const rootIndex = process.argv.indexOf("--root");
  const repoRoot = resolve(rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  const check = process.argv.includes("--check");
  const result = renderGovernanceCounts(repoRoot, { check });
  if (check && !result.ok) {
    console.error(`governance counts are stale in: ${result.changed.join(", ")}`);
    console.error("run `bun run governance:render`, stage the rendered files, and retry");
    return 1;
  }
  console.log(result.ok ? "governance counts already match derivation" : `rendered governance counts in: ${result.changed.join(", ")}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
