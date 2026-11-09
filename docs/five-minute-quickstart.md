# Five-minute quickstart

This is the shortest supported path from a clean checkout to a real revoy2 campaign. It uses the deterministic executor, so it needs no provider key, network request, Claude Code login, or OpenCode installation. Provider-backed work runs on the Canopy native lane, the only default harness (ADR-192).

## 1. Install and inspect

```bash
bun install --frozen-lockfile
bun run build
bun run dev:install
arbor doctor
```

`bun run build` checks the TypeScript projects. `dev:install` links `arbor` and `arbor-mcp` from `~/.local/bin` to this checkout.

## 2. Enroll the project

```bash
arbor project enroll . --dry-run
arbor project enroll .
arbor project status .
```

Enrollment writes a small, non-secret governance overlay. The preview shows every proposed write. Existing operator-owned configuration is not replaced. For an existing repository, it recognizes `package.json`, `pyproject.toml`, `Cargo.toml`, and `go.mod`, then derives only declared or profile-supplied commands. It refuses to guess a build or verification command when the repository does not state one.

## 3. Run the offline campaign

```bash
arbor run --once --executor deterministic --persistence-dir .arbor/quickstart
```

This command creates a campaign with an action tree, isolated worktree leases, review state, and a durable record of its decisions. `--once` keeps the example bounded. The executor reports provider usage as unavailable rather than inventing cost.

Its output remains claimed rather than verified because the sample does not execute an independent repository verification command. That distinction is deliberate and visible in the interfaces.

The sample contract is documented at [`examples/campaigns/five-minute-deterministic.md`](../examples/campaigns/five-minute-deterministic.md).

## 4. Open the product

```bash
arbor tui
# or
arbor webui
```

In the Cockpit, open the tree, activity, evidence, sessions, and result review from the command palette. In the WebUI, use the task composer and campaign selector, then inspect the same canonical runtime state in the live tree and review workspace.

Visual showcase media is omitted from this candidate pending rebranding and provenance review.

## 5. Move to provider-backed work

```bash
arbor setup
arbor doctor
arbor task "Inspect this repository and propose one bounded improvement"
arbor task "Implement this reviewed interface" --attach ./reference.png
```

Fill the generated `arbor.jsonc` and ignored `.env` only for the provider you use. `arbor doctor` reports exact remediation without printing credential values or making an implicit provider call.

Provider-backed campaigns run on the Canopy native lane. Configure a native credential per `docs/native-provider-auth.md`; with none, a campaign fails closed and points at `arbor doctor`.

The Codex CLI connector is deprecated until after 1.0.0 (ADR-192) and is refused unless `arbor.jsonc` sets `connectors.allow_deprecated: true` and a one-line `connectors.reason` (there is no env opt-in). After that opt-in it can be selected without copying credentials:

```bash
export ARBOR_HARNESS_INTEGRATION=codex
# Optional when `codex` is not on PATH:
export ARBOR_CODEX_BIN=/path/to/codex
# Optional: omit to use Codex's configured default model.
export ARBOR_CODEX_MODEL=<model-id>
```

The deprecated adapter receives a restricted environment and revoy2's governed sandbox policy. If the binary or required sandbox capability is unavailable, it fails closed; it never selects another integration implicitly.

Image tasks accept up to four PNG, JPEG, GIF, or WebP files and require
`native.capabilities.image_input: true`. The capability is explicit rather
than inferred from a model name; unsupported connectors fail closed.

Reasoning-bearing OpenAI-compatible streams use a bounded 4 MiB response
default. If a provider documents a different envelope size, configure
`native.transport.max_response_bytes` (hard-capped at 8 MiB) rather than
removing the guard. `native.transport.timeout_ms` sets the per-attempt timeout,
with a five-minute maximum.

When the draft is ready:

```bash
arbor task confirm <draft-id> <revision> --wait
arbor report --campaign <campaign-id>
arbor adopt --campaign <campaign-id>
arbor adopt --campaign <campaign-id> --apply
```

Inspect before applying. Adoption validates the captured patch and target state and returns a receipt.

## Next routes

- Guided task and recovery journey: [`operator-journey-1.0.md`](operator-journey-1.0.md)
- Daily operation: [`operator-guide.md`](operator-guide.md)
- Outcome-to-screen map: [`operator-workflows.md`](operator-workflows.md)
- Interface details: [`interface-showcase.md`](interface-showcase.md)
- Recovery: [`recovery-guide.md`](recovery-guide.md)
- Distributed proof and trailer media: [`sizzle-capture.md`](sizzle-capture.md)
- Full current command inventory: `arbor --help`
