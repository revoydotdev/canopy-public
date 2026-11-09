/** Revision-bound evidence contract for the native `arbor selfhost` cohort. */
export const SELFHOST_ACCEPTANCE_SCHEMA = "revoy2.selfhost.acceptance.v1";

export const SELFHOST_COHORT = Object.freeze({
  name: "native-selfhost-release-candidate",
  integrations: Object.freeze(["revoy-native"]),
  tasks: Object.freeze([
    "governed-backlog-selection",
    "native-specialist-and-critic",
    "declared-machine-verification",
    "durable-result-adoption",
  ]),
});

const HASH = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** Validate the producer's sealed run record; fixtures may exercise this shape but cannot become observed proof. */
export function validateSelfhostAcceptanceArtifact(value, { expectedCommit, allowFixture = false } = {}) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["artifact must be an object"] };
  if (value.schema !== SELFHOST_ACCEPTANCE_SCHEMA) add(`schema must be ${SELFHOST_ACCEPTANCE_SCHEMA}`);
  if (!HASH.test(value.candidate_commit ?? "")) add("candidate_commit must be a full lowercase Git commit hash");
  if (expectedCommit && value.candidate_commit !== expectedCommit) add("candidate_commit does not match the release candidate");
  if (value.kind !== "observed" && value.kind !== "fixture") add('kind must be "observed" or "fixture"');
  if (typeof value.producer !== "string" || value.producer.trim() === "") add("producer identity is required");
  if (value.kind === "fixture" && !allowFixture) add("fixture artifact cannot establish selfhost acceptance");
  if (!nonEmpty(value.cohort_id)) add("cohort_id is required");
  if (!value.cohort || value.cohort.name !== "native-selfhost-release-candidate"
      || !Array.isArray(value.cohort.integrations) || value.cohort.integrations.length !== 1 || value.cohort.integrations[0] !== "revoy-native"
      || !Array.isArray(value.cohort.tasks) || value.cohort.tasks.length === 0) add("cohort identity must name the native self-host integration and task scope");
  if (!nonEmpty(value.started_at) || Number.isNaN(Date.parse(value.started_at))) add("started_at must be an ISO-compatible timestamp");
  if (!nonEmpty(value.finished_at) || Number.isNaN(Date.parse(value.finished_at))) add("finished_at must be an ISO-compatible timestamp");
  if (!value.execution || value.execution.host_commit !== value.candidate_commit || value.execution.target_commit !== value.candidate_commit || value.execution.install_exit_code !== 0) add("host and target checkouts must match the candidate and host dependency install must succeed");
  if (!Array.isArray(value.runs) || value.runs.length === 0) add("runs must contain at least one CLI execution");
  else for (const [index, run] of value.runs.entries()) {
    const label = `runs[${index}]`;
    if (!run || typeof run !== "object" || Array.isArray(run)) { add(`${label} must be an object`); continue; }
    if (run.candidate_commit !== value.candidate_commit) add(`${label}.candidate_commit differs from the artifact candidate`);
    if (run.campaign_id !== `selfhost-${value.cohort_id}`) add(`${label}.campaign_id must bind to this cohort id`);
    if (!Array.isArray(run.argv) || run.argv.length < 3 || run.argv.some((part) => typeof part !== "string")) add(`${label}.argv must record the real CLI argv`);
    if (run.argv?.[0] !== "selfhost") add(`${label}.argv must begin with the selfhost subcommand`);
    const runIdIndex = run.argv?.indexOf("--run-id") ?? -1;
    if (runIdIndex < 0 || run.argv[runIdIndex + 1] !== value.cohort_id || !run.argv.includes("--target")) add(`${label}.argv must bind the target and exact cohort run id`);
    if (!Array.isArray(run.cli_argv) || run.cli_argv[0] !== "bun" || run.cli_argv[1] !== "packages/arbor-mcp/bin/arbor-mcp.mjs") add(`${label}.cli_argv must identify the shipped arbor CLI entrypoint`);
    if (run.selected_integration_id !== "revoy-native") add(`${label} must record the selected Canopy-native integration revoy-native`);
    if (!Number.isInteger(run.exit_code)) add(`${label}.exit_code must be an integer`);
    if (!nonEmpty(run.stdout_artifact) || !nonEmpty(run.stderr_artifact)) add(`${label} must retain stdout and stderr artifact paths`);
    if (!SHA256.test(run.stdout_sha256 ?? "") || !SHA256.test(run.stderr_sha256 ?? "")) add(`${label} must bind stdout and stderr with SHA-256 digests`);
    if (!nonEmpty(run.outcome)) add(`${label}.outcome is required`);
    if (run.outcome === "passed" && run.exit_code !== 0) add(`${label} cannot pass with a non-zero exit code`);
    if (run.outcome !== "passed" && run.outcome !== "failed" && run.outcome !== "interrupted" && run.outcome !== "awaiting_review") add(`${label}.outcome must be passed, failed, interrupted, or awaiting_review`);
    if (run.outcome !== "passed" && run.artifacts_preserved !== true) add(`${label} failure/interruption must preserve its artifacts`);
    if (run.outcome === "passed" && run.verified_result !== true) add(`${label} passed outcome requires a verified result`);
    if (run.outcome === "passed" && run.adoption_check !== "passed") add(`${label} passed outcome requires an independent adoption check`);
    if (run.outcome === "passed" && (!run.review_attestation || typeof run.review_attestation.artifact !== "string"
        || !SHA256.test(run.review_attestation.sha256 ?? "") || typeof run.review_attestation.signature_artifact !== "string"
        || !SHA256.test(run.review_attestation.signature_sha256 ?? ""))) add(`${label} passed outcome requires a hash-bound signed review attestation`);
  }
  if (value.artifact_index_sha256 !== undefined && !SHA256.test(value.artifact_index_sha256)) add("artifact_index_sha256 must be a lowercase SHA-256 digest");
  return { valid: errors.length === 0, errors };
}
