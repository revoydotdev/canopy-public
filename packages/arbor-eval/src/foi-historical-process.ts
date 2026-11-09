import { execFileSync } from "node:child_process";

/**
 * Narrow process boundary for revision-bound historical capture. Keeping the
 * boundary typed and text-only prevents verifier JSON parsing from becoming
 * subprocess-output control flow.
 */
export function runHistoricalCommand(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
