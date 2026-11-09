import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePersistenceDir } from "./persistence-path.js";

export interface SetupResult {
  readonly dry_run: boolean;
  readonly files: readonly { readonly path: string; readonly disposition: "created" | "would_create" | "preserved" }[];
  readonly next_commands: readonly string[];
}

const templates = [
  { name: ".env", source: fileURLToPath(new URL("../../../.env.example", import.meta.url)) },
  { name: "arbor.jsonc", source: fileURLToPath(new URL("../../../arbor.example.jsonc", import.meta.url)) },
] as const;

/** Where each template lands, relative to the resolved persistence root. */
const destinationOf = (name: string, cwd: string, persistenceDir: string): string =>
  // CD-E-24. The SECRET goes inside the persistence root — the containment guard every other
  // campaign write already goes through. `arbor.jsonc` deliberately stays at the project root:
  // `loader.ts` reads `<dir>/arbor.jsonc`, so moving it breaks config loading, and it is not a
  // secret sink.
  name === ".env" ? join(persistenceDir, name) : join(cwd, name);
/** Idempotent first-run scaffolding. Existing local policy and secrets are never overwritten. */
export function setupProject(cwd: string, dryRun = false, persistenceDir: string = resolvePersistenceDir(cwd)): SetupResult {
  const files = templates.map((template) => {
    const destination = destinationOf(template.name, cwd, persistenceDir);
    if (existsSync(destination)) return { path: destination, disposition: "preserved" as const };
    if (!dryRun) {
      // `setup` is usually the first command an operator runs, so it can be the thing that brings
      // the persistence root into existence — the writer lock normally does that later.
      mkdirSync(persistenceDir, { recursive: true, mode: 0o700 });
      writeFileSync(destination, readFileSync(template.source, "utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    return { path: destination, disposition: dryRun ? "would_create" as const : "created" as const };
  });
  return {
    dry_run: dryRun,
    files,
    next_commands: ["Edit .env and arbor.jsonc for the provider or integration you intend to use.", "arbor doctor", "arbor tui"],
  };
}

export function formatSetupResult(result: SetupResult): string {
  return [
    result.dry_run ? "Setup preview" : "Project setup",
    ...result.files.map((file) => `  ${file.disposition}: ${file.path}`),
    "Next",
    ...result.next_commands.map((command) => `  ${command}`),
  ].join("\n");
}
