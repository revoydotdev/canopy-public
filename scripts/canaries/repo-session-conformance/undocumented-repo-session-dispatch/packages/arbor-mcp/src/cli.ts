// Canary fixture: a native CLI that dispatches `run` and nothing else.
//
// The gate asserts that the native CLI dispatches the repository-session
// lifecycle by comparing argv[0] against that one command name. This file has
// a well-formed `main(args, environment)` with a real help branch and a real
// dispatch branch — it is not a malformed file, it is a CLI the lifecycle was
// never wired into, which is the exact drift class this gate exists to catch.
//
// The comment above deliberately spells neither the argv comparison nor the
// command name. A prose mention of either would satisfy the very regex this
// fixture exists to make fail, and the canary would go green for the wrong
// reason.
type Environment = { stderr: { write(text: string): void } };

export async function main(args: string[], environment: Environment): Promise<number> {
  if (args.length === 0 || args[0] === "--help") {
    environment.stderr.write("usage: arbor <command>\n");
    environment.stderr.write("  arbor run\n");
    return 0;
  }
  if (args[0] === "run") return 0;
  return 1;
}
