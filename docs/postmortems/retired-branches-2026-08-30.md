# Retired branch pointers — 2026-08-30 operator interview

Deleted during the 2026-08-30 interview (decisions/interviews.jsonl).
Every branch's allocated ADRs were already in master and each was 420-427
commits behind, so merging would have replayed a pre-drift tree over 400+
commits of subsequent work. Recover any of these with `git branch <name> <sha>`.

| SHA | branch |
|---|---|
| `fa9c4d3c67ae2d30ab3a0c296c746c59bf9ab455` | `backup/situational-awareness-before-adr-trailers-20260826` |
| `23285da8249a54a6b2c7bd0729264b0c6697faa9` | `codex/semantic-lifecycle-remediation-20260825` |
| `90b5fd69e3ef4b2e6cd580f2854ff165988066b5` | `codex/semantic-r1-determinism` |
| `3544cb5c607c74defff9f203d4aac0767b0a0856` | `codex/semantic-r1-reachability` |
| `d9082b22ca26edbf9982c1e8d97b329bf85d933b` | `codex/semantic-r1-scheduler` |
| `d32f4139513fee7653efbd2f062164a3a0694da9` | `codex/semantic-r2-budget` |
| `b135e951e62f99bc0ded0ca4e70a564e2c51731d` | `codex/semantic-r2-completion` |
| `488e86ca6233db3a2219d7af2f1959762ee2f4a1` | `codex/semantic-r2-observed-vi` |
| `13c6b3a3dad9ccf4d4041b2c4299b7cff67373c9` | `codex/semantic-r3-branch-antistub` |
| `4ee5e26beed11660452f8346b532d520c41b72fc` | `codex/semantic-r3-hollow` |
| `80a022fa4ab08e26a74daca5342ba4ec1848255f` | `codex/semantic-r3-tui-enum` |
| `4b834b929d57d91d32fae208790d16fda3e42a1f` | `codex/semantic-r4-governance` |
| `d170c85fd8db64400944778b1a0bfe451b6f8406` | `codex/semantic-r4-sdk-coherence` |
| `275e11f2315e174eebf14a927bec5471f5473522` | `codex/semantic-r4-token-epoch` |
| `d21e0709d10f6419e57666d183755347a6aefaf0` | `codex/semantic-r5-component-snapshot` |
| `72a047983b249d8d27b4f62f241f0d982ea6efe6` | `codex/semantic-r5-enforcement` |
| `b88b60af122131644b6a5113fb6fc42493fc0b3d` | `codex/semantic-r5-verification` |
| `99dcdbbc293a94037c3b13d1b4b5e44581f2bab3` | `codex/situational-awareness-integration-20260825` |
| `77cdde244616307c8b21eee532b0bb332a9ba7d4` | `arbor/demo-0-mtc7a408/node_mtc7a41u_5` |
| `77cdde244616307c8b21eee532b0bb332a9ba7d4` | `arbor/demo-0-mtc8bn6x/node_mtc8bn8k_1` |

## Follow-up — 2026-08-31 TUI integration audit

Three branches still reported as unaccounted after the TUI coherence integration.
Each commit was compared with `feat/tui-coherence` using `git cherry`; every
result was `-`, which proves a patch-equivalent commit is already reachable from
the integration branch even though the original branch topology was not merged.
Current-source inspection additionally confirmed that chronology now lives in
the canonical operator view model, notification expiry and adaptive tree detail
remain wired through the live shell, and the narrow-terminal and pre-push
acceptance artifacts remain present. Replaying these branches would restore old
file topology or duplicate already-integrated patches.

Recover any retired pointer with `git branch <name> <sha>`.

| SHA | branch | Patch-equivalent commits |
|---|---|---:|
| `faa8d2c040ffd7dfe6ffd4c8bc9af8de01f10e16` | `feature/tui-chronology-navigation-20260828` | 1/1 |
| `578d3bf05d7beb0bb8bfb0eabb1140cf9d78e5ef` | `terra/narrow-acceptance-performance-20260828` | 5/5 |
| `4a1242eb9d5e3110ada0ef1cc110c1d254b1258a` | `terra/tui-density-layout-20260828` | 1/1 |

### Checked-out integration lanes retired in the same audit

The three ADR-149 branches likewise returned `-` from `git cherry` against
`feat/tui-coherence`; their composer, palette, and activity-card behavior is
already present in the canonical Console/operator-view implementation. The old
timeline branch still names the removed `session-timeline.ts` topology, so
replaying it would restore a duplicate chronology model. The compliance lane's
commit has a different patch identity because its later integration also updated
the policy for subsequently added packages, but all five files introduced by
the lane are byte-identical between its tip and the current branch.

| SHA | branch | Disposition proof |
|---|---|---|
| `4c673d833d40c07e2aba3aa35a1cd0427574cbd8` | `codex/compliance-lane-adr147` | all five introduced files byte-identical in current source |
| `34de83bec4e8e0f347807d05108c4359c76fae4f` | `terra/adr149-composer` | patch-equivalent (`git cherry` `-`) |
| `4ae937577584b491c038126d31a13b05b12fe177` | `terra/adr149-palette` | patch-equivalent (`git cherry` `-`) |
| `c833cba3835e090f222ba0c5716d59a0f24944da` | `terra/adr149-timeline` | patch-equivalent (`git cherry` `-`); old chronology topology superseded |

### Feature worktrees integrated during final consolidation

Two remaining feature branches contained useful work rather than stale
duplicates. Their source was integrated deliberately; generated evidence from
the isolated branches was not copied because it is revision-bound and must be
reproduced from the final source commit.

| SHA | branch | Integration disposition |
|---|---|---|
| `658bbc8eeeefb45b448987341c4adf3bee93fc41` | `feature/repo-flight-director` | Flight-control source and tests integrated from the authored commits; its isolated ADR-147/148 records were identity-preservingly renumbered to ADR-151/152 to avoid the integration branch's existing ADR-147 allocation. Old generated evidence is intentionally retired. |
| `1ef69594971eedc4a83b6ede740e9fd140d612a7` | `feature/revoy-map-remediation` | Complete proprietary `revoy-map` skill, validation tests, self-contained architecture artifact, and visual proofs integrated as authored. |

The detached `/tmp/revoy2-governance-probe-WlEuhP/candidate` worktree was a
synthetic staged test snapshot, not an authored feature lane. Comparison found
406 paths byte-identical to the integration tree, 118 older or divergent, and
7 chronology files already removed by the canonical TUI integration. It was
not merged; its recoverable pointer was
`8b98055c648ad4ca08ca8547f8146bafaf26a26a`.
