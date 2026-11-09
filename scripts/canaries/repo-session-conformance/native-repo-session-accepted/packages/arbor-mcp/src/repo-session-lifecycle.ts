// Fixture stub: the native lifecycle module. The close is one contiguous process
// with a fixed order, and the end of a session only ever records.
export interface SessionRecord {
  readonly session_id: string;
  readonly status: string;
  readonly ended_at?: string | null;
  readonly unfinished?: { readonly status: string; readonly source_paths: readonly string[] } | null;
}

export type CloseRunner = (label: string, argv: readonly string[]) => { readonly ok: boolean; readonly status: number };

/** The one contiguous process. Order is the contract: bind evidence, commit the stores, then the cheap tier, then the cumulative one, then report what the operator still owes. */
export function closeSession(repo: string, run: CloseRunner): readonly string[] {
  const labels: string[] = [];
  const bind = run("evidence:rebind", ["bun", "run", "evidence:rebind"]);
  labels.push(bind.label ?? "evidence:rebind");
  if (!bind.ok) return labels;
  run("git add (evidence)", ["git", "add", "--"]);
  labels.push("git add (evidence)");
  run("git commit (evidence)", ["git", "commit", "-q", "-m"]);
  labels.push("git commit (evidence)");
  const stop = run("gate:all --tier stop", ["bun", "scripts/gate-all.mjs", "--tier", "stop"]);
  labels.push("gate:all --tier stop");
  if (!stop.ok) return labels;
  const cumulative = run("gate:all --tier full", ["bun", "scripts/gate-all.mjs", "--tier", "full"]);
  labels.push("gate:all --tier full");
  if (!cumulative.ok) return labels;
  run("decision-queue", ["bun", "scripts/decision-queue.mjs", "--json"]);
  labels.push("decision-queue");
  void repo;
  return labels;
}

/** Record the end of a session. This is what a session-end hook calls, and it is the whole of what it may call. */
export function sessionEnd(repo: string, sessionId: string): SessionRecord | null {
  void repo;
  return { session_id: sessionId, status: "open" };
}