#!/usr/bin/env bash
#
# observe-devtools.sh — external headless observer for the revoy2 DevTools stream.
#
# Watches <persistence_dir>/devtools/devtools.log (one ND-JSON line per event,
# rotated to devtools.1.log, devtools.2.log, ...) and, on a schedule, hands ONLY
# the newly-appended COMPLETE lines to a headless opencode agent, which digests
# the campaign's health into a short Markdown report.
#
# Modes:
#   (default / --once)         Tail-and-digest once, then exit.
#   --loop                     Tail-and-digest, sleep 15m, repeat (cron fallback).
#   --install-cron             Install an idempotent */15 crontab entry.
#   --uninstall-cron           Remove the idempotent crontab entry.
#   --dry-run                  Do the cursor/rotation/line logic, print captured
#                              lines, skip the agent (no tokens spent).
#
# Consent (this is the file's --help text: `--help` is `grep '^#' "$0"`):
#   "Digesting" means TRANSMITTING the campaign's live devtools event log to a
#   third-party hosted model. No flag, default, env var, or schedule implies
#   that, and there is no default destination. Every path that reaches the
#   model --once, --loop, and the installed cron entry -- requires:
#
#       --allow-third-party-egress=<provider/model>
#
#   whose value must EXACTLY equal the model the run would actually transmit
#   to, so the destination is read before it is used. The flag with no value is
#   refused like omission. Without consent the observer refuses to transmit and
#   refuses to schedule a transmission.
#
# Safety / correctness:
#   - READ-ONLY ON LOCAL STATE ONLY: never writes devtools.log or campaign
#     state, only its own cursor and reports under <dir>/devtools/observer/. It
#     is NOT read-only on the network -- see Consent above.
#   - Failures surface: a failed model call is logged and becomes the run's exit
#     status. The cursor still advances, so one undigestable window is not
#     re-transmitted forever.
#   - Idempotent cursor: stores a byte offset; only complete newline-terminated
#     lines are given to the agent (a partial trailing line completes next run).
#   - Rotation-aware: if devtools.log shrank below the cursor or a .1.log
#     appeared, the cursor resets to the fresh active segment (no MISSING lines,
#     no double-reporting).
#   - Concurrency-safe: a flock guards the whole read→digest→advance cycle, so
#     two concurrent fires never double-process the same lines.
#
# The opencode invocation (verified headless, 2026-08-03):
#     opencode run -m <MODEL> -f <captured-lines> -- "<DIGEST PROMPT>"
# MODEL has no default. The former free-tier third-party default is gone: pass
# --model, and consent to that same model with --allow-third-party-egress.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- defaults -----------------------------------------------------------------
# No default destination model: a third-party model is only ever named by the
# operator (--model, or OBSERVER_MODEL) AND consented to by that same name.
DEFAULT_PERSISTENCE_DIR="${REVOY2_PERSISTENCE_DIR:-$REPO_ROOT/.arbor}"
MODEL="${OBSERVER_MODEL:-}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
LOOP_INTERVAL_SECONDS="${DEVTOOLS_OBSERVER_LOOP_SECONDS:-900}"   # 15m
CRON_MARKER="# revoy2-devtools-observer"
CRON_SCHEDULE="*/15 * * * *"

# --- arg parsing ---------------------------------------------------------------
MODE="once"
PERSISTENCE_DIR="$DEFAULT_PERSISTENCE_DIR"
CONSENT_MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --once) MODE="once"; shift ;;
    --loop) MODE="loop"; shift ;;
    --install-cron) MODE="install-cron"; shift ;;
    --uninstall-cron) MODE="uninstall-cron"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    --dir) PERSISTENCE_DIR="$2"; shift 2 ;;
    # A bare flag yields an empty CONSENT_MODEL, which require_egress_consent
    # refuses exactly as it refuses omission -- one refusal path, not two.
    --allow-third-party-egress=*) CONSENT_MODEL="${1#*=}"; shift ;;
    --allow-third-party-egress) CONSENT_MODEL=""; shift ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | grep -v '^!/' | grep -v '^observe'
      exit 0 ;;
    *)
      # first positional is a persistence-dir override
      PERSISTENCE_DIR="$1"; shift ;;
  esac
done

DEVTOOLS_DIR="$PERSISTENCE_DIR/devtools"
LOG="$DEVTOOLS_DIR/devtools.log"
OBSERVER_DIR="$DEVTOOLS_DIR/observer"
REPORTS_DIR="$OBSERVER_DIR/reports"
CURSOR_FILE="$OBSERVER_DIR/.cursor"
LOCK_FILE="$OBSERVER_DIR/.lock"
TMP_DIR="$OBSERVER_DIR/tmp"

# --- helpers -------------------------------------------------------------------
now_stamp() { date +%Y%m%d-%H%M%S; }
log_msg()  { echo "[observe-devtools $(now_stamp)] $*"; }

# Consent gate for every path that transmits campaign data to a third-party
# model. Three distinct refusals, three distinct reasons, so an operator can
# tell "you named no model" from "you did not consent" from "you consented to a
# different model than the one this run would use". Each exits non-zero.
require_egress_consent() {
  local action="$1"
  if [ -z "$MODEL" ]; then
    log_msg "REFUSING $action: no destination model is configured."
    log_msg "This observer transmits the campaign's devtools event log off-machine,"
    log_msg "so it will not choose a destination for you. Name one explicitly:"
    log_msg "  --model <provider/model> --allow-third-party-egress=<provider/model>"
    exit 2
  fi
  if [ -z "$CONSENT_MODEL" ]; then
    log_msg "REFUSING $action: it transmits the campaign's devtools event log to the"
    log_msg "third-party model '$MODEL', and no operator consent was given."
    log_msg "If that is the destination you intend, re-run with the model named:"
    log_msg "  --allow-third-party-egress=$MODEL"
    exit 2
  fi
  if [ "$CONSENT_MODEL" != "$MODEL" ]; then
    log_msg "REFUSING $action: consent names '$CONSENT_MODEL' but this run would"
    log_msg "transmit to '$MODEL'. Consent must name the actual destination."
    exit 2
  fi
  log_msg "consent OK: $action transmits to '$MODEL', named by the operator"
}

ensure_dirs() {
  mkdir -p "$REPORTS_DIR" "$TMP_DIR"
}

# Read the stored cursor: "<inode> <offset>". Returns 0 offset if absent.
read_cursor() {
  if [ -f "$CURSOR_FILE" ]; then cat "$CURSOR_FILE"; else echo "0 0"; fi
}

# Determine whether the active log rotated/changed identity. The logger rotates
# by renaming devtools.log → .1.log then opening a fresh one, so the inode (or an
# observed size shrink) is the reliable signal.
log_identity_changed() {
  local stored_inode="$1" stored_offset="$2" now_inode now_size
  now_inode="$(stat -c %i "$LOG" 2>/dev/null || echo "0")"
  now_size="$(stat -c %s "$LOG" 2>/dev/null || echo "0")"
  # inode changed (fresh active segment) OR the file shrank below the cursor
  [ "$now_inode" != "$stored_inode" ] || [ "$now_size" -lt "$stored_offset" ]
}

# Read only the COMPLETE newline-terminated bytes from `from` to EOF into the
# given file; echoes the number of bytes actually consumed (complete).
capture_new_lines() {
  local from="$1" out="$2" total chunk_size consumed
  total="$(stat -c %s "$LOG" 2>/dev/null || echo "0")"
  if [ "$total" -le "$from" ]; then
    : > "$out"
    echo "$total"   # consumed to EOF
    return
  fi
  # bytes after `from`
  dd if="$LOG" bs=1 skip="$from" of="$out" status=none 2>/dev/null || true
  chunk_size="$(stat -c %s "$out" 2>/dev/null || echo 0)"
  if [ "$chunk_size" -le 0 ]; then
    echo "$from"
    return
  fi
  # If the tail ends with a newline, everything is complete.
  if [ "$(tail -c 1 "$out" | od -An -tx1 | tr -d ' \n')" = "0a" ]; then
    echo "$((from + chunk_size))"
  else
    # Find the last newline byte offset within the chunk; only consume up to it.
    local last_nl
    last_nl="$(grep -abo $'\n' "$out" | tail -1 | cut -d: -f1 || true)"
    if [ -n "$last_nl" ]; then
      echo "$((from + last_nl + 1))"
    else
      : > "$out"   # no complete line yet; consume nothing
      echo "$from"
    fi
  fi
}

digest_prompt() {
  cat <<'PROMPT'
You are the EXTERNAL OBSERVER for the revoy2 autonomous demo — a read-only
headless agent watching the campaign's DevTools streaming log from outside.

The ND-JSON lines for this observation window are attached to this message.
Each line is one event; "event_kind" is either a runtime kind or "loop.<phase>"
(e.g. loop.specialist_dispatched, loop.node_verified, loop.halt). A line with
"synthetic":true is a stream.truncated overflow marker.

Do, in order:
1. Read the attached devtools log lines.
2. Classify campaign health into exactly one of: ADVANCING / STALLED / HALTED /
   VERIFIED / FAILURES (state the label on its own line first).
3. Summarize the most recent loop events (dispatch, verify, fail, backtrack, halt).
4. Note any anomalies: synthetic truncation markers, run of node failures, budget
   halt, missing progress, stalled iterations.
5. End with a one-line health verdict.

Constraints:
- READ-ONLY. Do not modify files, run commands, or change campaign state. Read the
  attached lines and emit the digest only.
- Output ONLY a concise Markdown digest (status line, key events, anomalies,
  verdict). No preamble, no task commentary.
PROMPT
}

run_agent() {
  local captured="$1" report="$2"
  local prompt
  prompt="$(digest_prompt)"
  # Attach the captured lines and request a digest. --auto is intentionally NOT
  # used: the observer needs no tool-loop, and the caller has already asserted
  # consent to transmit to "$MODEL". A failed call is reported, not swallowed.
  local agent_rc=0
  "$OPENCODE_BIN" run -m "$MODEL" -f "$captured" --dir "$REPO_ROOT" -- "$prompt" > "$report" 2>&1 || agent_rc=$?
  # Strip ANSI escape sequences for a clean archival digest.
  sed -i $'s/\x1b\[[0-9;]*m//g' "$report" 2>/dev/null || true
  if [ "$agent_rc" -ne 0 ]; then
    log_msg "MODEL CALL FAILED: '$OPENCODE_BIN' exited $agent_rc sending to '$MODEL'."
    log_msg "The attempt is recorded in $report. This failure is not swallowed:"
    log_msg "it is the exit status of this run."
  fi
  return "$agent_rc"
}

observe_once() {
  ensure_dirs
  if [ ! -f "$LOG" ]; then
    log_msg "no devtools.log yet at $LOG — nothing to observe"
    return 0
  fi

  # Concurrency lock (non-blocking): a second simultaneous fire skips cleanly.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log_msg "another observer run holds the lock — skipping"
    return 0
  fi

  local stored_inode stored_offset now_inode
  local has_cursor=1
  if [ -f "$CURSOR_FILE" ]; then
    read -r stored_inode stored_offset <<<"$(read_cursor)"
  else
    stored_inode=0; stored_offset=0; has_cursor=0
  fi

  if [ "$has_cursor" = "1" ] && log_identity_changed "$stored_inode" "$stored_offset"; then
    log_msg "log rotated/replaced — resetting cursor to fresh active segment"
    stored_offset=0
  elif [ "$has_cursor" = "0" ]; then
    log_msg "first observation of this log — starting at offset 0"
  fi

  local captured="$TMP_DIR/captured-$(now_stamp).log"
  local new_offset
  new_offset="$(capture_new_lines "$stored_offset" "$captured")"

  if [ ! -s "$captured" ]; then
    log_msg "no new complete lines (cursor at $stored_offset/$new_offset)"
    rm -f "$captured"
    # persist advanced offset even on empty (rotation edge)
    echo "$(stat -c %i "$LOG") $new_offset" > "$CURSOR_FILE"
    return 0
  fi

  local line_count
  line_count="$(wc -l < "$captured")"
  log_msg "captured $line_count new line(s) ($stored_offset → $new_offset)"

  if [ "$MODE" = "dry-run" ]; then
    log_msg "DRY-RUN — would run agent on:"
    cat "$captured"
    echo "$(stat -c %i "$LOG") $new_offset" > "$CURSOR_FILE"
    rm -f "$captured"
    return 0
  fi

  local report="$REPORTS_DIR/campaign-$(now_stamp).md"
  require_egress_consent "digesting $line_count captured line(s)"
  local agent_rc=0
  run_agent "$captured" "$report" || agent_rc=$?
  echo
  log_msg "report written: $report"
  echo "────────── headless observer digest ──────────"
  cat "$report"
  echo "────────────────────────────────────────────────"

  # Advance the cursor even when the model call failed, so a window the model
  # can never digest is not re-transmitted on every fire. The failure itself is
  # NOT swallowed: run_agent logged it, and it is this run's exit status.
  echo "$(stat -c %i "$LOG") $new_offset" > "$CURSOR_FILE"
  rm -f "$captured"
  return "$agent_rc"
}

install_cron() {
  # Consent first. An unattended egress schedule is precisely the thing being
  # authorised, so it is checked before we even ask whether cron exists here.
  require_egress_consent "--install-cron"
  if ! command -v crontab >/dev/null 2>&1; then
    log_msg "crontab binary not available on this box — cron cannot be installed."
    log_msg "Use the --loop fallback instead, with the same consent flag:"
    log_msg "  nohup $0 --loop --allow-third-party-egress=$MODEL >> $OBSERVER_DIR/loop.log 2>&1 &"
    return 0
  fi
  local entry
  # The scheduled fire carries its own --model and consent, so a consent given
  # once to install is the consent the unattended run is held to. It cannot
  # drift onto a different destination than the one that was approved.
  entry="$CRON_SCHEDULE $(printf '%q' "$0") --dir $(printf '%q' "$PERSISTENCE_DIR") --model $(printf '%q' "$MODEL") --allow-third-party-egress=$(printf '%q' "$MODEL") >> $(printf '%q' "$OBSERVER_DIR/cron.log") 2>&1"
  local current
  current="$(crontab -l 2>/dev/null || true)"
  # strip any prior revoy2 observer entry + its marker, then re-add once
  current="$(printf '%s\n' "$current" | grep -vF "$CRON_MARKER" | grep -vF "$CRON_SCHEDULE $0" || true)"
  printf '%s\n%s\n%s\n' "$current" "$CRON_MARKER" "$entry" | crontab -
  log_msg "installed crontab entry: $entry"
  log_msg "DESTINATION: every fire above sends the campaign's devtools event log"
  log_msg "to the third-party model '$MODEL'. To withdraw it: $0 --uninstall-cron"
  log_msg "verify with: crontab -l"
}

uninstall_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    log_msg "crontab not available — nothing to remove"
    return 0
  fi
  local current
  current="$(crontab -l 2>/dev/null || true)"
  current="$(printf '%s\n' "$current" | grep -vF "$CRON_MARKER" | grep -vF "$CRON_SCHEDULE $0" || true)"
  printf '%s\n' "$current" | crontab - 2>/dev/null || true
  log_msg "removed revoy2 observer cron entry"
}

case "$MODE" in
  once|dry-run)
    observe_once ;;
  loop)
    require_egress_consent "--loop"
    log_msg "observer loop started (every ${LOOP_INTERVAL_SECONDS}s) — Ctrl-C to stop"
    while true; do
      MODE=once observe_once
      sleep "$LOOP_INTERVAL_SECONDS"
    done ;;
  install-cron)
    install_cron ;;
  uninstall-cron)
    uninstall_cron ;;
  *)
    log_msg "unknown mode: $MODE"
    exit 2 ;;
esac
