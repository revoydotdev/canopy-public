import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, lines } from "./git.mjs";

function assertRef(repo, ref) {
  git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function branchFiles(repo, trunk, branch) {
  assertRef(repo, trunk);
  assertRef(repo, branch);
  return new Set(lines(git(repo, ["diff", "--name-only", `${trunk}...${branch}`]).stdout));
}

export function readHandoffMetadata(repo, branch) {
  const directory = join(repo, "docs", "roadmaps", "handoffs");
  if (!existsSync(directory)) return { found: false, depends_on_declared: false, depends_on: [], declared_base: null };
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".md")).sort()) {
    const text = readFileSync(join(directory, name), "utf8");
    if (!text.includes(`Branch: \`${branch}\``) && !text.includes(`branch \`${branch}\``)) continue;
    const match = text.match(/^depends_on\s*:\s*(.*)$/im);
    const raw = match?.[1].trim().replace(/^\[/, "").replace(/\]$/, "") ?? "";
    const dependsOn = !raw || raw === "none" || raw === "[]"
      ? []
      : raw.split(",").map((item) => item.trim().replace(/^['"`]|['"`]$/g, "")).filter(Boolean);
    const declaredBase = text.match(/^declared_base\s*:\s*[`'"]?([^`'"\s]+)[`'"]?\s*$/im)?.[1] ?? null;
    return { found: true, depends_on_declared: Boolean(match), depends_on: dependsOn, declared_base: declaredBase };
  }
  return { found: false, depends_on_declared: false, depends_on: [], declared_base: null };
}

function overlap(left, right) {
  let count = 0;
  for (const file of left) if (right.has(file)) count += 1;
  return count;
}

export function planBranches({ repo, trunk, branches, dependencies = {} }) {
  if (!branches.length) throw new Error("at least one feature branch is required");
  if (new Set(branches).size !== branches.length) throw new Error("branch set contains duplicates");
  const files = Object.fromEntries(branches.map((branch) => [branch, branchFiles(repo, trunk, branch)]));
  const metadata = Object.fromEntries(branches.map((branch) => [branch, readHandoffMetadata(repo, branch)]));
  const dependsOn = Object.fromEntries(branches.map((branch) => [branch, dependencies[branch] ?? metadata[branch].depends_on]));

  for (const [branch, deps] of Object.entries(dependsOn)) {
    for (const dep of deps) {
      if (branches.includes(dep)) continue;
      const contained = git(repo, ["merge-base", "--is-ancestor", dep, trunk], { allowFailure: true }).ok;
      if (!contained) throw new Error(`${branch} depends on ${dep}, which is neither in the plan nor contained by ${trunk}`);
    }
  }

  const conflicts = [];
  const weight = Object.fromEntries(branches.map((branch) => [branch, 0]));
  for (let left = 0; left < branches.length; left += 1) {
    for (let right = left + 1; right < branches.length; right += 1) {
      const value = overlap(files[branches[left]], files[branches[right]]);
      conflicts.push({ left: branches[left], right: branches[right], weight: value });
      weight[branches[left]] += value;
      weight[branches[right]] += value;
    }
  }

  const remaining = new Set(branches);
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter((branch) => dependsOn[branch].every((dep) => !remaining.has(dep)));
    if (!ready.length) throw new Error("depends_on declarations contain a cycle");
    ready.sort((a, b) => weight[a] - weight[b] || a.localeCompare(b));
    const next = ready[0];
    remaining.delete(next);
    order.push(next);
  }

  return {
    trunk,
    trunk_revision: git(repo, ["rev-parse", trunk]).stdout,
    branches: branches.map((branch) => ({ branch, files: [...files[branch]].sort(), depends_on: dependsOn[branch], declared_base: metadata[branch].declared_base, conflict_weight: weight[branch] })),
    conflicts,
    order,
  };
}
