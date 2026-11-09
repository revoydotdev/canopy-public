/**
 * The repository-session lifecycle's two host hooks, native: open the record at
 * `session_start`, record the end at `session_end`.
 *
 * These replace `scripts/hooks/session-close-start.sh`,
 * `scripts/hooks/session-close-end.sh` and `scripts/hooks/codex-session-lifecycle.mjs`
 * (all deleted). What changed is WHEN each fires, and it is a real change, so it is
 * stated rather than papered over: the shell hooks fired on the HOST's session
 * boundary (a Claude Code or Codex CLI process starting and exiting), and revoy2
 * does not own that moment. The native seam fires on revoy2's own `session_start`
 * and `session_end` — the first moment a revoy2-driven session exists, and its
 * last. The guarantee is therefore "a revoy2-DRIVEN session cannot do work
 * without the deferral in force, and cannot end without the end recorded", not
 * "the operator's editor opening a terminal opens a record".
 *
 * THE END PATH RECORDS AND NEVER CLOSES. `sessionEnd` is the whole of what
 * `repoSessionEndNote` may do; the close rebinds evidence for eight to twelve
 * minutes, and the host hook this replaces fired under a timeout pinned to three
 * seconds. The lifetime it would break is the stranded-window problem itself, and
 * the terminator for that is `reconcileStrandedWindow`, not a hook.
 *
 * ONE REPOSITORY SESSION PER CHECKOUT, not one per model session. `session_start`
 * fires for every native session, subagent children included, and a record per
 * child would make `assertWindow` refuse commits while naming a dozen sessions
 * that share one window. So a second session finds the record already open and
 * joins it instead of opening another.
 */
import { createHash } from "node:crypto";
import type { Tropism } from "@arbor/prompts";
import { readSession, TERMINAL_STATUSES } from "../repo-session-store.js";
import { beginSession, sessionEnd } from "../repo-session-lifecycle.js";
import type { HookInjectHandler, HookLifecycleObserveHandler } from "./contracts.js";
import { currentGovernedRoot } from "./governance-tropisms.js";

/** Long enough that a model which ignores the first read still has it in context. */
const SESSION_TTL_TURNS = 3;

/**
 * Open (or join) the repository session and tell the model what the deferral costs
 * it. Returns null when the store cannot be reached — a session in a directory
 * that is not a Git worktree is not deferred anywhere, and an orientation block
 * that cannot be measured is not one worth injecting.
 */
export function repoSessionOpenTropism(root: string, sessionId: string): Tropism | null {
  const existing = readSession(root, sessionId);
  if (existing !== null && TERMINAL_STATUSES.includes(existing.status)) {
    // A terminal record means the previous session closed (or was retired);
    // reopening is a fresh record under this session's own id.
    beginSession(root, sessionId);
  } else if (existing === null) {
    // Join the record some earlier session in this checkout already opened, rather
    // than opening a second one for the same working tree.
    const latest = readSession(root);
    if (latest !== null && !TERMINAL_STATUSES.includes(latest.status)) return null;
    beginSession(root, sessionId);
  }

  const state = readSession(root, sessionId);
  if (state === null) return null;
  const notes = [
    `revoy2 repository session ${state.session_id} is ${state.status}: commits and the gate battery are DEFERRED to one close at the end of the session.`,
    "At the close: `arbor repo-session open`, commit the planned source series by concern with its `ADR: NNN` trailer, then `arbor repo-session close` — evidence rebind, store-only commit, stop tier, full tier, decision-queue report, receipt.",
    state.unfinished == null ? "" : `The previous session ended ${state.status} with ${state.unfinished.source_paths.length} uncommitted source path(s).`,
  ].filter((line) => line !== "");
  return Object.freeze({
    id: "repo-session", trigger: "session_start", lane: "ADVISORY", provenance: "generated",
    derived_from: Object.freeze([`session:${createHash("sha256").update(`${state.session_id}|${state.status}|${state.opened_at}`).digest("hex").slice(0, 16)}`]),
    body: notes.join("\n"), expires_after_turns: SESSION_TTL_TURNS, enforcing_ref: null,
  });
}

/**
 * Record the end of the repository session. Returns a bounded ledger note, which
 * is the only product the `session_end` observe lane has: no model-facing field
 * exists there, and inventing one would be the advisory-inject-lane decision
 * already refused for `turn_end`.
 */
export function repoSessionEndNote(root: string, sessionId: string): string {
  const own = readSession(root, sessionId);
  const state = sessionEnd(root, own === null ? null : sessionId);
  if (state === null) return "repo-session: no durable session record; nothing to reconcile";
  const unfinished = state.unfinished === null || state.unfinished === undefined
    ? ""
    : `, unfinished: ${state.unfinished.source_paths.length} source path(s)`;
  return `repo-session: session ${state.session_id} ended (${state.status}${unfinished}); the commit window and the close remain an operator action`;
}

/** The repository session's own cost, so the bus does not measure it with the
 *  50 ms default meant for an in-process predicate: both handlers run `git status`
 *  and read the durable store, and the inject one also writes it. */
export const REPO_SESSION_HANDLER_BOUND_MS = 2000;

export const repoSessionOpenHandler: HookInjectHandler = (context) => repoSessionOpenTropism(currentGovernedRoot(), context.session_id);
export const repoSessionEndHandler: HookLifecycleObserveHandler = (context) => ({ note: repoSessionEndNote(currentGovernedRoot(), context.session_id) });