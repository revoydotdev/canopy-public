# `observe-devtools.sh` — external headless observer for the revoy2 DevTools stream

An **external, headless** agent that watches the revoy2 autonomous demo's
DevTools streaming log (`<persistence_dir>/devtools/devtools.log`) on a
schedule and turns newly-appended lines into a short campaign-health digest.
This is the "watching the player-piano from outside" half of the demo: the
campaign runs and renders in one tmux window while this observer independently
digests the same stream every 15 minutes.

> ⚠️ **"Digesting" is a network egress, and it is opt-in (ADR-173).** Producing
> a digest means sending the campaign's live devtools event log to a
> **third-party hosted model**. There is no default destination. Every path that
> reaches the model — `--once`, `--loop`, and the installed cron entry —
> requires `--allow-third-party-egress=<provider/model>`, and the value must
> exactly match the model the run would use. Without it the observer refuses to
> transmit *and* refuses to schedule a transmission, exiting non-zero. A bare
> `--allow-third-party-egress` is refused like omission.

```
┌───────────────────────────────┐        ┌──────────────────────────────┐
│  tmux window (the demo)       │        │  observer (this script)      │
│  ┌─────────────────────────┐  │  writes│  ┌────────────────────────┐  │
│  │  arbor demo  (TUI)      │  │        │  │ devtools.log           │  │
│  └─────────────────────────┘  │        │  └───────────┬────────────┘  │
│  ┌─────────────────────────┐  │        │              │ cursor/flock  │
│  │  tail -f devtools.log   │  ────────▶│  new lines   ▼               │
│  └─────────────────────────┘  │        │  ┌────────────────────────┐  │
│                              │        │  │ opencode run (headless) │  │
│                              │        │  └───────────┬────────────┘  │
│                              │        │              ▼ digest        │
│                              │        │  reports/<ts>.md            │
└───────────────────────────────┘        └──────────────────────────────┘
```

## What it does

On each invocation (once, or every 15m via `--loop`/cron):

1. Acquires a non-blocking `flock` (a concurrent fire skips cleanly — never
   double-processes).
2. Reads a **byte-cursor** (`<dir>/devtools/observer/.cursor`) storing the
   active-file inode + byte offset of the last consumed line.
3. **Rotation-safe**: if the active file's inode changed (logger renamed
   `devtools.log` → `.1.log` and opened a fresh one) or the file shrank below
   the cursor, it resets to the fresh active segment — no missed lines, no
   re-reads.
4. Captures only **complete** newline-terminated lines after the cursor; a
   partial trailing line is left for the next run to complete.
5. Hands the captured lines to a **headless opencode agent**:
   `opencode run -m <model> -f <captured> -- <digest prompt>` (verified working,
   2026-08-03). The agent classifies campaign health
   (`ADVANCING / STALLED / HALTED / VERIFIED / FAILURES`), summarizes recent
   `loop.*` events, flags anomalies (synthetic truncation, failure runs, halt),
   and emits a short Markdown digest.
6. Writes the digest to `<dir>/devtools/observer/reports/campaign-<ts>.md` and
   prints it.
7. Advances the cursor after processing. A failed agent call does **not** stop
   the cursor (a single undigestible line can't wedge the loop forever) but it
   **is** logged and becomes the run's exit status — a provider failure is never
   reported as success.

**Read-only on local state only**: it never writes to `devtools.log`, the audit
ledger, or any campaign state. Its only writes are its own cursor file, reports,
and tmp files under `<dir>/devtools/observer/`. It is **not** read-only on the
network — see the egress notice above.

## Usage

Every example below names its destination, because that is what consent means
here. Substitute your own `<provider/model>`; there is no default.

```bash
# one-shot digest of new lines (exit 0 even when idle)
./scripts/observe-devtools.sh --dir .arbor \
      --model <provider/model> --allow-third-party-egress=<provider/model>

# dry-run: print captured lines, skip the agent — sends nothing, needs no consent
./scripts/observe-devtools.sh --dry-run --dir .arbor

# continuous fallback (this box has NO cron daemon installed):
nohup ./scripts/observe-devtools.sh --loop --dir .arbor \
      --model <provider/model> --allow-third-party-egress=<provider/model> \
      >> .arbor/devtools/observer/loop.log 2>&1 &

# install a */15 crontab entry (works only where `crontab` exists).
# The installed entry embeds --model and the consent, so each unattended fire is
# held to the destination you approved here.
./scripts/observe-devtools.sh --install-cron --dir .arbor \
      --model <provider/model> --allow-third-party-egress=<provider/model>

# remove it — no consent needed; removal is never gated
./scripts/observe-devtools.sh --uninstall-cron --dir .arbor
```

### Model / overrides

| Env var / flag | Default | Purpose |
|---|---|---|
| `--model` | **none** | Model the headless agent uses to digest. There is no default: a third-party destination must be named. |
| `--allow-third-party-egress=<provider/model>` | **none** | Consent. Must equal `--model` exactly. Required by `--once`, `--loop`, and `--install-cron`. |
| `OBSERVER_MODEL` | unset | Alternative to `--model`. A configured value is not authorisation — the consent flag is still required. |
| `OPENCODE_BIN` | `opencode` | Binary path. |
| `REVOY2_PERSISTENCE_DIR` / `--dir` | `<repo>/.arbor` | Persistence root under which `devtools/devtools.log` lives. |
| `DEVTOOLS_OBSERVER_LOOP_SECONDS` | `900` | `--loop` interval. |

## Cron vs `--loop` on this box

`crontab` is **not installed** and no cron daemon is running here. So:
- `--install-cron` checks consent **first** and refuses without it. Only after
  consent does it probe for `crontab`, and then points you at `--loop`.
- Use `--loop` (above) as the reliable background fallback. Verify a real
  install with `crontab -l`.

`scripts/demo-window.sh` starts the observer only when given
`--observer-model <provider/model>`, which it threads as both model and consent.
Without that flag it skips the observer and says so; the demo window's panes and
campaign run normally either way.

## Files / layout

```
.arbor/devtools/
  devtools.log                         # the ND-JSON stream (written by the demo)
  observer/
    .cursor                            # "<inode> <byte-offset>" idempotency pointer
    .lock                              # flock guard
    reports/campaign-<ts>.md           # digests (one per non-empty window)
    tmp/                               # captured-line scratch
    cron.log | loop.log                # scheduled-run output
```

## Testing

```bash
bash -n scripts/observe-devtools.sh                    # syntax
./scripts/observe-devtools.sh --dry-run --dir <tmpdir>  # exercises cursor/rotation
```
