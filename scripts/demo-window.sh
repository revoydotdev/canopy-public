#!/usr/bin/env bash
#
# demo-window.sh — the revoy2 autonomous "player-piano" tmux window.
#
# Opens a dedicated tmux window with a two-pane live view of the autonomous demo:
#   left (primary):  arbor demo  — the live TUI (campaigns screen + DevTools
#                                  screen with player-piano animations), driven by
#                                  a real runCampaign loop + seeded executor,
#                                  streaming runtime + loop.* events to devtools.log
#   right:           tail -f devtools.log | jq .  — the externally-observable
#                                  DevTools stream, filtered for readability
#
# It can wire the external headless observer (observe-devtools.sh). Because this
# box has no cron daemon, an opted-in observer runs in --loop mode (every 15m) as
# a background process with a persistent log, and reports its PID.
#
# THE OBSERVER IS OFF BY DEFAULT AND THIS IS NOT AN OVERSIGHT. The observer
# "digests" by TRANSMITTING the campaign's devtools event log to a third-party
# hosted model (ADR-173). It used to be started unconditionally here with no
# consent argument, which meant simply running this script sent campaign data to
# a model nobody chose. A demo harness is not a consent surface, so the
# destination must be named explicitly, in this invocation, as
# --observer-model <provider/model>; the value is threaded to the observer as
# both its model and its consent. With no such flag the observer is SKIPPED and
# this script says so in one line. Nothing else changes: the panes, the
# campaign, and the right-hand log tail all run normally.
#
# --- Track B3/B-demo: an opt-in SELF-HOSTING path ---------------------------
# By default this drives the pane with the seeded, scripted `demo`/`run`
# executor above — free, deterministic, no model calls. NOTE: `demo`'s OWN
# default executor is "real"; this script passes `--executor deterministic`
# explicitly. Until it did, both invocations here silently spawned
# `opencode run` against a live provider while this header promised the
# opposite — verified by running the window and finding a real
# openrouter/deepseek process, with the campaign stalled mid-dispatch while
# the player-piano kept animating. Do not drop that flag: a demo window that
# bills the operator without saying so is exactly the unwitnessed claim this
# repository exists to catch. Pass --selfhost (or
# set ARBOR_DEMO_SELFHOST=1) to instead drive the left pane with
# `arbor-mcp selfhost --from-backlog`: a REAL campaign, against THIS
# repository, whose task is derived from the real POL-04 governance backlog
# (packages/arbor-governance/src/backlog/derive.ts) rather than a scripted
# plan. This costs real model calls, so it stays opt-in.
#
# The self-hosting executor runs rooted at its own throwaway git worktree
# (selfhost.ts's own isolation boundary — never this checkout directly), so
# its devtools.log lives under that worktree, not under $PERSISTENCE_DIR. A
# pinned --run-id (SELFHOST_RUN_ID below) lets this script predict that path
# before the run starts, so the right pane can `tail -F` it from the first
# second — real ledger events from the real run, never a fabricated
# projection (see docs/adr-governance-audit/09-prior-art-and-self-hosting-roadmap.md
# §24.7). The worktree is kept after the run (--keep-worktree) so the log
# stays readable for review.
#
# Usage:
#   ./scripts/demo-window.sh [--session <name>] [--persistence-dir <dir>] [--once]
#                            [--selfhost] [--selfhost-max-iterations <n>]
#                            [--selfhost-max-seconds <n>] [--selfhost-task <text>]
#                            [--verification-cmd <cmd>]...
# Flags:
#   --session <name>      tmux session to target (default: revoy2-demo)
#   --persistence-dir <d> root under which devtools/devtools.log lives (default .arbor)
#   --once                run demo.campaigns once then stop (default: continuous player-piano)
#   --no-observer         skip starting the headless observer
#   --observer-model <provider/model>  opt in to the headless observer, naming the
#                          third-party model its digests are sent to. The value is
#                          threaded to the observer as both model and consent
#                          (ADR-173). Without it the observer is skipped; see the
#                          header for why a demo harness is not a consent surface.
#   --kill                stop the demo window + observer and clean up
#   --selfhost             opt-in: drive the pane from a REAL self-hosting `selfhost`
#                          campaign (real model calls) instead of the seeded `demo`.
#                          Same effect as ARBOR_DEMO_SELFHOST=1.
#   --selfhost-max-iterations <n>  cap for the real campaign (default 5)
#   --selfhost-max-seconds <n>     wall-clock cap in seconds (default 1800)
#   --verification-cmd <cmd>  repeatable: one ordered, fail-fast machine
#                          check run in the specialist's worktree. Every stage
#                          exiting 0 is what raises a result from `claimed` to
#                          `verified`; with none passed nothing is ever verified.
#   --selfhost-task <text>         override the hand-passed task; default is
#                                  --from-backlog (revoy2's real derived governance
#                                  backlog — see backlog/derive.ts's module header)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION="revoy2-demo"
PERSISTENCE_DIR="$REPO_ROOT/.arbor"
ONCE=0
OBSERVER=1
# Empty means the operator has not named a destination, so the observer does not
# start. OBSERVER stays 1 so --no-observer and --observer-model compose the way
# they read; the decision to actually spawn is made where it is spawned.
OBSERVER_MODEL=""
SELFHOST="${ARBOR_DEMO_SELFHOST:-0}"
SELFHOST_MAX_ITERATIONS=5
SELFHOST_MAX_SECONDS=1800
SELFHOST_TASK=""
# Repeatable: each occurrence is one ordered, fail-fast verification stage run
# inside the specialist's worktree. Without any, a campaign's every success
# ceilings at `claimed` -- self-attested -- because nothing machine-checked it.
VERIFICATION_CMDS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --persistence-dir) PERSISTENCE_DIR="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --no-observer) OBSERVER=0; shift ;;
    --observer-model) OBSERVER_MODEL="$2"; shift 2 ;;
    --kill) KILL=1; shift ;;
    --selfhost) SELFHOST=1; shift ;;
    --real) REAL=1; shift ;;
    --selfhost-max-iterations) SELFHOST_MAX_ITERATIONS="$2"; shift 2 ;;
    --selfhost-max-seconds) SELFHOST_MAX_SECONDS="$2"; shift 2 ;;
    --selfhost-task) SELFHOST_TASK="$2"; shift 2 ;;
    --verification-cmd) VERIFICATION_CMDS+=("$2"); shift 2 ;;
    --selfhost-run-id) SELFHOST_RUN_ID_OVERRIDE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

OBJ_ROOT="$PERSISTENCE_DIR/devtools"
LOG="$OBJ_ROOT/devtools.log"
RET=0

# Track B3/B-demo: pin the self-hosting run's identity up front so its
# throwaway worktree's own devtools.log path is known before the run starts
# (selfhost.ts roots its runtime at .worktrees/selfhost-<run-id>/.arbor, never
# at $PERSISTENCE_DIR — see selfhost.ts's own module header on isolation).
# A caller that must locate this run's evidence afterwards (the publication
# recorder does) can pin the id, because the worktree path -- and therefore the
# devtools log path below -- is derived from it and is otherwise unguessable.
REAL="${REAL:-0}"
SELFHOST_RUN_ID="${SELFHOST_RUN_ID_OVERRIDE:-demo-$(date +%s)-$$}"
SELFHOST_WORKTREE="$REPO_ROOT/.worktrees/selfhost-$SELFHOST_RUN_ID"
SELFHOST_LOG="$SELFHOST_WORKTREE/.arbor/devtools/devtools.log"

if [ "${KILL:-0}" = "1" ]; then
  echo "stopping revoy2 demo window + observer..."
  if [ -f "$OBJ_ROOT/observer/loop.pid" ]; then
    OBSERVER_PID="$(cat "$OBJ_ROOT/observer/loop.pid")"
    # Reap the observer's CHILDREN too, not just the loop shell. The loop
    # spawns `opencode run` per digest; killing only the parent orphaned an
    # in-flight model call that kept running against a live provider with
    # nothing left to reap it. Verified directly: a --kill left an
    # `opencode run` alive, and a separate stray from an earlier session had
    # been burning 65% CPU for 43 hours before anyone noticed one.
    #
    # Children first, then the parent — the reverse order lets the loop
    # respawn a digest in the gap. The observer is started with `nohup ... &`
    # and is not a process-group leader, so `kill -- -PID` does not reach it;
    # pkill -P is the reliable form here.
    pkill -P "$OBSERVER_PID" 2>/dev/null || true
    kill "$OBSERVER_PID" 2>/dev/null || true
    sleep 1
    pkill -P "$OBSERVER_PID" 2>/dev/null || true
    if kill -0 "$OBSERVER_PID" 2>/dev/null; then
      kill -9 "$OBSERVER_PID" 2>/dev/null || true
    fi
    rm -f "$OBJ_ROOT/observer/loop.pid"
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "done."
  exit 0
fi

if ! command -v tmux >/dev/null 2>&1 || ! tmux ls >/dev/null 2>&1; then
  echo "tmux server is not running — start it first (e.g. tmux new-session -d)" >&2
  exit 1
fi

# Ensure the target session exists (create a bare detached session if missing).
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" >/dev/null 2>&1
fi

# Build a self-contained demo CLI bundle. The monorepo packages export their
# TYPE-SCRIPT source (exports.import -> ./src/index.ts), so plain `node` on a
# typescript is left external: @arbor/governance uses the TS compiler API, and
# typescript is CJS with dynamic require()s that esbuild cannot inline into ESM —
# bundling it produced a 5-byte artifact that died with 'Dynamic require of "fs"'.
# It resolves from node_modules at runtime instead.
# dist file cannot resolve cross-package imports. esbuild inlines every @arbor/*
# package into one runnable file — the reliable demo invocation.
DEMO_BUNDLE="$REPO_ROOT/.arbor/demo/arbor-cli.mjs"
mkdir -p "$(dirname "$DEMO_BUNDLE")"
echo "bundling demo CLI with esbuild..."
./node_modules/.bin/esbuild "$REPO_ROOT/packages/arbor-mcp/src/cli.ts" \
  --bundle --platform=node --format=esm --log-level=warning \
  --external:typescript \
  --outfile="$DEMO_BUNDLE" || { echo "esbuild bundle failed" >&2; exit 1; }
echo "bundle ready: $DEMO_BUNDLE"

# Kill any prior demo window in this session to keep it idempotent.
tmux kill-window -t "$SESSION:demo" 2>/dev/null || true

# Create the window by name and split into two side-by-side panes.
tmux new-window -t "$SESSION" -n demo -d
sleep 0.3
tmux split-window -t "$SESSION:demo" -h -l 60 -d
tmux resize-window -t "$SESSION:demo" -x 180 -y 44 2>/dev/null || true
# Pin the event-stream pane AFTER the window resize. Sizing it at split time
# and then resizing the window redistributes the panes proportionally, which
# handed the log tail 110 columns and squeezed the cockpit into 69 -- the
# frontend, the thing a reel exists to show, arrived truncated mid-word while
# a scrolling text tail got the bulk of the frame.
tmux resize-pane -t "$SESSION:demo.1" -x 60 2>/dev/null || true

# Left pane: either the seeded demo TUI (default), or a REAL self-hosting
# campaign against this repository (--selfhost / ARBOR_DEMO_SELFHOST=1).
if [ "$SELFHOST" = "1" ]; then
  SELFHOST_ARGS=(selfhost --target "$REPO_ROOT" --run-id "$SELFHOST_RUN_ID" --keep-worktree
                 --max-iterations "$SELFHOST_MAX_ITERATIONS" --max-seconds "$SELFHOST_MAX_SECONDS")
  # Quoted expansion, guarded for the empty case: a stage is one shell string
  # ("bun run typecheck"), and an unquoted expansion would split it into three
  # arguments and silently verify something else.
  if [ "${#VERIFICATION_CMDS[@]}" -gt 0 ]; then
    for vcmd in "${VERIFICATION_CMDS[@]}"; do
      SELFHOST_ARGS+=(--verification-cmd "$vcmd")
    done
  fi
  if [ -n "$SELFHOST_TASK" ]; then
    SELFHOST_ARGS+=(--task "$SELFHOST_TASK")
  else
    # revoy2's first autonomous task on itself: derive it from the real
    # governance backlog rather than a hand-passed string (Track B3).
    SELFHOST_ARGS+=(--from-backlog)
  fi
  # printf %q shell-quotes each arg individually so a --task value containing
  # spaces or quotes survives being sent as one literal command string to the
  # pane's own shell (tmux send-keys has no notion of argv — it types keys).
  SELFHOST_ARGS_QUOTED=""
  for a in "${SELFHOST_ARGS[@]}"; do SELFHOST_ARGS_QUOTED+="$(printf '%q ' "$a")"; done
  # The campaign runs DETACHED, not in the pane. It prints one banner and then
  # nothing until a final summary minutes later, so putting it in the left pane
  # left the recording with a frozen wall of text -- no frontend, and not even
  # two distinct frames for the capture's live_pane_changed check. The operator
  # surface for a running campaign is the cockpit, so that is what the left
  # pane shows, pointed at the campaign's own persistence directory.
  SELFHOST_CONSOLE_LOG="$PERSISTENCE_DIR/selfhost-console.log"
  SELFHOST_STDERR_LOG="$PERSISTENCE_DIR/selfhost-stderr.log"
  mkdir -p "$PERSISTENCE_DIR"
# Detach with setsid, not `( ... & )`. The subshell form leaves the run as a
# child of this script, which then blocks in do_wait at exit -- so the caller's
# spawnSync sat on the pipe until its ten-minute timeout while the window it
# had asked for was already up and running. setsid puts the run in its own
# session with init as its parent, so this script can return immediately.
# Let tmux own the long-running run. Neither `( cmd & )` nor `setsid` detaches
# it from this script: the child's ppid stays this bash, which then blocks in
# do_wait at exit, so the caller's spawnSync sits on the pipe until its timeout
# and reports ETIMEDOUT while the window is already up and running (confirmed
# from /proc twice). tmux is already the detached supervisor for the panes, so
# give it the run too, in its own window that the capture never films.
  tmux kill-window -t "$SESSION:runner" 2>/dev/null || true
  tmux new-window -t "$SESSION" -n runner -d
  tmux send-keys -t "$SESSION:runner" \
    "cd $REPO_ROOT && node '$DEMO_BUNDLE' ${SELFHOST_ARGS_QUOTED} 2>'$SELFHOST_STDERR_LOG' | tee '$SELFHOST_CONSOLE_LOG'; echo \"[runner] campaign exited rc=\$?\" | tee -a '$SELFHOST_STDERR_LOG'" Enter
  # The worktree (and its .arbor) appears a moment after the campaign starts,
  # so the pane waits for it rather than racing it and dying on a missing dir.
  tmux send-keys -t "$SESSION:demo.0" \
    "cd $REPO_ROOT && printf 'SELF-HOSTING: real campaign, real model calls, capped at %s iterations / %ss\n' '${SELFHOST_MAX_ITERATIONS}' '${SELFHOST_MAX_SECONDS}' && until [ -d '$SELFHOST_WORKTREE/.arbor' ]; do sleep 0.5; done && node '$DEMO_BUNDLE' tui --persistence-dir '$SELFHOST_WORKTREE/.arbor' --renderer stdout" Enter
else
  # --real swaps the player-piano for genuine model calls. `arbor run` seeds
  # the tree with the whole plan rather than one action, so unlike selfhost --
  # which seeds exactly one node and sets branch_actions to null, and therefore
  # halts on no_nodes the moment that node is claimed -- this is the entry
  # point that actually exhibits tree search: sibling selection, decomposition
  # on timeout, and work still in flight while earlier nodes are being judged.
  if [ "$REAL" = "1" ]; then
    # Same shape as --selfhost: the run goes detached and the pane holds the
    # cockpit. `arbor run`'s own in-pane view reports "Campaign data
    # unavailable" for a real run while its events are already streaming, so
    # the surface that demonstrably reflects a live campaign is `arbor tui`
    # attached to the same persistence directory.
    REAL_CONSOLE_LOG="$PERSISTENCE_DIR/real-console.log"
    # Keep stderr OUT of the TUI stream. `2>&1 | tee` merged a crash message
    # into a live full-screen render, so the one run that died silently left a
    # console log ending mid-frame with no trace, no summary and no exit code --
    # nothing to diagnose from. stderr gets its own file, and the exit status is
    # recorded explicitly rather than inferred from a vanished tmux window.
    REAL_STDERR_LOG="$PERSISTENCE_DIR/real-stderr.log"
    mkdir -p "$PERSISTENCE_DIR"
    # `arbor run` is the entry point this capture actually films, so the
    # verification stages have to reach IT, not only the selfhost branch.
    # Without them every success ceilings at `claimed` and node_verified stays
    # zero -- exactly what both prior reels recorded.
    REAL_VERIFICATION_ARGS=""
    if [ "${#VERIFICATION_CMDS[@]}" -gt 0 ]; then
      for vcmd in "${VERIFICATION_CMDS[@]}"; do
        REAL_VERIFICATION_ARGS+="--verification-cmd $(printf '%q' "$vcmd") "
      done
    fi
    tmux kill-window -t "$SESSION:runner" 2>/dev/null || true
    tmux new-window -t "$SESSION" -n runner -d
    tmux send-keys -t "$SESSION:runner" \
      "cd $REPO_ROOT && ARBOR_PERSISTENCE_DIR='$PERSISTENCE_DIR' node '$DEMO_BUNDLE' demo --executor real --persistence-dir '$PERSISTENCE_DIR' ${REAL_VERIFICATION_ARGS}2>'$REAL_STDERR_LOG' | tee '$REAL_CONSOLE_LOG'; echo \"[runner] campaign exited rc=\$?\" | tee -a '$REAL_STDERR_LOG'" Enter
    tmux send-keys -t "$SESSION:demo.0" \
      "cd $REPO_ROOT && node '$DEMO_BUNDLE' tui --persistence-dir '$PERSISTENCE_DIR' --renderer stdout" Enter
  elif [ "$ONCE" = "1" ]; then
    tmux send-keys -t "$SESSION:demo.0" "cd $REPO_ROOT && ARBOR_PERSISTENCE_DIR='$PERSISTENCE_DIR' node '$DEMO_BUNDLE' demo --once --executor deterministic --persistence-dir '$PERSISTENCE_DIR'" Enter
  else
    tmux send-keys -t "$SESSION:demo.0" "cd $REPO_ROOT && ARBOR_PERSISTENCE_DIR='$PERSISTENCE_DIR' node '$DEMO_BUNDLE' demo --executor deterministic --persistence-dir '$PERSISTENCE_DIR'" Enter
  fi
fi

# Right pane: live tail of the DevTools stream, pretty-printed with jq if present.
# In --selfhost mode this tails the throwaway worktree's OWN log (real ledger
# events from the real run — never $PERSISTENCE_DIR's, which the self-hosting
# executor never writes to). `tail -F` (retry) tolerates the file/directory
# not existing yet — the worktree is created a moment after this pane starts.
if [ "$SELFHOST" = "1" ]; then
  TAIL_LOG="$SELFHOST_LOG"
  TAIL_MKDIR=""  # do NOT pre-create the worktree path — `git worktree add` requires it not to already exist.
else
  TAIL_LOG="$LOG"
  TAIL_MKDIR="mkdir -p '$OBJ_ROOT' && touch '$LOG' && "
fi
sleep 1
if command -v jq >/dev/null 2>&1; then
  # stream of clean one-line projections so the pane is informative but not wall-of-JSON
  tmux send-keys -t "$SESSION:demo.1" "cd $REPO_ROOT && ${TAIL_MKDIR}tail -n 200 -F '$TAIL_LOG' | jq -R -r 'fromjson? | \"\(.ts)  \(.event_kind)  c=\(.campaign_id // \"-\")  n=\(.node_id // \"-\")\"'" Enter
else
  tmux send-keys -t "$SESSION:demo.1" "cd $REPO_ROOT && ${TAIL_MKDIR}tail -n 200 -F '$TAIL_LOG'" Enter
fi

echo "Revoy2 demo window ready: tmux session='$SESSION' window='demo'"
if [ "$SELFHOST" = "1" ]; then
  echo "  left pane  : arbor tui cockpit attached to the REAL campaign (run-id=$SELFHOST_RUN_ID)"
  echo "  campaign   : detached, console at $SELFHOST_CONSOLE_LOG"
  echo "  right pane : tail -F $(basename "$SELFHOST_LOG") from the run's own throwaway worktree"
  echo "  worktree   : $SELFHOST_WORKTREE (kept after the run — --keep-worktree)"
  echo "  log        : $SELFHOST_LOG"
else
  echo "  left pane  : arbor demo (live TUI — player-piano)"
  echo "  right pane : tail -F devtools.log (externally-observable stream)"
  echo "  log        : $LOG"
fi

# Wire the external headless observer (15m) as a background loop.
#
# The observer TRANSMITS the campaign's devtools event log to a third-party model
# (ADR-173), so it is not started unless the operator named that destination in
# this invocation. Previously this started unconditionally with no consent
# argument at all, which meant running this script sent campaign data off the
# machine to a model nobody chose. Skipping is the default and the failure
# direction; --observer-model is the only way in.
if [ "$OBSERVER" != "1" ]; then
  echo "  observer   : skipped (--no-observer)"
elif [ -z "$OBSERVER_MODEL" ]; then
  echo "  observer   : skipped — not started, because it would send the campaign's"
  echo "               devtools log to a third-party model and no destination was"
  echo "               named. To enable: re-run with"
  echo "                 --observer-model <provider/model>"
  echo "               (or inspect the stream yourself, in the right-hand pane)"
elif [ -f "$OBJ_ROOT/observer/loop.pid" ] && kill -0 "$(cat "$OBJ_ROOT/observer/loop.pid")" 2>/dev/null; then
  echo "  observer   : already running (pid $(cat "$OBJ_ROOT/observer/loop.pid"))"
else
  # The named model is threaded as BOTH the observer's --model and its consent,
  # so the loop's every digest goes to the destination the operator just read.
  mkdir -p "$OBJ_ROOT/observer"
  nohup "$SCRIPT_DIR/observe-devtools.sh" --loop --dir "$PERSISTENCE_DIR" \
        --model "$OBSERVER_MODEL" \
        --allow-third-party-egress="$OBSERVER_MODEL" \
        >> "$OBJ_ROOT/observer/loop.log" 2>&1 &
  echo $! > "$OBJ_ROOT/observer/loop.pid"
  echo "  observer   : headless observer started (pid $(cat "$OBJ_ROOT/observer/loop.pid"), every 15m)"
  echo "               sends the devtools log to: $OBSERVER_MODEL"
  echo "               see $OBJ_ROOT/observer/loop.log"
fi

echo
echo "Press in the tmux window: Ctrl-b then d to detach, or:"
echo "  ./scripts/demo-window.sh --kill  to stop everything"
exit 0
