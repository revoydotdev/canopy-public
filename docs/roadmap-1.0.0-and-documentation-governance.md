# Canopy/revoy2 documentation governance and 1.0.0 roadmap

Artifact kind: roadmap
Status: active
Revision: 6
As-of commit: 8c016988 (2026-09-23)
Authority: this file governs sequencing. ADRs govern architectural decisions; code, tests, and sealed evidence govern implementation claims.
Evidence scope: mixed — observed corpus/history baseline and target release requirements
Supersedes: sequencing portions of ROADMAP.md, docs/roadmaps/README.md, and individual roadmap priority lists
Superseded by: none
Owner: Canopy/revoy2 maintainers
Review trigger: every release candidate, every accepted ADR that changes a public contract, and every material change to token, MCP, skill, tool, gate, or operator UX behavior.

This document is the single planning entry point for 1.0.0. It consolidates the active intent in `ROADMAP.md`, `docs/roadmaps/`, the token-economy architecture, frontier handoff, self-hosting blocker record, TUI overhaul register, and the September comparative audits. It supersedes their sequencing and priority claims. It does not erase them: those files remain evidence, design history, or implementation briefs and must be marked historical or linked here when their content is next touched.

## Evidence boundary and current state

This revision re-audits the integrated tree at `3c828333a19901bf1b8aac37009b3d2fa0d6b80e`, using Git history, the tracked Markdown inventory, document headings and status language, the decision registry, and the recent TUI, governance, self-hosting, token, MCP, and comparative-analysis records. The earlier uncommitted Canopy debug and TUI changes remain excluded from claims. A dirty tree is not evidence of a shipped feature.

The inventory check at this revision reports 1,430 in-scope items and a current input digest. The corpus baseline numbers in the original 2026-09-19 review (615 tracked Markdown files, 157 numbered ADR files, 24 top-level `docs/roadmaps/` Markdown files, 240 tracked files under `docs/`, and 271 total files under `docs/`) are historical counts, not reasserted counts for this revision. The top-level `ROADMAP.md` still carries an 2026-08-16 implementation-ledger date; its sequencing is now explicitly superseded below. The September comparative audits and TUI overhaul records remain the preferred evidence for those subjects.

The current product baseline is strong but not 1.0.0-complete: canonical runtime, recovery, provenance, evidence, MCP client breadth, and token-economy primitives are substantially implemented. The TUI has live slices and tested components, but a 2026-09-22 reachability audit at `e00ac295` found that several components—including Git projection subscription, the UCT reader, `InspectService`, stress/matrix views, and semantic glyph helpers—lack evidenced production callers; see the [dated TUI status note](../ROADMAP.md#phase-4c-tui-cockpit). **Revision 3 (2026-09-23, `93da8339`):** `bun run gate:reachability` now reports 5 unreachable exported symbols, down from 17. Git projection refresh (`0cecdcbe`, `56d4ad4c`), Inspect side-question history (`41b919e8`), semantic/focus glyphs (`c65a73e2`), and key-to-frame latency capture (`93da8339`) gained production callers. The last 5 were closed later the same day: the UCT reader state now reaches the live Tree (`6736e343`, `9fba5974`), and the fit-layout transform and M7 stress/matrix copies were deleted instead of being given invented callers (`93a32c8b`, `8be320f8`). `gate:reachability` passes at `9fba5974`. Live external-repository breadth, cache economics, tool/skill loading economics, governance-friction measurement, and release-grade self-hosting remain unfinished or only partially evidenced. “Implemented” means reachable code with tests where the referenced record says so; it does not establish full surface composition, a held-out quality win, or a production deployment guarantee.

## Standard durable-artifact format

Every durable Markdown artifact that can guide implementation, authorize behavior, describe state, or support a release claim uses this header, in this order:

```text
# Title
Artifact kind: <decision|roadmap|architecture|policy|runbook|audit|research|evidence|reference|generated-index>
Status: <draft|proposed|accepted|active|verified|historical|superseded|rejected>
Revision: <integer>
As-of commit: <full or abbreviated immutable commit>
Authority: <what this file may decide or claim>
Evidence scope: <observed|inferred|target|mixed, with boundary>
Supersedes: <links or “none”>
Superseded by: <links or “none”>
Owner: <role or team>
Review trigger: <event>
```

The body then follows the category contract below. A document may not use an unqualified “current”, “done”, “production”, “supported”, or “complete”; attach a commit, evidence pointer, test, or an explicit target label. Exact counts are generated facts or dated observations, never hand-maintained prose. A planned item has an identifier, an owner, a dependency, a commit-sized next action, and a gate. A historical record keeps its original date and evidence boundary and points to the newer record rather than being silently rewritten.

### Category contracts

| Kind | Required body sections | Durable meaning | Exit or supersession rule |
|---|---|---|---|
| Decision / ADR | Context, decision, alternatives, consequences, obligations, proof links, status history | A stable architectural choice and its authority boundary | New decision explicitly supersedes it; implementation status is separate from acceptance |
| Roadmap / plan | Goal, baseline, dependencies, phases, deliverables, commit tasks, quality gate, risks, exit criteria | Ordered work and release intent | One canonical roadmap per release; old plans become historical briefs |
| Architecture / specification | Scope, invariants, interfaces, data/lifecycle model, failure modes, compatibility, examples | How a system is supposed to behave | Update revision and link the ADR; do not turn it into a status report |
| Policy / governance | Rule, applicability, authority, refusal/remedy, audit record, exceptions | What may or must happen, and who may decide | Supersede by an accepted policy/ADR; exceptions are explicit and time-bounded |
| Runbook / guide | Preconditions, happy path, recovery path, observable outputs, troubleshooting, version assumptions | How an operator or agent performs a task | Refresh when commands or UX change; stale commands are a defect |
| Audit / report | Question, method, evidence set, findings, confidence, limitations, dispositions | A bounded observation at a point in time | Never silently mutate; issue a dated correction or successor |
| Research / position | Question, sources, observed/inferred split, synthesis, rejected options, applicability | Input to decisions, not authority by itself | Promote only through an ADR or roadmap task; otherwise remain research |
| Evidence / demo record | Run identity, revision, inputs, commands, outputs, acceptance matrix, failure preservation | Proof of one observed behavior | Immutable after sealing; a rerun creates a new record |
| Reference / generated index | Source generator, schema, freshness, regeneration command, limits | Navigation or derived inventory | Regenerate from source; never hand-edit generated values |

The same artifact can have several audiences, but only one kind and one authority boundary. A demo is not a roadmap, a research comparison is not an implementation claim, and a roadmap checkbox is not proof.

## Corpus disposition and deduplication

The following rules settle the overlap found in the review.

| Corpus | Disposition |
|---|---|
| `ROADMAP.md` | Retain as historical implementation ledger. Its live sequencing is superseded by this file. On next edit, add this link and a dated “sequencing superseded” banner; do not rewrite its evidence history wholesale. |
| `docs/roadmaps/*.md` and `docs/roadmaps/handoffs/` | Retain as implementation briefs and handoff evidence. Their priorities, phase order, and “not yet roadmapped” lists are subordinate to this roadmap. Close or mark `historical` when a task is complete, rejected, or absorbed here. |
| `docs/token-economy-architecture.md` | Retain as the technical contract for token and cache invariants. This roadmap owns sequencing and requires its pending empirical work to pass the gates in Phase 2. |
| `docs/frontier-harness-agent-handoff.md` | Retain as a dated handoff. Its P0–P4 queue is folded into Phases 1–5 here; do not treat its old checkpoint or test counts as current. |
| `docs/self-hosting-blockers-*.md`, `docs/*demo*.md`, `artifacts/` | Evidence and historical records. A new run gets a new dated record; old “cleared” tables are not a standing release claim. |
| `docs/tui-overhaul/*` and `docs/tui-cockpit/*` | Current specs and evidence where their latest commit is after the relevant implementation. TUI sequencing is absorbed into Phase 5; M0–M7 labels remain useful local milestones. |
| `docs/adr-governance-audit/*` and `docs/semantic-lifecycle-audit/*` | Audits and design research. Their target architecture and migration sequences are inputs, not competing roadmaps. |
| `docs/comparative-analysis/*`, `docs/research/*`, `docs/frontier-*` | Research or audit records. Keep observed/inferred confidence and source anchors; promote only selected findings into this roadmap or an ADR. |
| `README.md`, `docs/README.md`, operator guides, MCP guides | User-facing references. They must point to this roadmap and carry command/version assumptions; they are not planning authorities. |
| ADR files and registries | Remain authoritative for accepted decisions. This document never changes ADR status or rewrites an ADR’s rationale. |

No document is deleted merely because it is old. Deletion requires a generated-index or evidence-retention decision and a replacement link. The next documentation cleanup should be small, mechanical commits: add headers, add successor links, and close contradictory status claims.

## Definitive 1.0.0 roadmap

Each phase advances only after its gate passes on a clean, committed revision. A phase may land in several commits, but every checkbox below is intended to be a reviewable commit or a narrowly coupled commit pair. The listed commands are the repository’s required lanes; `bun run build` and `bun run tests:typecheck` are mandatory whenever source or tests change.

### Phase 0 — Make the corpus governable

**Outcome:** one discoverable document system whose status claims can be checked against history and generated inventories.

Deliverables:

- Add a docs metadata validator and a machine-readable artifact inventory covering `decisions/`, `docs/`, `audit/`, `artifacts/`, skills, and package-facing Markdown.
- Add successor links and “sequencing superseded” banners to `ROADMAP.md`, `docs/roadmaps/README.md`, and the principal handoff/plan documents.
- Split observed, inferred, target, and unavailable language in the token, MCP, self-hosting, TUI, and comparative baselines.
- Add a release-document checklist to `docs/README.md` and link this roadmap from the root README and operator guide.

Commit-level todos:

- [x] `docs: add durable artifact metadata schema and validator` — schema, validator, and focused tests landed in `56f3de77`; it checks ordered headers, kind/status vocabulary, local Markdown links, and successor references. Missing legacy headers remain distinct from malformed classified documents pending broader classification.
- [x] `docs: inventory and classify durable corpus` — generator and inventory landed in `29dc04c4`/`ecc598e0`, then refreshed at integrated HEAD in `d1fdcf8d`. `bun run docs:inventory:check` passes at this roadmap's as-of revision with 1,430 items. Inventory metadata does not itself prove that every artifact's declared lifecycle is semantically correct.
- [x] `docs: mark superseded planning sequences and link canonical 1.0 roadmap` — `ROADMAP.md`, `docs/roadmaps/README.md`, the tracked top-level roadmap briefs, and handoffs now carry dated supersession or historical disposition notes linking the canonical roadmap. The handoff template is excluded because it is a template, not a live plan or handoff.
- [x] `docs: refresh operator entry points for roadmap and evidence boundaries` — `README.md`, `docs/README.md`, and `docs/operator-guide.md` link this roadmap; `docs/README.md` has the release-document checklist (commits `3e8b17d7` and `bca10776`).

Quality gate to advance: the validator reports zero malformed headers, unresolved successor links, contradictory status vocabulary in the canonical planning set, or unclassified active roadmap items; `bun run build`, `bun run tests:typecheck`, and `bun run test:all` pass; the inventory is reproducible twice from the same commit.

**Gate status at `3c828333` (2026-09-22): NOT PASSED.** `bun run build` and `bun run tests:typecheck` passed; the Bun-native OpenTUI lane passed 66/66; and the blocking anti-stub scan reported zero weak Rule 4 and zero untriaged findings. The first full `bun run test:all` result was 4 failing tests, 8,839 passing, and 1 skipped. The four failures were: the empty-store claim-ledger failure-mode test unexpectedly accepted an empty store; committed store-freshness evidence was stale; the determinism baseline lacked measurements for nine seams; and the reachability communication proof failed on 17 exported symbols without evidenced production callers. A later run from a docs-only worktree at the same source revision reported those four failures plus one live-session paint assertion (5 failed, 8,838 passed, 1 skipped); the paint assertion passed on a focused rerun. These are observations bound to the cited revision and date, not standing claims about later revisions.

**Update at `93da8339` (2026-09-23): NOT PASSED.** Two of the four `3c828333` failures have fix commits: the claim-ledger failure proof now injects a real violation (`3ed4b0c2`), and the communication reachability proof assertion is scoped (`1e0f516b`). `gate:reachability` passes at `9fba5974`. `evidence:rebind` had failed since `4dee3523`, because `arbor liveness` aborted in a cwd without `decisions/`. That was fixed in `c8fc80e7`, and the stores were rebound in `9aebf514`. Determinism remains unmeasured. The stop tier's only remaining failures are the operator-owned `gate:decision-queue`/`gate:vi-findings` triage of `vi:09a11e41a63c075b`. The full `test:all` lane was not rerun for this note. 29 of the 32 commits since `3c828333` touch governed paths without an `ADR:` trailer, because the workstation's global `core.hooksPath` commit-msg hook did not chain to `scripts/hooks/commit-msg`. `gate:adr-trace` still passes. The global hook was fixed to chain the guard the same day.

Evidence rebinding was not completed at `3c828333`. An earlier `evidence:rebind` attempt recorded at `4dee3523` (2026-09-22) failed on reachability findings; no rebind was completed at `3c828333`, and no evidence-store hashes were manually changed. Determinism measurement is a separate operator action under ADR-034 and was not run. Re-run the source-bound evidence chain and required gates after the relevant source and caller work is committed; this note does not certify either gate.

**Documentation gate update at `7ccbdd94` (2026-09-23): NOT PASSED.** The
tracked inventory was stale after the release-readiness, operator-journey, and
release-boundary edits and requires a final generated refresh. The strict
metadata command (`bun run docs:metadata -- --require-headers`) reports 48 of
49 canonical planning documents unclassified; only this roadmap currently has
the standard metadata block. The new release-readiness snapshot and operator
runbooks are classified and validate individually. The canonical planning set
still needs a source-reviewed classification pass, and no current full-suite
result is asserted here.

### Phase 1 — Measure the real baseline and finish the release contract

**Outcome:** 1.0.0 claims are bounded by a release matrix rather than feature inventory.

Deliverables:

- Define the 1.0.0 acceptance matrix across native campaign, MCP, CLI, WebUI, TUI, recovery, adoption, evidence, and self-hosting.
- Replace stale prose counts with generated facts and record the exact commit, provider/model, environment, and command for every live claim.
- Establish a representative external-repository cohort: JavaScript, Python, and one compiled-language repository, each pinned to an exact revision and native acceptance command.
- Preserve failure artifacts for every expensive run and distinguish harness, repository, provider, and capture failures.

Commit-level todos:

- [x] `test(release): add revision-bound 1.0 acceptance manifest and checker` — the checker, README, and unbound template are tracked under `docs/release-acceptance-1.0.0/`; no candidate-bound `release-acceptance.json` is present. The implementation of the checker does not prove any domain.
- [ ] `docs(evidence): publish fresh native and external baseline records`.
- [x] `fix(capture): preserve failed campaign evidence and expose failure class` — `0cfa2cfb`, `e9906f11`, `df049399`, `9f6a2d65`. Not yet exercised on a real failed expensive run.
- [ ] `docs: reconcile release-readiness and self-hosting claims to baseline`.

Quality gate to advance: the manifest validates against the current commit; all required local lanes pass; at least one external cohort completes a real patch, verification, adoption, and restart/cancellation scenario; every failed run leaves inspectable evidence; no release claim depends on an uncommitted path.

**Current disposition at `ebb7a52b` (2026-09-23): NOT PASSED.** The manifest
template has ten domains, each initially `unavailable`; there is no
candidate-bound `release-acceptance.json`, and no fresh candidate-bound
self-hosting or external-cohort record is present. `docs/release-readiness.md`
is explicitly a historical snapshot at `466a2fe`; the dated self-hosting
blocker report is not current release evidence. Keep each domain `unavailable`
until its independent producer records evidence bound to the exact candidate.
This is a release-evidence gap, not a claim that the underlying feature is
absent.

### Phase 2 — Token economy, caching, and context efficiency

**Outcome:** token and cache reductions are measured, attributable, reversible, and quality-preserving.

Deliverables:

- Add per-turn context fingerprints and suppression of unchanged tool results, keyed by session, path/revision, purpose, and operation class.
- Separate fresh input, output, cache-read, and cache-write tokens in budgets and projections; surface unpriced cost explicitly.
- Add bounded tool-schema loading by route and revision, stable-prefix measurements, compaction thresholds/cooldowns, and one-shot overflow retry.
- Run paired held-out retrieval and economy experiments; promote only eligible non-inferior results as required by `docs/token-economy-architecture.md`.

Commit-level todos:

- [x] `feat(economy): add context fingerprints and duplicate-read references` — `c46f88eb` (+ unsquashed `fixup!` `4c5f94c1`) in `packages/arbor-harness/src/native-worker.ts`. The phase gate's ≥50% duplicate-read reduction has not been measured.
- [ ] `feat(budget): enforce prospective fresh/cache input-output accounting`.
- [x] `feat(tools): add route-scoped schema loading and manifest cache` — `da63628b`, `9caaa6cc`. The bounded manifest/cache contract and role/skill-filtered composition path are covered by harness and executor tests; empirical token savings remain unmeasured.
- [x] `feat(compaction): add thresholded, observable, one-shot overflow recovery` — `4814aca3`, `771c3d25`, `bb0db7a7`, `b5e7b2d6`, `c5525e66`. Provider-confirmed overflow triggers one forced evidenced compaction and one same-turn retry; session projections retain content-free outcomes. Runtime quality gates remain deferred to session end.
- [ ] `eval(economy): add paired held-out cache/retrieval cohort and promotion report`.
- [ ] `docs(economy): record priced coverage, p50/p95 cache reads, and no-progress cost`.

Quality gate to advance: duplicate repeatable reads fall by at least 50% on the baseline cohort; p95 cache-read tokens and no-progress high-cost spans are reported; priced-cost coverage is at least 95% or explicitly marked unavailable; promoted policies reduce effective tokens by at least 20% with no statistically significant loss in right-for-right-reasons, verification, adoption, or false-acceptance bounds; all cache invalidation tests pass for writes, patches, shell, and external operations.

### Phase 3 — MCP, skills, and tool use as one governed economy

**Outcome:** agents see the smallest capability surface that can complete the task, with protocol breadth and authority preserved.

Deliverables:

- Complete MCP conformance for discovery, version negotiation, list-change rediscovery, bounded frames, elicitation, resources/templates, cancellation, and typed errors.
- Make tool catalog, runtime catalog, skill descriptors, and capability tiers derive from one revision-bound source; detect drift mechanically.
- Make skills multi-file, operator-authored, reduction-only bundles with declared inputs, tools, budgets, provenance, and tests.
- Add per-call tool annotations (read-only, repeatable, mutating, destructive, open-world), session ownership, and compact references for repeated results.

Commit-level todos:

- [x] `test(mcp): add protocol conformance matrix and failure fixtures` — `9a457fdf`, with version-negotiation/resource-error fixes in `04ab5780`. Covers stdio only; other transports are not yet covered.
- [x] `refactor(catalog): derive MCP/runtime/skill indexes from one manifest` — `b04c778f`, `bcb0f831`, `6193d328`, `ead7d48c`, `e707b855`, `016a4e75`, `6b31c3d8`, `c5112cda`. Core owns the revision-bound runtime, risk, skill, role, model-tool, tier, and MCP-operation declarations; MCP and prompt catalogs project them while executable handlers and schema bodies remain local. Runtime quality gates remain deferred to session end.
- [ ] `feat(skills): enforce reduction-only bundles and descriptor provenance`.
- [ ] `feat(mcp): add session identity, resource templates, cancellation, and typed refusal projection`.
- [ ] `feat(tools): add operation annotations and repeated-result references`.

Quality gate to advance: conformance passes over stdio and every supported transport; catalog parity is zero-drift; every skill can only remove authority in a property test; unauthorized and stale-session calls fail closed with a remedy; repeated read results are bounded and linked to their source evidence; `bun run test:all` and test typecheck pass.

### Phase 4 — Robust, non-intrusive governance and code quality

**Outcome:** governance catches unsafe or unsupported claims while allowing ordinary agent progress through a clear, cheap recovery path.

Deliverables:

- Measure gate latency, refusal rate, false-veto rate, operator intervention count, recovery success, and time-to-next-action by task cohort.
- Make every refusal typed, attributable, actionable, and visible at the actor that can correct it; keep advisory observations distinct from blockers.
- Reconcile store freshness, evidence binding, capability scope, branch accounting, and merge-critical properties at session close and push boundaries.
- Fix high-confidence quality/performance defects surfaced by audits: repeated reads, unpriced costs, stale projections, narrow-terminal layout, startup diagnostics, and process-death recovery.

Commit-level todos:

- [ ] `feat(eval): add governance-friction and false-veto measurements`.
- [ ] `fix(gates): project one typed remedy to the corrigible actor`.
- [ ] `test(governance): add adversarial bypass, stale-evidence, and composition-property fixtures`.
- [ ] `perf(runtime): measure startup, event-fold, projection, and persistence budgets`.
- [ ] `fix(recovery): close real process-death, lease-contention, and stale-projection paths`.
- [ ] `fix(tui): close narrow-terminal, focus, wrapping, and discoverability gaps from live runs`.

Quality gate to advance: no silent refusal or unnameable stop remains; p95 gate overhead is below 5% of task wall time on the baseline cohort; false-veto rate is below 2% on valid tasks; every blocked action displays the correcting actor and next command; kill/restart and concurrent-writer tests pass; no new type, lint, coverage, or reachability regression is introduced.

### Phase 5 — Usable product and release hardening

**Outcome:** a new operator can install, understand, supervise, recover, and adopt work without memorizing internal governance vocabulary.

Deliverables:

- One guided onboarding path from install to first offline campaign to provider-backed run, with diagnostics and recovery inline.
- Consistent TUI, WebUI, CLI, and MCP terminology, status, focus, keyboard/mouse behavior, narrow-terminal rendering, transcript summaries, and screen-reader-friendly text exports.
- Real self-hosting and external cohort runs through cancellation, clarification, critic rejection, retry, restart, and adoption; retain sealed evidence and media only for verified outcomes.
- Remove or clearly label dead, deferred, or provider-specific surfaces; document security, licensing, clean-room, and deployment limits.

Commit-level todos:

- [x] `docs(ux): publish one guided operator journey and recovery decision table` — [operator journey](operator-journey-1.0.md). This closes the documentation deliverable only; cross-surface UX fixtures, provider-backed runs, and Phase 5 release gates remain open.
- [ ] `test(ux): add cross-surface terminology, narrow-terminal, and keyboard journey fixtures`.
- [ ] `feat(selfhost): run the revision-bound native campaign acceptance cohort`.
- [x] `docs(release): publish clean-room, security, licensing, and deployment boundaries` — [1.0.0 release boundaries and checklist](release-boundaries-1.0.0.md). Candidate-specific reviews and artifacts remain required.
- [ ] `chore(release): generate 1.0.0 checklist, changelog, and sealed evidence index`.

Quality gate to advance: fresh install reaches a verified adopted result in the documented quickstart; the same lifecycle is understandable across TUI, WebUI, CLI, and MCP; three external language cohorts pass the acceptance matrix; restart/cancellation/recovery and failure-preservation proofs pass; clean-room and secret scans pass; the documentation validator, build, test typecheck, full test lanes, and release checklist all pass on the exact candidate commit.

**Current release disposition at `43229b83` (2026-09-23): NOT READY.** The
candidate-bound manifest and external-cohort records are absent. The operator
journey and release-boundary checklist are now documented, but documentation
does not satisfy the live acceptance domains or phase gates. Treat release
readiness as unavailable until the checklist's exact-candidate evidence is
produced and reviewed.

Revision 6 closes only the Phase 5 documentation todo because
[`operator-journey-1.0.md`](operator-journey-1.0.md) now contains the guided
task flow and recovery decision table. Cross-surface fixtures, provider-backed
cohorts, and the Phase 5 quality gate remain open.

## 1.0.0 release gate and change control

The release candidate is the exact commit that passes every phase gate. A later commit invalidates the candidate until the affected gate is rerun. A roadmap task may be re-ordered only by editing this document with a revision increment, a reason, an evidence pointer, and an explicit impact on dependencies or gates. New architecture requires an ADR; new empirical claims require an evidence record; new user-facing behavior requires a runbook or guide update. A phase cannot be marked complete from code presence, a green unit test alone, or an attractive demo.

The minimum release command set is:

```bash
bun install --frozen-lockfile
bun run build
bun run tests:typecheck
bun run test:all
```

The release record must also include the documentation validator, the revision-bound acceptance manifest, the economy report, MCP/skill/tool parity report, governance-friction report, external cohort evidence, and the sealed failure-preservation check. If a check is unavailable in the hosting environment, the record says `unavailable` with the reason and a compensating local test; it is never represented as zero or silently omitted.

## Open issues carried into the plan

The review found no basis for claiming that all frontier behavior, hosted enforcement, provider quality, or remote transport is complete. Specific unresolved work is now represented by the phases above: provider-specific cache controls; empirical held-out economy results; full MCP server/session transport breadth; external-language self-hosting; OS and remote-worker deployment hardening; organizational branch protection; and the remaining TUI/operator UX observations. These are release work or explicit non-goals, never implied capabilities.
