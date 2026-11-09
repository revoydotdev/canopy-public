# Operator workflows

Revoy2 presents one campaign through four views: CLI automation, the TUI Cockpit, the responsive WebUI, and MCP clients. Choose the surface that fits the moment; each stays synchronized with the same campaign state.

## Outcome map

| Outcome | Primary route | Supporting route |
|---|---|---|
| Set up a repository | `arbor project enroll . --dry-run` | Web setup checklist / Projects screen |
| Diagnose readiness | `arbor doctor` | Native Setup Doctor / Web remediation |
| Plan or clarify work | `arbor task "..."` | Cockpit or Web task composer |
| Confirm and run | `arbor task confirm ... --wait` | Cockpit live activity |
| Inspect the search | Tree screen | Web kinetic tree / `campaign.tree` query |
| Attach or steer a session | Harness Sessions | Web session workspace / runtime catalog |
| Ask a sibling specialist | Capability-bound peer tool | Parent-relayed peer thread |
| Interrupt work | Active campaign/session control | `tree.interrupt` / Ctrl-C shutdown gate |
| Recover after crash | Recovery screen | `arbor recover --campaign ...` |
| Review changes | Result Review | `arbor report --campaign ...` |
| Apply selected output | Review adoption controls | `arbor adopt ... --apply` |
| Finish and verify locally without pushing | Deterministic finalization plan | `bun run finalize` (`--plan`, `--refresh`, or `--json`) |
| Submit reviewed source and evidence | Governed trunk submission | `bun run trunk:submit -- --message "..." --include <path>` |
| Install an integration | Extensions workflow | `arbor extension ...` |
| Govern multiple projects | Projects | `project registry list/verify/manage` |
| Prove distributed safety | Flight Control | `arbor flight-control-stress` |
| Produce trailer media | Sizzle pipeline | `scripts/sizzle-record.mjs` |

## Project lifecycle

```bash
arbor project status .
arbor project enroll . --dry-run
arbor project enroll .
```

Enrollment prepares a non-secret project overlay and bounded roots. It supports existing repositories with `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`, and derives only declared or explicitly profile-supplied commands. When required build or verification commands are not established, enrollment reports that prerequisite instead of guessing. `arbor setup` separately creates missing provider templates without overwriting existing files.

Less common paths remain explicit:

```bash
arbor project enroll ../new-product --new --dry-run
arbor project enroll . --backfill --dry-run
arbor project repair .
arbor project repair . --apply
```

Repair previews by default. Malformed operator-owned content is reported with its path rather than guessed or replaced.

Canopy (native) is the only default harness (ADR-192); configure a native credential per `docs/native-provider-auth.md` and check `arbor doctor`. The Codex CLI is a deprecated connector lane, refused unless `arbor.jsonc` sets `connectors.allow_deprecated: true` with a one-line `connectors.reason`. After that opt-in, to select a local Codex CLI for an admitted campaign, set `ARBOR_HARNESS_INTEGRATION=codex`; optionally set `ARBOR_CODEX_BIN` when it is not on `PATH` and `ARBOR_CODEX_MODEL` to override Codex's configured default model. The adapter runs with a restricted environment and governed sandbox policy. Readiness or sandbox failure remains a failed prerequisite, never an implicit provider fallback.

## Multi-project governance

A project remains associated with its current path and revision. The registry check identifies projects that have moved or drifted.

```bash
arbor project registry list
arbor project registry verify
arbor project manage
```

`arbor doctor` also reports registry discharge, so routine readiness detects moved, expired, or drifted projects.

## Task to adoption

```bash
arbor task "Make the change"
arbor task show <draft-id>
arbor task answer <draft-id> <revision> <question-id> "answer"
arbor task confirm <draft-id> <revision> --wait
arbor report --campaign <campaign-id>
arbor adopt --campaign <campaign-id>
arbor adopt --campaign <campaign-id> --apply
```

The planning draft, campaign, selected node, captured patch, review comments, and adoption receipt form explicit lineage. Follow-up work records its source campaign/result rather than becoming an unrelated prompt.

## Submit source and evidence

After review and adoption, publish selected repository changes through one transaction:

```bash
bun run trunk:submit -- \
  --message "Describe the reviewed change" \
  --include packages/example/src/change.ts \
  --include packages/example/tests/change.test.ts
```

The transaction creates a source commit, generates evidence from its clean snapshot, and creates a separate evidence commit before performing an ordinary guarded push. It records a durable journal between phases. On interruption or a rejected push, follow the reported resume path; do not reconstruct the sequence with manual commits. The command fails closed and provides no skip-gate or hook-bypass option.

## Supervision and intervention

Use the Cockpit or WebUI for live work. Attention ranking brings questions, failures, conflicts, approvals, and stalled sessions ahead of routine progress. Session attach and steering are capability-gated. Cancellation is durable and late results are suppressed.

Tree actions remain explicit:

- Branch adds admitted candidate actions.
- Prune removes a candidate from search without pretending it failed review.
- Interrupt creates a recoverable outcome.
- Retry requires fresh recovery authority and isolation.
- Abandon records the authorized decision and does not manufacture failure knowledge.

## Result review

Review before mutation:

1. Confirm repository, campaign, node, and patch digest.
2. Inspect changed files and unified or side-by-side diff.
3. Read critic rationale separately from verification evidence.
4. Check commands, exit status, output hashes, truncation, and evidence references.
5. Preview conflicts against the current target.
6. Comment or request revision if needed.
7. Adopt all or selected files and retain the receipt.

## Integrations

```bash
arbor extension representative-list
arbor extension marketplace-list <https-index>
arbor extension install-remote <https-index> <integration-id>
arbor extension inspect <integration-id>
```

Installation does not imply enablement. Review trust root, requested tier, tools, code/network/filesystem permissions, isolation boundary, credential name, and health. An upgrade is a new signed artifact and explicit operation.

## Distributed coordination

The flight-control scenario exercises:

- orchestrator-to-child delegation, acknowledgement, and reply;
- sibling query/reply through an explicit parent relay;
- two concurrent Bun sessions in separate repositories;
- signed cross-repository requests in both directions;
- independent leases across repositories and collision denial within one repository;
- scope denial, cancellation, crash, stale-lock recovery or quarantine, retry, and final integrity.

```bash
arbor flight-control-stress --keep-artifacts
```

## Recovery and finish

```bash
arbor doctor
arbor recover --campaign <id>
arbor ledger verify --help
```

At the end, inspect the result, adopt the intended files, and retain the receipt with the work record.
