# Roadmap 19 — Frontier protocol & harness alignment (2026-08)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 73fb8068 (2026-09-22)
Authority: Retained research-and-build brief; findings are inputs to ADRs or the canonical roadmap and are not implementation claims.
Evidence scope: mixed — dated 2026-08 literature/protocol sweep re-verified against code at authoring time (observed) plus build and do-not-build proposals (target); not re-run since
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22):** this brief is retained as design and implementation history. Its priorities and ordering are subordinate to the [Canopy/revoy2 1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md). Treat implementation and research claims as bounded to the evidence recorded in this brief; verify current status against code and sealed evidence before relying on them.

**Audience:** an implementing coding agent on a feature branch, and the integrator reviewing
roadmap 01 before it lands. Read `docs/roadmaps/01-mcp-client.md` §1–§2 and §8 first — the
invariants, read-list, and repo gotchas there apply unchanged. This brief **amends** roadmap 01
and adds four independent, smaller work items.

**One-line goal:** bring revoy2's external-protocol surface and its harness-quality claims into
alignment with the specifications and literature that actually govern them as of **2026-08-12**,
starting with a protocol-shape change that silently invalidates part of roadmap 01's acceptance
criteria.

**Provenance of this brief.** Two frontier research agents surveyed (a) MCP/ACP/A2A protocol
evolution and (b) agent skills, tool design, context engineering, and harness architecture. Every
paper either agent relied on was then downloaded and read in full by the integrator, and every
load-bearing specification claim was re-verified by direct fetch against the primary source. The
per-item evidence grade in §7 records which claims are spec-verified, which are single-study, and
which are weak — read it before treating any item here as settled.

---

## 0. What "done" means (acceptance, read first)

1. **W1 (P0):** revoy2's MCP client connects successfully to a `2026-07-28`-shaped server, and
   roadmap 01 no longer instructs an implementing agent to build a removed handshake as its
   acceptance criterion. `MCP_PROTOCOL_VERSION` is no longer a single pinned string compared by
   equality.
2. **W2:** `arbor_command`/`arbor_query` no longer inline the full `RUNTIME_CATALOG` kind list into
   their `tools/list` descriptions; a closed-catalog search surface replaces it, preserving the
   single-authority property `tools.ts` §"design principle" states today.
3. **W3:** ADR-018 and ADR-038 cite the published prior art they currently gesture at without
   naming, an uncommitted internal survey is no longer load-bearing as a citation, and one
   regression test asserts the specific failure mode that literature names.
4. **W4:** ADR-052's T1–T4 tier boundaries are checked against the published vulnerability-class
   data rather than only against internal reasoning, and ADR-052 moves Proposed → Accepted or
   records why not.
5. **W5:** `packages/arbor-eval`'s gate documentation records the known overestimation of the
   SWE-bench family, so no future quality claim rests on a raw Verified pass-rate.
6. Full suite green (`bun run build`, `bun run test:all`, `bun run check`); zero new runtime
   dependencies; every ADR touched follows the `ADR-PENDING-<slug>` convention in the roadmaps
   README (do not choose a number).

**Non-goals (do NOT build):** a `2026-07-28`-native MCP *server*; MRTR/elicitation adoption as
revoy2's own posture; the ADR-041 public listener (still deferred, see W1.4); a general
embedding-based tool retriever; any change to `critic_approved`'s accepted `Provenance` contract
without its own review cycle (see §6).

---

## 1. W1 — MCP client version negotiation (P0)

### 1.1 The finding

The canonical MCP specification pointer now serves **`2026-07-28`**, not `2025-11-25`. Verified by
direct fetch on 2026-08-12: the page's own schema link reads `schema/2026-07-28/schema.ts`, and its
"Key Details" section reads **"Stateless, self-contained requests"** and **"Per-request capability
negotiation"** where the prior revision read "Stateful connections" and "Server and client
capability negotiation."

This is a protocol-*shape* change, not a version bump. From the official changelog, fetched in full:

- **The `initialize` / `notifications/initialized` handshake is removed entirely** (SEP-2575).
  Every request now carries its version and client capabilities in `_meta`
  (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`).
  Version mismatches return `UnsupportedProtocolVersionError`.
- **A new `server/discover` RPC**, which servers **MUST** implement, replaces initialize-time
  capability exchange. Clients **MAY** call it first for up-front version selection, "or use it as
  a backward-compatibility probe on STDIO" — the spec names our exact fallback use case.
- **`Mcp-Session-Id` and protocol-level HTTP sessions are gone** (SEP-2567). Servers needing
  cross-call state mint their own opaque handles passed as ordinary tool arguments.
- **Roots, Sampling, and Logging are formally Deprecated** (SEP-2577) under a new feature-lifecycle
  policy with a minimum twelve-month window.
- Server-initiated `sampling/createMessage` / `elicitation/create` / `roots/list` are replaced by
  the **Multi Round-Trip Requests (MRTR)** pattern (SEP-2322): a server returns
  `resultType: "input_required"` with `inputRequests`; the client retries the *original* request
  with `inputResponses`. The `notifications/elicitation/complete` notification introduced one
  revision earlier is already removed.
- HTTP+SSE is reclassified Deprecated; SSE stream resumability and `Last-Event-ID` are removed.
- OAuth: Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents;
  `iss` validation per RFC 9207 is now a client **MUST**. The 2025-06-18 token-passthrough
  prohibition and resource-indicator rules are **carried forward unchanged** — that part of the
  in-repo research remains current and needs no correction.

### 1.2 Why this is P0 and not a version bump

`packages/arbor-mcp/src/mcp-client/contracts.ts:3` pins `MCP_PROTOCOL_VERSION = "2025-06-18"`, and
`mcp-client.ts:26-27` opens with `initialize` and then throws unless the server echoes that exact
string. Against a `2026-07-28` server the failure is not "version mismatch rejected" — it is that
**the first RPC the client sends is a method the server no longer implements at all.** The
connection sequence (`connect()` → `initialize` → await `capabilities.tools` →
`notifications/initialized` → `listTools()`) corresponds to no operation the current spec defines.

**The more consequential half:** `docs/roadmaps/01-mcp-client.md` is an in-flight implementation
brief that encodes this as acceptance criteria. Its §0.2 requires the agent to "perform the MCP
`initialize` handshake"; §1 sends the reader to
`https://modelcontextprotocol.io/specification/2025-06-18`; §5 steps 1–3 specify the
initialize → initialized ordering; §9 requires a test proving "handshake ordering enforced (call
before `initialized` rejected)". An agent implementing roadmap 01 as written today will correctly
and carefully build a removed protocol shape, and its tests will prove it works.

Note also that `docs/research/native-harness-primary-source-delta-2026-08-09.md` hardened the
`initialize`/`initialized` sequencing on 2026-08-09 — twelve days *after* `2026-07-28` shipped. Its
"Sources checked" list cites `2025-06-18` and `2025-11-25` and never reaches `2026-07-28`. This is
a genuine gap in the in-repo research, not a post-dated discovery.

### 1.3 The fix

Do **not** simply bump the constant.

1. Make `MCP_PROTOCOL_VERSION` a **bounded set of supported code paths with a preferred value**,
   not one string compared by equality. Both the legacy `initialize` negotiation and
   `server/discover` assume a client offers a version a server may decline.
2. Two connect paths behind a probe: attempt `server/discover` first; on `-32601` (method not
   found) or a connection-shape mismatch, fall back to the legacy `initialize` /
   `notifications/initialized` sequence already hardened by the 2026-08-09 delta work. This is
   exactly the "backward-compatibility probe on STDIO" the spec names.
3. **Scope discipline — this is where the work will try to grow.** revoy2 should *tolerate*
   whichever shape a peer server speaks. It should not become a `2026-07-28`-native implementation,
   should not adopt MRTR or statelessness as its own posture, and should not touch ledger or
   authority semantics. The composition-root rule already established in this repo — protocol
   adapters are never authority — bounds this change to the adapter.
4. Tests for four server shapes: `2025-06-18` (legacy handshake), `2025-11-25` (today's pinned
   case — must keep passing), `2026-07-28` (**must not hang waiting for an `initialized` ack that
   never arrives**), and an unrecognized future version (must fail closed with a diagnosable
   message, not a bare JSON-RPC protocol error). All against the in-process fake server; no
   network, per roadmap 01 §0.6.
5. **Amend roadmap 01 in the same branch.** Its §0.2, §1, §5, and §9 must describe version
   negotiation as a bounded set of code paths, not a fixed handshake. If W1 lands after roadmap 01
   has already been implemented, the amendment is a rework note, not a preface — say so plainly.
6. **New ADR required** (`ADR-PENDING-mcp-version-negotiation`). Nothing currently governs MCP
   client version policy: ADR-039/040/041 are adjacent but narrower, and the 2026-08-09 delta doc
   is a research note, not an ADR. Record: the bounded supported-set, the probe/fallback order, and
   that unrecognized future revisions fail closed.

### 1.4 What this changes for ADR-041 (no work now)

ADR-041's non-goals defer any HTTP/TLS/MCP/A2A listener pending independent security review
(Obligation O1). MCP's statelessness shift is a reason to **keep** deferring: it removes the
`Mcp-Session-Id` concept that ADR-041's "external transport session remains distinct from the
native execution session" language was written against. **Action: add to O1's review scope** that
the review must re-verify against whatever MCP revision is current at review time rather than
inheriting today's assumptions. No listener work now.

---

## 2. W2 — Intent-scoped catalog exposure

`packages/arbor-mcp/src/tools.ts:145-148`'s `catalogNotes()` joins every one of ~102
`RUNTIME_CATALOG` kind descriptions into a single static string embedded in the two generic tools'
descriptions at `tools/list` time (`:540`, `:569`). The two-generic-tool design
(`arbor_command`/`arbor_query`) is **right** — the DRY argument in the code comment is sound and
prevents catalog drift — but the description payload scales linearly with catalog size, which is
closer to full-catalog exposure than to intent-scoped routing.

*Tool Forge* (arXiv 2605.28000, 2026-05-27) measures this directly: an intent-scoped router over a
600-tool catalog achieves micro-F1 **0.958** on its realistic suite while cutting task-flow tool
context by **99.55%** versus naive full-schema exposure (aggregate 0.908 / 99.49% across 83 cases).
Its Router exposes a small stable MCP surface — search, resolve, describe, call — and loads full
schemas lazily. That is the same mechanism this session's own harness uses.

**Build:** a lightweight `arbor_catalog_search(query, direction?)` returning matching kinds with
their full field contract, and shrink the two tools' descriptions to a pointer at it.

**Why this is a well-posed problem here and not in general.** *ToolRet* (arXiv 2503.01763) shows
that IR models are genuinely bad at tool retrieval — the best model reaches nDCG@10 of only 33.83
over a 43k open tool corpus, because query↔tool lexical overlap (ROUGE-L 0.06) is far below
conventional IR (0.27–0.34). **That result does not transfer to us.** `RUNTIME_CATALOG` is a
closed, typed, versioned catalog with structured kind names; keyword and kind-prefix search over it
is a different and much easier problem than open-corpus embedding retrieval. Do **not** reach for
an embedding retriever — the closed-catalog assumption is a real structural advantage.

**Constraint:** preserve the single-authority guarantee stated at `tools.ts:120-141`.
`RUNTIME_CATALOG` remains the one source; the search index is derived, never hand-maintained.
Effort medium; risk low-medium.

---

## 3. W3 — Name the context-engineering prior art, and test the failure mode

ADR-018's "anchored merge, not regenerate" and ADR-038's `PlaybookDelta` are, mechanically,
**ACE's grow-and-refine** (arXiv 2510.04618, ICLR 2026; v3 2026-03-29) in more heavily governed
form. Neither ADR cites it. Both instead point at an internal "frontier survey Appendix C" that a
repo-wide grep does not resolve to a committed file. For a repo whose doctrine is that completeness
claims carry a durable record, an unattributed design lineage resting on an uncommitted survey is
the exact shape the claim ledger exists to catch.

ACE names two failure modes precisely:

- **Brevity bias** — summarization drops domain detail for concision.
- **Context collapse** — iterative monolithic rewriting erodes detail over successive compactions.
  Their AppWorld case study is concrete: at step 60 the context held 18,282 tokens at 66.7%
  accuracy; at step 61 it collapsed to **122 tokens at 57.1%** — *below* the 63.7% no-adaptation
  baseline. Their ablation shows removing incremental delta updates costs −11.7% TGC / −27.8% SGC.

**Do:**

1. Cite ACE (2510.04618) in ADR-018 and ADR-038. Either commit the internal survey as a real
   citable document or replace the citation; *Dive into Claude Code* (arXiv 2604.14228) is the
   better external comparator for the compaction-pipeline discussion, since it documents a
   five-layer graduated pipeline against which ADR-018's single ledger-witnessed layer is a
   deliberate alternative.
2. **Add one regression test** asserting that N successive compaction cycles do not monotonically
   shrink retained-fact count below a floor — a direct, cheap operationalization of context
   collapse — alongside the existing lifecycle tests (`packages/arbor-opencode/tests/loop.test.ts`
   around the `compaction_skipped` path). This is the item with the best evidence-to-effort ratio
   in the whole brief.
3. **Flag ADR-038's RLM framing as an open question before it moves toward Accepted.** ADR-038
   treats "RLM-style recursive context handling" as a settled reference point. Its confirmed
   successor, *SRLM* (arXiv 2603.15653, Apple, 2026-03-07), finds the opposite: recursion is **not**
   the primary driver. A simpler uncertainty-aware self-reflective program search matches or beats
   RLM without any recursion, by up to **+22%** under matched wall-clock budget — and critically,
   **RLM often degrades performance below the base model when context fits the window** (e.g.
   −12.0pp on LongBench-v2 under GPT-5 at <131K). Add a one-paragraph amendment: if O6
   (`context.retrieve` / `subagent.describe`) ever moves from capability-gated to composed, resolve
   recursion-vs-self-reflection by evidence under ADR-038's own O5 promotion bar, not by inheriting
   the RLM name.

---

## 4. W4 — Check ADR-052's tier boundaries against the published data

ADR-052 (dated 2026-08-12, Proposed) defines a four-tier T1–T4 trust model with G1–G4 gates,
Ed25519-signed manifests, and a hash-chained tier ledger. *Agent Skills for Large Language Models*
(arXiv 2602.12430, AgentSkills '26; v4 2026-06-02) independently proposes a **four-tier, gate-based
Skill Trust and Lifecycle Governance Framework** with G1–G4 gates mapping provenance to graduated
deployment capability — the same shape, published four months earlier. Convergence is
corroboration, not authorship; cite it in ADR-052's Context.

The **actionable** part is the empirical data behind it, which the ADR should be tested against
rather than merely aligned with:

- 26.1% of 31,132 analyzed community skills contain ≥1 vulnerability, across 14 patterns in four
  categories: prompt injection, data exfiltration (13.3%), privilege escalation (11.8%), supply
  chain. 5.2% show high-severity patterns suggesting malicious intent.
- **Skills bundling executable scripts are 2.12× more likely to be vulnerable** (OR=2.12,
  *p* < 0.001) — this is the number that should drive the T2 boundary.
- A ground-truth follow-up behaviorally verified 98,380 skills; among 157 confirmed-malicious, a
  single industrialized actor accounted for **54.1%** via templated brand impersonation.

**Do:** stress-test ADR-052's T2 boundary ("read-only tools, no code, no MCP servers") against those
vulnerability classes specifically — confirm each class is excluded *at T2*, not merely at T4 —
using the existing `command-catalog.ts` / `plugin-manifest.ts` proof comments. Then move ADR-052
Proposed → Accepted or record why not. Per ADR-044 and roadmap 18, acceptance authority is not
implementation authority: the acceptance must not ride in the same commit as the content.

Two cautions on adjacent work, both **read-only, do not build**:

- *SkCC* (arXiv 2605.03353) reports skill-compilation gains (Claude Code pass rate 21.1%→33.3%,
  94.8% anti-skill-injection trigger rate, sub-10ms compile). Its own ablation shows the *same*
  compiled format is neutral on GLM-5 (*d* = −0.03) and slightly negative on DeepSeek-v4
  (*d* = −0.14). It is research-stage, single-group; treat as awareness only.
- *When Lower Privileges Suffice* (arXiv 2606.20023) is the more useful one. It finds
  over-privileged tool selection is common (6 of 11 frontier models >30% OPUR) and, crucially,
  **amplified by transient failures** — GPT-5.2 escalates 5 times at PED=0 but 35 times at PED=2.
  Safety alignment does not transfer (AgentAlign *raised* OPUR for Qwen, 50.4%→60.7%), and
  prompt-level mitigation weakens across turns. revoy2's mechanism — capability gates, not
  prompting — is architecturally the right answer. The action is to validate ADR-028's gates
  against the **transient-failure escalation** scenario specifically, not just steady-state
  selection.

---

## 5. W5 — Do not let a SWE-bench number become a quality claim

`packages/arbor-eval` (ROADMAP G-12) must not adopt a raw SWE-bench Verified pass-rate as an
internal quality signal. Four independent 2026 results, read in full:

- **SWE-ABS** (arXiv 2603.00520, 2026-02-28): adversarially strengthening test suites rejects
  **19.78%** of previously-passing patches (2,184 / 11,041) across the top-30 leaderboard agents.
  The top agent drops **78.80% → 62.20%** and falls from 1st to 5th; Spearman ρ between old and
  new rankings falls to 0.82. Of 100 manually analyzed rejected patches, 47% are logic errors and
  35% incomplete fixes — semantic failures, not syntax. Their own false-negative rate is 10.6%,
  which they report honestly.
- **SWE-Bench ProMax** (arXiv 2608.09802, 2026-08-10 — two days old): cites an audit finding
  material test defects in ~60% of unsolved SWE-bench Verified instances (35.5% overly narrow,
  18.8% overly broad), and reports OpenAI has **deprecated the benchmark**. Best model on their
  multilingual refactoring set: 41.2%.
- **Saving SWE-Bench** (arXiv 2510.08996, v4 2026-01-23): rewriting formal issue text into
  realistic chat-style queries drops OpenHands' success rate 20–40% relative on public benchmarks
  but only 2–5 points on a private C# set — evidence of overfitting, not just over-specification.
- **SWE-bench-Live** (arXiv 2505.23419): the same agent/model pair scores 43.20% on Verified and
  **19.25%** on Live under identical settings.

**Do:** record this in the eval gate's own documentation, and if a SWE-bench-family signal is used
at all, prefer a contamination-resistant variant (SWE-bench-Live) with the overestimation risk
stated. Effort low; risk low.

**Related, deliberately not built:** *LLM-as-a-Verifier* (arXiv 2607.05391) shows continuous
logit-expectation scores beat discrete LM-judge scoring (SOTA Terminal-Bench V2 86.5%, SWE-Bench
Verified 78.2%; zero ties vs. the judge's 26.7% at k=1) and ships a Claude Code extension. Our
`critic_approved` provenance tag (`tools.ts:50-54`) carries only `critic` + free-text `rationale`.
Adding a numeric confidence field is a genuine design question — but it changes an **accepted**
contract (`Provenance` union in `@arbor/core`), so it belongs in the next critic-panel ADR review
under ADR-024, not in this branch. Flag, do not implement.

---

## 6. Documentation corrections (trivial, do these first)

1. `docs/frontier-intra-agent-comms.md:23` reads "A2A (now absorbing ACP, under the Linux
   Foundation)". This is true for **exactly one of two unrelated protocols called ACP**, and the
   line does not disambiguate. IBM/BeeAI's Agent Communication Protocol (`i-am-bee/acp`) *is*
   archived (2025-08-27) with a banner reading "ACP is now part of A2A under the Linux Foundation."
   **Zed's Agent Client Protocol** (`agentclientprotocol.com`) is a different protocol sharing only
   the acronym, and is independently governed and active (3,958★, Apache-2.0, pushed 2026-08-12,
   stable protocol version 1, SDKs in Rust/Python/TypeScript/Kotlin/Java). Correct the line to name
   IBM/BeeAI's ACP specifically. No code decision changes — both research docs already treat ACP as
   prior art only, which is the right posture either way.
2. A2A is at **v1.0.1** (2026-05-28), a patch over v1.0.0 (2026-03-12): prefer
   `application/a2a+json` in the HTTP binding, transcoding error corrections, `TaskStatus` value
   corrections. Nothing in v1.0.1 invalidates `a2a-wire.ts`'s SCREAMING_SNAKE_CASE `TaskState` set
   or its correct non-reliance on the removed `kind` discriminator. Governance is an 8-seat Linux
   Foundation TSC (Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM).
3. **`a2a-wire.ts` needs no change.** Assessed against the fetched v1.0.1 spec text: the
   evidence-ref-via-`metadata`/`extensions` approach is what the spec prescribes for vendor data;
   the exhaustive lossy-state signaling (`wireStateIsLossy` for `REJECTED`/`AUTH_REQUIRED` rather
   than silent narrowing) is more careful than a naive mapping. Recorded as an assessment, not an
   action item.

---

## 7. Evidence grades — read before treating any item as settled

| Item | Grade | Basis |
|---|---|---|
| W1 MCP `2026-07-28` shape | **Spec-verified** | Canonical spec page + full changelog fetched directly 2026-08-12; SEP numbers quoted. Independently corroborated: arXiv 2606.31498 (2026-06-30) still describes "MCP v1.1, schema 2025-11-25", consistent with `2026-07-28` postdating it. |
| W1 roadmap 01 conflict | **Verified in repo** | `contracts.ts:3`; `mcp-client.ts:26-27`; roadmap 01 §0.2/§1/§5/§9. |
| W2 intent-scoped routing | **Single study, well-controlled** | Tool Forge is an early open-source release benchmark on *synthetic* catalogs; its authors explicitly decline a matched cross-system claim. The token-reduction geometry is arithmetic and robust; the F1 is not a SOTA claim. Its L3 adversarial suite drops to 0.786 — negation and confusable families remain hard. |
| W2 ToolRet non-transfer | **Strong, and it argues against a design** | The value here is what it tells us *not* to build. |
| W3 ACE | **Strong** | ICLR 2026 conference paper, ablations + hyperparameter sensitivity + robustness-to-noisy-reflector analysis, open code. |
| W3 SRLM | **Single study, credible** | Apple; direct head-to-head against RLM under matched budget. Note the integrator could not independently confirm the originating RLM paper by arXiv ID — recorded as an empty finding. SRLM treats RLM as established prior art. |
| W4 26.1% / 2.12× | **Second-hand within a survey** | The survey (2602.12430) reports Liu et al.'s numbers; the integrator read the survey, not the underlying empirical papers (2601.10338, 2602.06547). Treat the *ratio* (scripts 2.12× riskier) as the actionable signal. |
| W4 over-privilege | **Strong** | 544 human-audited scenarios, 11 models, tool-sufficiency validated by two-judge consensus + human audit, mitigation ablated. |
| W5 SWE-bench critique | **Strong, four independent sources** | Different methods (adversarial tests, curation audit, query mutation, live benchmark) converging. |
| — *AURA FARADAY* (2604.23425) | **Weak — do not cite** | Cited by the research agent, read in full, and **rejected here**. Single-author preprint marketing that author's own patent portfolio; its central "698 scheming incidents" figure is second-hand from a CLTR report; its R1–R5 requirements conclude that only the author's unpublished architecture satisfies them. The underlying CLTR finding may be sound, but cite CLTR directly if needed. Listed so a future reader does not re-derive it. |
| — *SkCC* (2605.03353) | **Weak-moderate** | Real ablations, but single group, no maintained public implementation found, and its own results show format gains are model-specific. |

**Recorded empty findings** (per the frontier method — an empty result is a finding, not a retry):
arXiv searches for LLM/MCTS tree-search at the coding-agent intersection returned no relevant hits
across two independent phrasings.

> **AMENDED 2026-08-12 — this empty finding was wrong, and the claim it supported is narrowed.**
> A later sweep re-ran the query with several fresh phrasings and found **Agent-UCT**
> (arXiv 2607.24162, 2026-07-27), read in full. It applies UCT with a cost-aware reuse
> regularization term to agentic *workflow* optimization. The original searches missed it because
> they used tree-search vocabulary scoped to *coding agents*; Agent-UCT is indexed under RAG
> pipeline optimization.
>
> It is **not** a comparator for revoy2's design: its nodes are partial *configurations* in a static
> 384-point space (chunking × query × retrieval × post-retrieval × generation), and it performs
> offline pipeline optimization — structurally closer to AutoML than to live tree search. revoy2's
> nodes are live campaign states with real side effects, under crash-safe recovery, gate lifecycle,
> and capability gating. Agent-UCT has no audit ledger, no gate lifecycle, and no recovery model.
>
> **The corrected claim:** no published comparator exists for *live, crash-safe, gate-governed*
> campaign search. Do not state or imply that nothing adjacent exists — Agent-UCT is adjacent, and
> two of its mechanisms are transferable (see roadmap 20 §5.3's note on EvoGit for the other
> adjacent-but-different system, and roadmap 21 for the transferable mechanisms).
>
> Recorded here rather than silently edited, because the original claim shipped and a reader may
> have relied on it. The general lesson: an empty finding is only as strong as the vocabulary it
> was searched with.

**Adjacent on a different axis — EvoGit, assessed and declined.** EvoGit
([arXiv:2506.02049](https://arxiv.org/abs/2506.02049)) coordinates stateless agent populations
stigmergically through a Git phylogenetic graph, without message passing or shared memory. That is
a real adjacent coordination paradigm, but not an upgrade for revoy2: replacing one UCT-selected
campaign tree and its canonical ledger authority with coordination-by-commit-graph would weaken
the authority model rather than fill a gap. Agent-UCT remains the nearest adjacent system on the
search-mechanism axis; EvoGit is nearest on the decentralized-coordination axis. EvoGit is
AGPL-3.0, so it is prior art for clean-room study only and no code may be vendored from it.

Likewise, GitHub searches for peer A2A vendor-extension implementations returned zero results, so
§6.3's conformance assessment originally rested on spec reading rather than peer comparison. The
[official A2A extension overview](https://a2a-protocol.org/latest/topics/extensions/) now closes
the mechanism-level gap: its Timestamp example uses the same versioned-URI plus
metadata-augmentation pattern as revoy2's evidence-ref extension. This is same-mechanism
precedent, not a same-vendor implementation or a claim that revoy2's extension is official.

---

## 8. Suggested order and effort

| # | Item | Effort | Risk | Why this order |
|---|---|---|---|---|
| 1 | §6 doc corrections | Trivial | None | Cheap; §6.1 prevents a future misdirected interop decision. |
| 2 | **W1** MCP negotiation + roadmap 01 amendment | Small-medium | Low-medium | P0. Every day roadmap 01 stands unamended risks an agent building a removed handshake. |
| 3 | W3 ACE citation + collapse test | Low-medium | Low | Best evidence-to-effort ratio; the test is small and the failure mode is named. |
| 4 | W5 eval-gate note | Low | Low | Pure documentation; prevents a bad claim before `arbor-eval` grows one. |
| 5 | W4 ADR-052 boundary check | Low | Low | Closes a Proposed→Accepted gap with better citations, not new architecture. | <!-- sur-05:historical -->
| 6 | W2 catalog search | Medium | Low-medium | Real but not urgent; must preserve the single-authority property. |

**Sequencing note for A2A/NodeCard work (roadmap 08, gap G-29):** the internal `NodeCard` ledger
projection is MCP-version-independent and can proceed now. The **external** A2A bridge — publishing
`/.well-known/agent-card.json` — should sequence **after W1**, because a published card's
`supportedInterfaces[].protocolVersion` would otherwise misstate which MCP revision our tool layer
speaks. *MMA2A* (arXiv 2604.12213) supports this ordering from a different angle: its ablation
shows routing improvements yield **exactly zero** gain (36% vs 36%) unless the consuming agent can
exploit what was routed. Build the consumer before the advertisement.

---

## 9. Handoff

Write `docs/roadmaps/handoffs/19-frontier-protocol-and-harness-alignment.md` recording: which
server shapes W1's tests actually cover; whether roadmap 01 was amended pre- or post-implementation;
the ADR-PENDING slugs authored; and — most importantly — **whether the MCP spec moved again between
this brief and your branch landing.** It moved twice in the eight months before this was written,
and the repo's own 2026-08-09 research missed a revision that was twelve days old at the time. Check
`https://modelcontextprotocol.io/specification` before you start, not after.
