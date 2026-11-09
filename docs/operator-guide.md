# revoy2 operator guide

For the end-to-end supervised task flow and recovery choices, see the
[operator journey](operator-journey-1.0.md).
For release preparation and the product's security, licensing, clean-room,
and deployment limits, see the [1.0.0 release checklist](release-boundaries-1.0.0.md).

revoy2 is a generalist harness with a governed authority model. Use it for any repository, language, framework, documentation set, or operational task that its admitted tools can reach. Governance determines who may do what, what evidence is required, and how results are adopted; it does not constrain packaging or writing style.

## Start every environment here

```bash
arbor project status .
arbor doctor
```

`doctor` is read-only and local by default. It reports effective config sources, selected model and revision, explicit image-input capability, credential presence without values, connector readiness, persistence reconciliation, migration state, terminal capabilities, and project-registry discharge. Use `--json` for automation.

Existing repositories are supported when they expose one of `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`. Enrollment uses only commands that the repository declares or an operator profile explicitly supplies. It reports an unresolved command rather than inventing a package-manager, build, or test invocation.

For a new checkout:

```bash
arbor setup
arbor project enroll . --dry-run
arbor project enroll .
```

### Harness lane

Canopy (`revoy-native`) is the only default campaign harness (ADR-192). Configure a native credential per `docs/native-provider-auth.md` and verify with `arbor doctor`; with no ready native credential a campaign fails closed and points at `arbor doctor`, and nothing falls back to a connector.

### Codex adapter (deprecated)

The Codex, Claude Code and opencode connector lanes are deprecated until after 1.0.0. They are refused unless `arbor.jsonc` sets `connectors.allow_deprecated: true` with a one-line `connectors.reason`; there is no env opt-in, and the reason is recorded in each run's ledger. After that opt-in, select Codex when its CLI is installed:

```bash
export ARBOR_HARNESS_INTEGRATION=codex
# Optional: use a non-PATH binary.
export ARBOR_CODEX_BIN=/path/to/codex
# Optional: omit to preserve Codex's configured default-model behavior.
export ARBOR_CODEX_MODEL=<model-id>
```

The native adapter launches only that binary, with a restricted child environment and the campaign's governed sandbox policy. A missing binary, unavailable sandbox capability, or adapter failure stops the campaign with remediation; revoy2 does not silently switch to a different integration or provider.

## The daily task lifecycle

### Compose

```bash
arbor task "Implement the requested change and verify the acceptance criteria"
arbor task "Reproduce the attached layout and verify keyboard access" --attach ./layout.png
```

The composer assigns a governance tier, plans bounded actions, asks questions when needed, and preserves a durable draft. If the planner is unavailable, it fails closed with recovery guidance; it does not fabricate an actionable plan.

Action authority is specific. A read-only child may use non-mutating repository inspection commands and tools, but cannot write files or run mutating commands. A command-only validation action may run only its admitted validation command and cannot edit repository files. If root recovery is needed, it inherits only the union of its admitted child write paths and commands; recovery never expands a campaign's original scope.

The CLI, TUI, and WebUI accept up to four PNG, JPEG, GIF, or WebP images per
task. Image bytes are captured into a content-addressed store; drafts and UI
state retain immutable references rather than raw payloads. Confirmation
binds those references to the campaign, restart/replay re-verifies their hash,
size, and media signature, and only an explicitly image-capable native planner
or Specialist can resolve them. Claude Code and OpenCode campaign paths reject
media tasks until they can provide equivalent governed-consumption evidence.

### Confirm and supervise

```bash
arbor task confirm <draft-id> <revision> --wait
```

Crown selects branches and delegates isolated work. Use the TUI or WebUI for the most complete live view, or query with CLI/MCP. Cancellation reaches the canonical task and session authorities; a late planner or worker result cannot overwrite a durable cancellation.

### Review

```bash
arbor report --campaign <campaign-id>
arbor adopt --campaign <campaign-id>
```

The result workspace distinguishes critic approval from machine verification. It shows changed files, unified or side-by-side diffs, commands and exit status, provenance, comments, revision requests, editor handoffs, conflict preview, and adoption state. Missing verification remains unavailable, never implied by a green critic verdict.

### Adopt

```bash
arbor adopt --campaign <campaign-id> --apply
```

Adoption is fenced by campaign, node, expected patch digest, repository identity, and current target state. Selective-file adoption and receipt-bound revert use the same boundary.

## Product surfaces

### TUI Cockpit

```bash
arbor tui
```

The Cockpit is keyboard-first and task-centered. It includes the kinetic tree, task composer, live activity, sessions, result review, approvals, recovery, projects, configuration, integrations, telemetry, and searchable command palette. `?` opens help/palette, `Ctrl+N` starts a draft, and `Ctrl+P` searches actions. Screen controls are shown in context.

### WebUI

```bash
arbor webui
```

The responsive WebUI presents setup, task composition, live campaigns, the animated tree, session attach/history, result review, selective adoption, notification inbox, integration health, and flight control. Browser notifications are opt-in. The local server does not become a public listener implicitly.

### CLI

`arbor --help` is the canonical inventory. Human output favors next actions; `--json` preserves machine-readable contracts. Ctrl-C routes through a shutdown gate that requests interruption before tearing down transports.

### MCP

```bash
arbor serve
```

MCP tools and resources project the same manager, runtime catalog, evidence stores, and capability checks. See [`mcp-guide.md`](mcp-guide.md).

## Sessions and continuity

Session history is durable, bounded, and redacted. Current surfaces support inspection, attach, steering, interruption, replay checkpoints, lineage-linked continuation, and explicit recovery dispositions. Continuation re-admits current credentials, budget, policy, model revision, workspace, and capabilities; it does not blindly restore old authority.

Use session display names and filters for operator retrieval while retaining immutable IDs for audit and collision safety.

## Agents and peer communication

Crown orchestrates. Seed and Heartwood execute bounded specialist work. Lenticel independently critiques. Direct agent summoning does not bypass planning: a role is admitted through a task plan, project command, or declarative subagent descriptor.

Parent-child and sibling communication is durable and capability-bound. Sibling query/reply requires a fixed parent-authorized grant with disclosure limits. Cross-repository communication adds signed host/session identity, nonces, expiry, replay protection, fencing, and repository-scoped leases.

## Extensions and integrations

```bash
arbor extension representative-list
arbor extension list
arbor extension inspect <id>
arbor extension marketplace-list <https-index>
arbor extension install-remote <https-index> <id>
```

The installable SDK supports command/skill and MCP adapters. Marketplace discovery and installation require HTTPS, trusted signatures, artifact hashes, size bounds, path confinement, and atomic installation. Inspect permissions, isolation, health, and credential requirements before enabling. Credential values remain host-owned leases.

## Hooks

Hooks are governed, immutable descriptors under `.arbor/hooks/*.json` (filename `<hook_id>@<version>.json`), validated exactly like a skill descriptor: bounded, resolved against a handler registry, and rejected at load if a descriptor's declared `event` exceeds what its `kind` permits. A descriptor never carries executable code — `handler_ref` names one in-process handler.

The registry has two sources (ADR-111). `handlers.ts`'s built-in set is always available. Beyond it, an operator may author a handler, but only by shipping it inside a **signed plugin**, and the trust tier gates what that handler is allowed to do: a plugin-supplied handler bound to a veto event (`tool_preflight`) or to the one deny-capable lifecycle event (`session_start`) is refused below **T4**, the tier that already gates `code_execution`. Observe-only handlers are admitted at lower tiers. The point is that arbitrary operator code cannot acquire the authority to *deny* a tool call without passing the same signed, tiered, hash-chained admission every other capability escalation passes.

```bash
arbor hook list [--json]      # every descriptor under .arbor/hooks, its event/kind/handler, and load diagnostics
arbor hook validate [--json]  # diagnostics for malformed descriptors (non-zero exit) and hooks that have never fired
arbor hook events [--json]    # the canonical lifecycle event names the hook bus dispatches
```

These three verbs are **CLI-only by design** — hook inspection is operator diagnostics, not a runtime capability, so there is deliberately no MCP catalog kind, TUI screen, or Web panel for them (canvas C-11, 2026-08-23).

`arbor hook events` derives its list from the same closed per-kind event tables (`HOOK_VETO_EVENTS`, `HOOK_OBSERVE_EVENTS`, `HOOK_LIFECYCLE_EVENTS`) the catalog validator and bus dispatcher both read, so it can never drift from what actually fires. Those events are:

- **veto** (may deny a tool call before it runs): `tool_preflight`
- **observe** (bounded note only; cannot deny/mutate/grant): `tool_audit`, `tool_write`, `phase`, `ledger_transition`, `user_prompt_submit`, `pre_compact`, `notification`, `turn_end`
- **lifecycle** (observe-only except `session_start`, the only event a lifecycle hook may ever deny): `session_start`, `session_end`, `node_start`, `node_end`, `plan_confirm`, `interruption`

`turn_end` fires once per turn that ends successfully — the boundary a Claude Code `Stop` event corresponds to. It is observe-only by construction: refusing a turn is the native worker's `turn_gate` option, consulted in line with every other step of the turn and bounded by a refusal budget, because a deny-capable bus handler is measured after it returns and cannot preempt, which is the opposite of what a multi-second battery needs. A `turn_end` handler that does I/O starts it detached: the firing row is written at the boundary and the settlement recorded when it lands, with an overrun reported as an attributed `error` naming the bound the handler declared.

A descriptor's schema is `{schema_version, hook_id, version, kind, event, handler_ref, why}` — `hook_id` bounded kebab-case, `version` canonical SemVer, `kind` one of `observe`/`veto`/`lifecycle`, and `why` a non-secret rationale. The whole safety case is that a hook can only reduce: a veto hook can flip a base allow to a deny, never the reverse; an observe handler's return type carries no field that could deny, mutate, or grant anything.

A documented default hook set — a `plan_confirm` notifier (`lifecycle.session-boundary-notes`) and a `tool_audit` audit-log hook (`observe.tool-audit-notes`) — is available for a project's `.arbor/hooks/` directory to install, materialized only when the identity is absent (the same "only when absent" rule `.arbor/commands`/`.arbor/skills` enrollment already follows).

`arbor doctor`'s `operational.extensions`/`operational.integrations` block includes a `hooks` entry summarizing catalog/bus health: a malformed descriptor or a declared-but-never-fired hook reports `attention` with the exact path and reason; a clean, quiet catalog reports `ready`.

## Remote and scheduled work

Remote control is opt-in. Non-loopback listeners require TLS and scoped operation grants. Distributed control supports discovery, inbox, signed requests, deadlines, bounded retries, replay defense, fencing, cancellation, and recovery. Schedules and jobs remain canonical runtime commands rather than a second queue authority.

Use the flight-control proof before deploying coordination changes:

```bash
arbor flight-control-stress --keep-artifacts
```

## Recovery

Recovery is explicit, never automatic. An interruption, crash, stale lease, critic failure, abandonment, timeout, and successful verdict are distinct outcomes.

```bash
arbor recover --campaign <id>
arbor doctor --json
arbor project repair .
arbor project repair . --apply
```

A retry receives fresh authority and a fresh lease. Abandonment requires operator or auditor authority. See [`recovery-guide.md`](recovery-guide.md).

## Evidence and quality controls

```bash
arbor evidence refresh --dry-run
arbor evidence refresh
```

Evidence refresh updates the local evidence projections used by campaign inspection and evaluation. Run it when working on the harness itself; everyday campaign operation does not require it.

For end-of-task local verification, use the coordinator instead of assembling
producer and gate order from memory:

```bash
bun run finalize -- --plan
bun run finalize
# If it reports evidence_refresh_required:
bun run finalize -- --refresh
# Review and commit only the generated evidence, then:
bun run finalize
```

It checks the committed-source and freshness barriers before constructing the
expensive immutable prepush snapshot. Its stable phase plan exposes exactly one
current barrier and one next action; the final phase prints the real
topological gate waves consumed by the runner.

To publish selected source changes and their required repository evidence, use the governed transaction rather than staging, committing, and pushing by hand:

```bash
bun run trunk:submit -- \
  --message "Describe the reviewed change" \
  --include packages/example/src/change.ts \
  --include packages/example/tests/change.test.ts
```

`trunk:submit` records the selected source change first, generates required evidence from that clean snapshot, then records the evidence in a second commit before an ordinary guarded push. It journals each phase. If an interruption occurs, use the reported resume instruction so the transaction can reconcile its recorded state rather than recreating commits or evidence by guesswork. The command fails closed on an unselected change, failed gate, stale evidence, conflict, or push failure. It has no skip-gate or hook-bypass mode; the resulting push runs the normal local protections.

## Non-negotiable operator rules

- Never equate a claim, generated fact, or critic approval with verification.
- Never let one agent propose and approve the same action.
- Never expose a local WebUI or remote listener without its explicit auth and transport policy.
- Never publish raw session, provider, environment, or desktop capture as proof media.
- Never apply a result whose patch digest or target state changed after review.
- Never infer missing provider capability, price, identity, test evidence, or sandbox strength.

## Current boundaries

- Provider and OS sandbox strength depends on the selected adapter and host. The default local verifier does not deny network by itself.
- Public A2A discovery and transport remain host-composed rather than implicitly exposed.
- Experimental Agent-UCT and harness-economics exports remain evaluation-only until governed evidence authorizes a production policy change.
- For deployment-specific status, use [`release-readiness.md`](release-readiness.md), not historical parity documents.
- For release sequencing and documentation governance, use the [1.0.0 roadmap](roadmap-1.0.0-and-documentation-governance.md).
