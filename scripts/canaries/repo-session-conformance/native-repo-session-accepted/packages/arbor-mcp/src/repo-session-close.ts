// Fixture stub: the operator surface. Five verbs, each reaching the source-owned
// lifecycle module in-process.
import { abortWindow, beginSession, finishSession, openWindow, statusReport } from "./repo-session-lifecycle.js";

type Environment = { readonly stdout: { write(text: string): void }; readonly stderr: { write(text: string): void } };

export function repoSessionLifecycleCommand(args: readonly string[], environment: Environment): number {
  const [action = "status", ...flags] = args;
  const session = flags.includes("--session") ? flags[flags.indexOf("--session") + 1] : null;
  if (action === "begin") { beginSession(".", session ?? "session"); return 0; }
  if (action === "open") { openWindow(".", session); return 0; }
  if (action === "close") { closeSession(".", () => ({ ok: true, status: 0 })); return 0; }
  if (action === "abort") { abortWindow(".", session); return 0; }
  if (action !== "status") { environment.stderr.write("Usage: arbor repo-session <begin|status|open|close|abort> [options]\n"); return 2; }
  environment.stdout.write(`${JSON.stringify(statusReport("."))}\n`);
  return 0;
}