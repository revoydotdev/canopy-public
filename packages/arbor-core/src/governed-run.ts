/**
 * The marker that says "this process is running inside a Canopy harness run".
 *
 * Repository governance (commit windows, decision trailers, the push battery)
 * is enforced by the harness itself. The few git hooks that remain are thin
 * entry points into that enforcement, and they act only when this variable is
 * set to "1": a host agent session (Claude Code, Codex) or a human terminal
 * never carries it, so governance cannot fire on work the harness is not
 * running. The harness sets it on every process it spawns.
 *
 * Governing records: ADR-170 (native-feasible gates migrate into the harness), ADR-177 (governance acts only inside Canopy runs).
 */
export const GOVERNED_RUN_ENV = "ARBOR_GOVERNED_RUN" as const;

/** `env` plus the governed-run marker; never mutates its argument. */
export function withGovernedRun<T extends Record<string, string | undefined>>(env: T): T & { readonly [GOVERNED_RUN_ENV]: "1" } {
  return { ...env, [GOVERNED_RUN_ENV]: "1" as const };
}

/** True when `env` carries the governed-run marker. */
export function isGovernedRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[GOVERNED_RUN_ENV] === "1";
}
