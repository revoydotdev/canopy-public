import { acquireWriterLock, type WriterLockHandle } from "@arbor/core";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type WorkerCommand =
  | { readonly kind: "create_challenge"; readonly peer_repo_id: string; readonly peer_session_id: string; readonly token: string }
  | { readonly kind: "peer_challenge"; readonly from_repo_id: string; readonly from_session_id: string; readonly token: string }
  | { readonly kind: "peer_reply"; readonly from_repo_id: string; readonly from_session_id: string; readonly token: string }
  | { readonly kind: "shutdown" };

type WorkerEvent = Readonly<Record<string, string | number | boolean>> & { readonly kind: string };

const [mode = "session", repoId = "unknown-repo", sessionId = "unknown-session", persistenceDir = "", commandFile = ""] = process.argv.slice(2);
let lock: WriterLockHandle | null = null;

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function release(): void {
  lock?.release();
  lock = null;
}

function finish(code: number): never {
  release();
  process.exit(code);
}

if (mode === "session" || mode === "hold-lock" || mode === "try-lock") {
  const result = acquireWriterLock(persistenceDir, { holder: `flight-worker:${repoId}:${sessionId}` });
  if (!result.ok) {
    emit({ kind: "lock_refused", repo_id: repoId, session_id: sessionId, pid: process.pid, detail: result.detail });
    process.exit(0);
  }
  lock = result.lock;
  emit({ kind: "ready", repo_id: repoId, session_id: sessionId, pid: process.pid, lock_held: true, reclaimed_stale: result.reclaimed_stale });
  if (mode === "try-lock") finish(1);
} else if (mode === "blocked") {
  emit({ kind: "ready", repo_id: repoId, session_id: sessionId, pid: process.pid, lock_held: false, blocked: true });
} else {
  emit({ kind: "worker_error", repo_id: repoId, session_id: sessionId, pid: process.pid, detail: `unknown mode ${mode}` });
  process.exit(2);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
    if (line.trim().length === 0) return;
    let command: WorkerCommand;
    try {
      command = JSON.parse(line) as WorkerCommand;
    } catch {
      emit({ kind: "worker_error", repo_id: repoId, session_id: sessionId, pid: process.pid, detail: "malformed command" });
      return;
    }
    handle(command);
});

process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || typeof (message as { kind?: unknown }).kind !== "string") {
    emit({ kind: "worker_error", repo_id: repoId, session_id: sessionId, pid: process.pid, detail: "malformed IPC command" });
    return;
  }
  handle(message as WorkerCommand);
});

let commandBytes = 0;
void (commandFile.length === 0 ? null : setInterval(() => {
  if (!existsSync(commandFile)) return;
  const contents = readFileSync(commandFile, "utf8");
  if (contents.length <= commandBytes) return;
  const appended = contents.slice(commandBytes);
  commandBytes = contents.length;
  for (const line of appended.split("\n")) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line) as WorkerCommand); }
    catch { emit({ kind: "worker_error", repo_id: repoId, session_id: sessionId, pid: process.pid, detail: "malformed command journal entry" }); }
  }
}, 10));

function handle(command: WorkerCommand): void {
    if (command.kind === "create_challenge") {
      emit({ kind: "challenge", repo_id: repoId, session_id: sessionId, peer_repo_id: command.peer_repo_id, peer_session_id: command.peer_session_id, token: command.token, pid: process.pid });
    } else if (command.kind === "peer_challenge") {
      emit({ kind: "reply", repo_id: repoId, session_id: sessionId, peer_repo_id: command.from_repo_id, peer_session_id: command.from_session_id, token: command.token, pid: process.pid });
    } else if (command.kind === "peer_reply") {
      emit({ kind: "reply_acknowledged", repo_id: repoId, session_id: sessionId, peer_repo_id: command.from_repo_id, peer_session_id: command.from_session_id, token: command.token, pid: process.pid });
    } else if (command.kind === "shutdown") {
      emit({ kind: "stopped", repo_id: repoId, session_id: sessionId, pid: process.pid });
      finish(0);
    }
}

process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
