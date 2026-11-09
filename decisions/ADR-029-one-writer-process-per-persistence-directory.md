# ADR-029: One Writer Process per Persistence Directory

**Status:** Accepted
**Date:** 2026-08-05

**Decided in substance** on 2026-08-05 by revelri (repository owner), who chose
"single-writer, enforced" over multi-writer support, convention-without-
enforcement, and further deferral. It was authored as Proposed rather than
Accepted because POL-05 flags any record that arrives already accepted as never
having traversed the lifecycle — the rule exists so a decision has a reviewable
moment, and exempting the record that implements it would be the wrong
precedent.

**Accepted 2026-08-06** by revelri, on review, with no conditions. The
lifecycle POL-05 asks for was traversed: Proposed on 2026-08-05, reviewed and
accepted a day later as a separate act.

## Context

`saveLedger` (`packages/arbor-audit/src/persist.ts`) performs a read-modify-
append: it reads the persisted chain, verifies it, computes what to append
relative to that read, and appends. There is no locking anywhere in the
repository — a search for `flock`, `lockfile`, `.lock` and `pidfile` across
`packages/*/src` and `scripts/` returns only `lockfile-check.mjs`, which is the
npm **package-lock** drift gate and unrelated.

Two processes doing that against one directory interleave. The loser's append is
refused by the chain's own integrity check with "cannot append a discontinuous
audit chain" or "cannot overwrite persisted trace packet". Reproduced:

    B's append REFUSED: cannot overwrite persisted trace packet trace_2
    B's evidence on disk -> false   (silently dropped: no retry, no rebase)

That refusal keeps the ledger CORRECT — the file is never corrupted, and the
integrity mechanisms work exactly as designed. It is a liveness failure, not a
safety one. But none of the ~10 `saveLedger` call sites in `manager.ts` catch
the exception, retry it, or rebase onto the new tip, so the losing process's
evidence is simply gone. Evidence that was taken and then dropped is worse than
evidence never taken, because the ledger reads as complete in both cases.

**This is reachable, not hypothetical.** `arbor-mcp serve` (cli.ts:452) and
`webui` (cli.ts:466) each call `createCliRuntime(cwd, persistenceDir)`, which
constructs a fresh `ArborRuntime` and `CampaignManager` against a caller-supplied
directory. `campaign_id` is client-supplied free text with no server-side
uniqueness. The only two "already running" guards in the system —
`CampaignManager.startCampaign`'s `this.campaigns.has(id)` and
`ArborRuntime.runCampaignJob`'s `this.activeCampaignRuns.has(campaignId)` — are
in-memory maps private to one process. Nothing stops a leftover server from a
prior session, or a second editor's MCP client, from being pointed at the same
directory.

**Intra-process concurrency is separately not a risk**, and this record does not
claim otherwise: `saveLedger` is synchronous with no `await` inside the
read-verify-append sequence, so it is atomic with respect to Node's event loop,
and `runCampaign` dispatches sequentially. The hazard is strictly across OS
processes.

## Decision

**One writer process owns a persistence directory at a time, and this is
enforced rather than assumed.**

A long-lived server acquires an advisory lock file, .arbor-writer.lock
(`WRITER_LOCK_FILENAME` in `packages/arbor-core/src/writer-lock.ts`; the lock
file itself is created only while a server holds it, never checked in), in the
persistence directory at startup. If a live process already holds it, the server
refuses to start and exits with the registry's CONFLICT code, naming the holder
and the consequence. A lock whose recorded pid is no longer running is stale and
is reclaimed, so a hard kill does not disable a directory permanently. An
unparseable lock file is refused rather than reclaimed — we cannot show its
owner is gone, so deleting it would be fail-open on precisely the evidence we
lack.

Acquisition is atomic by construction: `openSync(path, "wx")` fails when the
file exists, so racing acquirers cannot both succeed. There is no
check-then-create window.

**Scope: writers only.** `serve` and `webui` acquire the lock; short-lived read
commands (`ledger verify`, `governance`, `audit`) deliberately do not, so
inspecting a directory a running server owns stays possible. The hazard is two
writers, never a reader alongside a writer.

**What this does not claim.** It is advisory between cooperating revoy2
processes. It cannot stop a process that ignores it, edits the ledger directly,
or runs as a user able to remove the file. Per ADR-025's ladder that is
PREVENTED for the case it covers — a second revoy2 server — and nothing at all
for an arbitrary writer, which is the same honest ceiling the tip sentinel and
sanctioned repair log already operate under.

## Consequences

**Positive.** The reachable evidence-loss path is closed at the point where it
becomes reachable, and the failure moves from silent and late (an append dropped
mid-campaign) to loud and early (a server refusing to start). It also settles a
question two independent audits raised and neither could answer: the deployment
model is now stated, so `saveLedger`'s per-append full re-verify can be justified
as defence against crash and corruption rather than against concurrency, which
is the premise its O(n^2) cost was previously deferred on.

**Negative.** An operator who genuinely wants two servers on one directory now
cannot have one, and must use separate directories. A crashed server leaves a
lock that the next start reclaims — correct, but it means a stale lock is not by
itself evidence of a running process, and an operator reading the file must not
treat it as such. The lock adds a failure mode of its own: a directory on a
filesystem where the lock file cannot be created now refuses to start a server
that would previously have run.

**Rejected: multi-writer support** (advisory locking plus retry-with-rebase at
every `saveLedger` call site). More faithful to what the architecture currently
permits, and strictly more work at every call site, for a capability nobody has
asked for. It can be adopted later without undoing this record — this decision
constrains the deployment model, not the ledger format.

**Rejected: convention without enforcement** (document the assumption, add no
lock). Cheapest, and exactly the "documented but not wired" shape this
repository treats as worse than nothing: it would create the belief that the
directory is protected while leaving the proven path open.

## Obligations

Each obligation is a claim this decision makes that a reader can check against
the working tree. A `proof` comment cites a symbol, the file declaring it, and a
test file that exercises it. Per `packages/arbor-governance/src/obligation/proof.ts`'s stated ceiling, a
resolving `roundtrip=` attests that the named test **exists and is collected by
vitest** — not that it passes, and not that it exercises this obligation. That
remains a human judgement; what the machine removes is the possibility of
citing something that is not there at all.

### O1 — Acquiring a directory that a live process already holds fails, rather than proceeding

<!-- proof: symbol=acquireWriterLock file=packages/arbor-core/src/writer-lock.ts roundtrip=packages/arbor-core/tests/writer-lock.test.ts -->

### O2 — A lock whose recorded pid is no longer running is reclaimed, so a hard kill does not disable a directory permanently

<!-- proof: symbol=acquireWriterLock file=packages/arbor-core/src/writer-lock.ts roundtrip=packages/arbor-core/tests/writer-lock.test.ts -->

### O3 — An unparseable lock file is refused rather than reclaimed, because its owner cannot be shown to be gone

<!-- proof: symbol=acquireWriterLock file=packages/arbor-core/src/writer-lock.ts roundtrip=packages/arbor-core/tests/writer-lock.test.ts -->

### O4 — Acquisition is atomic by construction, so racing acquirers cannot both succeed

<!-- proof: symbol=acquireWriterLock file=packages/arbor-core/src/writer-lock.ts roundtrip=packages/arbor-core/tests/writer-lock.test.ts -->

### O5 — The lock file is a named constant, not a literal repeated at call sites

<!-- proof: symbol=WRITER_LOCK_FILENAME file=packages/arbor-core/src/writer-lock.ts roundtrip=packages/arbor-core/tests/writer-lock.test.ts -->

### O6 — The CLI's writer surfaces (`serve`, `webui`) acquire the lock at startup, and read-only commands do not

`main` is cited rather than the module-private `takeWriterLock` it calls: the
resolver checks that a symbol is *declared or exported* in the cited file, and
deliberately does not chase call graphs. Exporting a private helper purely to
make a citation resolve would be shaping the code to satisfy the documentation,
which is the inversion this whole mechanism exists to prevent.

<!-- proof: symbol=main file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/cli.test.ts -->
