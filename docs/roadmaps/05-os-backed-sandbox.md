# Roadmap 05 — OS-backed hostile-filesystem & process sandbox (LR-NH-04)

Artifact kind: roadmap
Status: historical
Revision: 1
As-of commit: c373ea2b (2026-09-22)
Authority: Retained implementation brief for OS-backed sandbox; informs local technical scope only. Release sequencing is owned by the canonical 1.0.0 roadmap.
Evidence scope: mixed — Linux Bubblewrap and macOS Seatbelt backends observed at 2348ddbb; Windows confinement, CapSeal and the overprovisioning metric are target
Supersedes: none
Superseded by: sequencing and priority only: `docs/roadmap-1.0.0-and-documentation-governance.md`
Owner: Canopy/revoy2 maintainers
Review trigger: the brief is reopened, or its implementation is materially changed or superseded by an accepted ADR

> **Historical implementation brief — sequencing superseded.** The canonical 1.0.0 sequence is [docs/roadmap-1.0.0-and-documentation-governance.md](../roadmap-1.0.0-and-documentation-governance.md); this document's priority and ordering are subordinate to it. The design and evidence history below is retained. Any present-tense gap or future-work statements below describe the brief's authoring-time baseline, not a current status claim.
>
> **Implementation status at `2348ddbb6363f85ae3ddd3aeffec4b07156e5cd8`: partially implemented; Linux and macOS backends exist, other platform claims are unavailable.** `packages/arbor-mcp/src/sandbox/{sandbox-broker,seatbelt-sandbox-broker,seccomp,workspace-file}.ts`, `packages/arbor-mcp/tests/sandbox-broker.test.ts`, ADR-044, and ADR-102. Bubblewrap Linux and Seatbelt macOS code are present; no Windows OS backend is evidenced. CapSeal/generalized secret mediation and the overprovisioning metric remain proposed.

**Audience:** an implementing coding agent on a feature branch. Read roadmap 01 §1-§2 and §8
first (invariants, read-list, repo gotchas). This is a **security-critical** piece with the same
stakes as roadmap 03 — when unsure, fail closed and report; never represent an application-level
check as an OS boundary.

**One-line goal:** give the native tool host and verifier a real OS-enforced confinement boundary
(descriptor-relative filesystem, process/resource limits, and — via LR-NH-07 — network egress
control), so a hostile local process cannot race path checks, escape a worktree, spawn undeclared
children, or reach the network when denied. This is the dependency that lets `shell.execute`,
`verification.run`, and external MCP tools run *safely* rather than being refused for honesty
(today the tool host declares it cannot enforce network denial and refuses those tools when
network is disallowed — see `native-tool-host.ts`'s `command()` and roadmap on the network policy).

**Read `ROADMAP.md` §"LR-NH-04"** for the authoritative disposition. The governing constraint,
verbatim: *application-level path validation remains necessary but must not be represented as an
OS boundary.* Your work adds the OS boundary; it does not remove the app checks (they stay as
defense-in-depth and the portable fallback).

---

## 0. What "done" means (acceptance)

1. A separately-reviewable **sandbox broker/worker** exists (not more ad-hoc checks sprinkled into
   each tool). Tool and verification command execution can run *through* it.
2. On Linux, filesystem operations are descriptor-relative and beneath-root
   (`openat2`-class `RESOLVE_BENEATH`/`RESOLVE_NO_SYMLINKS`, and/or mount + user namespaces),
   so a symlink swap or directory-component replacement race cannot escape the admitted worktree.
3. A read-only repository base with an explicit writable overlay + separately-scoped
   artifact/output dirs, enforced at the OS level.
4. Process trees, executable policy, environment inheritance, CPU/memory/descriptor/output-byte
   limits, wall time, and cleanup are enforced at the OS boundary — not merely by the current JS
   `spawn` options.
5. Network egress is enforced (namespace or equivalent) when the policy denies it, so
   `shell.execute`/`verification.run` can be *safely admitted* with network denied instead of
   refused. (This is the LR-NH-07 half; scope it with this work.)
6. Capability is reported as a **graded closed enum** — `application_validated`, `os_confined`,
   `container_confined`, `remote_attested` — never a single `sandboxed` boolean. A tool result /
   session capability states which grade actually applied.
7. When the OS broker is unavailable (non-Linux, missing perms), the system **falls back to the
   current application-level checks and reports `application_validated`** — it never silently
   claims a stronger grade, and it never quietly drops to *no* checks.
8. Adversarial tests (see §5) race symlinks, directory replacement, mount changes, inherited
   descriptors, child processes, and resource exhaustion against the boundary and prove escape is
   prevented (on a platform where the broker is active) or honestly refused/downgraded elsewhere.

Non-goals: Windows/macOS OS confinement in v1 (report `application_validated` there and design the
grade seam so they can be added later); a container runtime dependency (namespaces/`openat2`
directly, zero new runtime deps — see §8 of roadmap 01); remote attestation (that is LR-NH-03/06).

---

## 1. The invariant that dominates this design

**Never collapse the grades into a boolean, and never over-claim.** The single worst outcome is a
`verified`/`sandboxed` signal that says "OS-confined" when only application checks ran — that is
the false-confidence failure the whole LR-NH series exists to prevent (see `handoff.md` §4.2: "a
safeguard that is documented but not wired is worse than none"). Every result carries the *actual*
grade that applied. A test must prove that a run on a platform without the broker reports
`application_validated`, not `os_confined`.

---

## 2. Where it plugs in (integration points)

- `packages/arbor-mcp/src/native-tool-host.ts` — the current enforcement: `existingPath`/
  `writablePath` canonicalization, `realpathSync` symlink rejection, `inside(root, …)` containment,
  `sensitive()` path-class denial, and the sanitized-env `spawn` in the command path. These become
  the **fallback layer**. The broker wraps or replaces the raw `fs`/`spawn` calls with
  descriptor-relative, OS-confined equivalents when active.
- `packages/arbor-mcp/src/worktree-machine-verifier.ts` — `LocalBoundedVerificationCommandPort`
  (the `spawn` with `env: { PATH }`, SIGTERM→SIGKILL, output/time bounds). This is the model for
  a bounded command runner; the sandboxed runner is its OS-confined sibling behind the same
  `MachineVerificationCommandPort` interface, so the verifier composes either.
- The native execution policy (`native-agent-executor.ts` `executionPolicy()` + the
  `allow_unisolated_shell_network` flag from the network-policy work): today `network_allowed:
  true` is honest-but-unisolated. With this sandbox, network denial becomes *enforceable*, so the
  policy can express `network: "os_denied"` and the tool host can admit shell under it.
  **NOTE:** `native-agent-executor.ts` and `cli.ts` may be under concurrent change — coordinate
  with the integrator; prefer to land the broker + tool-host/verifier seams first and thread the
  policy grade in a small, separate follow-up commit.
- Capability reporting: extend the existing `CapabilitySupport`/tool-evidence surface
  (`protocol.ts` `NativeToolExecutionEvidence`, the session capability negotiation) with the
  confinement grade — additively, as a closed enum.

## 3. Suggested structure

```
packages/arbor-mcp/src/sandbox/
  contracts.ts        # closed grade enum, sandbox policy shape, bounds
  sandbox-broker.ts   # detects platform capability; hands out a confined executor or the fallback
  linux-openat2.ts    # descriptor-relative, beneath-root fs ops (RESOLVE_BENEATH/NO_SYMLINKS)
  linux-namespaces.ts # mount/user/network namespace setup for the command runner (optional v1: guard)
  confined-command.ts # a MachineVerificationCommandPort-shaped runner that execs under the sandbox
  fallback.ts         # the application-validated path (delegates to today's checks), grade reporting
```
- The broker is the one place that decides "can I OS-confine here?" and returns either a confined
  implementation (reporting `os_confined`) or the fallback (reporting `application_validated`).
- Tool host and verifier take the executor from the broker; they do not each re-detect capability.

## 4. Gotchas
- **`openat2` is Linux-and-recent-kernel only.** Detect at runtime; `ENOSYS`/`EINVAL` → fall back
  and report `application_validated`. Never assume it exists.
- **User namespaces may be disabled** (some hardened distros). Detect; fall back honestly.
- **A raced symlink is the canonical exploit.** `realpathSync`-then-`open` is a TOCTOU window; the
  whole point of `openat2 RESOLVE_BENEATH` is to close it by resolving atomically relative to a
  dirfd. Your adversarial test must actually race a symlink swap and prove the confined path wins.
- **Do not remove the current checks.** They are the fallback and defense-in-depth. Deleting them
  when adding the broker would regress every non-Linux/perms-restricted deployment to *no* checks.
- **Zero new runtime deps** (roadmap 01 §8). `openat2`/namespaces via `node`'s syscall surface or a
  tiny bounded native binding you build — if you cannot do it without a dependency, STOP and report;
  this may be the one roadmap where the honest answer is "a reviewed native addon is required", and
  that is a decision for the integrator, not a silent `bun add`.
- **`npm run build` is the type gate; bun for installs; structural redaction.** (roadmap 01 §8.)

## 5. Tests
- Adversarial (on a broker-active platform): symlink swap race, directory-component replacement,
  bind-mount change, inherited-descriptor leak, fork-bomb/child-process containment, memory/CPU/
  output/time exhaustion — each is *contained* and reported, never an escape.
- Grade honesty: broker-unavailable → `application_validated`; broker-active → `os_confined`; a
  result never claims a grade stronger than what ran.
- Fallback equivalence: with the broker disabled, every current native-tool-host test still passes
  (the fallback is behavior-preserving).
- Network: with OS network denial active, an egress attempt from `shell.execute` fails at the
  boundary; with it unavailable, the tool is refused (today's honest behavior), not silently run.
- Full suite green.

## 6. Feature-branch workflow
Same as roadmap 01 §10. Branch `feature/os-backed-sandbox`. Because this changes the meaning of a
safety-relevant signal (confinement grade) and the enforceability of the execution policy,
**write an ADR** (relate it to the network-policy ADR and LR-NH-04/07). The integrator will hard-
review the adversarial tests and the grade-reporting honesty before merge — that review is the
safety gate. Land the broker + tool-host/verifier seams first; thread the execution-policy grade
in a separate follow-up to avoid colliding with concurrent `cli.ts`/`native-agent-executor.ts` work.

---

## 7. Prior art & grounded design (arXiv 2025–2026 + competitive RE)

Sources: `docs/research/frontier-gap-literature-2026.md` (Gap 20). The two design-driver papers
below were read in full (method sections), not abstract-only; the Codex mechanisms are from the
competitive-RE brief. The OS-confinement layer (§2–§5 above) is *one* of three layers this gap
needs; the literature supplies the other two.

### 7.1 The privilege model beneath the boundary — Progent (arXiv:2504.11703, read in full)
OS confinement answers "can this process touch the filesystem/network?"; it does **not** answer
"is *this specific tool call* authorized?". Progent supplies the second layer and it maps onto
revoy2 almost exactly:
- **Privilege = a symbolic policy of `allow`/`forbid` rules over the tool name + its *typed*
  arguments** (conditions: comparison, membership `in`, regex `match`, array length, wildcards).
  revoy2's `high_risk_tool_scope` (`write_paths`, `command_argv`) **is already this shape** — a
  per-action symbolic authorization over typed args. Adopt Progent's *enforcement algorithm*:
  gather rules targeting the tool, evaluate **forbid-before-allow**, and **default-deny** (no
  matching rule → block) with a fallback that returns an *agent-readable feedback message*
  ("call not allowed because …; try other tools/args") rather than a silent failure — the paper
  shows this feedback lets the agent recover and still complete the benign task.
- **Monotonic confinement is the property to steal.** The authorized scope may *narrow*
  mid-session automatically, but any *expansion* requires explicit re-approval; the check is a
  deterministic subset test `A(P') ⊆ A(P)` (Progent uses Z3; revoy2's scopes are simple enough
  for a hand-rolled subset check — an SMT dep is **not** required and would violate §8-zero-deps).
  This guarantees `A(P⁰) ⊇ A(P¹) ⊇ …` — the action space can only shrink without approval, which
  is exactly the confinement guarantee the grade enum should reflect. Evidence: AgentDojo attack
  success 39.9%→1.0%, and **only 6% of updates needed approval** (low operator burden).
- **Layer generic (operator/org) policies above the task policy with priority ordering** — a
  higher-priority deny cannot be overridden by a task-specific allow. This is the natural home for
  revoy2's role/waiver governance, and composes with the gate spine.

### 7.2 Secret mediation for the confined executor — CapSeal (arXiv:2604.16762, read in full)
A confined process that still holds raw credentials (env vars, files, forwarding sockets) can
both *use and exfiltrate* the same bearer secret. CapSeal's answer — and revoy2 already has the
seed of it in its 10-minute MCP credential broker:
- **The broker is the sole ingress across the trust boundary** (TCB = broker + policy engine +
  execution layer + audit log; the agent is untrusted). Generalize revoy2's MCP credential broker
  to a **capability broker for every secret-bearing tool** (`shell.execute`, `verification.run`,
  MCP HTTP/SSH).
- **6-stage lifecycle:** `register` (session established, **UDS peer-credential binding** so a
  capability handle is cryptographically useless outside its session/process) → `req_cap`
  (declare intent + scope, policy-evaluated, optional step-up) → `invoke` (validated:
  **anti-replay** = monotonic seq + nonce + ms-timestamp + call quota, TTL, scope) → `revoke` →
  `audit.prove` (chain into the append-only ledger — a natural fit for revoy2's hash-chained
  audit).
- **Secrets are non-exportable; the agent gets a capability, never the credential.** HTTP
  capability = a *constrained request constructor* (scope pins method/host/path + a JSON-schema
  body ref; broker injects the token internally, strips caller-supplied auth headers, validates
  the body, fail-closed). SSH = a **broker-exec** model (host/user allowlist, `command_prefix`
  template, `max_arguments`, **`known_hosts_pin`**, forwarding forbidden) — never a signing
  oracle. This is the concrete design for admitting network-bearing tools *safely* (the §0.5 goal
  of running shell/verification/MCP instead of refusing them).

### 7.3 The per-platform OS primitive map — Codex (competitive RE)
Codex is the one shipping harness with real OS enforcement, and its per-platform binding is the
clearest spec to reimplement for §2–§4's `os_confined` grade:
- **Linux:** `bubblewrap` (`bwrap`) + `seccomp`, with **Landlock** as the compatibility fallback
  (validates this roadmap's `openat2`/namespaces direction, and the Landlock fallback tier).
- **macOS:** Seatbelt sandbox profiles. **Windows:** dedicated lower-privilege sandbox users +
  filesystem ACLs + firewall rules. These populate the future non-Linux grades §0 defers.
- **Tiered model** (`read-only` / `workspace-write`-with-approval / `full-access`) with **network
  disabled by default in the most-privileged remote posture** — directly corroborates the grade
  enum and the "network denial must be enforceable" requirement (§0.5). revoy2 today refuses these
  tools honestly; Codex proves the tiered *enforce-able* model is achievable without a container
  runtime dep.

### 7.4 Why allowlist-only, and a required audit metric — Balkanization (arXiv:2607.05743) + overprovisioning (arXiv:2604.11839)
The survey systematizing 39 execution-security papers reports **denylist/blocked-pattern
enforcement fails 69–98% of the time under adversarial retest**, confirms **4 CVEs against
production agent harnesses**, and names **policy-author error** and **benign-but-out-of-scope
actions (up to 17.1%)** as unaddressed classes. Consequences for this roadmap:
- Keep the model **default-deny allowlist + deterministic gate** (which §1 already implies) — never
  ship a denylist as the primary control. revoy2's app-level allowlist is a *complement* to the OS
  boundary, never a substitute.
- Add an explicit **overprovisioning-ratio audit metric** (granted-vs-actually-invoked capabilities
  per session): 2604.11839 measured a ~15× overprovision ratio against a real runtime. This is a
  cheap, high-signal ledger metric revoy2 can emit for free from its existing tool-audit records,
  and it directly measures whether the confinement is doing its job.

### 7.5 Shared substrate note
The **propose-then-verify gate** in §7.1 is the *same primitive* roadmap 06 builds its hook/
lifecycle bus on (an LLM proposes a tool call; a deterministic gate authorizes before commit).
Build the symbolic-policy + monotonic-confinement engine once, in a shared module, and let both
the sandbox (this roadmap) and the hook bus (roadmap 06) consume it — do not implement it twice.
