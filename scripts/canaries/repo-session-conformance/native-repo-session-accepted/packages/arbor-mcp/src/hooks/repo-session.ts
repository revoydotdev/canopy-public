// Fixture stub: the session_end half of the native lifecycle. It RECORDS the end
// and reports it; it never reaches the close, whose cost is a rebind of minutes
// and which a session-end hook has no time to run.
import { sessionEnd } from "../repo-session-lifecycle.js";

export function repoSessionEndNote(root: string, sessionId: string): string {
  const state = sessionEnd(root, sessionId);
  if (state === null) return "repo-session: no durable session record";
  const unfinished = state.unfinished === null ? "" : `, unfinished: ${state.unfinished.source_paths.length} source path(s)`;
  return `repo-session: session ${state.session_id} ended (${state.status}${unfinished}); the commit window and the close remain an operator action`;
}