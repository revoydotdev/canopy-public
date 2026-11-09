# Historical review package — `feat/adr-governance-control-plane`

> **Archive status (2026-08-09):** This is a point-in-time review of the
> governance-control-plane branch, not a release report for current `master`.
> Its commit counts, test results, waiver inventory, and A2A observations are
> historical evidence only. Current release work is governed by
> `docs/release-readiness.md`, `ROADMAP.md`, the checked-in gate scripts, and
> the exact candidate's gate output. Current `master` includes ADR-040's
> host-composed signed ingress, but still claims no public HTTP/SSE/A2A/MCP/
> OpenCode transport or PKI deployment.

**Date:** 2026-08-06
**Base:** `master` @ `e9422fc`
**Head:** 72 commits, 250 files, +26,945 / −3,179

**Verification at head** — build 0 errors; 184 test files / 2,335 tests passing;
all eight gates (`reachability`, `docs-truth`, `lockfile`, `typecheck-tests`,
`anti-stub`, `registration-integrity`, `closed-enum-hygiene`,
`branch-accounting`) PASS; reachability reports zero unused allowlist entries.

This document oriented the branch reviewer. It does not replace reading the
diff, and it is explicit about what had *not* been verified.

---

## 1. What this branch is for

Two threads, landed together because they kept colliding:

1. **ADR-027's governance control plane** — placing governance events on the
   existing `EvidenceLedger` rather than a parallel mechanism, plus ADRs 024–029.
2. **Retiring reachability waivers** — the allowlist went **77 → 59** entries.
   Every retirement is either a wiring (the symbol now has a real caller) or a
   deletion (the symbol duplicated something already implemented). No waiver was
   retired by renewing its expiry.

---

## 2. Where to look first

Ranked by how much damage a mistake would do.

| Priority | Area | Why |
|---|---|---|
| **1** | `ADR-029` one-writer enforcement (`76edd73`, `207f54c`) | New process-level lock on the persistence directory. A false positive bricks startup; a false negative is the corruption it exists to prevent. |
| **2** | Ledger fsync durability (`00866b8`) | Fixes a window where a **gate checkpoint authorized an ADR-006 governed transition against evidence a restart would erase**. Reproduced against a real ledger with a real `EACCES`. |
| **3** | A2A signing secret (`a117411`, `c2c682c`) | Cards were signed with a public literal. Now requires a real secret — a deployment-breaking change if a secret is not provisioned. |
| **4** | `verifyChain` / `verifyScopedChains` deletion (`6b8f10a`) | Deleting a *verifier* always deserves a second look. Rationale in §4. |
| **5** | Merge resolution (`458e162`) | 72-commit branch reconciled with an extraction of its own tip. See §5. |

---

## 3. Waiver retirements — 18 net

Retired by **wiring** (symbol now has a real caller):

- `resizeTerminal` → `TuiShell`. This fixes a real bug: `NavigationModel` was
  built once at launch and never revisited, so **resizing the terminal did
  nothing until restart**.
- `TerminalPainter`, `paintTargetFromRenderFn` → `renderTerminalFrame`, which
  had been duplicating the painter's join/ANSI-wrap inline.
- Six governance identity/scan symbols → `scanDecisionsCorpus`.

Retired by **deletion** (duplicated something already implemented):

- `verifyChain`, `verifyScopedChains` — see §4.
- `reconcile` (artifact lineage) — no two-snapshot workflow exists; every
  consumer does one fresh scan per call.
- `JsonPainter` — `arbor://frame` already serves its frame through the generic
  resource-serialization path every other `arbor://` resource uses.
- Six TUI navigation mutators (`pushWorkspace`, `popWorkspace`, `replacePanes`,
  `openModal`, `closeModal`, `moveFocus`) — the only candidate callers build one
  static single-pane model and never mutate it. Wiring them would have meant
  inventing the feature, not connecting it.

---

## 4. The one deletion to argue with

`verifyChain` / `verifyScopedChains` re-derived the identical per-record
continuity walk and the same `sha256(canonicalizeForHash(record minus
content_hash))` recipe that `EvidenceLedger.verifyIntegrity` already implements.

ADR-027 Decision point 1 states a fifth canonicalizer "is a governance
violation, not a refactor", and Alternative 3 rejects "a separate chain
implementation" by name.

**The reviewer's question should be:** was any *behavior* unique to the deleted
pair — a scope, an ordering, an error class — that `verifyIntegrity` does not
provide? The claim made here is no. It is the claim most worth attacking.

---

## 5. Two things the reviewer should not have to discover

**The merge reported clean and was not.** `458e162` reconciles this branch with
`e9422fc` on master, which is this branch's own tip content extracted so it
could land independently. Git auto-merged `arbor-core/src/index.ts` by keeping
**both** copies of the `canonicalizeForHash` re-export — 28 `TS2300` errors and
131 failing test files from a merge git called successful. Caught and fixed
inside the same commit. A merge that git calls successful is a claim about text,
not about the build.

**A corruption report that was a false positive.** During this work an agent
reported `identity.ts` corrupted by `ENOSPC`: one null byte, git showing a
binary diff, size changed. All three observations were accurate and the
conclusion was wrong — the null byte is a deliberate `NUL` delimiter in a
composite key (`` `${kind}\0${symbol_id}` ``), which is exactly *why* git
classifies the file as binary. Acting on that framing without checking where the
byte was, a repairing `checkout` ran against a full disk and truncated the file
to zero. The only real damage was self-inflicted, and it reverted one legitimate
edit — `identitiesEqual` therefore keeps its waiver.

---

## 6. Known limitations

- **`identitiesEqual`** retains a waiver that should have been retired; the edit
  removing it was lost to the incident in §5 and was not redone.
- **ADR-028 is `Proposed`, not accepted.** 12 of the 59 remaining waivers
  (`G-14`, capability enforcement) are blocked on it. Their expiry is
  deliberately tied to that decision: *if ADR-028 is still undecided at
  2026-09-04, escalate — do not renew.*
- **The A2A server transport has never been exercised against a live
  `opencode serve`.** Coverage is hermetic. See gap register `G-09`, which was
  itself corrected on 2026-08-04 for asserting a stronger, false claim.
- **The clean-room reports are held back but remain in git history** (5 commits,
  back to `04e460d`). If they must never be publicly retrievable, a history
  rewrite is required before the repository goes public. Not performed.
- **`docs/full-harness-ownership-brief.md` and
  `docs/tui-cockpit/research-synthesis.md`** touch the same clean-room material
  more lightly and have not been reassessed.

---

## 7. Remaining waivers — 59

| Count | Tag | Blocked on |
|---:|---|---|
| 12 | `G-14` | **ADR-028 — an operator decision** |
| 12 | `DEFERRED-WAVE1-TUI-CONTRACTS` | wire-or-delete |
| 10 | `DEFERRED-WAVE1-LOOP-AS-JOB` | wire-or-delete; original premise expired in fact |
| 7 | `G-32` | registered gap |
| 4 | `G-06`, 4 `G-29`, 3 `RECOMMEND-DELETION`, 2 `G-11`, 5 other | registered gaps |

The `LOOP-AS-JOB` group is the most honest thing in the allowlist and worth
reading: its waivers state plainly that the lane which was supposed to reach
them completed without doing so, that the premise "has expired in fact, not
merely by date", and that renewing again without a decision "is exactly the
drift this gate's dated expiry exists to prevent."
