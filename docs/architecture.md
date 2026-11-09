# revoy2 architecture

revoy2 is a tree-search-as-cognition harness with provenance-typed governance. A unit of work is a node in a scored action tree, not a step in a prompt pipeline. Trusted transitions are durably witnessed before interfaces observe them.

## System shape

```text
operator / MCP client / remote host
               |
       CLI / WebUI / TUI / MCP
               |
      RuntimeCatalogRouter
               |
          ArborRuntime
   /       /       |       \
manager sessions evidence integrations
   |       |       |       |
tree    workers   ledger   signed adapters
   \_______ isolated worktrees _______/
```

Every surface projects one `ArborRuntime`. There is no Web manager, TUI manager, or remote manager with competing authority.

## Package boundaries

| Package | Responsibility |
|---|---|
| `@arbor/core` | Shared types, canonical hashing, UCT scoring, tree controller, persistence contracts, budgets, operations, events, supervision |
| `@arbor/harness` | Connector-neutral session/model/tool protocol, native worker, replay checkpoints, execution profiles, scoped credential leases |
| `@arbor/kb` | Provenance-typed, capability-gated knowledge with JSONL and SQLite persistence |
| `@arbor/gate` | Pure admission, isolation, evidence, and audit gates |
| `@arbor/audit` | Append-only, hash-chained evidence ledger and replay validation |
| `@arbor/config` | JSONC configuration, provenance-aware loading, validation, keymap grammar |
| `@arbor/prompts` | Botanical role templates and bounded context framing |
| `@arbor/tui` | Headless unidirectional UI core, screens, widgets, and renderer contracts; depends only on core |
| `@arbor/campaign-support` | Neutral campaign/worktree support extracted from upstream-specific composition |
| `@arbor/opencode` | Transitional OpenCode integration and remaining campaign-loop compatibility surface |
| `@arbor/mcp` | Canonical runtime, CLI, MCP, WebUI, TUI driver, distributed control, integrations, product services |
| `@arbor/eval` | Deterministic evaluation, trajectory economics, retrieval, and policy experiments |
| `@arbor/governance` | Architectural decisions, policy obligations, artifact identity, and repository claims |

`@arbor/core` imports no other internal package. `@arbor/harness` remains connector-neutral. Upstream-specific process/provider composition belongs in integration modules, not the runner.

## Tree execution

```text
plan -> select -> expand in isolated worktree -> specialist
     -> self-validation -> independent critic -> evidence gate
     -> verify and branch | record failure and backtrack
```

Crown selects with the production UCT scorer and coordinates work but does not write code. Seed and Heartwood execute within admitted scopes. Lenticel critiques without proposal authority. Failed approaches become provenance-typed KB entries that can inform later specialists. Campaigns halt on budgets, score threshold, convergence, explicit interruption, or terminal tree state.

### Per-action acceptance

Each action has a distinct acceptance mapping. A Specialist may run self-validation and submit its output, but that is the Specialist's evidence or claim, not independent verification. Lenticel then reviews the proposed action and its evidence without proposal authority; its approval is a critic decision, not a substitute for a verification command. A node becomes `verified` only when the evidence gate maps an admissible command or evidence record to `verified` provenance. A rejected review or failed verification closes that branch as a failure and makes backtracking available; it does not silently turn a partial result into an accepted outcome.

## Provenance and checks-and-balances

The closed provenance union separates:

- `verified`: command/evidence-backed truth;
- `claimed`: an assertion by an actor;
- `critic_approved`: an independent review decision;
- `generated`: a deterministic derivation with generator and input hash.

Only verified evidence can verify a node. Critic approval does not become machine verification, and Specialist self-validation does not become either one by itself. Specialists cannot read critic-only KB entries, and self-approval is rejected structurally.

## Canonical runtime

`ArborRuntime` owns the manager, supervisor, operation registry, job scheduler, session authorities, event stream, approvals, notification inbox, integration registry, recovery, output evidence, result review, budgets, telemetry, remote sessions, distributed control, and configuration projections.

`RuntimeCatalogRouter` is the typed transport boundary. Each entry declares direction, capability, idempotency, and support. Commands return acknowledgement and operation identity; completion is observed through events and queries. Use the runtime catalog rather than copying a static command list into a new surface.

## Evidence before observability

Governed state changes follow this order:

```text
validate envelope, capability, version, and authority
-> append authoritative evidence
-> persist or rebuild derived state
-> update canonical runtime/tree state
-> publish bounded projection or event
```

The audit ledger is append-only and SHA-256 hash-chained. Replay detects tampering, truncation, reordering, duplication, and conflicting records. KB and other stores publish sealed or content-identified snapshots. UI, memory, telemetry, search indexes, and status summaries are disposable projections.

## Sessions and context

A native session binds model identity, execution policy, workspace roots, credential lease, budget, capabilities, and lineage. Tool calls pass through host ports with immutable policy and evidence. Protected replay checkpoints preserve bounded conversation state without persisting credentials.

Continuation is not authority restoration. Resume, fork, attach, or retry revalidate current model revision, policy, budget, workspace, tools, and credential availability, then create lineage-linked state. Redacted history and diagnostic projections remain bounded.

## Worktrees, results, and adoption

Each specialist branch uses a lease-bound isolated worktree. Writer locks and canonical repository identities prevent same-resource collisions while allowing independent work across different repositories.

Captured results are content-addressed patches. Review services build file trees, diffs, verification summaries, comments, revision requests, editor handoffs, and conflict previews. Adoption is fenced by repository/campaign/node identity, expected patch digest, and current target state. A receipt supports bounded revert.

## Distributed control and A2A

Distributed requests carry host identity, timestamp, nonce, body digest, and HMAC signature. Servers enforce skew, replay caches, body limits, deadlines, operation capabilities, TLS requirements for non-loopback exposure, and typed failure results. Remote session identity and result adoption use fencing so an expired or superseded worker cannot publish into current authority.

Parent-child and native peer channels are durable. Sibling communication requires a parent-authorized relationship grant with capabilities, tier, disclosure bound, expiry, and provenance. Public A2A exposure remains explicitly host-composed.

## Extensions

The integration SDK admits signed packages into an isolated registry. Marketplace indexes and artifacts are HTTPS-only, signed, hashed, size-bounded, path-confined, and installed atomically. Command/skill and MCP adapters declare permissions, origins, path prefixes, isolation, health, and credential names. Credentials are host-provided leases, not package content.

## Interfaces

- CLI: task-first human and JSON automation surface.
- MCP: tools, resources, and catalog dispatch over stdio.
- WebUI: responsive task, live work, tree, sessions, review, setup, integrations, and flight control.
- TUI: unidirectional Cockpit with structured scenes, diff rendering, kinetic tree, viewport/navigation, forms, review, and runtime effects.
- Remote: opt-in authenticated HTTP and distributed control composition.

Each interface submits the same typed commands and reads the same projections.

## Recovery

Interruption is not failure. Recovery is explicit and journaled. A retry obtains fresh authority and leases; reconciliation does not pretend pre-crash work is live. Abandonment requires authorized intent. Stale locks may be reclaimed only under the defined ownership and quarantine rules.

## Quality and evidence

Architectural decisions, evaluation fixtures, and evidence stores keep product behavior reviewable as the harness evolves. Derived evidence is refreshed in dependency order so a later record does not attest to an outdated predecessor. This supports repeatable engineering work without becoming part of an operator's campaign authority.

## Invariants

- Provenance is a type, not a comment.
- Evidence precedes observability.
- Authority is singular; projections are disposable.
- No actor both proposes and approves.
- Gates fire or an evidence deficit is recorded.
- Interruption, failure, abandonment, and verification remain distinct.
- Raw output is evidence, not ambient context.
- Missing data stays unavailable rather than inferred.
- Bounds, idempotency, identity, and collision behavior are part of the contract.
- Core never depends upward.
