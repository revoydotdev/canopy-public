import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { git, lines, run } from "./git.mjs";
import { isGeneratedStore, resolveDiff3Text } from "./conflicts.mjs";
import { allocateDecision } from "../adr-registry.mjs";
import { MERGE_CRITICAL_REGISTRY, runMergeCriticalCheck } from "../merge-critical.mjs";
import { checkAdrAcceptance } from "../adr-acceptance.mjs";

function slug(branch) {
  return basename(branch).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function checkedOutPath(repo, branch) {
  const records = git(repo, ["worktree", "list", "--porcelain"]).stdout.split("\n\n");
  for (const record of records) {
    const path = record.match(/^worktree (.+)$/m)?.[1];
    const ref = record.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (ref === branch) return path;
  }
  return null;
}

function unresolvedPaths(worktree) {
  return [...new Set(lines(git(worktree, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }).stdout))];
}

function continueRebase(worktree) {
  return git(worktree, ["-c", "core.editor=true", "rebase", "--continue"], { allowFailure: true });
}

function resolveConflicts(worktree) {
  const semantic = [];
  const mechanical = [];
  const deferredStores = [];
  for (const path of unresolvedPaths(worktree)) {
    if (isGeneratedStore(path)) {
      git(worktree, ["checkout", "--ours", "--", path]);
      git(worktree, ["add", "--", path]);
      deferredStores.push(path);
      continue;
    }
    git(worktree, ["checkout", "--conflict=diff3", "--", path]);
    const absolute = join(worktree, path);
    const resolution = resolveDiff3Text(readFileSync(absolute, "utf8"));
    if (resolution.semantic || resolution.mechanical_count === 0) {
      semantic.push(path);
      continue;
    }
    writeFileSync(absolute, resolution.text);
    git(worktree, ["add", "--", path]);
    mechanical.push(path);
  }
  return { semantic, mechanical, deferred_stores: deferredStores };
}

function verify(worktree, commands) {
  const results = [];
  for (const command of commands) {
    const result = run(command.command, command.args, { cwd: worktree, allowFailure: true, inherit: command.inherit ?? false, env: command.env });
    results.push({ command: [command.command, ...command.args].join(" "), status: result.status, stdout: result.stdout, stderr: result.stderr });
    if (!result.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

function defaultPreparationCommands(worktree) {
  if (!existsSync(join(worktree, "package.json")) || !existsSync(join(worktree, "bun.lock"))) return [];
  return [{ command: "bun", args: ["install", "--frozen-lockfile"] }];
}

function declaredPackageScript(worktree, name) {
  try {
    const packageJson = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
    return typeof packageJson?.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

function advanceTrunk(repo, trunk, branch, expected) {
  const actual = git(repo, ["rev-parse", trunk]).stdout;
  if (actual !== expected) return { ok: false, reason: "trunk_moved", expected, actual };
  const trunkPath = checkedOutPath(repo, trunk);
  if (trunkPath) {
    const result = git(trunkPath, ["merge", "--ff-only", branch], { allowFailure: true });
    return result.ok ? { ok: true, revision: git(repo, ["rev-parse", trunk]).stdout } : { ok: false, reason: "fast_forward_failed", detail: result.stderr || result.stdout };
  }
  const update = git(repo, ["update-ref", `refs/heads/${trunk}`, branch, expected], { allowFailure: true });
  return update.ok ? { ok: true, revision: git(repo, ["rev-parse", trunk]).stdout } : { ok: false, reason: "fast_forward_failed", detail: update.stderr || update.stdout };
}

export function landBranch({ repo, trunk, branch, declaredBase = null, scratchRoot, acceptManualResolution = false, prepareCommands, verifyCommands, keepWorktree = false, hooks = {} }) {
  // Deliberately resolved here, not accepted from a plan file. Every invocation
  // re-reads advancing trunk immediately before it creates/reuses the worktree.
  const trunkRevision = git(repo, ["rev-parse", trunk]).stdout;
  if (declaredBase === trunk) {
    throw new Error("declared_base must identify a stable stacked-branch base, not the movable trunk ref");
  }
  hooks.afterTrunkRead?.(trunkRevision);
  const root = resolve(scratchRoot ?? join(tmpdir(), "revoy2-integration-conductor"));
  mkdirSync(root, { recursive: true });
  const worktree = join(root, slug(branch));
  const existing = checkedOutPath(repo, branch);
  if (existing && resolve(existing) !== resolve(worktree)) {
    return { ok: false, state: "branch_checked_out_elsewhere", branch, worktree: existing, trunk_revision: trunkRevision };
  }
  // A conflicted rebase detaches HEAD, so `git worktree list` no longer names
  // the feature branch. In explicit resume mode, recognize only this exact
  // conductor-owned scratch path with live rebase metadata; an arbitrary
  // occupied directory remains a refusal.
  const resumableRebasePath = existsSync(worktree)
    ? git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], { allowFailure: true }).stdout
    : "";
  const resumableDetachedWorktree = acceptManualResolution && Boolean(resumableRebasePath) && existsSync(resumableRebasePath);
  if (!existing && !resumableDetachedWorktree) {
    if (existsSync(worktree)) return { ok: false, state: "scratch_path_occupied", branch, worktree, trunk_revision: trunkRevision };
    const added = git(repo, ["worktree", "add", worktree, branch], { allowFailure: true });
    if (!added.ok) return { ok: false, state: "worktree_add_failed", detail: added.stderr || added.stdout, branch, worktree, trunk_revision: trunkRevision };
  }

  // Scratch worktrees never inherit node_modules. Materialize the frozen
  // dependency graph before rebase continuation because commit hooks can run
  // during `rebase --continue`, and before the conductor's own evidence commit.
  const preparation = verify(worktree, prepareCommands ?? defaultPreparationCommands(worktree));
  if (!preparation.ok) return { ok: false, state: "dependency_setup_failed", branch, worktree, trunk_revision: trunkRevision, preparation };

  let conflictReport = { semantic: [], mechanical: [], deferred_stores: [] };
  const rebasePath = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], { allowFailure: true }).stdout;
  const inProgress = Boolean(rebasePath) && existsSync(rebasePath);
  if (inProgress && !acceptManualResolution) {
    return { ok: false, state: "manual_resolution_required", branch, worktree, trunk_revision: trunkRevision, semantic_conflicts: unresolvedPaths(worktree) };
  }

  let rebased;
  if (inProgress) {
    if (unresolvedPaths(worktree).length) return { ok: false, state: "manual_resolution_incomplete", branch, worktree, trunk_revision: trunkRevision, semantic_conflicts: unresolvedPaths(worktree) };
    rebased = continueRebase(worktree);
  } else if (git(worktree, ["merge-base", "--is-ancestor", trunkRevision, "HEAD"], { allowFailure: true }).ok) {
    // The branch already contains the exact trunk candidate. Replaying its
    // history is unnecessary and can flatten reviewed merge ancestry or
    // resurrect conflicts from commits whose net tree is already composed.
    rebased = { ok: true, status: 0, stdout: "trunk already ancestor", stderr: "" };
  } else {
    const rebaseArgs = declaredBase
      ? ["rebase", "--onto", trunkRevision, declaredBase, branch]
      : ["rebase", trunkRevision];
    rebased = git(worktree, rebaseArgs, { allowFailure: true });
  }

  while (!rebased.ok) {
    const unresolved = unresolvedPaths(worktree);
    if (!unresolved.length) return { ok: false, state: "rebase_failed", detail: rebased.stderr || rebased.stdout, branch, worktree, trunk_revision: trunkRevision };
    const pass = resolveConflicts(worktree);
    conflictReport = {
      semantic: [...conflictReport.semantic, ...pass.semantic],
      mechanical: [...conflictReport.mechanical, ...pass.mechanical],
      deferred_stores: [...conflictReport.deferred_stores, ...pass.deferred_stores],
    };
    if (pass.semantic.length) {
      return { ok: false, state: "semantic_conflict", branch, worktree, trunk_revision: trunkRevision, semantic_conflicts: pass.semantic, mechanical_resolutions: conflictReport.mechanical, deferred_stores: conflictReport.deferred_stores };
    }
    rebased = continueRebase(worktree);
  }

  // Preserve branch measurements only when the repository's own freshness
  // gate proves they describe this exact composed candidate. Otherwise return
  // to trunk-owned measurements and regenerate them atomically before any
  // verification claim.
  const measurementsFresh = hooks.isMeasurementSnapshotFresh?.(worktree)
    ?? (declaredPackageScript(worktree, "gate:store-freshness")
      && run("bun", ["run", "gate:store-freshness"], { cwd: worktree, allowFailure: true }).ok);
  if (!measurementsFresh) {
    for (const path of [".determinism-baseline", ".completion-depth"]) {
      const onTrunk = git(worktree, ["cat-file", "-e", `${trunkRevision}:${path}`], { allowFailure: true }).ok;
      if (onTrunk) {
        git(worktree, ["checkout", trunkRevision, "--", path]);
      } else if (existsSync(join(worktree, path))) {
        rmSync(join(worktree, path), { recursive: true, force: true });
        git(worktree, ["add", "-A", "--", path]);
      }
    }
    if (git(worktree, ["diff", "--cached", "--quiet"], { allowFailure: true }).status !== 0) {
      const committed = git(worktree, ["commit", "-m", "chore(evidence): discard branch-local measurement snapshots"], { allowFailure: true });
      if (!committed.ok) return { ok: false, state: "integration_commit_failed", branch, worktree, trunk_revision: trunkRevision, detail: committed.stderr || committed.stdout, preparation, ...conflictReport };
    }
    if (declaredPackageScript(worktree, "evidence:refresh-atomic")) {
      const evidenceRefresh = verify(worktree, [{ command: "bun", args: ["run", "evidence:refresh-atomic"], inherit: true }]);
      if (!evidenceRefresh.ok) return { ok: false, state: "evidence_refresh_failed", branch, worktree, trunk_revision: trunkRevision, preparation, evidence_refresh: evidenceRefresh, ...conflictReport };
      if (git(worktree, ["diff", "--cached", "--quiet"], { allowFailure: true }).status !== 0) {
        const sealed = git(worktree, ["commit", "-m", "chore(evidence): seal integrated candidate"], { allowFailure: true });
        if (!sealed.ok) return { ok: false, state: "evidence_commit_failed", branch, worktree, trunk_revision: trunkRevision, detail: sealed.stderr || sealed.stdout, preparation, evidence_refresh: evidenceRefresh, ...conflictReport };
      }
    }
  }

  const decisionsDirectory = join(worktree, "decisions");
  const pendingDecisions = (existsSync(decisionsDirectory) ? readdirSync(decisionsDirectory) : [])
    .map((name) => name.match(/^ADR-PENDING-([a-z0-9][a-z0-9-]*)\.md$/)?.[1])
    .filter(Boolean)
    .sort();
  const allocations = pendingDecisions.map((pendingSlug) => allocateDecision({ repo: worktree, slug: pendingSlug, commit: true }));

  const acceptance = hooks.checkAdrAcceptance?.(worktree, `${trunkRevision}..HEAD`)
    ?? checkAdrAcceptance({ repo: worktree, revision: `${trunkRevision}..HEAD` });
  if (!acceptance.ok) return { ok: false, state: "adr_acceptance_failed", branch, worktree, trunk_revision: trunkRevision, acceptance, allocations, ...conflictReport };

  // Run ADR-attributed properties against the composed result before the
  // ordinary isolation gate. This is intentionally broader than only the
  // mechanically-resolved files: a clean textual merge can still violate a
  // cross-file invariant (the ADR-044 sandbox-read incident).
  const mergeCritical = existsSync(join(worktree, MERGE_CRITICAL_REGISTRY))
    ? runMergeCriticalCheck({
      repo: worktree,
      range: `${trunkRevision}..HEAD`,
      runTest: hooks.runMergeCriticalTest,
      log: hooks.onMergeCriticalProperty,
    })
    : { ok: true, state: "not_configured", selected: [], results: [] };
  if (!mergeCritical.ok) return { ok: false, state: "merge_critical_failed", branch, worktree, trunk_revision: trunkRevision, acceptance, merge_critical: mergeCritical, allocations, ...conflictReport };

  const verification = verify(worktree, verifyCommands ?? [
    { command: "bun", args: ["run", "build"], inherit: true },
    { command: "bun", args: ["run", "test:all"], inherit: true },
  ]);
  if (!verification.ok) return { ok: false, state: "verification_failed", branch, worktree, trunk_revision: trunkRevision, verification, acceptance, merge_critical: mergeCritical, allocations, ...conflictReport };

  const advanced = advanceTrunk(repo, trunk, branch, trunkRevision);
  if (!advanced.ok) return { ok: false, state: advanced.reason, branch, worktree, trunk_revision: trunkRevision, verification, acceptance, merge_critical: mergeCritical, allocations, ...advanced, ...conflictReport };

  if (!keepWorktree) {
    git(repo, ["worktree", "remove", worktree]);
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  }
  return { ok: true, state: "landed", branch, trunk, previous_trunk_revision: trunkRevision, trunk_revision: advanced.revision, worktree: keepWorktree ? worktree : null, preparation, verification, acceptance, merge_critical: mergeCritical, allocations, ...conflictReport };
}
