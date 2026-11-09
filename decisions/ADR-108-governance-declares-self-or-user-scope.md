# ADR-108: Governance Machinery Declares Whether It Serves This Repository Or Its User

**Status:** Accepted
**Date:** 2026-08-26
**Authoring Revision:** 886ad211a3762ac4580253056a2a39e6e909b0cc
**Content ID:** sha256:1d90976df5803dd1c61fb32ce110f7cd6f9f12199d255e51ca7467412e8726f5

## Context

The 2026-08-26 four-agent parity audit (revoy2 @ 5afc268f) found that a large share of this repository is machinery arbor runs on *itself* rather than capability a user of arbor gets for *their* repo. Two headline measurements check out exactly: `packages/arbor-governance/src` is 31 files, 6,034 lines; `packages/arbor-gate/src` is 2 files, 227 lines, and its exports (`checkAdmission`, `checkIsolation`, `checkEvidence`, `checkAudit`) run inside a user's campaign — `checkEvidence` does real claim-vs-evidence cross-referencing, not paperwork about this repo.

An earlier draft of this ADR measured the self/product split by whether a gate parses `--root` from its own `process.argv` (`classifyGateCatalog` in `packages/arbor-mcp/src/project-manage.ts`), and treated the resulting 86%-not-retargetable figure as the headline evidence. **That was a category error, corrected here rather than quietly dropped.** Retargetability answers a different question — can a gate be pointed at *another* checkout, the Roadmap 23/ADR-076 multi-project concern `enrollProject`/`manageProjects` own — not whether a gate's subject belongs to arbor or to a user. Arbor's primary deployment modes (TUI terminal, meta-harness driving opencode/claude/codex, IDE integration) put the user's repo in the position of the *host checkout itself*. A gate that always evaluates the host checkout is behaving correctly for that case, not parochially; `gate:reachability` lacking `--root` is evidence it was written for the normal case, not evidence it is self-scoped.

The distinction that actually determines scope is whether a gate's *subject* — the artifact it reads or writes — exists only in arbor's own tree, independent of argv shape. `gate:adr-registry` reads `decisions/registry.json`, a format that doesn't exist in a plain user repo; it is self-scoped because of that, not because it declines `--root` (it in fact accepts `--repo`). `gate:reachability` asks whether code is reachable, a question meaningful anywhere. Re-reading the 45 real `gate:*` scripts (46 in `package.json` minus `gate:all`) by this existence test gave **31 (69%)** whose subject is arbor's own governance format (`decisions/`, the gap register, `.claim-ledger/`, `.visual-intelligence/`'s stores, `execution-profile.json` itself, branch/worktree/registration bookkeeping) and **14 (31%)** whose subject is source code or a target repo's conformance profile, meaningful anywhere (`anti-stub`, `anti-stub:blocking`, `closed-enum-hygiene`, `coverage`, `determinism`, `eval-regression`, `hook-liveness`, `liveness`, `lockfile`, `project-conform`, `reachability`, `tui-catalog-parity`, `typecheck-tests`, `vi-reproducible`), **at drafting (2026-08-26, pre-backfill)**. This confirmed the audit's 70-80% estimate, conservatively. As of 2026-08-26 (post-backfill, four gates later — `gate:finalization-progress`, `gate:evidence-transaction-observability`, `gate:campaign-run-status`, `gate:projection-lifecycle`, all self-scoped), `scripts/execution-profile.json` carries 49 real `gate:*` entries (50 in `package.json` minus `gate:all`): **35 (71%)** self, 12 target, 2 both. The retargetability figure (6 of 42 classifiable gates parse `--root`) is kept only as a secondary fact about the multi-project path.

What happens when a self-scoped gate meets a repo with none of its subject artifacts was investigated directly, not assumed. Three gates were run against an empty scratch directory: `adr-registry.mjs verify --repo <empty>` accepts a repo flag and fails cleanly — `{"ok": false, "error": "ENOENT ... decisions/registry.json"}`. `decision-queue.mjs` has no `--repo`/`--root` flag at all; its `REPO_ROOT` is `resolvePath(dirname(fileURLToPath(import.meta.url)), "..")` — anchored to where the script *file* lives, never `process.cwd()`. Run with the working directory actually set to the empty scratch repo, it printed revoy2's own 117 open commitments verbatim — it did not fail, it silently reported on the wrong repository. `claim-ledger.ts` and `gap-status-gate.ts` resolve `REPO_ROOT` the same `import.meta.url`-anchored way, with no override. `branch-accounting.mjs` accepts `--repo`, but its own comment says why: "so this gate can be tested against a throwaway [repo]" — a test-only escape hatch. Three gates, three different behaviors, none of them a deliberate "not applicable, this repo has no ADRs" — chosen ad hoc per script, because nothing declares which repository a gate is even supposed to answer about.

`enrollProject` (`packages/arbor-mcp/src/project-lifecycle.ts:117`) sharpens this: it scaffolds `decisions/registry.json` content only for a brand-new project with no existing `package.json`; enrolling an *existing* target only creates the empty `decisions_dir` (`project-lifecycle.ts:246`), leaving the same ENOENT-producing state `adr-registry.mjs` failed on above. `classifyGateCatalog` keeps `adr-registry` out of the 6 gates `manageProjects` runs against enrolled paths, so this isn't reachable through enrollment yet — only by a human running a self-scoped gate against another root directly, which `adr-registry.mjs` and `branch-accounting.mjs` already permit.

Two supporting findings from the earlier draft still hold. `packages/arbor-governance/src`'s exports are parameterized, not hardcoded — `parseRecord` in `packages/arbor-governance/src/record/parse.ts`, `findSymbolAcrossRepo` in `packages/arbor-governance/src/obligation/proof.ts` both take content or a root as an argument; the package is not incapable of governing a user's repo, nothing currently points it at one. `PERSISTENCE_DIR/project-registry.json` (`PROJECT_REGISTRY_FILENAME` in `packages/arbor-mcp/src/project-registry.ts`, joined onto whatever `loadProjectRegistry` is given; `.arbor/` is this repo's own gitignored default) holds `{"schema_version": 1, "entries": []}` when it exists at all — the multi-project mechanism exists and is unused. And the declaration site already exists: `scripts/execution-profile.json`, validated by `loadExecutionProfile`, already carries a `contexts` object per gate plus, wherever a context is skipped, an `excluded_contexts` entry with a `code`/`detail`; `gate:execution-profile --verify` already fails when a gate has no manifest entry.

## Decision

**1. Every `gate:*` entry in `scripts/execution-profile.json` declares `scope: "self" | "target" | "both"`, assigned by the existence test, not argv shape.** `"self"` means the subject artifact only exists in arbor's own governed tree and the gate always evaluates the host checkout regardless of any `--repo`/`--root` it happens to accept. `"target"` means the subject is source code or a declared conformance profile, meaningful anywhere, whether or not a retargeting flag is wired (`gate:reachability`, `gate:closed-enum-hygiene`, `gate:determinism`, `gate:hook-liveness` all qualify despite having none). `"both"` covers a gate meaningful either way (`gate:lockfile`, `gate:typecheck-tests`). `classifyGateCatalog`'s `retargetable` verdict is an independent, secondary fact about the multi-project path, not part of this classification.

**2. `loadExecutionProfile` rejects a `gates` entry with a missing or unrecognized `scope`**, the same way it already rejects a `package.json` gate absent from the manifest. `gate:execution-profile --verify` already runs on every commit touching the file, so the ratchet needs no new gate, only a stricter check inside the one that already owns this manifest.

**3. A `scope: "self"` gate given a `--repo`/`--root` it does not honor, or run with a working directory outside its own installed tree, must fail loudly rather than silently report on the wrong repo or throw a raw filesystem error.** This responds directly to the investigated finding: `decision-queue.mjs`, `claim-ledger.ts`, and `gap-status-gate.ts` currently have no way to notice they've been pointed somewhere their subject doesn't live, and `adr-registry.mjs` reports a raw `ENOENT` instead of a clear "not applicable." The `scope` field gives a caller (a human, `gate-all.mjs`, a future `manageProjects` extension) a place to check before invoking the gate, so the fix is declaring the fact once rather than patching 31 scripts individually.

**4. `gate_id`s remain unchanged; no script is renamed.** A `gate:self:*`/`gate:target:*` naming convention was considered and rejected below.

**5. The 14 subject-generic gates get `scope: "target"` or `"both"`; the 31 arbor-only gates get `scope: "self"`.** This backfill is the ratchet's first exercise: every existing gate must classify before `gate:execution-profile --verify` can enforce the field on new ones.

This does not touch `packages/arbor-governance`'s internals, delete or rewrite any gate script, or change which gates run in which context. It adds one required field to a manifest that already exists and is already validated.

## Consequences

An operator can answer "how much of this is product vs. overhead" by reading `execution-profile.json`'s `scope` tallies instead of running an audit or, as this ADR's own drafting did, testing each gate against a scratch directory; the measured 69% becomes a live, gated fact instead of a one-time snapshot. A new `gate:*` script is forced to declare which repository it answers about at review time. Rule 3 closes a demonstrated hazard: a self-scoped gate pointed at the wrong repo today either throws a raw error or, worse, silently reports on arbor's own tree as if it answered a question about the repo in front of the user.

The cost: one required, review-visible decision per new gate, and the backfill (rule 5) is 45 judgment calls made once, several genuinely ambiguous — `gate:project-registry` is the discharge mechanism for target enrollment but is itself scoped to this repo's registry file; `gate:completion-depth`/`gate:entrypoint-reachability` run generic reachability analysis through a self-scoped findings store. This ADR commits to the field existing and to the verify gate refusing silence, not to a single correct answer for every hard case. It does not make any self-scoped gate retargetable, does not add loud-failure behavior beyond what rule 3 requires, does not enroll any project (`PERSISTENCE_DIR/project-registry.json` stays empty until an operator runs `arbor project enroll`), and does not claim `arbor-governance` has been made more general than it is. This is a labeling and call-site-safety decision, not a capability expansion.

## Alternatives / Roads not taken

**Classify scope by `--root`/`--repo` support, as an earlier draft did.** Rejected and named rather than silently corrected: `adr-registry.mjs` accepts `--repo` yet is unambiguously self-scoped by subject; `reachability.mjs` accepts no root flag yet is unambiguously target-scoped. Argv shape would have mislabeled both.

**A `gate:self:*`/`gate:target:*` naming convention instead of a manifest field.** Rejected: script names are also the CLI surface an operator types, and every reference to a gate — `execution-profile.json`'s own keys, `gate-all.mjs`, CI, prior ADRs — would need a rename. The manifest already exists and already holds `contexts`/`excluded_contexts`.

**Move self-scoped governance behind an internal package namespace.** Rejected on its own terms: `arbor-governance`'s functions are already root/content-parameterized — not internal in any type-level sense, only in that nothing calls them with another repo's root today. A namespace boundary would duplicate already-generic functions into a "real" external package or import across the boundary it just drew.

**Do nothing; leave this as a documentation-only audit finding.** Rejected: a ratio recorded in an audit snapshot is the "gap register vs. audit snapshot" trap this repo's own corpus already names — current the day it's written, stale the next time a gate is added. `gate:execution-profile --verify` already runs on every relevant commit; making it the enforcement point costs nothing new.

## Obligations

### O1 — The multi-project retargetability classifier this ADR treats as secondary evidence is real and runs against the live gate catalog

`classifyGateCatalog` reads `package.json`'s real `gate:*` scripts and returns a real `retargetable`/`not_applicable` verdict per entry — the 6/42 split cited as secondary evidence is this function's actual output. This demonstrates only that the retargetability axis is measured, not that it is the scope classification: `gate:adr-registry` is `not_applicable` yet unambiguously `scope: "self"`, and `gate:reachability` is also `not_applicable` yet unambiguously `scope: "target"`. That divergence is the category error this ADR corrects.

<!-- proof: symbol=classifyGateCatalog file=packages/arbor-mcp/src/project-manage.ts roundtrip=packages/arbor-mcp/tests/project-manage.test.ts -->

### O2 — A real, tested path for enrolling a user's target repository already exists, even though zero repositories use it today

`enrollProject` accepts an arbitrary `inputRoot`, inspects it, and stages a governance overlay for that path — real code with a round-trip test. `PERSISTENCE_DIR/project-registry.json` holds `{"schema_version": 1, "entries": []}`. This also grounds the Context finding that `enrollProject`'s decisions-content authoring fires only for a brand-new scaffold, not an enrolled existing repository, which is why enrolling a real target reproduces the same empty-`decisions/` state this ADR's investigation tested directly.

<!-- proof: symbol=enrollProject file=packages/arbor-mcp/src/project-lifecycle.ts roundtrip=packages/arbor-mcp/tests/project-lifecycle.test.ts -->

### O3 — `scripts/execution-profile.json` is the real, already-validated manifest the new `scope` field is added to

`loadExecutionProfile` parses and structurally validates the file today — schema version, every `package.json` gate present as an entry and vice versa, non-empty `gate_order` groups — and `gate:execution-profile --verify` already runs this as a gate. This demonstrates the file this ADR modifies is live and enforced; it does not yet demonstrate the `scope` field, which doesn't exist in the file as of this ADR.

<!-- proof: symbol=loadExecutionProfile file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/enforcement-control-plane.test.mjs -->

### O4 — `gate:execution-profile --verify` refuses a `gates` entry that declares no `scope`

<!-- proof: symbol=auditExecutionProfile file=scripts/enforcement-control-plane.mjs roundtrip=scripts/tests/enforcement-control-plane.test.mjs -->

`auditExecutionProfile` — the function `loadExecutionProfile`'s existing
validation path and `gate:execution-profile --verify` both run per entry,
alongside its `contexts`/`mutability`/`cost_class`/`required` checks — now
requires `entry.scope` to be one of `GATE_SCOPES` (`"self" | "target" |
"both"`), rejecting a missing or unrecognized value exactly as it already
rejects a package.json gate absent from the manifest. Proven by
`scripts/tests/enforcement-control-plane.test.mjs`'s "rejects a gates entry
with a missing or unrecognized scope" case (missing key, an unrecognized
string, and all three valid values). The backfill assigning `scope` to all 45
existing gates (rule 5) is outside this tranche's file ownership
(`scripts/execution-profile.json` belongs to the orchestrator this tranche);
until that backfill lands, `gate:execution-profile --verify` fails for every
existing gate by design — this is the ratchet Decision §5's Consequences
section names ("the backfill... is the ratchet's first exercise"), not a
regression. See the implementing session's report for the complete
self/target/both classification the orchestrator applies mechanically.
