type Environment = { stderr: { write(text: string): void } };

/** Canary fixture: dispatches `canary` and never documents it in --help. */
export async function main(args: string[], environment: Environment): Promise<number> {
  if (args.length === 0 || args[0] === "--help") {
    environment.stderr.write("usage: arbor <command>\n");
    environment.stderr.write("  arbor run\n");
    return 0;
  }
  if (args[0] === "canary") return 0;
  return 1;
}
