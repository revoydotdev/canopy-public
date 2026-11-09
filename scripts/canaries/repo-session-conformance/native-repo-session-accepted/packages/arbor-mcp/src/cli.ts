// Fixture stub: the native CLI, dispatching the repository-session lifecycle and
// the rest of its own surface.
import { repoSessionLifecycleCommand } from "./repo-session-close.js";

type Environment = { readonly stdout: { write(text: string): void }; readonly stderr: { write(text: string): void } };

export async function main(args: string[], environment: Environment): Promise<number> {
  if (args.length === 0 || args[0] === "--help") {
    environment.stdout.write("usage: arbor <command>\n");
    environment.stdout.write("  arbor repo-session <begin|status|open|close|abort> [options]  Govern the repository-session lifecycle\n");
    environment.stdout.write("  arbor run\n");
    return 0;
  }
  if (args[0] === "repo-session") return repoSessionLifecycleCommand(args.slice(1), environment);
  if (args[0] === "run") return 0;
  return 1;
}