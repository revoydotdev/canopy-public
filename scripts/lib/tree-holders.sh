#!/usr/bin/env bash
# Shared: how many agent processes hold a given working tree.
#
# Sourced by scripts/hooks/session-isolation.sh (which reports it) and
# scripts/hooks/git-write-guard.sh (which gates a refusal on it). One
# definition, because a guard and the orientation that explains it must not
# disagree about whether the tree is shared.
#
# Counts THIS SESSION TOO: a hook cannot reliably identify its own claude pid
# ($$ is the shell it runs in), and guessing wrong would either hide a real peer
# or invent one. So the count is a total, and ">1" is the shared-tree condition.
tree_holder_count() {
  local target resolved pid cmd holder_cwd count=0
  target="${1:-$PWD}"
  resolved="$(readlink -f "$target" 2>/dev/null || printf '%s' "$target")"
  for pid in $(pgrep -x claude 2>/dev/null || true); do
    # One session spawns helpers (daemon, bg-pty-host, spare, mcp) that share
    # its cwd but are not independent editors; counting them inflates the
    # number, and a signal that overstates is one the reader learns to skip.
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmd" in *"daemon run"*|*bg-pty-host*|*--bg-spare*|*mcp*) continue ;; esac
    holder_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$holder_cwd" = "$resolved" ] && count=$((count + 1))
  done
  printf '%s' "$count"
}
