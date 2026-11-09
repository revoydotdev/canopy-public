# Roadmap 10 — Authenticated, capability-scoped remote worker transport (LR-NH-03)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: 3498984f (2026-09-22)
Authority: Retained implementation brief for authenticated remote worker transport; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — listener, scoped grants and consent state observed at 2348ddbb; no deployed remote-worker operation is claimed
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Sequencing superseded (2026-09-22).** The [1.0.0 roadmap](../roadmap-1.0.0-and-documentation-governance.md) governs release order and priority; this file is a retained implementation brief, not an active queue. Its handoff is [here](handoffs/10-authenticated-remote-worker-transport.md).
>
> **Status checked at `2348ddbb` (2026-09-22): implementation present; deployment unverified.** The listener, scoped grants, consent state, reconciliation boundary, and focused tests are tracked. This review did not establish a deployed remote-worker operation or production deployment; the pre-handoff verification statement is historical.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8 first.
This is a **security-critical** piece (a real network listener + cross-trust-boundary delegation) —
same stakes as roadmaps 03 and 05: when unsure, fail closed and report.

**Gap closed (parity matrix):** category **35 (remote / cloud session ingress, 🟡)**. revoy2 has a
`RemoteRuntimeIngress` seam and an internal A2A bridge, but the *only* implemented transport is
`loopback-remote-transport.ts` — whose own comment states it has "no `listen`, socket, port, or
discovery document." There is no real remote listener. This is the **full brief that `ROADMAP.md`'s
LR-NH-03 named but never spelled out**; write it "after the local lifecycle (adopt, recovery) is
solid" — which, post roadmaps 03/04, it now is.

---

## 0. What "done" means (acceptance)

1. A **real authenticated listener** exists (bound HTTP, not loopback-only), gated behind explicit
   opt-in config (default off; ADR-040 opt-in remote ingress). It exposes a bounded, documented
   surface; a remote client can drive a session by id.
2. **Ephemeral, single-operation, capability-scoped tokens.** No long-lived bearer credential:
   tokens are short-lived (30s–5min), scoped to a specific operation, and JIT-provisioned per
   invocation (A2A-hardening — §7). A leaked token is useless after its window and outside its
   scope. This is the single most important security property.
3. **Granular, auditable scopes.** A remote grant declares exactly which campaign/operation and
   which capabilities it authorizes — never a broad "run anything" token (18.5% of OAuth deployments
   over-scope; do not join them). The scope is a durable, ledger-witnessed fact.
4. **`consent_required` is a first-class durable task state** for sensitive remote operations,
   distinct from `input_required` — it pauses until affirmative operator consent, then resumes.
   revoy2 **already has this shape** (`human_required`/awaiting-input); extend it, do not invent a
   parallel one (A2A's `USER_CONSENT_REQUIRED` — §7).
5. **Effect reconciliation across the boundary** (roadmap 03): a remote worker's results enter under
   fresh admission and are reconciled/verified locally — never blindly trusted or replayed. A remote
   `verified` claim is `claimed` until the local verifier confirms.
6. **Capability grade is honest** (roadmap 05's grade enum): a remote-executed result reports
   `remote_attested` only when attestation actually happened; otherwise the weaker grade that
   applied. Never over-claim confinement across a trust boundary.
7. Wired + tested: a remote client authenticates, drives a session, its result is locally
   reconciled+verified; an expired/over-scoped token is rejected; a sensitive op suspends for
   consent; the loopback transport still works (behavior-preserving); full suite green.

Non-goals (v1): decentralized identity / agent marketplaces (ANP — that is LR-NH beyond this);
multi-tenant *resource* isolation at scale (k8s/cgroups territory — see §7 note; scope the seam,
not the scheduler); a hosted cloud product (this is the self-hosted listener).

---

## 1. The invariant that dominates this design
**A remote boundary is a trust boundary; nothing crosses it un-reconciled.** The worst outcome is a
remote worker's `verified` claim being trusted as authority, or a long-lived token becoming a
skeleton key. Every remote grant is ephemeral + scoped + audited; every remote result re-enters
through admission and local verification (roadmap 03); every confinement claim reports the grade
that *actually* applied (roadmap 05). Fail closed: if attestation/reconciliation cannot be done,
refuse and report — never silently accept.

## 2. Where it plugs in
- `packages/arbor-mcp/src/loopback-remote-transport.ts` + `remote-ingress.ts` +
  `RemoteRuntimeIngress` — the existing seam. The loopback transport becomes one implementation
  behind the transport interface; the new authenticated HTTP listener is its sibling. Do not delete
  loopback (it is the local/test path).
- `packages/arbor-mcp/src/a2a-bridge.ts` / `a2a-wire.ts` — the internal A2A contracts are the
  message model; harden them per §7 for the cross-trust-boundary case (they are currently
  in-process-trusted).
- The credential broker (roadmap 05 §7.2 / existing MCP broker) issues the ephemeral scoped tokens —
  reuse it; a remote token is a capability handle, not a raw credential.
- Roadmap 03 recovery/reconciliation — remote results reconcile through it.
- ADR-039/040/041 (durable direct-thread transport, opt-in remote ingress, authenticated remote
  transport contract) are the **existing governing ADRs** — this roadmap implements them; read them
  first and supersede/extend rather than contradict.

## 3. Suggested structure
```
packages/arbor-mcp/src/remote/
  transport-contract.ts   # the interface loopback + http both implement
  http-listener.ts        # bound authenticated listener (opt-in); OpenAPI-shaped bounded surface
  ephemeral-token.ts      # JIT short-lived single-operation scoped tokens (via the broker)
  remote-reconcile.ts     # remote result -> local admission + verification (roadmap 03)
```

## 4. Gotchas
- **Never a long-lived bearer token.** A2A-hardening cites real CVEs (CVE-2025-1198/-1801) from
  exactly this. JIT, short-lived, single-operation, scoped — verify expiry and scope on every call.
- **A remote `verified` is `claimed` locally** until the local verifier re-confirms — crossing a
  trust boundary strips provenance to `claimed` (this is the provenance invariant, `handoff.md` §2).
- **Bind carefully.** Default off; when on, bind explicitly, require auth, and document the surface —
  an accidental `0.0.0.0` listener with weak auth is the catastrophic failure.
- **Zero new runtime deps**; a bounded HTTP listener via node's own `http`/`https`, not a framework.
- **`native-agent-executor.ts`/`cli.ts` may be under concurrent change** — coordinate; land the
  transport contract + listener first, thread the executor wiring separately.

## 5. Tests
- Authenticated remote client drives a session; result is locally reconciled + verified.
- Expired token rejected; over-scoped/mismatched-scope token rejected; token from wrong session
  rejected.
- Sensitive operation suspends to `consent_required` and resumes on approval.
- Remote `verified` claim is treated as `claimed` until local verification.
- Loopback transport unchanged (behavior-preserving); full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/remote-worker-transport`. **Write an ADR** extending
ADR-040/041 (or superseding if the contract changes); the integrator hard-reviews the auth model,
token lifetime/scope enforcement, and the reconciliation-not-trust property before merge — that
review is the safety gate.

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Source: `frontier-gap-literature-2026.md` Gap 35. The A2A-hardening paper was **read in full**; the
protocol survey and AWCP are abstract-verified.

### 7.1 Harden A2A before shipping it — Improving Google A2A (arXiv:2505.12490, read in full)
A2A is the most-evidenced peer-task-delegation protocol, but the stock spec has documented gaps this
paper fixes — and its fixes are the acceptance criteria above:
- **Absence of token-lifetime limits** (OAuth2-based, no strict expiry) → leaked long-lived tokens
  are reused (real CVEs cited). **Fix: ephemeral tokens (30s–5min), valid for a single operation,
  JIT-provisioned only for the duration of a tool invocation.** This is §0.2 and the most important
  property.
- **Insufficiently granular scopes** → overprivilege (18.5% of OAuth deployments over-scope,
  violating GDPR minimum-necessary). **Fix: precise, auditable, capability-scoped tokens**
  (WebAssembly-style privilege-attenuation / agent-specific credentials with named scope limits).
  → §0.3.
- **Lack of transparency/consent** → **Fix: a new task state `USER_CONSENT_REQUIRED`, distinct from
  `INPUT_REQUIRED`, that pauses execution until affirmative consent, then transitions to
  `IN_PROGRESS`.** revoy2 already has this shape (`human_required`); extend it. → §0.4.
- The paper's `DirectDataFlowController` pattern (verify consent + endpoint legitimacy + issue
  short-lived single-use token before opening a channel) took A2A's **60–100% prompt-injection leak
  rate to 0%** empirically — a concrete, validated target.

### 7.2 Adopt protocols in phases — Interoperability Survey (arXiv:2505.02279, abstract-verified)
The survey's phased roadmap is **MCP → ACP → A2A → ANP**: MCP for tool access (revoy2 already has
it), A2A only once **cross-trust-boundary peer delegation** is genuinely required (this roadmap), and
ANP (decentralized identity/marketplaces) deferred. Do not jump to ANP-style discovery; this
roadmap is the A2A step, scoped to authenticated point-to-point remote workers.

### 7.3 Decide the "context gap" explicitly — AWCP (arXiv:2602.20493, abstract-verified)
Message-only protocols can't let a remote worker manipulate a peer's files/tools (the **"context
gap"**). revoy2's worktree isolation makes this a real choice: either (a) stay message-only (remote
worker returns results, local side applies them — simplest, and composes with adopt/reconcile), or
(b) add AWCP-style **temporary workspace delegation** (project a worktree to a remote executor).
**Recommend (a) for v1** — it keeps the trust boundary clean and reuses roadmap 03's reconciliation;
defer (b) until a concrete need. (AWCP ref: github.com/SII-Holos/awcp — verify maturity/license
before any adoption.)

### 7.4 Competitive RE — the minimal listener shape, and a multi-tenant caveat
- **OpenCode's `opencode serve`** is the smallest-surface reference: a single bind flag flips
  loopback into a bound HTTP listener, Basic-Auth via env-var credentials
  (`OPENCODE_SERVER_PASSWORD`), a documented OpenAPI surface, sessions addressed per-id. Steal this
  minimal shape (but revoy2's tokens should be ephemeral/scoped per §7.1, stronger than Basic-Auth).
- **Codex's app-server** (bidirectional JSON-RPC 2.0; remote requires **WebSocket auth + TLS**) is
  the reference for the transport contract that lets *any* client (CLI/IDE/custom) drive one core.
- **Multi-tenant resource isolation is arXiv-sparse and product-shaped** (k8s/cgroups) — and
  OpenCode's `serve` multi-tenant isolation is explicitly undocumented (RE confidence gap). Scope v1
  to **single-tenant authenticated remote workers**; design the token/scope model so multi-tenant
  isolation can be added at the OS/infra layer later (roadmap 05's sandbox is the per-worker
  confinement substrate), but do not claim multi-tenant safety in v1.
