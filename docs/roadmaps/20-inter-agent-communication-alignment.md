# Roadmap 20 — Inter-agent communication alignment (2026-08)

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

**Audience:** an implementing coding agent on a feature branch, and the integrator maintaining
`docs/frontier-intra-agent-comms.md` and ADR-039/040/041. Read `docs/roadmaps/01-mcp-client.md`
§1–§2 and §8 first for the invariants and repo gotchas, and
`docs/roadmaps/19-frontier-protocol-and-harness-alignment.md` for the MCP `2026-07-28` change this
brief assumes and does not repeat.

**One-line goal:** align revoy2's inter-agent communication surface — A2A extensions, delegation
identity, and the governance claims made about the conversation bus — with the specifications and
empirical literature that actually govern them as of **2026-08-12**, and record, with citations,
the four places where the honest answer is *don't build*.

**Provenance.** A dedicated frontier research agent surveyed A2A extensions, Zed's ACP, agent
identity and delegation chains, coordination substrates, multi-agent failure taxonomies, and the
governance-layer question. Every paper it cited was then downloaded and read in full by the
integrator; every specification claim was re-verified by direct fetch; and every repo-state claim
was re-checked against the working tree. That verification pass **rejected one of the brief's six
recommendations outright** (§8) and **materially strengthened another** (§1). Read §7's evidence
grades before treating any item here as settled.

---

## 0. The bound this roadmap operates under (read first)

Before any recommendation: **better inter-agent protocol semantics do not fix inter-agent
coordination failures.** This is not a caution invented here; it is the explicit finding of the
strongest paper in this survey.

MAST (arXiv 2503.13657, NeurIPS 2025 Datasets & Benchmarks; Cemri et al., UC Berkeley — Stoica,
Zaharia, Gonzalez, Klein, Keutzer) annotated **1,642 execution traces across 7 multi-agent
frameworks** and four model families, deriving 14 failure modes in 3 categories by Grounded Theory
with **κ = 0.88** inter-annotator agreement, validated out-of-domain at κ = 0.79. Its Insight 2
states the bound directly:

> "Recent system innovations, such as Model Context Protocol and Agent to Agent, improve agent
> communication by standardizing message formats from different tool or agent providers. **However,
> the errors we observe in FC2 occur even when agents within the same framework communicate using
> natural language.** This signals a deeper agent interaction dynamic challenge: the collapse of
> 'theory of mind' … Solutions focused on context or communication protocols are often insufficient
> for FC2 failures."

FC2 (inter-agent misalignment) is **36.9%** of observed failures — the second-largest category, and
the one an inter-agent-comms roadmap would naively claim to address. Meanwhile FC3 (task
verification) is 21.3%, and MAST's Insight 3 is that "sole reliance on final-stage, low-level checks
is inadequate" — adding a *high-level objective* verification step to ChatDev yielded **+15.6%**
task success, and fixing a single role-specification flaw yielded **+9.4%**.

**What follows for this roadmap:** nothing here is permitted to claim that protocol work improves
campaign reliability. The A2A/extension items below are *interoperability and conformance* work.
The place where MAST says revoy2's leverage actually is — multi-level verification — is already
where revoy2 invests (four-gate lifecycle, critic panel, obligations gate), and roadmap 19 W5
already guards its evaluation honesty. That is a pleasant result, but state it as a bound, not a
boast.

---

## 1. W1 — Adopt MAST as the reference failure taxonomy for the conversation bus

revoy2 has no stated taxonomy for classifying a `NodeCommunication` pathology: a stalled `steer`, a
`needs_attention` that never resolves, a `reply_to_communication_id` rejected cross-thread under
ADR-039. ADR-039 also carries **no citation** for *why* its transport-semantics choices (explicit
intent, ack/deadline, no mailbox) are the right shape.

MAST supplies both. It is publicly released (dataset on HuggingFace, LLM-judge annotator,
`pip install agentdash`), and several of its modes map directly onto bus pathologies revoy2 can
already produce: FM-1.4 *Loss of Conversation History* (2.80%), FM-2.1 *Conversation Reset*
(2.20%), FM-2.2 *Fail to Ask for Clarification* (6.80%), FM-2.4 *Information Withholding* (0.85%),
FM-3.1 *Premature Termination* (6.20%).

**Do:** cite MAST in ADR-039's Context as the empirical grounding for the failure modes a durable
direct-thread transport must make legible, and name the specific FM ids ADR-039's intent set is
designed to surface. **Do not** build a `gate:conversation-health` detector yet — MAST's own method
required a trace corpus, and revoy2 has no production bus-failure corpus to classify against.
Building the detector before the corpus reproduces the "capability nobody has designed" shape
ADR-023 warns about. Effort: low. Risk: none. Disposition: **document**.

---

## 2. W2 — Correct the governance claim to the narrower true thing

`docs/frontier-intra-agent-comms.md` §3 frames revoy2 as broadly exceeding the frontier on
governance. The honest version is narrower, more defensible, and more useful. Scored against the
six dimensions of arXiv 2606.31498 (Kang & Diponegoro, 2026-06-30), which finds voting and dissent
preservation **universally absent** across MCP/A2A/ACP/ANP/ERC-8004:

| Dimension | revoy2 | Basis |
|---|---|---|
| **G6 Audit/replay** | **Closed, and exceeds the paper's examples** | Hash-chained `NodeCommunicationRecord`, deterministic replay (ADR-012), conversation envelope (4D.1). Exceeds because the bus *is* the ledger rather than a bolted-on trace — the paper's own critique is that audit, where it exists at all, is a substrate property rather than a governance design. |
| **G5 Human escalation** | **Closed, single-operator scope** | `needs_attention`/`ack_required`/`deadline_at` (ADR-039); `ApprovalService` (G-14) that never blesses an action itself. Not multi-stakeholder. |
| **G1 Membership** | **Partial** | Capability tiers (`specialist`/`critic`/`auditor`/`orchestrator`, `canReadCommunication`), `RemoteSessionAuthority` enrollment (ADR-040). Admission, not deliberation. |
| **G2 Deliberation** | **Absent** | The critic/specialist relation is hierarchical review, not peer deliberation. |
| **G3 Voting** | **Absent** | Exactly one decider per gate. |
| **G4 Dissent preservation** | **Absent** | Nothing aggregates multiple authored positions into a recorded, dissent-preserving group decision. |

**revoy2 is not accidentally sitting on the missing Layer-4 governance substrate.** It has durably
solved two of six dimensions to a standard the field has not matched, has a partial third, and the
other three are unbuilt. A deliberation/voting/dissent primitive would be **new authority surface**
— multi-party, conflict-resolution-bearing — not a wiring gap or a rename of something that exists.

There is a second, stronger framing available, and it should be used alongside the scorecard. The
Oxford/NYU-Shanghai comparative trust study (arXiv 2511.03434) classifies inter-agent trust into
six models — Brief, Claim, Proof, Stake, Reputation, **Constraint** — and concludes that no single
mechanism suffices, recommending **Proof and Stake to gate high-impact actions, Brief for identity
and discovery, and Reputation as an overlay only**. Constraint it describes as "shifts trust from
the agent to the framework," effective specifically against prompt injection and privilege
escalation because it bounds the action surface rather than predicting behavior.

revoy2's posture is **Constraint-class (capability gates, ADR-028; worktree isolation, ADR-023)
plus Proof-class (signature/certificate/nonce chain, ADR-040/041)** — with no Reputation dependency
anywhere. That is precisely the combination the paper recommends for high-impact actions. This is
a citable, bounded claim, and it is a better one than "revoy2 already has governance."

**Do:** replace §3's framing with the scorecard plus the trust-model classification, citing both
papers by name. Effort: low (writing). Risk: none — but this is the item with real reputational
exposure if skipped, because the current looser framing could be cited uncritically. Disposition:
**document**.

---

## 3. W3 — Bound any future delegation-chain design, and record the convergence

ADR-040/041 currently scope a single remote-worker hop. If revoy2 ever extends toward genuine
multi-hop delegation (the eventual shape of roadmap 10), two findings should already be in the
ADRs so a future author inherits them rather than rediscovering them after building.

**3.1 The negative result — do not make intent verification load-bearing.** SentinelAgent's
Delegation Chain Calculus (arXiv 2604.02767) defines seven properties: six deterministic (authority
narrowing, policy preservation, forensic reconstructibility, cascade containment, scope-action
conformance, output schema conformance) and one probabilistic (intent preservation). Its
Proposition 1 argues, and demonstrates, the **practical infeasibility of deterministic intent
verification**: eight semantically ambiguous delegation pairs where identical natural language is
simultaneously consistent with benign and malicious readings ("Cross-reference applicant data with
external databases" — fraud detection vs. unauthorized surveillance). The off-the-shelf NLI model
returns NEUTRAL on all eight; the keyword filter triggers on **0/8**. Under adversarial
paraphrasing the false-acceptance rate reaches **87.0%** (i.e. ~13% TPR) *even after* fine-tuning
that lifted baseline malicious TPR from 1.7% to 88.3% on non-adversarial text.

**Action:** one sentence in ADR-040's Consequences, alongside the existing AgentTrust/AgentCanary
citations, stating that no future delegation design's safety case may rest on verifying an agent's
*stated intent* against its authorized scope via NLI or LLM-judge. The six deterministic properties
are what ADR-040/041's nonce/certificate/audience-scoping already target in spirit; this is
corroboration that they target the right six things and an explicit exclusion of the fragile
seventh.

**3.2 The convergence — three independent designs land on ADR-041's exact primitives.** ADR-041
already mandates Ed25519-signed envelopes serialized as **RFC 8785 JSON Canonicalization Scheme**
bytes, with a `sha256:` digest over the exact JCS signing bytes and an explicit prohibition on
substituting host JSON-stringifier output (ADR-041:25-32). Independently:

- **AIP** (arXiv 2603.24775) uses Ed25519 + RFC 8785 canonical form for identity documents, with
  append-only capability-attenuating blocks; compact-mode verify at **0.049 ms** (Rust) / 0.189 ms
  (Python), chained tokens at 340–380 bytes per delegation block, and **100% rejection across 600
  adversarial attempts**, with two attack classes (delegation-depth violation, audit evasion)
  caught *only* by the chained model. It ships cross-language conformance tests — the same
  requirement ADR-041 §O1 already imposes ("RFC 8785 test vectors across every supported
  implementation language").
- **HDP** (arXiv 2604.04522) independently selects Ed25519 + RFC 8785 for an append-only signed hop
  chain with fully offline verification.

**Action:** one citation line in ADR-041's Context recording the three-way convergence on
Ed25519+JCS as independent validation of the wire contract. **Do not adopt AIP's dual JWT/Biscuit
wire format** — ADR-041 has a committed contract, and changing it is scope creep with no stated
benefit. Effort: trivial for both. Risk: none. Disposition: **document**.

---

## 4. W4 — Close roadmap 19's empty finding with same-mechanism precedent

Roadmap 19 §7 recorded an empty finding: GitHub searches for peer A2A vendor-extension
implementations returned zero results, so §6.3's conformance assessment of `a2a-wire.ts` rested on
spec reading rather than peer comparison. That gap can now be closed — not with a same-vendor
example, but with the **official reference extensions**, verified by direct fetch of the A2A
extensions spec page on 2026-08-12:

- Extensions are declared at `AgentCapabilities.extensions[]`, each an `AgentExtension` with
  `uri` / `description` / `required` / `params`.
- Activation is negotiated via the **`A2A-Extensions` HTTP header**, a comma-separated list of
  extension URIs; the agent echoes back the successfully activated set.
- Official extensions use the canonical namespace
  `https://a2a-protocol.org/extensions/{name}/v1`, hosted under the `a2aproject` org with an
  `ext-` repo prefix; experimental ones use `experimental-ext-`.
- Four reference extensions exist: **Secure Passport**, **Timestamp** (the "Hello World" minimal
  example — metadata augmentation, no new wire shape), **Traceability**, and **Agent Gateway
  Protocol**.
- **No comprehensive registry URL is specified** — recorded as a confirmed emptiness, matching the
  spec page's own silence, not a search failure.

`a2a-wire.ts`'s `EVIDENCE_REF_EXTENSION_URI` (`https://arbor.dev/a2a/extensions/evidence-ref/v1`)
follows the same URI-namespace-plus-version convention and the same declaration path, and its
metadata-augmentation shape is structurally closest to the Timestamp extension.

**Do:** a short comment near `EVIDENCE_REF_EXTENSION_URI` recording that the pattern matches the
official reference-extension convention, naming Timestamp as the closest structural analog, and
noting that revoy2 uses its own vendor namespace deliberately (it is not an `a2aproject` official
extension and does not claim to be). Effort: trivial. Risk: none. Disposition: **document**.

**Not verified this session:** the four extension repositories themselves were described only via
the overview page. Anyone relying on their exact wire shapes must fetch `a2aproject/ext-*`
directly first.

---

## 5. Three explicit *don't-build* decisions and one bounded exception

Each of these is a question the repo would otherwise re-litigate. Record the reason, not just the
verdict.

**5.1 Zed's Agent Client Protocol — wholesale adoption declined; bounded IDE transport adopted.** ACP is scoped
strictly editor↔agent by its own documentation ("The user is primarily in their editor, and wants
to reach out and use agents"); there is no agent-to-agent scope. The ecosystem is real (core repo
3,958★ Apache-2.0, pushed 2026-08-12; adapters `cola-io/codex-acp` 142★, `moabualruz/claude-code-cli-acp`,
`letta-ai/letta-acp`), so maturity is not the objection.

As **guest** (revoy2 hosted inside an ACP client): declined. The schema — fetched directly, 242 KB
— contains `RequestPermissionRequest`/`Response`/`Outcome`, and `session/new` carries an
**`mcpServers`** field with `McpServer`, `mcpCapabilities`, and `stdio`/`http`/`sse` transports.
(The research brief flagged this field as unconfirmed; direct fetch **confirms it is present**.)
That means an ACP host would own both the tool-call permission decision *and* the set of MCP
servers the guest sees — two authorities revoy2 already gates through its own composition root.
This is the same violation shape ADR-039/040/041 exist to prevent for remote transport, arriving
through a different protocol.

As **host** (revoy2 driving an external agent as an ACP client): more defensible — peer tool
execution, not authority handoff — but there is no use case. revoy2's runtime catalog *is* its tool
substrate.

**Updated disposition (operator D46, 2026-08-24):** preserve the authority
finding and adopt only an ACP v1 IDE transport that refuses non-empty
client-supplied `mcpServers` and advertises no client-owned filesystem,
terminal, or tool-permission capability. `arbor acp` maps task input, displayed
questions, progress, cancellation, and verified-result projection onto Revoy's
existing authorities. Disposition: **bounded transport / do not adopt ACP as an
authority substrate**.

**5.2 AWCP-style workspace delegation — the gap does not exist in this architecture.** AWCP
(arXiv 2602.20493; reference impl `SII-Holos/awcp`, 9★ Apache-2.0, four transports including Git)
exists to bridge the "context gap" where message-passing agents cannot touch each other's
filesystem. revoy2's nodes are not isolated remote processes with private filesystems; they are
worktree-isolated branches of one campaign tree, and **ADR-023** ("no rollback target — worktree
isolation plus ledger suffice") already decided workspace sharing, for a different reason but with
the same practical effect. **Do:** close the open question at
`docs/research/frontier-gap-literature-2026.md` §Gap 35 with the ADR-023 cross-reference.
Disposition: **don't-build**.

**5.3 Git-as-substrate / stigmergic coordination — a different paradigm, not an upgrade.** EvoGit
(arXiv 2506.02049) coordinates a population of agents purely through a Git phylogenetic graph, with
no message passing and no shared memory; agents are stateless and coordination is explicitly
stigmergic. It is real and successful (1.4k★, 192 forks, AgentX Multi-Agent Track 1st place,
successor `EMI-group/genesis`). It is also solving a different problem: EvoGit's agents are
independent asynchronous populations exploring a fitness landscape with sparse human curation;
revoy2's nodes are a single tree under UCT-selection authority with a canonical runtime as
composition root. Adopting coordination-by-commit-graph would trade the ledger's
single-authority property for a weaker git-native one — a regression.

**Two things worth recording anyway.** First, on the "no published comparator" claim: roadmap 19 §7
has since been **amended** — Agent-UCT (arXiv 2607.24162) is nearer than EvoGit on the *search
mechanism*, though still not a comparator, since it searches a static configuration space offline.
EvoGit remains the nearest adjacent system on *coordination paradigm*:
**decentralized/stigmergic** rather than centralized-authoritative. Both are adjacent-but-different,
along different axes; saying so is more useful than letting "no comparator" imply nothing adjacent
exists. Second,
**EvoGit is AGPL-3.0** — prior-art reading only; do not vendor code from it, and observe a
clean-room boundary if its mechanisms are ever studied in depth. Disposition: **don't-build**, with
a one-paragraph addendum to roadmap 19 §7.

**5.4 ERC-8004 / on-chain identity — empirically hollow, and the wrong trust class.** Two
independent 2026 studies, both read in full:

- arXiv 2606.26028 (Imperial/Ohio State/Bristol/CSIRO/Manchester) crawled every Identity and
  Reputation event on Ethereum, BSC, and Base through 2026-05-13. Only **3% / 4% / 15%** of
  registrations expose a valid registration file with a live service endpoint. Sybil-flagged
  reviewers account for **73.5% / 59.2% / 90.6%** of reviewers; after removing their feedback,
  **15.8% / 77.9% / 86.8%** of rated agents have no valid feedback left. Reputation can be
  fabricated or destroyed for a median **$0.055 / $0.0042 / $0.0027**.
- arXiv 2606.12128 (Western Sydney/Telkomsel) on the first 10,000 Ethereum agents: **67** expose
  service records (0.67%), **628** have any feedback (6.28%), **19** have full evidence (0.19%);
  top-10 owner wallets hold **51.40%** of agents; the single largest feedback client contributes
  **65.82%** of all feedback.

Beyond the hollowness, the trust-model analysis (§2) puts ERC-8004's deployed posture in the
**Reputation** class, which 2511.03434 identifies as the weak layer. **Do:** record that if
cross-org agent identity is ever needed, the target shape is Proof+Stake anchored with Brief for
discovery — not ERC-8004's current Reputation-heavy deployment. Disposition: **don't-build**.

---

## 6. Not scheduled here

**G-29's external A2A bridge** (`/.well-known/agent-card.json` publication) — roadmap 19 §8 already
sequences this after W1 (MCP version negotiation), and nothing in this survey changes that.
MMA2A's ablation (arXiv 2604.12213, already read) is the standing reason: routing infrastructure
without a consumer that can exploit it yields **exactly zero** gain (36% vs 36%).

---

## 7. Evidence grades

| Item | Grade | Basis |
|---|---|---|
| §0 MAST bound | **Strong — the anchor of this brief** | NeurIPS 2025 D&B; 1,642 traces / 7 frameworks / 4 model families; κ=0.88 human, κ=0.77 LLM-judge, κ=0.79 out-of-domain; public dataset + annotator + pip package. Caveat the authors state themselves: not claimed exhaustive. |
| W2 governance scorecard | **Strong for the taxonomy; the scoring is our own judgment** | 2606.31498 supplies G1–G6; mapping revoy2 onto them was done here against the actual ADRs and types, not by the paper. Contestable per-cell — say so in the doc. |
| W2 trust-model framing | **Strong** | 2511.03434, Oxford + NYU Shanghai, AAAI-copyright comparative study. Conceptual, not empirical — its value is the classification, not a measurement. |
| W3.1 intent-verification infeasibility | **The negative result is strong; the positive claims are not** | The Proposition-1 argument plus the 8-pair demonstration is convincing and is the citable part. But SentinelAgent is single-author, its "100% TPR at 0% FPR" is on its own DelegationBench v4, and the paper itself states properties "hold because the DAS architecture is designed to enforce them, not because of a mathematical derivation independent of the implementation." Cite the limit, not the framework. |
| W3.2 Ed25519+JCS convergence | **Moderate, and that is enough** | AIP is single-author with real dual-language open-source implementations and cross-language conformance tests. HDP is a **vendor whitepaper** (Helixar Ltd, promoting its own npm SDK, CC BY 4.0, no venue) — downgrade accordingly. Convergence across three independent designs is the signal; no individual paper is load-bearing. |
| W4 A2A extension mechanism | **Spec-verified** | Fetched directly 2026-08-12: field path, header, URI convention, four reference extensions, `ext-`/`experimental-ext-` split, and the absence of a registry URL. |
| 5.1 ACP scope + `mcpServers` | **Spec-verified** | Overview page and the 242 KB `schema/v1/schema.json` fetched directly. Resolves the brief's own unconfirmed flag: `mcpServers`, `McpServer`, `mcpCapabilities`, `stdio`/`http`/`sse`, `RequestPermissionRequest/Response/Outcome`, `session/new`/`load`/`prompt` all confirmed present. |
| 5.3 EvoGit | **Verified** | AGPL-3.0, 1.4k★, 192 forks, AgentX 1st place, successor `EMI-group/genesis` — confirmed by direct fetch. The paper (v1, 2025-06) is a **demonstration**: 2 tasks, 16 agents, 120 iterations, no quantitative baseline comparison. Cite for the paradigm, not for performance. |
| 5.4 ERC-8004 | **Strong, two independent studies** | Different institutions, different methods (cross-chain event crawl vs. agent-level readiness funnel + network analysis), converging conclusions. |

**Recorded empty findings** (per method, not retried): (1) no comprehensive A2A extension registry
URL exists — confirmed against the spec page's own text, not a search failure; (2) "CodeCRDT" does
not resolve to a paper or maintained repo under that name across two search phrasings; (3) no
second independent governance-taxonomy paper beyond 2606.31498 — the literature is thin, consistent
with the paper's own framing; (4) the four A2A reference-extension repos were not individually
fetched.

---

## 8. One recommendation from the research brief, rejected

The brief proposed investigating whether `NodeCommunicationKind`'s 7-member union exceeds what
ADR-039 governs — framing it as a live instance of the "type says more than the ADR governs"
pattern the gap register repeatedly catches (G-02/G-09/G-11/G-30), and suggesting `steer`/`clarify`/
`promote` might be type-only and unreachable.

**This rests on a conflation and is rejected.** `packages/arbor-audit/src/audit.ts` declares **two
distinct coexisting types**: `NodeCommunicationKind` (7 members — `delegate`/`report`/`retract`/
`steer`/`reply`/`clarify`/`promote`, audit.ts:173) and `NodeCommunicationIntent` (4 members —
`request`/`response`/`notify`/`needs_attention`, audit.ts:179). ADR-039:21 governs **intent** ("a
`NodeCommunication` may persist one closed intent: `request`, `response`, `notify`,
`needs_attention`") and never claims to govern `kind`. The file's own header comment documents the
4→7 extension as deliberate.

Reachability also fails the premise: `steer`, `clarify`, and `promote` appear in non-test runtime
code at `conversation-bus.ts:264` (`kind !== "promote"` in retraction filtering), `:303`
(`kind === "steer"`), `a2a-bridge.ts:100-103` (state mapping for `clarify`/`steer`/`promote`),
`parent-child-thread-contracts.ts:142`, and are validated at `audit.ts:1425`.

Recorded here so the next reader does not re-open it. The general instinct — check the type against
the ADR — is right and cheap; it simply came back clean this time.

---

## 9. Suggested order

| # | Item | Effort | Risk | Disposition |
|---|---|---|---|---|
| 1 | §2 W2 governance correction | Low | None | document |
| 2 | §5.1–5.4 the four don't-build notes | Low (4 short notes) | None | assess-only |
| 3 | §3 W3 ADR-040/041 citations | Trivial | None | document | <!-- sur-05:historical -->
| 4 | §1 W1 MAST in ADR-039 | Low | None | document |
| 5 | §4 W4 `a2a-wire.ts` comment | Trivial | None | document |

**Every item in this roadmap is documentation or citation.** That is the honest outcome: the survey
found no inter-agent-comms capability revoy2 should build right now, one claim it should narrow
(§2), four questions it should close (§5), and one bound it should stop implying it can cross (§0).
A roadmap that produced a build item here would be doing so against MAST's evidence.

---

## 10. Handoff

Write `docs/roadmaps/handoffs/20-inter-agent-communication-alignment.md` recording: which ADRs were
amended and under what `ADR-PENDING-<slug>`; whether §2's scorecard survived review per-cell (it is
the most contestable content here); and whether A2A, ACP, or ERC-8004 moved between this brief and
your branch landing. A2A shipped v1.0.0 → v1.0.1 in ten weeks and MCP changed protocol shape twice
in eight months; check the spec pages before starting, not after.
