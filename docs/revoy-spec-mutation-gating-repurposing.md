# Repurposing revoy-spec's Mutation-Gating & Governance for revoy2

**Date:** 2026-08-03
**Source reviewed:** `revoy-spec` (`master`, remediation/wave-4) — specifically
`revoy/edit/{core,mcp_edit,owned_artifacts}.py`, `revoy/q/capability.py`,
`revoy/mcl/capability.py`, `revoy/modes/{discipline,plan_gate}.py`,
`plugin/hooks/hooks.json` + hook scripts, `governance/*.json`, `.mcp.json`.
**Brief:** what can be repurposed here for *mutation gating + governance that
mechanistically forces compliance*, plus an **internal-only MCP** that makes
those actions painless, predictable, and fully scripted for the agent.

Every claim below is verified against the actual revoy-spec source — not
inferred. The honest framing: revoy2 *already owns* several of these primitives
(provenance-as-type, capability tiers, process gates, hash-chained ledger,
worktree isolation). The repurposable value is therefore **not** "adopt the
concepts" but the specific *mechanisms* revoy-spec built that close the gaps
revoy2 still has.

---

## 1. Quick gap map — what revoy2 has vs. what revoy-spec adds

| Concern | revoy2 today | revoy-spec mechanism that fills the gap |
|---|---|---|
| Parallel/conflicting file edits | Multiple phase worktrees + sessions; no CAS on ledger/ROADMAP writes | **Hashline CAS edit** (`revoy/edit/core.py`) |
| Raw writes to owned state | JSONL/SQLite ledgers + ROADMAP phase block are hand-editable | **Owned-artifact classification** (`owned_artifacts.py`) |
| Enforce scope at mutation, not read | Capability tiers gate *reads*; write gating is advisory | **`enforce_action()` hard-raise before side effect** (`q/capability.py`) |
| Least-privilege, no-drift authority | Ambient tier checks at call time | **Checkout-minted, expiring, tamper-evident capability tokens** (`mcl/capability.py`) |
| Scope = declarative boundary | Remove-phase concerns only in `ROADMAP.md` prose | **Memory/footprint `covers()` gate** consulted by BOTH hook and MCP |
| Write-lock per plan/preview mode | No mode-scoped write lock | **`plan_gate` mode write-lock** (`modes/plan_gate.py`) |
| Anti-stub, honest "done" | Task-supervisor exists; no obligation check | **TodoObligation discipline check** (`modes/discipline.py`) |

---

## 2. The mechanisms worth repurposing (ranked by value ÷ effort)

### M1 — Content-hash CAS edit ("hashline") — HIGH value, LOW effort
`revoy/edit/core.py` + `mcp_edit.py`: `hashline_read` returns the file's SHA-256
digest; `hash_edit(file, old, new, expected_hash)` writes **only if the current
hash matches**, else `STALE_HASH`. This turns a silent parallel-worktree clobber
into a loud, retryable error.

**Why repurpose:** revoy2 *already runs* parallel phase worktrees (we manage 8 of
them) and multiple sessions. Two sessions editing the same `ROADMAP.md` /
`docs/tui-cockpit/roadmap.md` / `.redis`-adjacent state can silently clobber.
The CAS makes concurrent mutation safe and *mechanically* predictable.

**Mechanical-compliance property:** the agent *cannot* blind-write; it must
read→edit→verify-hash→retry after any concurrent change. Compliance is forced
by the write primitive itself, not by a prompt rule.
**Repurpose:** a TypeScript `@arbor/edit` module (stdlib `crypto`) + an MCP tool
pair, ~200 LOC. Mirrors revoy2's existing content-addressing idiom.

### M2 — Owned-artifact classification — HIGH value, MEDIUM logic
`owned_artifacts.py`: classifies a path as (a) a `.jsonl` ledger under `.revoy/`,
(b) a generated view (`revoy.md`/`DEFERRALS.md`), or (c) the ROADMAP phase block
(via `<!-- revoy:begin -->`…`<!-- revoy:end -->` markers + old/new string
overlap). Returns a human reason; each caller decides advisory vs. deny.

**Why repurpose:** revoy2's JSONL/SQLite KB+audit ledgers and its ROADMAP phase
block are exactly these "owned" artifacts. A raw `Edit`/`Write` in a phase
worktree can splice the phase block or hand-edit a ledger — bypassing the
owning verbs. Repurposing the classifier lets revoy2 say: *"mutate the ledger via
`recordCompactionLifecycle`/`recordNodeCommunication`, never a raw write."*

**Mechanical-compliance property:** the mutation path knows it's touching owned
state and either routes to the verb or refuses. Enforcement is structural, not
prose.

### M3 — `enforce_action()` hard gate before side effect — HIGH value, LOW effort
`q/capability.py`: `enforce_action(action_class, cap, action)` **raises
`CapabilityError` before the mutation** for `preview-confirm` (mutating) actions
unless the caller holds `senior`. `forbidden` is never allowed, period. The
mutation MCP (`hash_edit`) calls it first — proof it's wired.

**Why repurpose:** revoy2 has capability *tiers* that gate *reads* (envelope
redaction), but write paths don't have a single hard-raise gate. This is the
"mechanistically forces compliance" ask in one function: a mutating call
without the right tier cannot happen, not merely "shouldn't."

### M4 — Checkout-minted, expiring, tamper-evident capability tokens — MED/MED
`mcl/capability.py`: at concern-checkout, mint a token snapshotting
`code/role/holder/footprint/allowed_actions/entitled_action_classes/ttl`. The
token is content-hashed (`token_id`), `alive(now)` enforces TTL (default 1h),
`is_tamper_evident()` catches hand-edits, and `covers(path, action)` is the ONE
gate. Enforcement only *reads* the token — never re-derives from ambient state.

**Why repurpose:** ADR-106 T5's "bind to what was reviewed at checkout, not
ambient session state" is the anti-drift property revoy2's ambient-tier checks
lack. For revoy2's dynamic NodeCard capability routing this is a natural fit: a
scope/concern checkout mints a bounded token the gates consult.

### M5 — Plan-mode write-lock (`plan_gate`) — MED value, LOW effort
`modes/plan_gate.py`: per-mode write lock; additive; fails open. Repurposes to
revoy2's `Taproot` (planning) vs. `Heartwood`/`Seed` (doing) split — a
"planning mode cannot mutate" write-lock is a cheap, mechanical floor.

### M6 — TodoObligation discipline check — MED/HIGH value, MED effort
`modes/discipline.py`: a mode declares `must_enumerate_before_work`,
`may_claim`/`may_complete`, and `forbid_silent_complete`. `check_discipline`
verifies real todo records honor them ("architect/planner must enumerate before
implementing"; "a reviewer cannot silently complete an implementation todo").

**Why repurpose:** revoy2's `task-supervisor` + botanist agents map directly.
Forbidding a docs/review mode from silently completing an implementation task is
the anti-stub/anti-gaming guarantee — mechanical, not just a critic rule.

### M7 — The DUAL-PATH gate (hook AND MCP consult the same `covers()`) — the key insight
The single most influential pattern: `_footprint_deny_reason` and
`_owned_artifact_deny_reason` exist **because** the PreToolUse hook only matches
`{Edit,Write,MultiEdit}` and an MCP write tool would otherwise be a second,
ungated write path. revoy-spec closes that by making the **MCP write tool
consult the same gate the hook consults**. This is the blueprint for the
internal MCP brief: don't add a second mutation backdoor — gate both paths with
one function.

---

## 3. The internal-only MCP: making it painless, predictable, scripted

revoy-spec already runs **8 stdio MCP servers** (`q`, `dispatch`, `signal`,
`edit`, `edit-lsp`, `lsp`, `prov`, `spine` — see `.mcp.json`), each small,
stdlib-only, JSON-RPC 2.0 over stdio. The properties that make them "painless,
predictable, completely scripted for the agent" — and the blueprint for revoy2's
internal MCP:

1. **One write surface, capability-gated:** `hash_edit` is *the* mutation tool;
   `hashline_read` is *the* read tool. The agent learns two tools, not a sprawl.
2. **Structured, machine-parseable errors:** `CapabilityError` → JSON-RPC
   error `-32001` with a typed data payload; `STALE_HASH`/`MATCH_ERROR`/`ENFORCED`
   are string-prefixed so the agent pattern-matches and picks the retry path.
   This is the "completely scripted" part — an error tells the agent *exactly*
   what to do next (re-read → re-hash → retry; or extend footprint).
3. **Gate-before-write ordering:** `enforce_action` runs before any mutation;
   footprint/owned-artifact checks return a deny payload before the write. The
   agent never half-mutates then discovers a violation.
4. **Fail-open/fail-closed is documented per gate** — footprint fails open,
   token least-privilege fails closed. Predictability requires knowing which
   posture each gate takes.
5. **Deterministic, stateless, scriptable:** stdio JSON-RPC, no daemon, no
   process boundary — a shell script can drive it. This matches revoy2's
   existing "pure module + stdlib" style and its `command/query` catalog.

**Recommended revoy2 internal MCP shape** (a `@arbor/mcp` "edit/gate" toolset,
or a sibling `@arbor/ops` server — do **not** bolt into the existing public MCP
which is surface-facing):
- `ops.read(path)` → hashline envelope (hash + line ids) [read, junior]
- `ops.edit(path, old, new, expected_hash, scope_token?)` → CAS write, gated:
  `enforce_action("preview-confirm", cap)` → `owned_artifact_reason` →
  `token.covers(path,"edit")` → write; structured error otherwise
  [mutation, senior]
- `ops.scope.checkout(footprint_globs, allowed_actions, ttl)` → mint capability
  token [mutation, senior]
- `ops.guard.status(scope)` → reconcile guard from durable facts (revoy2's
  existing no-marker-authority idiom)
- `ops.discipline.check(mode, todos)` → TodoObligation verification [read]

Each is a thin projection over existing revoy2 modules (`@arbor/edit` new,
`token-epoch-service`, `task-supervisor`, `evidence-ledger`, `runtime-catalog`)
— the same "pure function, no new authority" posture revoy-spec uses.

---

## 4. Order of repurposing (dependency-aware)

1. **`@arbor/edit`** (M1) — CAS edit core. Standalone, stdlib, ~200 LOC, tests.
2. **`owned_artifacts.ts`** (M2) — the classifier; classify revoy2's ledgers +
   ROADMAP phase block.
3. **inner `enforce_action`** (M3) into the runtime command/query catalog —
   hard-raise for mutating kinds (`compaction.write`, `a2a.send` already exist,
   but give them a shared pre-mutation gate).
4. **capability-token mint** (M4) at concern/scope checkout — optional but the
   anti-drift binding.
5. **`plan_gate`** (M5) + **discipline check** (M6) — the mode/write floor.
6. **Dual-path wiring** (M7): make the internal MCP edit tool and the (future)
   PreToolUse-equivalent consult the same `covers()`, so no second backdoor.

Steps 1–3 are the highest leverage and fully mechanical against today's revoy2;
4–6 layer the anti-drift, mode-floor, and no-backdoor guarantees.

---

## 5. Bottom line

revoy-spec's mutation-gating is **repurposable at the mechanism level, not the
concept level** — revoy2 already believes in provenance, tiers, gates, and
hash-chaining, but its *write paths* lack the three things revoy-spec
mechanically nails:

1. **A CAS edit primitive** so concurrent/parallel edits are safe and
   deterministic (M1),
2. **A hard, pre-mutation capability gate** so a mutating call without the right
   tier is impossible, not discouraged (M3), and
3. **A single `covers()` gate consulted by every write surface** (hook + MCP +
   tool) so there is no second backdoor (M7).

Wrapped in an **internal-only stdio MCP** (read/edit/scope/discipline tools,
structured errors, gate-before-write, scriptable) — exactly the shape
revoy-spec already runs with its 8 servers — these three mechanisms turn "the
agent should comply" into "the agent cannot do otherwise, and the error tells it
exactly how to proceed." That is the entire brief, mechanized.
