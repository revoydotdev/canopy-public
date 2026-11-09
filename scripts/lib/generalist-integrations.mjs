export const GENERALIST_INTEGRATIONS = Object.freeze({
  "claude-code": Object.freeze({
    executable: "claude",
    readiness_args: Object.freeze(["auth", "status", "--json"]),
    disclosure: "Claude Code integration; account identity, credential values, and raw provider content withheld",
  }),
  opencode: Object.freeze({
    executable: "opencode",
    readiness_args: Object.freeze(["auth", "list"]),
    disclosure: "OpenCode integration; account identity, credential values, and raw provider content withheld",
  }),
  codex: Object.freeze({
    executable: "codex",
    readiness_args: Object.freeze(["login", "status"]),
    disclosure: "Codex CLI integration; account identity, credential values, and raw provider content withheld",
  }),
});

export function resolveGeneralistIntegration(value) {
  const integration = GENERALIST_INTEGRATIONS[value];
  if (integration === undefined) {
    throw new Error(`--integration must be one of: ${Object.keys(GENERALIST_INTEGRATIONS).join(", ")}`);
  }
  return integration;
}

export function readinessCommandForIntegration(value) {
  const integration = resolveGeneralistIntegration(value);
  return [integration.executable, [...integration.readiness_args]];
}
