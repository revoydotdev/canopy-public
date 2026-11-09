/**
 * vitest setupFiles entry — strips GIT_DIR/GIT_WORK_TREE/etc. from
 * process.env before any test runs.
 *
 * ROOT CAUSE (live incident, 2026-08-08): many test files across this repo
 * build an "isolated" fixture repo with `mkdtempSync` + raw `spawnSync("git",
 * ["init", "-q", repo], ...)` / `spawnSync("git", ["-C", repo, "commit", ...])`
 * calls (packages/arbor-mcp/tests/demo.test.ts's "a2" fixture,
 * packages/arbor-opencode/tests/worktree.test.ts's makeRepo(), and others —
 * grep `spawnSync("git"` across every package's tests/ dir). None pass an
 * explicit `env`, so every one of them inherits `process.env` by reference at
 * spawn time. If GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR is EVER set in the
 * ambient environment a vitest run inherits (this repo's own tooling never
 * sets them, but this box runs many concurrent git-shelling processes and a
 * push's pre-push hook chain spawns vitest via docs-truth.mjs), those explicit
 * `-C <tmpdir>` / path-argument calls are silently overridden: `git init`
 * reuses the poisoned GIT_DIR instead of creating a repo at the tmp path, and
 * a later `git commit --allow-empty`-shaped call lands a real, tree-replacing
 * commit on whatever branch that GIT_DIR's HEAD points at.
 *
 * Reproduced live during this session's own `git push`: the pre-push hook's
 * `docs-truth.mjs` step re-runs ROADMAP.md's `roundtrip=`-cited test files
 * (including demo.test.ts) via `vitest run --reporter=json`, and two commits
 * landed directly on this session's own checked-out branch — one from
 * demo.test.ts's `writeFileSync(join(repo, "README.md"), "seed\n")` fixture,
 * one from worktree.test.ts's `writeFileSync(join(repo, "x.txt"), "hi\n")`
 * fixture, both authored "t <t@t>" exactly matching those files' `git config
 * user.name/user.email` calls. Recovered via `git reset --hard` to the last
 * real commit; nothing was lost from disk (the corruption is HEAD/index-only
 * -- see packages/arbor-opencode/src/worktree.ts's sanitizedGitEnv for the
 * production-code half of this same defense).
 *
 * This is the one central choke point that protects every current and future
 * test file without requiring each one to remember to sanitize its own git
 * calls: vitest.config.ts's `test.setupFiles` runs this before test
 * collection, and every spawnSync/execFileSync call anywhere in the suite
 * that does not pass an explicit `env` option inherits this already-cleaned
 * process.env.
 */
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
  delete process.env[key];
}

// Fixture repositories must also be isolated from the operator's Git policy.
// A globally installed revoy2 hooksPath correctly protects real repositories,
// but a raw `git init` fixture has no checked-in scripts/hooks/pre-commit for
// that launcher to delegate to. Letting the fixture inherit the global hook
// makes its first commit fail before the behavior under test can run. Tests
// that intentionally exercise an ambient global config pass their own
// GIT_CONFIG_GLOBAL explicitly to the child process.
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
