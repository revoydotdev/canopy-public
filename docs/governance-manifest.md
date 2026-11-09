# revoy2 governance manifest

One row per governance concern this repository mechanizes, curates, or has deliberately left
to review. This document exists because two axes get conflated in casual description and the
conflation invents a false equivalence:

- **Scheduling** (`GATE_TIERS` in `scripts/gate-all.mjs`) — *when* a mechanism runs: every
  `Stop`, during governed source submission and ordinary guarded push (`fast`), or only on a full/CI pass (`full`). `n/a` for
  mechanisms that are not part of the `gate:*` battery at all (PreToolUse hooks, Tier 2 skills).
- **Authority** (`HOOK_ADVISORY` in the same file, plus each mechanism's own documented
  behavior) — *whether a red result vetoes anything*, and if so, what: the tool call itself
  (`blocks` a `PreToolUse` hook), the claim of completion (`blocks` a `Stop` hook or `gate:all`
  exit code), or neither (`advisory` — runs and reports, never vetoes; `reports` — a pure
  observability hook with no pass/fail concept at all).

**"Runs at stop tier" is not "blocks."** `gate:store-freshness` and `gate:vi-findings` both run
at `stop` on every Stop hook invocation, print their full remedy, and still fail `gate:all`
everywhere else (pre-push, CI, manual runs) — but the Stop hook itself never vetoes on them,
for two structurally different reasons stated in each row below.

## Cell states

Every `Evidence` cell is exactly one of three legal states (the operator's own decision this
session, `docs/proposals/procedural-knowledge-hooks-vs-skills.md`):

- **(a)** — a real, tested mechanism. The `Mechanism` column names it and it is reachable
  (`bun run <name>`, an `arbor` verb, or a wired hook).
- **(b)** — a stated boundary: mechanization is impossible or unsafe, with the concrete reason
  given inline. Never an undated TODO.
- **(c)** — a dated waiver naming a follow-up and an owner.

A row claiming enforcement it does not have, or an undated TODO standing in for a boundary, is
a defect in this document, not an acceptable shorthand.

## Governed source submission

The supported source-and-evidence publication path is:

```bash
bun run trunk:submit -- --message "<subject>" --include <path> [--include <path>...]
```

It creates a source commit from the explicit include set, generates required evidence from that clean snapshot, creates a separate evidence commit, and then performs an ordinary guarded push. A durable journal records the transaction so an interrupted submission is resumed from its recorded phase rather than reconstructed manually. The command fails closed on invalid scope, stale or failed evidence, gate failure, conflict, or push failure, and deliberately exposes no skip-gate or hook-bypass option. This does not overstate direct Git: a manually invoked `git push` remains subject to the separately documented local-hook limits.

## Tier 0 — PreToolUse hooks (block the tool call)

| Concern | Mechanism | Scheduling | Authority | Cell-state | Evidence |
|---|---|---|---|---|---|
| An ADR write lacking a proof comment | `veto.claim-completeness-guard` — `packages/arbor-mcp/src/hooks/claim-completeness-guard.ts` | n/a (every `tool_preflight`) | blocks | (a) | `HookVetoDecision { allow: false, reason }` when an edit adds a completeness marker to ROADMAP.md, decisions/README.md or an ADR with no proof comment in the same change; `gate:claim-ledger` remains the fail-closed authority over the whole tree. Replaced the deleted .claim-ledger/claim-guard.sh (`PreToolUse`) |
| A write outside a live VI observation window | `veto.vi-readonly-guard` — `packages/arbor-mcp/src/hooks/vi-readonly-guard.ts` | n/a (every `tool_preflight`) | blocks | (a) | `HookVetoDecision { allow: false, reason }` while a `.visual-intelligence` run is armed; ignores a stale sentinel rather than wedging. Replaced the deleted vi-readonly-guard.sh (`PreToolUse`) |
| `git stash`/`reset`/`checkout --`/`rebase`/`commit`/`add` from a subagent context | `veto.git-write-guard` — `packages/arbor-mcp/src/hooks/git-write-guard.ts` | n/a (every `tool_preflight`) | blocks | (a) | `HookVetoDecision { allow: false, reason }`; the rule motivating it is measured (five violations across five briefs, `docs/proposals/procedural-knowledge-hooks-vs-skills.md`); never blocks the orchestrator. Replaced the deleted `scripts/hooks/git-write-guard.sh`, including its undocumented half: the old shell hook's orchestrator sweep (`git add -A`/`reset --hard`/`checkout -- .`/`clean -f` refused while another agent held the tree) has no native equivalent, because nothing in `packages/` can map a live pid to a working-tree path. See the handler's own header. |

## Tier 1 — Stop hooks (block the claim of completion)

| Concern | Mechanism | Scheduling | Authority | Cell-state | Evidence |
|---|---|---|---|---|---|
| The `stop`-tier gate battery | native `observe.stop-battery` + the worker's `turn_gate` (replaced `scripts/hooks/gate-stop.sh`, deleted) → `bun scripts/gate-all.mjs --tier stop --advisory hook-default` | stop | blocks (except the two named HOOK_ADVISORY gates below) | (a) | every `stop`-tier gate in the table below runs here; a red one refuses the turn with the gate's own remedy text fed back to the model. Measured out of band on the `turn_end` boundary and cached on HEAD + dirty-path count + tier/advisory, so a turn costs a file read and not the battery's ~30s |
| Visual-intelligence graph debt reminder | `observe.vi-graph-debt` — `packages/arbor-mcp/src/hooks/vi-graph-debt.ts` | n/a (every `turn_end`) | reports | (a) — a pure observability hook, no pass/fail concept; it returns a bounded ledger note and never reaches the model | the UNSCOPED `.dirty` ∩ `git status` intersection, sampled to five four-space rows with a `... and N more` row and the maintenance-mode remedy, recomputed on every turn. Replaced the deleted `vi-graph-debt.sh` (`Stop`). It is a note rather than an injection because the `turn_end` lane is observe-only and `contracts.ts` mints no new inject trigger point; the model-facing equivalent is `inject.vi-freshness` above. Its `derived_from` is a hash of the intersected path set and is recorded on the ledger row — NOT deduped, as the inject lane's is — and its tests assert both that the hash moves and that two identical firings produce one derivation, because a native handler is invisible to `gate:hook-liveness` and a note that stopped measuring is the ~42-session fixed-verdict defect ADR-032 records |
| Visual-intelligence dirty-file tracking | `observe.vi-dirty-tracker` — `packages/arbor-mcp/src/hooks/vi-dirty-tracker.ts` | n/a (every admitted `file.write`/`file.patch`) | reports | (a) | a pure side effect, no pass/fail concept. Sole writer of `.visual-intelligence/.dirty`; append-only, deduped, skipped under `.visual-intelligence/` and outside the repository. Replaced the deleted `vi-dirty-track.sh` (`PostToolUse`), firing on the tool-input side because the post-execution audit record is content-free by design. Fires only after the base port admits the call |
| Visual-intelligence graph freshness reminder at session start | `inject.vi-freshness` — `packages/arbor-mcp/src/hooks/vi-freshness-tropism.ts` | n/a (every `session_start`) | reports | (a) | a verdict ladder, and the only native hook that reports commit distance: UNCOMMITTED-BASIS / CURRENT (silent) / DIVERGED / STALE, plus a third silence for a STALE whose commits missed `packages/`+`decisions/`. Reads the `.dirty` above through the shared `dirtyIntersection` helper, and is deliberately the opposite of `inject.governance-orient`, which suppresses commit distance on purpose. Replaced the deleted `vi-freshness.sh` (`SessionStart`). Its `derived_from` is a hash of every ladder input and its tests assert that hash moves, because the bus dedupes an unmoving derivation into SILENCE rather than an error |

## Tier 2 — Skills (steer sequence and blast radius, ex ante, never block)

| Concern | Mechanism | Scheduling | Authority | Cell-state | Evidence |
|---|---|---|---|---|---|
| Routing an operator to the correct governance mechanism at the moment of need | `.claude/skills/revoy2-procedure/` (this repository's dispatch table + CRUD appendix, both generated by `scripts/generate-procedure-tables.mjs`) | n/a | advisory (a skill is read by a model, not enforced against one) | (b) | judgment about WHICH situation an agent is in cannot be mechanically decided from a pending tool call the way a `PreToolUse` predicate can; that is precisely why this is a skill and not a hook (`docs/proposals/procedural-knowledge-hooks-vs-skills.md`'s Tier 2 criteria) |

## Tier 3 — Gates (`bun run gate:*`, detect and report; `gate:all` aggregates and blocks on the aggregate)

Derived from `bun scripts/gate-all.mjs --list` and `scripts/gate-all.mjs`'s `GATE_TIERS`/
`HOOK_ADVISORY` at the time this document was last regenerated by hand (this document is not
yet wired to a `gate:manifest-truth` drift check — see **Boundaries and open follow-ups** below).

| Gate | Concern | Scheduling | Authority | Cell-state | Evidence |
|---|---|---|---|---|---|
| `gate:adr-acceptance-staged` | An ADR's acceptance is a separate, status-only commit from its substantive authoring | stop | blocks | (a) | `bun scripts/adr-acceptance-gate.mjs` |
| `gate:adr-registry` | The ADR registry (`decisions/registry.json`) matches the files on disk | stop | blocks | (a) | `bun scripts/adr-registry.mjs verify` |
| `gate:adr-retirement-integrity` | A retired/superseded ADR is cross-referenced in both directions | stop | blocks | (a) | `bun scripts/adr-retirement-integrity.mjs` (landed this session; not built by this agent) |
| `gate:adr-status` | Obligation coverage across every ADR's proof comments | fast | blocks | (a) | `bun scripts/adr-status-audit.mjs` |
| `gate:adr-trace` | ADR references trace correctly across the merge-base..HEAD range | stop | blocks | (a) | `bun scripts/adr-trace.mjs` |
| `gate:anti-stub` | Dead/stub exports report (non-blocking sweep) | fast | blocks (of `gate:all`'s own exit; see the `:blocking` variant for the harder gate) | (a) | `bun scripts/anti-stub.mjs` |
| `gate:anti-stub:blocking` | Untriaged anti-stub findings | stop | blocks | (a) | `bun scripts/anti-stub.mjs --blocking`; a finding not in the in-file TRIAGE table is UNTRIAGED and fails this variant |
| `gate:branch-accounting` | Every non-integration branch has a dated, reasoned disposition | stop | blocks | (a) | `bun scripts/branch-accounting.mjs` against `scripts/branch-accounting/dispositions.json` |
| `gate:claim-ledger` | The `.claim-ledger/` store's claims match the ADR proof comments they attest | fast | blocks | (a) | `bun scripts/claim-ledger.ts` |
| `gate:claim-ledger-precommit` | Pre-commit-time claim-ledger consistency | stop | blocks | (a) | landed this session; not built by this agent |
| `gate:closed-enum-hygiene` | Closed enums have no orphaned/duplicate cases | stop | blocks | (a) | `bun scripts/closed-enum-hygiene.mjs` |
| `gate:completion-depth` | The `.completion-depth/` store matches the working tree | stop | blocks | (a) | `bun scripts/completion-depth.mjs` |
| `gate:coverage` | Test coverage floor | full | blocks | (a) | `vitest run --coverage --pool=forks` |
| `gate:decisions-precommit` | Pre-commit-time decisions-directory hygiene | stop | blocks | (a) | landed this session; not built by this agent |
| `gate:determinism` | The `.determinism-baseline/` store matches a real, single-pass suite run | full | blocks | (a) | `bun scripts/determinism-baseline.ts` |
| `gate:docs-truth` | Documentation claims match observable repository state | fast | blocks | (a) | `bun scripts/docs-truth.mjs` |
| `gate:eval-regression` | The scripted eval harness has not regressed | full | blocks | (a) | `bun scripts/eval-regression-gate.ts` |
| `gate:gap-status` | ROADMAP.md's Verified gap register matches reality | stop | blocks | (a) | `bun scripts/gap-status-gate.ts`; pure text scan, no subprocess |
| `gate:governance-counts` | Governance projection counts are internally consistent | stop | blocks | (a) | landed this session; not built by this agent |
| `gate:hook-liveness` | Every wired Claude hook is declared in `.hook-liveness/hook-manifest.json` | stop | blocks | (a) | `bun scripts/hook-liveness-gate.mjs` |
| `gate:ledger-audit` | Campaign audit ledgers pass tamper-detection and cross-record sweeps | stop | blocks | (a) | `bun packages/arbor-mcp/bin/arbor-mcp.mjs ledger audit --all --dir .arbor` |
| `gate:liveness` | Every registered native-harness seam and consumer is reachable by real execution | fast | blocks | (a) | `bun scripts/liveness-gate.ts`; also reachable via `arbor liveness` |
| `gate:lockfile` | The lockfile matches `package.json` | stop | blocks | (a) | `bun scripts/lockfile-check.mjs` |
| `gate:merge-critical-check` | Merge-critical files agree across integration branches | stop | blocks | (a) | previously outside `auditRoster` entirely (A5 in the plan's inventory); now namespaced as a gate by a sibling this session |
| `gate:obligations` | Every ADR obligation has a proof comment discharging it | stop | blocks | (a) | `bun scripts/obligations-gate.ts` |
| `gate:project-conform` | A project's `arbor.profile.jsonc` conforms to the governed spec | stop | blocks | (a) | `bun scripts/project-conform.mjs`; also reachable via `arbor project status`/`enroll` |
| `gate:project-registry` | Every registered project entry's discharge still holds (ADR-076) | stop | blocks | (a) | `bun scripts/project-registry-gate.mjs`; also reachable via `arbor project registry verify` and (new, C5) `arbor doctor` |
| `gate:reachability` | Every symbol the 6.2 walker roots at is reachable, or has a dated waiver | fast | blocks | (a) | `bun scripts/reachability.mjs` against `scripts/reachability/allowlist.json` |
| `gate:registration-integrity` | Registered capability/tool/command tables have no orphaned or duplicate entries | stop | blocks | (a) | `bun scripts/registration-integrity.mjs` |
| `gate:store-freshness` | The four committed evidence stores match the working tree's content hash | stop | **advisory in the Stop hook only** (see below); blocks everywhere else | (a) | `bun scripts/store-freshness-gate.mjs`; now correctly reachable via `arbor evidence refresh` (this agent's C1) |
| `gate:tui-catalog-parity` | The TUI's rendered command catalog matches the real command registry | stop | blocks | (a) | `bun scripts/tui-catalog-parity.mjs` |
| `gate:typecheck-tests` | `tsc` covers test files, not just `src/` | full | blocks | (a) | `bun scripts/typecheck-tests.mjs`; the exact gate the 2026-08-15 14-error incident (`gate-all.mjs`'s own header) was about |
| `gate:vi-findings` | Every VI finding has a recorded, reasoned, dated human triage verdict | stop | **advisory in the Stop hook only** (see below); blocks everywhere else | **(b)** | `bun scripts/vi-findings.mjs`. This is the canonical (b): a mechanism here would require a model to triage its own findings, fabricating exactly the human verdict this gate exists to prove. No amount of engineering closes this — it is a boundary, not a gap. |
| `gate:vi-freshness` | The visual-intelligence graph is within its commit budget | stop | blocks | (a) | `bun scripts/vi-freshness-gate.mjs`; the graph-before-stores precheck `arbor evidence refresh` runs first |
| `gate:vi-reproducible` | Regenerating the VI graph twice produces byte-identical output | full | blocks | (a) | `bun scripts/vi-refresh.mjs --check` |
| `gate:worktree-hygiene` | No stale worktrees or writer locks | stop | blocks | (a) | `bun scripts/worktree-hygiene.mjs` |

### Why `gate:store-freshness` and `gate:vi-findings` are advisory only in the Stop hook

Both run at `stop` tier and both still fail `gate:all` everywhere else (pre-push, CI, manual).
What is relaxed is only the Stop hook's veto, for two different, non-interchangeable reasons
(`scripts/gate-all.mjs`'s own `HOOK_ADVISORY` comment):

- **`gate:store-freshness`** — its verdict depends on uncommitted working-tree state. Editing
  any tracked file, or adding any un-ignored new one, turns it red until the stores are
  refreshed AND committed. Vetoing every Stop on this would block all normal mid-task work; it
  is a correct release condition and an incorrect per-Stop blocking condition. Cell-state **(a)**
  — the mechanism (`arbor evidence refresh`, C1) is real; only the Stop-time veto is relaxed.
- **`gate:vi-findings`** — requires a recorded human verdict per finding, with a reason and an
  expiry. Vetoing the Stop on this would force a model to fabricate the human decision the gate
  exists to prove — the fail mode described in "Why not make everything a hook"
  (`docs/proposals/procedural-knowledge-hooks-vs-skills.md`). Cell-state **(b)**.

## Non-`gate:*` governance checks (A5 in the plan's inventory)

Roadmap 23's audit noted five governance checks living outside `gate:*` and therefore outside
`auditRoster` entirely: pre-commit's four checks and `merge-critical-check --verify`. As of this
document's last regeneration, `gate:merge-critical-check`, `gate:claim-ledger-precommit`, and
`gate:decisions-precommit` have been namespaced into the `gate:*` roster by a sibling agent this
session (visible in the Tier 3 table above) — narrowing, not yet closing, A5. This document does
not independently verify that every remaining pre-commit check has a `gate:*` counterpart; that
verification is out of this agent's ownership (`.claude/settings.json`, `scripts/gate-all.mjs`).

## Boundaries and open follow-ups

- **This document is not yet self-verifying.** The proposal names the target mechanism
  explicitly: *"A `gate:manifest-truth` check derives the tier/scheduling/authority columns from
  `GATE_TIERS`, `HOOK_ADVISORY`, and `enumerateGates()` and fails if the document disagrees."*
  That gate does not exist yet. Until it does, the Tier 3 table above is accurate as of the
  moment it was regenerated by hand against `bun scripts/gate-all.mjs --list` and a text read of
  `GATE_TIERS`/`HOOK_ADVISORY` — the same extraction `scripts/generate-procedure-tables.mjs`
  (C2/C3 of this delivery) already performs for the `revoy2-procedure` skill's own tables. This
  is a dated **(c)**-shaped follow-up on the manifest AS A WHOLE, not a per-row waiver: **owner —
  whichever agent next owns `scripts/gate-all.mjs`; wire `docs/governance-manifest.md`'s Tier 3
  table into that same generator (or a sibling one) so this file stops being hand-regenerated.
  Opened 2026-08-18.**
- **ADR retirement, the claim-ledger precommit gate, decisions-precommit gate, and the
  governance-counts gate landed concurrently with this document**, from siblings working the
  same plan in parallel worktrees on this batch. Their rows above are populated from
  `bun scripts/gate-all.mjs --list` output observed at generation time, not from reading their
  source (out of this agent's file ownership) — a live check, not a stale assumption, but also
  not independently verified beyond the roster listing.
- **The three waiver stores (reachability allowlist, branch dispositions, anti-stub TRIAGE)
  now share one implementation**, `scripts/lib/waiver-store.mjs` (landed `5f892865`,
  ADR-075): `scripts/reachability.mjs`, `scripts/branch-accounting.mjs`, and
  `scripts/anti-stub.mjs` all import it rather than each carrying its own schema, validator,
  and expiry arithmetic. See `.claude/skills/revoy2-procedure/`'s CRUD appendix, generated
  fresh from the same source each time it is regenerated.
