# revoy-spec Port Manifest

**Date:** 2026-08-17
**Sources reviewed:** `revoy-spec` @ `33e8b99a` (dormant since 2026-07-30);
this repository @ `466a2fe8`.
**Status:** research record. Not an ADR, not a ROADMAP tranche. Nothing here
authorizes a port; each Tier 1/2 entry still needs its own decision record.

**Supersedes the ordering of** `docs/revoy-spec-mutation-gating-repurposing.md`
(2026-08-03). That brief ranked mechanisms by value ÷ effort. Four of its seven
were built and then deleted (§0.3). This manifest ranks by *consumer* instead.

**Extends, does not contradict,**
`docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md` §24
(2026-08-04). That pass mined revoy-spec for governance-microscopic lessons
(P1–P8) and rejected four things outright. It did not survey revoy-spec's 57
packages for capability-level ports. This does.

---

## 0. What the two repositories are to each other

| | revoy-spec | revoy2 |
|---|---|---|
| Language | Python (+ optional Rust ext) | TypeScript / Bun |
| Span | 2026-06-27 → 2026-07-30 | 2026-07-31 → present |
| Commits | 2,503 | 1,091 |
| Scale | ~183k LOC, 57 packages, 159 decision records | 12 packages, 391 test files, 74 ADRs | <!-- sur-05:historical — comparison snapshot dated 2026-08-17 against this repo @ 466a2fe8; not a live count -->
| State | Dormant; stopped mid-remediation with CI red | Active |

revoy2's first commit lands the day after revoy-spec's last. This is a
deliberate restart, not a fork. revoy-spec's corpus never mentions revoy2 — a
`grep -rn "revoy2"` over it returns zero hits — so no migration memo exists on
either side. The transition is reconstructible only from timing and from
revoy2's own retrospective documents.

### 0.1 The reuse question is not a licensing question

revoy-spec is dual-licensed: spec text (`decisions/`, `artifacts/`, Markdown)
under CC-BY-4.0, reference code under MIT. It is an **attributed parent**, not a
clean-roomed source. The clean-room boundary table in the private research
report names only omo/opencode/Codex and the Arbor paper. §24.1 of the
governance audit settles it:

> "CC-BY-4.0 explicitly permits adaptation with attribution, which is exactly
> what ADR-006's 'Derived from revoy-spec's `process_gate.v1` (ADR-086),
> independently implemented' already does. Attribution stays mandatory;
> clean-room paranoia does not."

`decisions/ADR-006-process-gates-wrapping-tree-search.md:37` carries that
attribution today and is the template for any port here.

### 0.2 The reuse question is a wiring question

`bun run gate:reachability` treats a barrel re-export as **not a caller**.
42 symbols currently hold waivers, expiring 2026-08-22 → 2026-09-12. Anything
imported without a live consumer is deleted on schedule.

### 0.3 The evidence: four of these were already ported, and all four deleted

| Commit | What it removed |
|---|---|
| `98ea8f1` | `hashline.ts` (CAS edit), `ops-edit.ts`, `ops-server.ts`, their barrel exports and tests — 719 deletions |
| `e9e9f22` | `checkTodoDiscipline`, `ownedArtifactReason`, `REVOY_PHASE_BEGIN/END`, `passedGate` |
| `1050aca` | `plan-gate.ts` and the unused loop-policy substrate |

`e9e9f22`'s message states the cause exactly:

> "The first two cite `ops.discipline.check` and an `ops.edit` MCP server as
> their future consumers. Both exist only in
> `docs/revoy-spec-mutation-gating-repurposing.md`, a speculative research
> brief — not an ADR, not a ROADMAP tranche — and neither tool was ever built."

`98ea8f1` adds the general principle: the reachability gate "independently
confirmed the entire surface … has no caller anywhere in `packages/` outside
the package barrel re-export and its own tests — reachable only through
`index.ts`, which is not a caller."

**The rule this manifest is organized around:**

> A port with no named, already-wanted consumer is not a contribution. It is
> future deleted code.

Every Tier 1 entry names a consumer that exists today. Every Tier 2 entry names
the consumer that must be built first, and is explicitly blocked on it.

---

## 1. Tier 1 — real gap, consumer already exists

### T1 — Compaction epochs

**Source:** `revoy/compaction/` (12 files, 1,352 LOC, 5 test files). <!-- sur-05:historical — "5 test files" counts the external revoy-spec `revoy/compaction/` tree, not this repository -->
Compaction as an *epoch transition*: protect a recent message tail, prune
everything before it into one persisted `workload_summary.v1`, and record the
transition as a `context_epoch.v1` boundary carrying source provenance.
`dedup.py` runs a cheaper pre-pass collapsing repeated Read-tool calls, and
deliberately runs *before* compaction rather than folded into it.

**The gap.** ROADMAP's gap register, G-04:

> "**CLOSED as a Hollow-shape defect (2026-08-04, wave 5); real compaction
> remains unbuilt.** … Real structural folding (the actual point of 4D.7) is
> still not implemented — see 4D.7's own status line, which stays 🟡 for that
> reason."

The loop now emits a typed `compaction_skipped` event rather than fabricate a
ledger record. That is an honest skip, not a capability. ADR-018's lifecycle
type, the audit record shape, and `screens/compaction.ts` all exist and are
waiting on the mechanism.

**Consumer (live):** the compaction lifecycle in `arbor-mcp`,
`arbor-harness/src/context-manager.ts`, and the TUI compaction screen, which
today renders an empty lifecycle.

**Why this ranks first.** It is the only entry closing a capability revoy2 has
openly *withdrawn* a claim about. Everything around the hole is already built;
the epoch/anchor mechanism is the single missing piece. Note the shape of the
original defect — empty `pre_evidence_id`/`post_evidence_id` — is precisely what
revoy-spec's `context_epoch.v1` boundary carries by construction, so the port
addresses the root cause rather than the symptom.

### T2 — Transient-file provenance gate

**Source:** `revoy/prov/` (23 files, 5,908 LOC, 10 test files). Every transient <!-- sur-05:historical — counts the external revoy-spec tree, not this repository -->
repository file (docs, plans, artifacts, reports, reviews, handoffs) must carry
a provenance hash linking it to at least one *active* ROADMAP todo. Unlinked or
closed-todo files are archived as orphans, then swept after a retention window.
Load-bearing surface is small: `provenance_hash`, `active_todo_ids`,
`classify_transient`, `check`, `link`, `archive`, `sweep`.

**The gap.** `scripts/docs-truth.mjs` resolves exactly one input —
`const ROADMAP_PATH = resolvePath(REPO_ROOT, "ROADMAP.md")` (line 209) — and
reads no other Markdown. Every file under `docs/` is outside every gate in the
31-step `bun run check`.

This is not a hypothetical. The governance audit caught itself on it in §24.6.1,
where a stale exit-code claim survived review:

> "it went stale because `docs-truth.mjs` only reads `ROADMAP.md`, leaving this
> document outside every gate. Recorded rather than quietly corrected: an
> unwitnessed claim inside the audit's own paperwork is the defect this program
> exists to catch."

**Consumer (live):** the docs-truth step of `bun run check`;
`arbor-governance/src/artifact/{scan,identity,duplicates}.ts` already walk
repository artifacts and are the natural host for the linkage check.

**Note on scope.** revoy-spec's version archives and sweeps orphans. The
archival half is a separate, more invasive decision — the *check* half is what
closes the evidenced gap, and can land alone.

### T3 — LSP-as-tools

**Source:** `revoy/lsp/` (26 files, 3,671 LOC, 8 test files) orchestrates real <!-- sur-05:historical — counts the external revoy-spec tree, not this repository -->
language servers per (language, root), falling back to tree-sitter structure
when no server is configured. `revoy/edit/mcp_lsp.py` exposes exactly three
tools — `lsp_find_references`, `lsp_diagnostics`, `lsp_rename` — giving
compiler-exact answers instead of grep heuristics.

**The gap.** revoy2 has no LSP integration at all: a case-insensitive grep for
`languageserver|language-server|\blsp\b` across `packages/*/src` returns zero
matches. `repository-graph.ts` uses the TypeScript compiler API, but is scoped
to retrieval *ranking*, and its structural-centrality arm is disabled by
calibration. Specialists editing code have no authoritative references, rename,
or diagnostics surface.

**Consumer (live):** `arbor-mcp/src/native-tool-host.ts`. Specialists already
execute edits through this tool catalog; these are three additional tools in a
registry that exists.

**Caveat worth stating in the ADR.** This adds a real external dependency
(language-server binaries on PATH) to a repository that is currently
hermetic. revoy-spec's tree-sitter fallback is the mitigation and should be
ported with it, not after it.

---

## 2. Tier 2 — real gap, consumer must be built first

These are genuine absences. Each is **blocked** on a consumer that does not yet
exist; porting before that consumer reproduces §0.3.

| # | Component | Source | Gap | Blocked on |
|---|---|---|---|---|
| **T4** | Drift-locked context compiler (`weave`) | 11 files, 1,133 LOC, 2 tests. Compiles a minimal prompt from *pointers* into source, resolved to current spans, with a compile-time drift-lock that fails loudly if a frozen unit's source has moved. | ADR-038 governed context folding has no guarantee that a folded pointer still refers to what it referred to when frozen. | **T3** — the span resolver is the drift-lock's substrate. Sequence strictly after. |
| **T5** | Git-native flight control (`flight`) | 14 files, 3,512 LOC, 6 tests plus cross-package coverage. Board/admit/lease/sync/handoff/cleanup over worktrees, a worktree-drift classifier, and merged-work ledger reconciliation. | revoy2 has one worktree per node (`WorktreeManager`) but no fleet-level lease, drift, or handoff layer. ADR-067 racing and `sibling.spawn` are partial (G-03's spawn-path half). | A fleet view over the runtime catalog. Needs an ADR; this is the largest Tier 2 item. |
| **T6** | Deterministic prior-art briefs (`priorart`) | 16 files, 1,194 LOC, 7 tests. Splits nondeterministic web-tool COLLECTION from deterministic ASSEMBLY into a hashable `prior_art_brief.v1`. | The KB captures only *self-generated intra-campaign* knowledge. No external prior-art capture exists anywhere in revoy2. | A planning-phase step for Taproot. Needs an ADR. |
| **T7** | Commit-identity drift (`identity`) | 7 files, 1,317 LOC, 2 tests. Forges attribute commits by *email*, so `git log` can read correctly while every commit is miscredited; recertification proceeds only when provably a bijection onto the prior accounted set. | Not covered by the branch-accounting gate or anything else. | Nothing structural — smallest item here. Folds into `bun run check` as one more gate. |
| **T8** | Stacked-PR rebase triage (`rebasestack`) | 6 files, 815 LOC, 2 tests. Classifies commits by `git patch-id --stable` into duplicate-upstream/original, and conflicted paths into generated-index / roadmap-ledger / genuine-source. | No equivalent. Read-only over git; never mutates HEAD. | ADR-053's integration conductor is the natural host. |

**Suggested order if Tier 2 is pursued:** T7 (cheapest, self-contained) →
T8 (host exists) → T6 → T4 (after T3) → T5 (largest, needs the most design).

---

## 3. Tier 3 — rejected, with reasons

Recorded so these are not re-litigated. The negatives carry as much weight as
the adoptions.

**The twelve turnstiles (`turnstile`), the conformance stamp (`stamp`), and
`writ`.** This is the most elegant construction in revoy-spec: every crossing
between two surfaces (intent → ledger → graph → adr → repo → dispatch → proof →
audit → ci → tui → daemon → stamp → release) modeled as a typed bidirectional
gate with required evidence and five states including `stale` and `impossible`.
It is still a reject. §24.2 already settled the sibling case on verified
evidence:

> "the only non-test importer of `revoy.process` is
> `engine/revoycli/commands_process.py` — a manual CLI. The gates never advance
> on their own … **Four working gates beat eleven decorative ones.**"

revoy2 has seven wired gate checkers (`packages/arbor-gate/src/gate.ts`:
admission, isolation, evidence, audit, fold-activation, harness-activation,
harness-promotion). Adding twelve unwired ones imports the exact defect
ADR-086 was written to fix and never did. `writ` is separately the
thinnest-tested unit in the set: 1 test file for 1,217 LOC.

**GBNF grammar compiler (`grammar`, 1,482 LOC).** Inert on *both* sides.
revoy-spec's own module documentation concedes the scope (ADR-146): "revoy has
no local/self-hosted model-serving code," so the compiled grammar has no
sampling loop to attach to. revoy2 has the same absence. Porting relocates dead
code. Revisit only if revoy2 ever owns a sampling loop.

**MCL (`mcl`, 6,662 LOC + PyO3/Rust extension).** Its thesis — the LLM emits
typed signals, a deterministic engine validates them against a declared world —
is already served by revoy2's native protocol and structured output. The cost is
disproportionate and it drags a Rust toolchain into a Bun repository.

**`map` (17,169 LOC) and `index` constellations (6,304 LOC).** Substantial and
genuinely interesting (BIGCLAM overlapping community detection over a code
graph, cross-linked to PROV-O). Rejected because revoy2's retrieval is
deliberately narrow and *calibrated* — the structural-centrality arm is disabled
because measurement said so. Replacing a measured design with a larger unmeasured
one inverts the evidence discipline this repository is built on.

**`vivisect` (2,311 LOC).** Decompilation/RE MCP surface. Orthogonal capability
domain; unrelated to the governance thesis.

**Eleven separate MCP servers.** Already rejected by §24.2 — appropriate to
revoy-spec's scale, wrong here, where a single catalog gives one auth path, one
idempotency mechanism, one error union.

**`amends` as a field, and canonicalization.** Already rejected by §24.2:
`amends` is parsed by three mirrored parsers and consumed by nothing;
canonicalization is ~8 uncoordinated `json.dumps(sort_keys=True)` sites, worse
than revoy2's pre-fix state.

**hashline CAS edit, owned-artifact classification, plan-gate, discipline check
(the 2026-08-03 brief's M1, M2, M5, M6).** Already ported and already deleted —
§0.3. Do not re-port. If a consumer genuinely appears, revive from git history
and wire it in the same commit.

---

## 4. Already covered — one-line dispositions

| revoy-spec | revoy2 equivalent |
|---|---|
| `q` (envelope read-model) | runtime catalog, 110 command/query kinds |
| `webui` | `arbor-mcp/src/webui.ts` + SSE |
| `surveillance` | `arbor-core/src/surveillance.ts` (ADR-013, monitor not gate) |
| `fullauto` | `arbor selfhost` |
| `d` (governance daemon) | canonical runtime + scheduler (ADR-047) |
| `mailbox` | conversation bus, thread-push, A2A bridge (ADR-039/040) |
| `necromancer` | `gate:reachability` + deletion manifest |
| `creds` | `credential-broker.ts`, scoped opaque leases |
| `modes` | botanical role profiles (`arbor-prompts`) |
| `catalog`, `primitives` | runtime catalog + plugin registry (ADR-052) |
| `telemetry` | ledger-derived telemetry projection (ADR-017) |
| `store` | KB + audit ledgers |
| `integrate` | integration conductor (ADR-053) |
| `compliance`, `graph` | `arbor-governance` + the 31-step `bun run check` |
| `hooks`, `harnessgen` | governed hook and lifecycle bus (ADR-049) |
| `process` (11 gates) | 7 wired gate checkers — see Tier 3 |
| `agent`, `orchestrate`, `runtime`, `workload`, `tasks`, `phases` | campaign manager, task supervisor, runtime catalog |

---

## 5. Provenance

Any port arising from this manifest carries attribution in its ADR, following
the existing precedent at
`decisions/ADR-006-process-gates-wrapping-tree-search.md:37`:

> "Derived from revoy-spec's `process_gate.v1` (ADR-086), which defines eleven
> lifecycle gates from intent to cleanup. The concept is independently
> implemented with four gates specific to the tree-search loop."

revoy-spec is CC-BY-4.0 (spec text) / MIT (code). Attribution is mandatory;
a clean-room protocol is not required for this parent.

## 6. How the claims here were verified

- **revoy-spec sizes** — `find <pkg> -name '*.py' -not -path '*__pycache__*'`
  for file and test counts, `-exec cat {} + | wc -l` for LOC. All 17 cited
  packages verified 2026-08-17.
- **T2's gap** — `grep -n "ROADMAP_PATH\s*=" scripts/docs-truth.mjs` returns a
  single line; no other Markdown read exists in that script.
- **T3's gap** — `grep -rlniE "languageserver|language-server|\blsp\b"
  packages/*/src` returns nothing.
- **§0.3's deletions** — `git show 98ea8f1 e9e9f22 1050aca`; quotes are verbatim
  from the commit messages.
- **Correction to a prior survey.** An earlier survey pass reported that
  `revoy/surveillance` and `revoy/rebasestack` have no test directories. Both
  do — 4 and 2 test files respectively. <!-- sur-05:historical — counts the external revoy-spec tree, not this repository -->

**This document is itself outside `bun run check`**, for exactly the reason T2
exists. Nothing in `docs/` is gated. Treat its claims as verified on the date
above and re-derive rather than inherit them.
