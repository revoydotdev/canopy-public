# revoy2 Release Readiness

Artifact kind: audit
Status: historical
Revision: 2
As-of commit: 466a2fe (2026-08-16)
Authority: dated release-readiness snapshot; it does not authorize a current release claim
Evidence scope: mixed — historical observations and release requirements at the stated revision
Supersedes: none
Superseded by: [the canonical 1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md)
Owner: Canopy/revoy2 maintainers
Review trigger: each release candidate or material change to a listed command, gate, or compatibility claim

This is a historical snapshot. Its compatibility table, percentages, CI job
inventory, and implementation descriptions are not re-verified for the current
tree. The canonical roadmap owns current sequencing. A 1.0.0 release decision
requires a candidate-bound manifest and evidence for every required domain;
the tracked `manifest.template.json` is unbound and is not release evidence.

**Status:** rolling release note, reconciled 2026-08-16 against `master` at
`466a2fe`. This document records the checked-in release contract and current
implementation boundary; a release candidate still requires the commands in
§1 and §8 to pass on its exact commit. Bun is the primary package manager and
runtime. Node 22 remains an intentional secondary runtime for the Vitest worker
paths that the repository explicitly launches under Node.

This document is the release report for ROADMAP Phase 5.3. It records test,
typecheck, and build results, coverage, the CI/gate inventory, the
compatibility matrix, known limitations, and migration instructions. It is
deliberately blunt about what is **not** shipped — see §5 and §7.

## Five-minute operator smoke path

The supported first-run command is intentionally bounded and offline:

```bash
node ./packages/arbor-mcp/bin/arbor-mcp.mjs run --once --executor deterministic --persistence-dir .arbor/quickstart
```

It uses the real CLI/TUI/runtime composition and writes a durable local trace,
but it does not call a provider or claim verified work. It is a smoke path, not
a release gate and not a substitute for §1's `bun run test:all`. See
[`five-minute-quickstart.md`](five-minute-quickstart.md) and the
[`five-minute deterministic campaign`](../examples/campaigns/five-minute-deterministic.md).

The scripted tree-search/linear comparison is likewise a regression evaluator,
not evidence of operational advantage. Its runnable, provider-free report path
and interpretation boundary are in [`evaluation-guide.md`](evaluation-guide.md);
the proposed real-task scenario matrix and acceptance thresholds are in
[`research/operational-advantage-evaluation.md`](research/operational-advantage-evaluation.md).

---

## 1. Test results

**Required for the release candidate:**

```bash
bun run test:all
```

- Vitest (including its coverage contract) and the Bun-native OpenTUI proof
  must both pass. Exact test and file counts are deliberately not recorded here
  (see §8's note); the command above is the current source of truth.

This total includes everything the wave-5 snapshot counted (Phase 5.2
conformance/scale suites, the ADR-019 user-interview stack, NodeCard/
capability-routing/compaction tests, the DevTools inspector suite) plus
substantial wave 1–3 additions: the campaign-loop-as-supervised-job roundtrip
suite (ADR-026), the TUI tasks/campaigns/diagnostics screen-contract repairs
(G-31) and read-side wiring (G-32), the repo-instructions scope (G-10), the
config env-override provenance and `kb.backend` wiring (G-07/G-11), the 6.6
LoopExecutor contract-conformance suite and its scanner-robustness
regression tests, the 6.3 roundtrip-shape hardening tests, and the 6.5 Rule 5
(tautological-test) unit tests, and the `@arbor/governance` control-plane
suites (ADR-027). The prior baselines (779/70 … 1465/125 … 1638/135) are
superseded. See `ROADMAP.md`'s Verified gap register for row-by-row evidence
of what each addition actually closes.

Do not infer a result for a later commit from this historical inventory; record
the command output with the release candidate.

---

## 2. Typecheck and build

```bash
bun run typecheck   # alias for `tsc --build` — never `tsc --noEmit` at root (see G-19)
bun run build       # tsc --build (declaration/project-reference build)
bun run gate:typecheck-tests  # G-23 — type-checks packages/*/tests/** too (build excludes it)
```

`bun run build` and `gate:typecheck-tests` are required release gates. Their
result must be recorded against the exact release candidate rather than copied
from an earlier integrated-tree run.

`tsc --noEmit` at the repo root type-checks **zero files** (the root
project is `"files": []` with project references, which `--noEmit` does not
traverse) and must never be treated as a gate — this was itself a
documented-but-false safeguard until wave 5 (G-19), fixed by aliasing
`typecheck` to `tsc --build`. `tsc --build --noEmit` is not an alternative
(TS6310: composite projects may not disable emit).

---

## 3. Coverage

**Full-repository coverage (2026-08-04, wave 3, v8 provider, all
`packages/*/src/**/*.ts`, matching `vitest.config.ts`'s enforced glob):**

```bash
bun run gate:coverage   # vitest run --coverage, enforces the thresholds below and runs in CI
```

| Scope | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| **All files (repo-wide floor)** | **90%** | **80%** | **95%** | **90%** |
| arbor-audit/src | 88% | 85% | 97% | 88% |
| arbor-config/src | 97% | 91% | 100% | 97% |
| arbor-core/src | 96% | 84% | 97% | 96% |
| arbor-eval/src | 92% | 87% | 91% | 92% |
| arbor-gate/src | 100% | 100% | 100% | 100% |
| arbor-kb/src | 96% | 85% | 100% | 96% |
| arbor-mcp/src | 84% | 78% | 91% | 84% |
| arbor-opencode/src | 94% | 84% | 97% | 94% |
| arbor-prompts/src | 100% | 98% | 100% | 100% |
| arbor-tui/src | 95% | 75% | 96% | 95% |

These are `vitest.config.ts`'s checked-in, **enforced** per-metric,
per-package thresholds — the honest current measured value floored to a
whole percent, not the aspirational 85%, per the "never lower a bar
silently" rule. A live `bun run gate:coverage` run at the prior measurement
repo-wide **90.58% / 80.82% / 95.18% / 90.58%** (stmts/branches/funcs/lines),
comfortably clearing the floors above; treat the table as the load-bearing
gate contract and any prose percentage (here or elsewhere) as a point-in-time
observation that can drift slightly run to run.

**Corrected this wave:** the wave-5 snapshot of this document reported
`arbor-tui` branches as the weakest package at 75.06% and `arbor-mcp` at
77.71%, using a coverage-reporter rollup that (per `vitest.config.ts`'s own
header comment) does not include `arbor-tui/src/screens/**` in the number it
displays, even though the enforced threshold glob (`**/*.ts`) does. The
combined, threshold-scoped figure for `arbor-tui` is 75%, still its floor
today, but the `arbor-tui`-vs-`arbor-mcp` "weakest package" framing in the
old text should not be read as precise — cite the `vitest.config.ts` table,
not a reporter rollup, when precision matters. `arbor-mcp` and `arbor-tui`
both remain below 85% branches; **`arbor-mcp`'s coverage is under active
work by a concurrent wave-3 lane** — re-verify this table against the
integrated tree's actual `vitest.config.ts` before citing exact figures.

**Wired into CI this wave (commit `3241a13`):** the thresholds above existed
in `vitest.config.ts` since wave 5, but nothing in CI ever ran `vitest run
--coverage` — a safeguard that was documented but not enforced, worse than
no safeguard because it created false confidence. `coverage-floor-gate` now
runs it on every push/PR.

---

## 4. CI and gate inventory

`.github/workflows/ci.yml` runs on every push and pull request, fourteen named
jobs. The build/test lane also runs the Bun-native OpenTUI proof:

| Job | What it runs | Strength |
|---|---|---|
| `build-test-gate` | `bun run build`, test type-checking, `bun run test:all`, reachability, lockfile | REPORTED |
| `anti-stub-lint` | `bun run gate:anti-stub:blocking` (blocks untriaged findings) | REPORTED |
| `contract-conformance`, `docs-truth-checker`, `obligations-gate`, `liveness-gate` | Dedicated contract, documentation, obligation, and liveness gates | REPORTED + DETECTED where behavioral |
| `vi-freshness-gate`, `static-integrity-gates`, `claim-ledger-gate`, `determinism-baseline-gate`, `completion-depth-gate`, `store-freshness-gate` | Governance-store freshness, static integrity, claims, reproducibility, completion-depth, and freshness checks | REPORTED |
| `eval-regression-gate`, `coverage-floor-gate` | Scripted evaluation regression and enforced coverage floors | REPORTED |

**No job here is BLOCKED in the strength-ladder sense** (ADR-025): `revoydotdev`
is on GitHub's free plan and this repository is private, so branch protection
returns 403 and nothing on GitHub's side refuses a merge or a direct push
past a red run. `bun run install-hooks` installs a local `pre-push` hook
running build plus nine blocking quality/freshness gates — real local
refusal, opt-in per clone, bypassable with `git push --no-verify` by design.
New untriaged anti-stub and completion-depth findings are included.

**Historical correction (2026-08-04, wave 3).** `ROADMAP.md`'s Phase 6.5 previously
claimed **BLOCKED** for the anti-stub rules. It does not deliver even
REPORTED today: the CI job runs `gate:anti-stub`, never the `--blocking`
variant (`gate:anti-stub:blocking`) the same script also exposes, so the job
always exits 0 regardless of findings — a dedicated gate that computes the
correct verdict but is configured to never turn CI red. 9 findings remain (2
genuine, 7 false positives on individual inspection — see `ci.yml`'s job
comment and `ROADMAP.md` §6.5 for the current breakdown). Retagged
**REPORTED** in `ROADMAP.md`. The baseline was subsequently triaged and both CI
and the local hook now fail on a new untriaged finding. This remains REPORTED,
not server-side BLOCKED, under ADR-025.

---

## 5. Compatibility matrix

| Surface | Status |
|---|---|
| MCP stdio server (14 tools: 12 bespoke + `arbor_command`/`arbor_query` exposing the canonical `RuntimeCatalogRouter` command/query surface — plus resources) | ✅ shipped |
| Web dashboard + SSE (`/api/stream`, campaign/kb/audit/telemetry endpoints, `/api/runtime/command` + `/api/runtime/query`) | ✅ shipped |
| CLI (`arbor run`/`serve`/`webui`/`tui`; `arbor demo` kept as an alias for `run`, wave 3) | ✅ shipped |
| **Repository Flight Director** (ADR-147) | 🟡 shipped as a repo-local, single-writer control plane with durable lifecycle, PID/start/boot identity, resource fencing, snapshot/quiescent gates, exact-effect approval closure, crash-safe dispatch, authenticated UDS operator CLI/Web APIs, and provider launch enrollment. Deployment strength is mechanically reported; raw same-user shell mutation and any provider lacking a composed mutation interceptor keep the profile below `enforced`. See `docs/repo-flight-director.md`. |
| **Campaign tree-search loop as a supervised job** (ADR-026, wave 1–3) | ✅ shipped — `job.submit` with `job_kind: "campaign.run"` genuinely drives the loop on every CLI transport (not just the former `arbor demo`); `campaign.halt`/`tree.interrupt` reach the live run via the job's own `AbortSignal`; **no auto-resume** — recovery after a halt/interrupt/crash stays operator-authorized per ADR-012 |
| **OpenCode plugin driving a campaign** | ❌ **not shipped.** `arbor-opencode/src/plugin.ts` (`arborPlugin`) has zero references to `job.submit`, `campaign.run`, or `runCampaign` — confirmed by direct search. The plugin registers agents/prompts/tools; it does not start a supervised campaign. An operator inside an opencode session driving `arborPlugin` cannot launch a campaign from there — only revoy2's own CLI/MCP/webui surfaces can, today. See ADR-026 §Consequences. |
| TUI cockpit | ✅ shipped — native OpenTUI rendering, keyboard/mouse selection, recovery controls, operator forms, approvals, and detail views are exercised through the real driver. `gate:tui-catalog-parity` records a disposition for every supported catalog entry; that does not imply a dedicated panel for every internal seam. |
| JSONL KB backend | ✅ shipped |
| SQLite KB backend | ✅ shipped and selectable end-to-end (wave 3, G-11 closed) — `createCliRuntime` now threads `arbor.jsonc`'s `kb.backend` (or `ARBOR_CONFIG__KB__BACKEND`) into `CampaignManagerOptions.kb_backend`; a real config edit genuinely selects `SqliteKbStore` on a live run |
| Conversation envelope + bus (4D.1/4D.2) | ✅ shipped — parent-child sessions add a canonical tree context, bidirectional initiation, expected-version CAS, metadata idempotency, bounded replay/restart restoration, capability redaction, evidence references, reply/correlation binding, and ledger-derived `pending`/`acknowledged`/`timed_out` delivery. Closed `request`/`response`/`notify`/`needs_attention` intent and explicit durable ack are internal semantics (ADR-039), not an A2A wire-conformance claim. No direct-thread push subscription is claimed. |
| NodeCard capability-addressable module (4D.3) | ✅ shipped — `loop.ts` builds a live card set every selection and routes through `selectNodeWithCard`, advisory by design (G-01 closed) |
| Foreground derivation (4D.4) | ✅ live specialist/critic dispatches re-derive a node-bound foreground; configured models and operator-authored modes/input/output bindings flow through the same composition path |
| Repo-instructions memory scope (4B.6, ADR-022) | ✅ shipped (wave 3, G-10) — `resolveRepoInstructions` walks a worktree for AGENTS.md/CLAUDE.md and injects a byte-budgeted section into root/plan-level agent prompts only, never the ledger |
| Ledger-backed siblings (4D.5) | ✅ bounded isolated `sibling.spawn` is cataloged and compensates failed post-branch setup with durable evidence-deficit recording; recovery remains ledger-backed. |
| A2A bridge (4D.6) | 🟡 configured local bridge plus an exact-version host-composed direct-thread profile — `a2a.send`/`a2a.receive`/`bus.*`/`sibling.status` dispatch, and `a2a.cards` publishes fresh live node cards only after configured signature and task-shape validation. The leg deliberately returns typed `unavailable` without `ARBOR_A2A_SIGNING_SECRET`; the direct-thread profile is limited to durable send/ack and does not expose discovery. Neither is a public transport claim. |
| Opt-in authenticated remote ingress (ADR-040/041) | 🟡 host-composed only — every accepted remote command has Ed25519 integrity, session/key/certificate binding, direct-edge or approval-role authorization, durable nonce replay protection, rotation/revocation, and operation/communication attribution. A bounded in-process loopback host consumes the typed envelope, but has no socket, port, listener, or default activation; it is not an HTTP, SSE, A2A, MCP, or OpenCode endpoint. |
| Compaction lifecycle (4D.7) | 🟡 durable operator-driven lifecycle machinery is reachable, but automatic structural folding is not shipped; the loop emits a typed skip rather than fabricating a completed lifecycle until it can capture real pre/post evidence and an anchor. |
| User-interview transition (4D.8) | ✅ shipped — the loop raises a real question whenever a specialist/critic signals `needs_input`, exercised by a real run (G-05 closed) |
| Palette/keymap/config grammar (4D.9) | ✅ shipped — `runTui` loads config/keymap at startup and drives a real `InputCatalog` (G-06 closed); canonical `formatBinding` carries parsed bindings across that boundary, while `config.get` identifies the checked-in JSON Schema and each leaf's real source (`default`/`file`/`env`/`ledger`-reserved/`injected`) via `ARBOR_CONFIG__*` env overrides. |
| Agent model configuration (`agents.*.model` in `arbor.jsonc`) | ✅ shipped — real executor tests prove `agents.<agent>.model` reaches specialist and critic dispatch, with explicit executor options retaining higher precedence. |
| Category model configuration (`categories.*.model` in `arbor.jsonc`) | 🟡 schema is present but has no runtime reader (G-35). Per-campaign foreground re-derivation is a separate open item. |
| Provider cost accounting (4B.7) | 🟡 the Hollow defect is closed — `token_usage`/`cost` are typed absence, never a fabricated zero — but the default (subprocess) executor still cannot recover real usage; the opt-in `--transport server` executor genuinely can (G-09 narrowed) but is unexercised by default and not covered by a live soak (see §7) |
| Evaluation harness as a release gate | ✅ CI wiring closed (wave 3) — `eval-regression-gate` runs the real CLI bin against a pinned baseline on every push/PR (G-12 fully closed); still explicitly a scripted-determinism check, never a live-model quality measurement (see its own job header) |
| DevTools inspector (Phase 4E, ADR-021) | ✅ shipped |
| TUI rendering system (Phase 4F) | 🟡 twelve of thirteen — the native renderer and content panes ship; comprehensive production inference/tool/diff capture still lacks full direct execution coverage. |
| Governed retrieval/index + descriptor adapters (4D.7a) | 🟡 capability-gated and reference-only — adapters may prepare owned context-artifact references and declarative descriptors; they cannot recursively delegate, grant tools, or silently apply an absent/declined result. The fixed no-tools declarative-subagent adapter and provider-free reference evaluator ship. The CLI additionally composes a controlled live-provider A/B evaluator when configured: two explicit durable partitioned corpus records, same-model fixed no-tools/read-only arms, exact-hash oracle, run-bound redacted evidence, and fail-closed absence. It establishes no broad empirical quality, safety, or generalization claim. |
| Governed overlay evaluation controls | ✅ controlled request path — Web and TUI project canonical eligible candidates, durable run status, and bounded redacted detail. They request the composed evaluator; a missing configured provider/corpus/measurement settles `unmeasured`. The controls never expose provider credentials, tools, raw scenarios, or raw provider traces; only measured canonical evidence may reach human promotion or independent quarantine. |

**Primary toolchain (recorded 2026-08-08; re-check for a release candidate):**

| Tool | Version |
|---|---|
| Bun | 1.3.14 |
| Node.js | 22.x (secondary runtime for explicitly Node-launched worker paths) |
| TypeScript | 5.9.3 (root `devDependencies` pins `^5.6.0`) |
| vitest | 2.1.9 |

Root `package.json` declares no `engines` field; all packages are
`"type": "module"`.

---

## 6. Known limitations

- **Full-repo branch coverage is 80% (floor), ~80.8% measured** — below the
  85% aspiration, honestly measured and enforced repo-wide plus per-package
  (Phase 6.9, wired into CI this wave). See §3.
- **The opencode plugin cannot submit a campaign.** ADR-026 ratifies the
  supervised-job deployment shape and explicitly rejects having the plugin
  *drive* a campaign (its Option B); the sanctioned path it names is for the
  plugin to *submit* a `campaign.run` job through the same `job.submit`
  authority. Neither exists today: `arborPlugin` returns only `config` and
  `dispose` hooks. An operator wanting to start a campaign from inside an
  opencode session cannot today. This is not closable by editing `plugin.ts`
  alone — `@arbor/opencode` does not depend on `@arbor/mcp`, and the
  `@opencode-ai/plugin` contract is not installed to verify against. See
  `docs/proposals/opencode-campaign-submission.md`.
- **No auto-resume.** A halted, interrupted, or crashed campaign job requires
  an operator (or automation acting on the operator's behalf) to notice and
  explicitly re-submit or run recovery — this is deliberate (ADR-012,
  ADR-026), not an oversight, but it is a real operational cost.
- **Two operator decisions remain open and are not code problems:**
  1. **BLOCKED-tier enforcement** (real platform merge refusal) requires
     either making this repository public or moving the `revoydotdev` org to
     a paid GitHub plan — ADR-025 names both routes and costs; neither is
     something a code change can grant.
  2. **Linux is the canonical full correctness/coverage environment.** The
     expensive build, full suite, reachability, and coverage lanes remain on
     `ubuntu-latest`. Focused Windows 11 and macOS Sonoma smoke jobs use the
     `revoydotdev` org's on-demand self-hosted VMs and exercise type-checking,
     CLI launch, subprocesses, setup/idempotent filesystem writes, and a
     bounded platform-safe contract subset. This detects host assumptions
     without tripling the full coverage workload; it is not a claim that all
     OS-specific behavior has exhaustive parity coverage.
- **Anti-stub findings are only locally triaged, not eliminated.** CI now runs
  `gate:anti-stub:blocking`, which blocks a new untriaged finding; the local
  pre-push hook still does not run this gate. Triaging is evidence for an
  exception, not proof that a residual finding is harmless.
- **Critic mandates are now strict and durable.** Both production transports
  reject partial/malformed five-mandate output, panel votes reconcile into a
  complete derived verdict, and restart/TUI roundtrip coverage proves it.
- **A2A remains a typed, configured bridge, not public transport.** Server,
  web, and TUI roots inject it only when `ARBOR_A2A_SIGNING_SECRET` is set;
  emitted cards and task projections validate at that boundary. It still lacks
  public endpoint hosting, peer PKI/TLS, discovery, and independently operated
  interoperability testing.
- **Provider-usage recovery is opt-in, not default, and unexercised live.**
  `--transport server` genuinely maps real token usage; the default
  subprocess transport structurally cannot. No live soak against a real
  `opencode serve` process has been run (would need real provider secrets,
  network egress, and tolerance for non-determinism — an explicitly
  non-blocking, secrets-gated workflow if built, never a required PR check).
- **Learned/regression scoring is deferred** until the eval harness produces
  data justifying a replacement for the accepted UCT scorer.
- **Surveillance fifth-gate decision deferred:** surveillance ships as a
  non-blocking audited monitor (ADR-013); whether it becomes a blocking gate
  is left to a future ADR.
- **Remote ingress is not public transport.** The present loopback host is
  in-process only. The following deployment controls are explicit external
  prerequisites, not shipped capability:

  | prerequisite | accepted default / current disposition |
  |---|---|
  | Channel binding | No listener. If authorized: mTLS for service peers or DPoP for clients that cannot hold certificates; select one binding for the first deployment. |
  | PKI and credential lifecycle | Operator-owned CA or managed workload identity must issue, rotate, and revoke credentials. Local session enrolment is not PKI. |
  | Key custody | KMS/HSM-equivalent production custody; disk keys only for local development. |
  | Resource and spend control | Add typed per-peer request/storage quotas before a listener; a provider-enforced currency spend cap needs a named external owner. Current byte/in-flight bounds are not a quota program. |
  | Replay and confidentiality | Atomic shared replay storage and encrypted authenticated channel are required for multi-host deployment; the current durable local nonce state is not a distributed design. |
  | Security review | Named independent reviewer, threat-model artifact, and adversarial authorization/replay/restart/resource report before advertising any listener. |
  | Merge enforcement | The repository remains REPORTED: private/free-plan branch protection is unavailable, and local hooks are bypassable. Real BLOCKED requires an operator to fund/configure a protected platform path under ADR-025. |

  These prerequisites also apply before public A2A discovery or an external task
  round-trip. See `docs/research/waiver-decision-brief-2026-08.md`; none is
  supplied by ADR-040/041.
- **External A2A capability is provider-gated.** The composed A2A bridge
  remains typed `unavailable` without `ARBOR_A2A_SIGNING_SECRET`; a real
  provider-backed roundtrip additionally requires a provisioned peer and its
  authenticated transport. This repository does not claim either as shipped.

---

## 7. Migration instructions

- **JSONL → SQLite:** select the backend via `arbor.jsonc`'s `kb.backend`
  (`"jsonl" | "sqlite"`, now genuinely read end-to-end, G-11) or the
  `ARBOR_CONFIG__KB__BACKEND` environment override (G-07). Both validate and
  preserve all provenance variants.
- **Legacy unwitnessed rows:** startup excludes them with diagnostics;
  `saveKBProjection` is an exact-replacement operation that never merges stale
  rows back in. A remembered fact cannot exist without witnessed evidence.
- **Legacy entry-only KB files:** handled through an explicit migration and
  version path; never silently promoted.
- **Sealed snapshots:** KB streams use atomically sealed v1 hash-chain
  snapshots; tail truncation is detectable. See `docs/persistence-migration-guide.md`.
- **`arbor demo` → `arbor run`:** `demo` is kept as an alias (wave 3); no
  script relying on `arbor demo` needs to change, but new usage should prefer
  `arbor run` — it is the same code path every transport now uses, not a
  demo-only special case.

---

## 8. Release checklist

> **On counts.** This document no longer records exact test/file totals, by
> decision on 2026-08-06. Every document that carried one had drifted — 1465/125,
> 1638/135 and 1147/98 were all live in the repository simultaneously, each
> stale by a different amount, and this document's own figure was two
> generations behind. The count changes on every commit that adds a test, so a
> hand-maintained one is drift by construction. `bun run test:all` is the source
> of truth. The SUR-05 checker still recognises the `N tests / M files` shape,
> so a re-introduced hard-coded count is caught rather than accepted.

**Closed:**
- [x] Phase 5.2 conformance suites committed and green; invoke `bun run
      test:all` for current counts.
- [x] `bun run build` (`tsc --build`) clean; `gate:typecheck-tests` (G-23)
      clean across all 11 packages' tests. <!-- sur-05:historical — the package count at As-of commit 466a2fe -->
- [x] Full-repository coverage measured honestly, repo-wide, and **enforced
      in CI** (wave 3): floors at 90%/80%/95%/90% (stmts/branches/funcs/lines).
- [x] CI runs fourteen named jobs in §4 on every push/PR, including the
      Bun-native OpenTUI lane and governance integrity gates.
- [x] The gap register (`ROADMAP.md`'s Verified gap register) is reconciled
      against source, not against prior wave reports, as of this document's
      date — see that document for the full per-gap verdict table.
- [x] G-07 (per-knob config provenance), G-10 (repo-instructions scope,
      ADR-022), G-11 (`kb.backend` threading), G-31 (TUI tasks/campaigns
      screen contracts) closed this wave; G-32 (TUI read-side wiring)
      narrowed to three residual screens.
- [x] The campaign loop is a supervised job on every CLI transport
      (ADR-026), not just `arbor demo`'s private driver.
- [x] Six defect-fabrication gaps closed: G-15, G-16, G-22, G-25, G-26, G-24.
- [x] G-17 (clean-room patent-sensitive surface) closed by deletion, wave 5
      — `hashline.ts`/`ops-edit.ts`/`ops-server.ts` no longer exist.
- [x] The governance corpus indexes <!-- governance:adr_total -->186 ADRs<!-- /governance:adr_total --> (ADR-001 through ADR-055, with ADR-045 reserved for a revoy-spec cross-reference).
      The obligation gate reports coverage and fails invalid proof citations;
      do not infer approval status or proof coverage from this checklist.

**Remaining blockers, reconciled 2026-08-16 against source and gates.**

- [ ] Bring repo-wide branch coverage to ≥85% (currently ~80.8% measured, 80%
      floor enforced; `arbor-mcp` and `arbor-tui` are the weakest packages —
      see §3). `opencode-server-executor.ts` specifically moved
      74.00%/74.76% → 87.22%/81.39% (lines/branches) on 2026-08-06.
- [x] The anti-stub and completion-depth baselines are fully triaged; CI and
      the local pre-push hook block new untriaged findings.
- [x] G-36: `review()` session-creation failure is hermetically exercised in
      `packages/arbor-mcp/tests/loop-executor-contract.test.ts`; it fails
      closed and returns typed unavailable token usage rather than approval or
      a fabricated zero-token record.
- [ ] A live provider-usage soak for the server-transport executor (G-09's
      remaining half) — deliberately **not** a PR gate; it needs provisioned
      secrets, the `opencode` binary, and network egress.
- [ ] No way to **submit** a `campaign.run` job from inside an opencode
      session. Note the precise claim: the plugin *driving* a campaign is
      Option B of ADR-026 and is explicitly rejected, so this row is not a
      request to implement that. Two structural obstacles, both confirmed at
      `c6feed8`, mean this cannot be closed by editing `plugin.ts` alone:
      `@arbor/opencode` does not depend on `@arbor/mcp` (the edge runs the
      other way), so the plugin cannot import `job.submit` without inverting
      it; and `@opencode-ai/plugin` is an uninstalled optional peer
      dependency, so `ArborHooks` is a hand-written mirror of a contract this
      repository cannot verify. See
      `docs/proposals/opencode-campaign-submission.md`, which also names the
      conflict with ADR-061's intent to delete this package.
- [x] The ten capability waivers ADR-028 left standing are resolved; both
      halves were decided, not deferred. The **six `capability-token`
      exports** were closed by deletion — `packages/arbor-core/src/capability-token.ts`
      and its test were removed in commit `01203d5` (2026-08-08, -141/-80
      lines) and neither file exists. The **four action-class exports** are
      genuinely wired: `enforceAction`, `entitledActionClasses`,
      `requiredCapability`, `ACTION_CLASSES` and `isMutating`
      (`packages/arbor-core/src/capability.ts`) each have a real production
      consumer beyond the barrel — `arbor-mcp/src/runtime-catalog.ts`'s single
      authorization point (`denialReason`, line ~2069) and
      `arbor-mcp/src/arbiter-intake.ts`. `scripts/reachability/allowlist.json`
      correspondingly holds **zero** capability entries. Verified at
      `fef234d`; this row asserted an open delete-or-build decision for ten
      days after the deletion landed.
- [ ] The two standing operator decisions in §6 (BLOCKED-tier platform
      support; the CI runner choice) are not code problems and cannot be
      closed by an agent working in this repository. BLOCKED requires GitHub
      branch protection, which is unavailable to this private/free-plan setup;
      the local hook remains bypassable with `--no-verify`.
- [ ] Before exposing remote ingress outside a trusted host, provide the public
      transport/PKI/key-custody/replay-store prerequisites listed in §6 and
      independently review ADR-040. Until then it is intentionally opt-in and
      uncomposed.
