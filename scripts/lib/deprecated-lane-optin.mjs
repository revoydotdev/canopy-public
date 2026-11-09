// ADR-192: Canopy (revoy-native) is the only campaign harness before 1.0.0.
// A script whose purpose is to exercise a deprecated connector lane (opencode,
// claude-code, codex) must not grant itself that lane: re-enabling it is an
// operator grant, made in arbor.jsonc as `connectors.allow_deprecated: true`
// plus `connectors.reason`. This preflight reads the same ADR-110 scope chain
// the CLI reads and refuses early, before any recording spend, with the remedy.
import { resolveConfigScopes } from "@arbor/config";

export function deprecatedLaneOptInStatus(dir, env = process.env) {
  const connectors = resolveConfigScopes(dir, env).scoped.connectors;
  const reason = typeof connectors?.reason === "string" ? connectors.reason.trim() : "";
  return { admitted: connectors?.allow_deprecated === true && reason.length > 0, reason };
}

export function assertDeprecatedLaneOptIn(dir, lane, script, env = process.env) {
  const status = deprecatedLaneOptInStatus(dir, env);
  if (status.admitted) return status;
  throw new Error(
    `${script} exercises the deprecated "${lane}" connector lane, but all work runs through the Canopy harness before 1.0.0 (ADR-192). ` +
    `To run it anyway, set connectors.allow_deprecated: true and connectors.reason: "<why>" in an arbor.jsonc that resolves for ${dir} ` +
    `(project, user or organization scope); the reason is recorded in the run's evidence.`,
  );
}
