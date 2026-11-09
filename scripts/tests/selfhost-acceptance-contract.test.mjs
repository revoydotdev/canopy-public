import { describe, expect, it } from "vitest";
import { SELFHOST_ACCEPTANCE_SCHEMA, SELFHOST_COHORT, validateSelfhostAcceptanceArtifact } from "../selfhost-acceptance-contract.mjs";

const commit = "a".repeat(40);

function artifact(overrides = {}) {
  return {
    schema: SELFHOST_ACCEPTANCE_SCHEMA,
    kind: "observed",
    producer: "selfhost-runner",
    candidate_commit: commit,
    cohort: SELFHOST_COHORT,
    cohort_id: "cohort-a",
    started_at: "2026-09-22T12:00:00.000Z",
    finished_at: "2026-09-22T12:01:00.000Z",
    execution: { host_checkout: "host", host_commit: commit, target_checkout: "target", target_commit: commit, install_exit_code: 0 },
    runs: [{ candidate_commit: commit, campaign_id: "selfhost-cohort-a", argv: ["selfhost", "--target", "/tmp/target", "--run-id", "cohort-a"], cli_argv: ["bun", "packages/arbor-mcp/bin/arbor-mcp.mjs", "selfhost"], selected_integration_id: "revoy-native", exit_code: 0,
      outcome: "awaiting_review", stdout_artifact: "run.stdout.log", stderr_artifact: "run.stderr.log",
      stdout_sha256: "b".repeat(64), stderr_sha256: "c".repeat(64),
      artifacts_preserved: true, verified_result: false, adoption_check: "pending" }],
    ...overrides,
  };
}

describe("revision-bound selfhost acceptance evidence", () => {
  it("accepts an observed native CLI capture as pending review, not as release proof", () => {
    expect(validateSelfhostAcceptanceArtifact(artifact(), { expectedCommit: commit })).toEqual({ valid: true, errors: [] });
  });

  it("requires an independently verified result and adoption check before a run says passed", () => {
    const value = artifact({ runs: [{ ...artifact().runs[0], outcome: "passed" }] });
    const result = validateSelfhostAcceptanceArtifact(value, { expectedCommit: commit });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("runs[0] passed outcome requires a verified result");
    expect(result.errors).toContain("runs[0] passed outcome requires an independent adoption check");
  });

  it("requires failed and interrupted captures to preserve their evidence", () => {
    const value = artifact({ runs: [{ ...artifact().runs[0], outcome: "interrupted", artifacts_preserved: false }] });
    expect(validateSelfhostAcceptanceArtifact(value, { expectedCommit: commit }).errors)
      .toContain("runs[0] failure/interruption must preserve its artifacts");
  });

  it("rejects evidence rebound to a different candidate commit", () => {
    expect(validateSelfhostAcceptanceArtifact(artifact(), { expectedCommit: "b".repeat(40) }).errors)
      .toContain("candidate_commit does not match the release candidate");
  });

  it("rejects host or target checkout identity that differs from the candidate", () => {
    const value = artifact({ execution: { host_commit: commit, target_commit: "b".repeat(40), install_exit_code: 0 } });
    expect(validateSelfhostAcceptanceArtifact(value, { expectedCommit: commit }).errors)
      .toContain("host and target checkouts must match the candidate and host dependency install must succeed");
  });
});
