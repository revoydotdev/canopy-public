# ADR-169: The Visual-Intelligence Graph Is Not Committed

**Status:** Accepted
**Date:** 2026-09-24
**Authoring Revision:** def5574a5faeb6ef9945ff74ee2fb57851b98334
**Content ID:** sha256:c41e2c51cf05544596fe70f4b144ddb08187e9581f1d03ebb03a6c7be60414ea

## Context

Authored as Proposed, not Accepted: the implementing agent does not hold
acceptance authority (AGENTS.md checks-and-balances, applied to ADR governance
by ADR-024's ratification note).

ADR-031 committed `.visual-intelligence/graph/{nodes,edges,evidence}.jsonl`
deliberately, on the stated grounds that it "diffs line-by-line and is the
reviewable record of the repository's structure," and `.gitignore`'s own
comment (until this record) said the same thing. That claim was tested, not
assumed:

1. **The graph is a pure, deterministic function of committed source.** Two
   clean, serialized `bun run vi:refresh` runs against the identical
   committed revision produced byte-identical `nodes.jsonl`/`edges.jsonl` —
   zero diff lines. `gate:vi-reproducible`/`gate:vi-prepush-policy` already
   independently prove the same thing on every CI run and every local push
   that touches a VI producer file: they regenerate the whole graph from
   scratch and structurally diff it against the committed copy. A cache a
   gate re-derives and compares on every run is a cache, not a source of
   truth requiring its own preserved history.
2. **The provenance stamps that looked like preserved history are not.**
   `first_seen`/`last_verified`/`content_hash` are explicitly marked
   `VOLATILE` in `.claude/skills/repository-visual-intelligence/scripts/lib/
   graph.mjs` and excluded from the reproducibility comparison. `vi-lsp-
   facts.mjs` stamps `first_seen: revision` — the CURRENT revision, on every
   regeneration — never looked up from a prior committed copy. Nothing reads
   the graph at a past git revision anywhere in this repository's tooling.
3. **The measured cost was large and compounding.** `edges.jsonl` alone
   carried 2,035 historical blob versions totaling 18.7GB of logical content;
   git's own delta compression reduced that to 397MB on disk, and the three
   large graph files (`edges`, `nodes`, `evidence`) together accounted for
   ~564MB of this repository's ~791MB `.git` directory (measured 2026-09-24,
   before this record) — roughly 71%, even after git's own compression.
   GitHub additionally warns on every push once any tracked blob exceeds its
   50MB recommendation, which every commit touching `edges.jsonl` (72MB)
   already did.
4. **This repository already accepted the identical principle for `views/`.**
   `.visual-intelligence/README.md`: "`views/` is generated and gitignored.
   Deleting it must be lossless; if regenerating loses information, that
   information was authored in the wrong tier." The graph meets that exact
   bar (finding 1). Applying a principle this repository already accepted,
   one tier earlier in the same pipeline, is not a new risk appetite.
5. **The "one writer" merge-conflict problem ADR-031/vi-refresh.mjs named as
   the reason NOT to require full reproduction on every branch is eliminated
   by this change, not worked around.** `scripts/vi-freshness-gate.mjs`'s own
   header: "concurrent regeneration on parallel branches produces textual
   conflicts in a 17MB `edges.jsonl` that nobody can resolve by hand." An
   untracked file cannot conflict in a git merge; there is no longer a
   conflict to coordinate around.
6. **A fresh pre-push candidate worktree's `vi-refresh --check` was already
   diagnosed failing intermittently** with a different node count each run
   against the identical committed revision (36136, 36131, 36130) while this
   very investigation was underway. The root cause was resource contention
   (an orphaned `tsserver` fleet from an earlier overlapping push attempt,
   later a live CI enforcement run on the same shared machine) — not a
   defect in the deterministic extraction pipeline itself (finding 1 already
   proved that). But the mechanism that made the gate sensitive to that
   contention in the first place — diffing a freshly regenerated graph
   against a byte-committed prior copy, prone to reporting either false
   positives from timing-sensitive load or ABSENT failures in the ordinary
   case of a cold isolated worktree — is removed entirely by this record: a
   fresh worktree now legitimately has no prior copy, and `--check` treats
   that as the expected first-generation case rather than a failure.

## Decision

**`.visual-intelligence/graph/{nodes,edges,evidence}.jsonl` and
the graph directory's lsp-facts.json are gitignored and no longer committed.**
`.visual-intelligence/manifest.json` (small, metadata-only, ~8KB) remains
committed — it is the only file `gate:vi-freshness` reads, and its checks
(commit-distance advisory, dirty-tree rejection, entry-point/reachability
sanity, exact input-binding hash) are entirely unaffected by this change:
`computeViInputBinding` (`scripts/lib/vi-input-binding.mjs`) already hashed
only SOURCE inputs (packages/, decisions/, config, the VI tool scripts
themselves), never the graph output bytes — its own comment already said so:
"Generated evidence outputs are absent by construction, so committing the
graph never makes its own binding stale."

Mechanism changes, each scoped to the minimum needed to keep the system
honest once there is no committed graph baseline:

- **`scripts/vi-refresh.mjs` (`--check` mode).** When no prior local graph
  exists on disk (the ordinary state of a fresh clone or isolated worktree
  now), `--check` reports `FIRST-GENERATION` and exits 0 instead of
  `ABSENT`/exit 1. The correctness bar becomes "did regeneration complete
  without violating this script's own invariants" (LSP facts availability,
  entry-point materialization, the input-binding write — all checked before
  this branch is reached), not "does it match a byte-committed prior copy."
  When a prior LOCAL copy does exist (an ordinary dev machine that already
  ran `vi:refresh` once), the structural diff still runs as a bonus signal.
- **`scripts/lib/store-provenance.mjs`.** ADR-055's content-hash mechanism
  scopes `.visual-intelligence/graph/` as a real, declared input for the
  `completion-depth` and `vi-observed` stores. `allRepoPaths()` used
  `git ls-files -co --exclude-standard`, which respects `.gitignore` even for
  untracked files — gitignoring the graph would have silently dropped it from
  that scan, exactly the "far worse than an unnecessary refresh"
  under-invalidation this file's own comments warn against. Fixed by walking
  `.visual-intelligence/graph/` directly from disk and unioning it into the
  scan, regardless of gitignore status.
- **`scripts/hooks/pre-push`, `scripts/vi-freshness-gate.mjs`.** Comments
  asserting the graph "IS committed... diffs line-by-line" corrected to
  describe the new mechanism; no gate LOGIC in `vi-freshness-gate.mjs`
  changed, since (as established above) it never read the graph bytes.

## Consequences

**Positive.** Eliminates ~71% of this repository's `.git` size going
forward (the sunk historical cost remains in existing clones' object stores
until/unless a separate, disruptive history rewrite is deliberately chosen —
not decided by this record). Removes the possibility of a graph-file merge
conflict entirely, the exact problem ADR-031/`vi-refresh.mjs` named. Removes
the diagnosed pre-push flakiness at its structural root, not merely its
symptom. GitHub's per-push large-file warning stops firing on every commit
that touches the graph.

**Negative.** A machine that wants to read the graph (a human exploring via
the `revoy-map`/`repository-visual-intelligence` skills, or a gate invoked
standalone outside `evidence:rebind`/pre-push, which already regenerate it
as their own first step) must run `bun run vi:refresh` first if no local copy
exists yet — a real cost (minutes, LSP-bound) this record does not remove,
only relocates from "paid once, amortized via git history" to "paid on
demand, per machine that needs it." A PR can no longer show a line-level
diff of the raw graph in GitHub's web UI — weak in practice (a 60-70MB JSONL
diff was never actually reviewed by a human; `views/` and `findings/`, both
still committed and genuinely human-scannable, remain the reviewable tiers).

**Negative, load-bearing.** This reverses ADR-031's explicit "committed on
purpose" claim for the graph specifically. ADR-031 itself remains Accepted
and is not superseded by this record — its vendoring decision (the
extractor lives in this repository, not `$HOME`) is independent of whether
the extractor's OUTPUT is committed, and stands unchanged.

## Alternatives / Roads not taken

1. **Compress the committed history (zstd, or restructure as a binary/
   columnar format).** Rejected once the necessity question was answered:
   optimizing storage for a file with zero demonstrated governance value in
   its history is solving the wrong problem. Compressing an asset that
   should not exist in git history is not the fix; not committing it is.
2. **Git LFS.** Same rejection as (1) for the same underlying reason —  LFS
   solves "large file, must stay versioned in git," and finding 1-2 above
   establish the graph does not need to stay versioned in git at all. LFS
   would also add a dependency and a fetch step to every clone for a file
   most consumers regenerate locally anyway.
3. **Keep committing, fix the flakiness by adding a lock instead.** A
   `flock`-based serialization of the pre-push hook's gate phase against
   concurrent runs on this shared machine was ALSO implemented (separately,
   prior to this record) and remains in place — it is real and independently
   useful (a genuinely stuck/contended run should still queue rather than
   race). But it does not address the ~71% `.git` bloat or the underlying
   "one writer" merge-conflict problem, and a graph proven to have zero
   preserved-history value should not be committed regardless of whether its
   flakiness is separately contained.
4. **Purge the existing history (BFG/`git filter-repo`) to reclaim the sunk
   ~564MB.** Rejected for this record: rewrites every commit SHA, breaking
   every existing clone/fork/worktree of this shared, actively-multi-agent
   repository. A disruptive, coordinated operation warranting its own
   deliberate decision and operator-scheduled window, not a side effect of
   this one.

## Obligations

### O1 — The gitignored, untracked graph directory still changes a dependent store's content hash when its bytes change

<!-- proof: symbol=computeEvidenceContentHashForStore file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-scoped-provenance.test.mjs -->

### O2 — Store content-hash provenance still scopes the gitignored graph as a real input, so ADR-055's freshness guarantee is not silently weakened

<!-- proof: symbol=evidenceInputPathsForStore file=scripts/lib/store-provenance.mjs roundtrip=scripts/tests/store-scoped-provenance.test.mjs -->

### O3 — `vi-refresh --check` succeeds (not fails) when no prior local graph exists, the ordinary state of a fresh worktree now

*(2026-10-06: the --check restore is now performed by the plane transaction of ADR-188, `beginPlaneTransaction`, which replaced `restoreCheckPlane`; proof repointed.)*
<!-- proof: symbol=beginPlaneTransaction file=scripts/vi-refresh.mjs roundtrip=scripts/tests/vi-refresh-root.test.mjs -->

### O4 — `gate:vi-freshness`'s exact-input-binding check is unaffected: it never read the graph bytes, only the committed manifest and source inputs

<!-- proof: symbol=computeViInputBinding file=scripts/lib/vi-input-binding.mjs roundtrip=scripts/tests/vi-input-binding.test.mjs -->
