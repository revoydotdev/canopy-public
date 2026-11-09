# ADR-191: Verifier Commands Run Without Host Network Unless The Operator Grants It

**Status:** Accepted
**Date:** 2026-10-07
**Authoring Revision:** abb0abc0fa37b744f8140bfc3803572a94657299
**Content ID:** sha256:da2d432e8c938d8f9b1a24c2f4f8c5802c5622cad4a13d329c6acc9ab7f68d48

## Context

Authored as Proposed: the implementing agent does not hold acceptance authority. This record amends ADR-102 (sandbox confinement is cross-platform), which defined *how* `network_denied` is enforced but left *who* asks for it to each composition site. It records the operator decision of 2026-10-06.

A specialist's own tools (`shell.execute`, `verification.run`, `evidence.refresh`) already run network-denied: `native-tool-host.ts` passes `network_denied: true` to the sandbox broker, which gives the process a private network namespace (`--unshare-net`) with only its own loopback brought up. The verifier did not. `createDeclaredOutputsVerifier` in `packages/arbor-mcp/src/cli.ts` composed every command it ran -- the plan-declared or project-configured acceptance commands, the declared-outputs check -- with `network: "unrestricted"`, and so did the generated-oracle amplifier, the mutation probe's acceptance command and its killer tests. `SandboxedVerificationCommandPort` maps `unrestricted` to `network_denied: false`, so bubblewrap shared the host network namespace. The verifier runs those commands in the specialist's writable worktree, so a specialist-written test executed with host network: it could reach anything bound on the host's 127.0.0.1 (a database, an agent socket over TCP, the harness's own services) as well as the internet. The verifier is the one place where specialist-authored code runs with no model in the loop to refuse it.

Some acceptance commands genuinely need egress. `cargo test` in a repository that commits no Cargo.lock file must resolve and fetch crates before it can build; `npm install` / `pip install` steps likewise. The 1.0.0 external cohort's Rust member (`dtolnay/semver`) is such a case.

## Decision

1. **Every verifier command defaults to `enforced_denied`.** `createDeclaredOutputsVerifier` composes acceptance commands and the declared-outputs check through `verifierNetworkFor` (`packages/arbor-mcp/src/sandbox/confined-command.ts`), whose default is `{ network: "enforced_denied" }`. The broker runs them in a private network namespace with its own working loopback: a test that binds and dials its own localhost server still passes, but nothing reaches the host's network, including services on the host's 127.0.0.1. Model-generated tests (the amplifier's generated test, the mutation probe's killer tests) are pinned to `enforced_denied` unconditionally and never consult a grant.

2. **Egress is an explicit, operator-authored, exact-argv grant: `verification.network_egress`.** The project config (`arbor.jsonc`, any config layer, file-only -- arrays are not env-overridable) may list `{ "argv": [...], "reason": "..." }` grants. A verifier command gets `network: "unrestricted"` only when its argv is element-for-element equal to a granted argv. Nothing is inferred from the command text: a prefix, an extension, or a differently spelled executable path of a granted argv stays denied. `validateConfig` rejects a grant with an empty or malformed argv, a missing, blank, multi-line or over-200-character reason, an unknown key, or a duplicate argv. A plan cannot grant itself network; only the operator's config can. An authored plan command whose argv equals a granted argv receives the grant, because the grant names the command, not who declared it.

3. **The grant is recorded in the verification evidence.** A stage that runs under a grant carries `network_egress: { reason }` on its `WorktreeVerificationCommand`; `WorktreeMachineVerifier` refuses an egress record on a command that is not actually `unrestricted`, or one with a blank reason. The stage's evidence label becomes `<command> [network:egress reason="<reason>"]`, and that label is the verified provenance `cmd` -- the durable record the ledger, KB, critic and UI read. Both the verified and failed outcomes also carry `network_egress: [{ display, reason }]` for every stage attempted under a grant.

4. **Egress-allowed commands are NOT denied host loopback (residual risk, stated plainly).** The existing sandbox machinery offers two states: a private namespace with no external route, or the host namespace. Outbound-only egress that still excludes host loopback needs a user-mode network stack (for example `pasta --no-map-gw` or `slirp4netns`) placed between a private namespace and the host. Neither is part of the sandbox broker today, neither is a declared dependency, and wiring one in -- plus probing for it and degrading honestly when absent -- is not cheap. So a granted command runs in the host network namespace and can reach the host's loopback services: allow-with-record. The record makes the exposure visible and reviewable per command; it does not reduce it. A follow-up decision can add a user-mode-NAT rung to the broker.

5. **The external cohort declares its one egress need.** `docs/release-acceptance-1.0.0/external-cohort.json`'s `semver` member carries `acceptance_network: { mode: "egress", reason }`. The cohort runner translates that into the run's `verification.network_egress` grant for the member's exact `acceptance` argv; the other two members need no network and declare none.

## Consequences

A specialist-written test can no longer reach a host-loopback service or the internet during verification unless the operator granted that exact command. Tests that use localhost for in-process IPC are unaffected on Linux.

Hosts where the broker falls to the `application_validated` floor (no usable bubblewrap) can no longer run verifier commands unconfined: a denied command now returns `network_isolation_unavailable` and fails verification, exactly as a specialist's own tool call already does there. That is fail-closed by design; an operator on such a host must either provide bubblewrap or grant the command egress, and the grant is then recorded.

On macOS the Seatbelt profile denies every `network*` operation when network is denied, including loopback, so a localhost-binding acceptance test fails there under the default. The Linux in-namespace-loopback guarantee does not extend to macOS.

The failed-outcome `network_egress` field is produced by the verifier, but the executors (`native-agent-executor.ts`, `packages/arbor-mcp/src/integrations/claude-code-campaign.ts`) persist only the verified provenance and the bounded failure fields; a failed run's grant is visible to an in-process consumer, not yet in the durable ledger. The mutation probe passes the grant through to its acceptance re-runs but records no evidence of it, since its findings are advisory notes, not verification evidence. `scripts/release-acceptance.mjs` does not yet validate `acceptance_network`.

## Alternatives / Roads not taken

**Infer egress from the command (`cargo`, `npm install`, `pip`).** Rejected by the operator decision: an inferred grant is a grant nobody made, and any command-text heuristic is something a specialist can shape.

**Declare egress on the plan's `high_risk_tool_scope`.** Rejected: on direct and reviewed tiers that scope is mined from task text or authored by a model planner, so a plan-level flag would let the proposer grant its own work network -- the checks-and-balances rule forbids it. Operator config is the authority.

**Keep `unrestricted` as the verifier default and deny only generated tests.** Rejected: the acceptance command is exactly where specialist-written test code runs, so that would leave the reported exposure in place.

**Add outbound-only NAT now.** Deferred, not rejected; see Decision 4.

## Obligations

### O1 — A verifier command is network-denied unless its exact argv is granted, and the grant carries its reason

`verifierNetworkFor` returns `enforced_denied` for no grant, an empty grant list, or any argv that is not element-for-element equal to a granted one, and returns `unrestricted` plus the declared reason only for an exact match.

<!-- proof: symbol=verifierNetworkFor file=packages/arbor-mcp/src/sandbox/confined-command.ts roundtrip=packages/arbor-mcp/tests/verifier-network-policy.test.ts -->

### O2 — Through the production verifier and a real bubblewrap sandbox, a default command cannot reach the host's loopback and a granted one can, with the grant in the verified provenance

The roundtrip drives `createDeclaredOutputsVerifier` with the default `SandboxedVerificationCommandPort` against a listener bound on the host's 127.0.0.1: by default the command fails with the listener having accepted nothing, a test binding its own localhost server still verifies, and with an exact-argv grant the command reaches the listener and the verified `provenance.cmd` contains `[network:egress reason="..."]`. Runs only where the broker resolves to `os_confined` (skipped otherwise).

<!-- proof: symbol=createDeclaredOutputsVerifier file=packages/arbor-mcp/src/cli.ts roundtrip=packages/arbor-mcp/tests/verifier-network-policy.test.ts -->

### O3 — The verifier refuses an inconsistent egress record and records every granted stage on failure too

`WorktreeMachineVerifier` rejects `network_egress` on a command whose `network` is not `unrestricted`, or with a blank reason, and a failed staged run carries the granted stage's label and reason on `network_egress`.

<!-- proof: symbol=WorktreeMachineVerifier file=packages/arbor-mcp/src/worktree-machine-verifier.ts roundtrip=packages/arbor-mcp/tests/verifier-network-policy.test.ts -->

### O4 — A malformed `verification.network_egress` grant is refused at config load

`validateConfig` rejects a non-array value, an empty or malformed argv, a missing, blank, multi-line or over-long reason, an unknown key and a duplicate argv, and the default config grants nothing.

<!-- proof: symbol=validateConfig file=packages/arbor-config/src/validator.ts roundtrip=packages/arbor-config/tests/verification-network-egress.test.ts -->
