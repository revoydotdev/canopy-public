import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkCohortToolchains, validateExternalCohortSpec } from "../release-acceptance.mjs";

const root = resolve(import.meta.dirname, "../..");
const checker = join(root, "scripts/release-acceptance.mjs");
const pinnedCohortSpec = join(root, "docs/release-acceptance-1.0.0/external-cohort.json");
const tempDirs = [];
const domains = ["native_campaign", "mcp", "cli", "webui", "tui", "recovery", "adoption", "evidence", "selfhost", "external_cohort"];
const reviewerKeys = generateKeyPairSync("ed25519");

function selfhostArtifact(commit, kind = "fixture", outcome = "awaiting_review") {
  const stdout = Buffer.from("fixture selfhost stdout\n");
  const stderr = Buffer.from("fixture selfhost stderr\n");
  return {
    schema: "revoy2.selfhost.acceptance.v1", kind, producer: "scripts/run-selfhost-acceptance.mjs", candidate_commit: commit,
    cohort: { name: "native-selfhost-release-candidate", integrations: ["revoy-native"], tasks: ["governed-backlog-selection"] },
    cohort_id: "native-fixture", started_at: "2026-09-22T12:00:00.000Z", finished_at: "2026-09-22T12:01:00.000Z",
    execution: { host_checkout: "host", host_commit: commit, target_checkout: "target", target_commit: commit, install_exit_code: 0 },
    runs: [{ candidate_commit: commit, campaign_id: "selfhost-native-fixture", argv: ["selfhost", "--target", "fixture", "--run-id", "native-fixture"], cli_argv: ["bun", "packages/arbor-mcp/bin/arbor-mcp.mjs", "selfhost"], exit_code: 0,
      outcome, selected_integration_id: "revoy-native", stdout_artifact: "selfhost.stdout.log",
      stdout_sha256: createHash("sha256").update(stdout).digest("hex"), stderr_artifact: "selfhost.stderr.log",
      stderr_sha256: createHash("sha256").update(stderr).digest("hex"),
      artifacts_preserved: true, verified_result: outcome === "passed", adoption_check: outcome === "passed" ? "passed" : "pending" }],
  };
}

function reviewedSelfhostArtifact(directory, commit) {
  const stdout = Buffer.from("selfhost RAN campaign selfhost-native-fixture\n  selected integration: revoy-native\n  verified: 1   claimed: 0   failed: 0\n");
  const stderr = Buffer.from("");
  const adoptionOutput = Buffer.from("Applied verified result for campaign selfhost-native-fixture.\n");
  const postOutput = Buffer.from("build and acceptance checks passed\n");
  writeFileSync(join(directory, "selfhost.stdout.log"), stdout);
  writeFileSync(join(directory, "selfhost.stderr.log"), stderr);
  writeFileSync(join(directory, "adoption.stdout.log"), adoptionOutput);
  writeFileSync(join(directory, "post-adoption.stdout.log"), postOutput);
  const artifact = selfhostArtifact(commit, "observed", "passed");
  const run = artifact.runs[0];
  run.stdout_sha256 = createHash("sha256").update(stdout).digest("hex");
  run.stderr_sha256 = createHash("sha256").update(stderr).digest("hex");
  const review = {
    schema: "revoy2.selfhost.independent-review.v1", decision: "accept", candidate_commit: commit,
    cohort_id: artifact.cohort_id, run_index: 0, reviewer_id: "independent-reviewer",
    selected_integration_id: "revoy-native", run_evidence: { stdout_sha256: run.stdout_sha256, stderr_sha256: run.stderr_sha256 },
    adoption: {
      campaign_id: run.campaign_id,
      apply_argv: ["bun", "packages/arbor-mcp/bin/arbor-mcp.mjs", "adopt", "--campaign", run.campaign_id, "--apply"],
      apply_exit_code: 0, apply_stdout_artifact: "adoption.stdout.log",
      apply_stdout_sha256: createHash("sha256").update(adoptionOutput).digest("hex"),
      post_adoption_checks: [{ argv: ["bun", "run", "build"], exit_code: 0, stdout_artifact: "post-adoption.stdout.log", stdout_sha256: createHash("sha256").update(postOutput).digest("hex") }],
    },
  };
  const reviewBytes = Buffer.from(JSON.stringify(review));
  const signatureBytes = Buffer.from(`${sign(null, reviewBytes, reviewerKeys.privateKey).toString("base64")}\n`);
  writeFileSync(join(directory, "review-attestation.json"), reviewBytes);
  writeFileSync(join(directory, "review-attestation.sig"), signatureBytes);
  run.review_attestation = {
    artifact: "review-attestation.json", sha256: createHash("sha256").update(reviewBytes).digest("hex"),
    signature_artifact: "review-attestation.sig", signature_sha256: createHash("sha256").update(signatureBytes).digest("hex"),
  };
  return artifact;
}

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "revoy-release-acceptance-"));
  tempDirs.push(directory);
  return directory;
}

function head() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function writeManifest(directory, mutate = (manifest) => manifest) {
  const commit = head();
  writeFileSync(join(directory, "reviewer-public.pem"), reviewerKeys.publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(join(directory, "selfhost.stdout.log"), "fixture selfhost stdout\n");
  writeFileSync(join(directory, "selfhost.stderr.log"), "fixture selfhost stderr\n");
  for (const domain of domains) writeFileSync(join(directory, `${domain}.json`), JSON.stringify(domain === "selfhost" ? selfhostArtifact(commit) : { domain, fixture: true }));
  const cohortSpecBytes = readFileSync(pinnedCohortSpec);
  writeFileSync(join(directory, "external-cohort.json"), cohortSpecBytes);
  const cohortSpec = JSON.parse(cohortSpecBytes.toString("utf8"));
  const manifest = {
    schema_version: 1,
    release: "1.0.0",
    candidate_commit: commit,
    domains: Object.fromEntries(domains.map((domain) => {
      const artifact = `${domain}.json`;
      const bytes = readFileSync(join(directory, artifact));
      return [domain, {
        status: "passed",
        kind: "fixture",
        commit,
        producer: "release acceptance test fixture",
        scope: `fixture exercise for ${domain}`,
        observed_at: "2026-09-22T12:00:00.000Z",
        artifact,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(domain === "tui" ? { coverage: [{ path: "git.workspace", status: "passed" }] } : {}),
        ...(domain === "external_cohort" ? { cohort: {
          name: cohortSpec.cohort, integrations: ["revoy-native"], tasks: cohortSpec.members.map((member) => member.id),
          spec: "external-cohort.json", spec_sha256: createHash("sha256").update(cohortSpecBytes).digest("hex"),
        } } : {}),
      }];
    })),
  };
  const file = join(directory, "manifest.json");
  writeFileSync(file, JSON.stringify(mutate(manifest), null, 2));
  return { file, manifest };
}

function run(manifest, ...args) {
  return spawnSync("bun", [checker, "--manifest", manifest, "--reviewer-key", join(dirname(manifest), "reviewer-public.pem"), "--json", ...args], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("release acceptance CLI", () => {
  it("validates complete fixtures only in explicit structural mode, without asserting release readiness", () => {
    const directory = tempDir();
    const { file } = writeManifest(directory);
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.release_ready).toBe(false);
    expect(report.fixture_domains).toEqual(domains);

    const defaultMode = run(file, "--candidate", "HEAD");
    expect(defaultMode.status).toBe(1);
    expect(JSON.parse(defaultMode.stdout).error).toContain("fixture evidence cannot establish release acceptance");
  });

  it("rejects a manifest bound to an old commit", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory);
    const previous = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: root, encoding: "utf8" }).stdout.trim();
    manifest.candidate_commit = previous;
    writeFileSync(file, JSON.stringify(manifest));
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("stale manifest");
  });

  it("rejects an absent required domain record", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory, (value) => {
      delete value.domains.external_cohort;
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("required domain records are absent: external_cohort");
  });

  it("reports explicit unavailable evidence as valid but incomplete", () => {
    const directory = tempDir();
    const { file } = writeManifest(directory, (manifest) => {
      manifest.domains.external_cohort = { status: "unavailable", reason: "No external cohort run has been captured." };
      return manifest;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.release_ready).toBe(false);
    expect(report.unavailable).toEqual([{ domain: "external_cohort", reason: "No external cohort run has been captured." }]);
  });

  it("rejects proof whose artifact hash is stale", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory, (value) => {
      value.domains.cli.sha256 = "0".repeat(64);
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("artifact SHA-256 does not match");
  });

  it("rejects an artifact symlink that escapes the manifest directory", () => {
    const directory = tempDir();
    const outside = tempDir();
    const { file, manifest } = writeManifest(directory);
    const outsideFile = join(outside, "outside.json");
    writeFileSync(outsideFile, JSON.stringify({ domain: "cli" }));
    unlinkSync(join(directory, "cli.json"));
    symlinkSync(outsideFile, join(directory, "cli.json"));
    manifest.domains.cli.sha256 = createHash("sha256").update(readFileSync(outsideFile)).digest("hex");
    writeFileSync(file, JSON.stringify(manifest));
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("artifact symlink escapes");
  });

  it("marks all hash-bound observed records release ready in the checker", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory);
    for (const domain of domains) {
      const artifact = `${domain}.json`;
      const bytes = JSON.stringify(domain === "selfhost"
        ? reviewedSelfhostArtifact(directory, manifest.candidate_commit)
        : { domain, candidate_commit: manifest.candidate_commit, test_record: true });
      writeFileSync(join(directory, artifact), bytes);
      manifest.domains[domain].kind = "observed";
      manifest.domains[domain].sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    writeFileSync(file, JSON.stringify(manifest));
    const result = run(file, "--candidate", "HEAD");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.release_ready).toBe(true);
    expect(report.domains).toHaveLength(domains.length);
    expect(report.unavailable).toEqual([]);
    expect(report.fixture_domains).toEqual([]);
  });

  it("rejects tampered detached reviewer signatures for an otherwise passing selfhost capture", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory);
    const bytes = JSON.stringify(reviewedSelfhostArtifact(directory, manifest.candidate_commit));
    writeFileSync(join(directory, "selfhost.json"), bytes);
    manifest.domains.selfhost.kind = "observed";
    manifest.domains.selfhost.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(join(directory, "review-attestation.sig"), "dGFtcGVyZWQ=\n");
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("review signature SHA-256 does not match");
  });

  it("refuses a selfhost CLI completion as release proof until verified adoption is independently recorded", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory);
    const bytes = JSON.stringify(selfhostArtifact(manifest.candidate_commit, "observed", "awaiting_review"));
    writeFileSync(join(directory, "selfhost.json"), bytes);
    manifest.domains.selfhost.kind = "observed";
    manifest.domains.selfhost.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(file, JSON.stringify(manifest));
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("verified result and passed independent adoption check");
  });

  it("rejects a selfhost stdout artifact whose bound digest no longer matches", () => {
    const directory = tempDir();
    const { file } = writeManifest(directory);
    writeFileSync(join(directory, "selfhost.stdout.log"), "altered output\n");
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("stdout artifact SHA-256 does not match");
  });

  it("does not let TUI proof claim git.workspace without evidence", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory, (value) => {
      delete value.domains.tui.coverage;
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("coverage array including git.workspace");
  });

  it("requires explicit external cohort identity and task scope", () => {
    const directory = tempDir();
    const { file, manifest } = writeManifest(directory, (value) => {
      delete value.domains.external_cohort.cohort;
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("requires cohort name, named integrations, and named tasks");
  });
  it("requires an external cohort pass to bind the pinned cohort spec by digest", () => {
    const directory = tempDir();
    const { file } = writeManifest(directory, (value) => {
      value.domains.external_cohort.cohort.spec_sha256 = "0".repeat(64);
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("cohort spec SHA-256 does not match");

    const unbound = writeManifest(tempDir(), (value) => {
      delete value.domains.external_cohort.cohort.spec;
      return value;
    });
    const unboundResult = run(unbound.file, "--candidate", "HEAD", "--allow-fixtures");
    expect(unboundResult.status).toBe(1);
    expect(JSON.parse(unboundResult.stdout).error).toContain("requires cohort.spec and cohort.spec_sha256");
  });

  it("refuses an external cohort pass that does not cover every pinned member", () => {
    const directory = tempDir();
    const { file } = writeManifest(directory, (value) => {
      value.domains.external_cohort.cohort.tasks = ["yocto-queue"];
      return value;
    });
    const result = run(file, "--candidate", "HEAD", "--allow-fixtures");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("does not cover pinned cohort members: more-itertools, semver");
  });
});

describe("pinned external cohort spec", () => {
  const spec = () => JSON.parse(readFileSync(pinnedCohortSpec, "utf8"));

  it("accepts the committed 1.0.0 cohort: JavaScript, Python, and a compiled language at exact revisions", () => {
    const result = validateExternalCohortSpec(spec());
    expect(result).toEqual({ valid: true, errors: [] });
    expect(spec().members.map((member) => member.language).sort()).toEqual(["javascript", "python", "rust"]);
  });

  it("rejects floating revisions, missing language coverage, and tampered requirement files", () => {
    const value = spec();
    value.members[0].revision = "main";
    value.members[1].requirements[0].contents.push("    pass");
    value.members = value.members.filter((member) => member.language !== "rust").concat([{ ...value.members[0], id: "dup", language: "javascript" }]);
    const result = validateExternalCohortSpec(value);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "members[0].revision must be a full 40-character lowercase commit hash",
      "members[1].requirements[0].sha256 does not match its contents",
      "cohort must include a compiled-language member",
    ]));
  });

  it("requires each member to declare the tools its commands execute and keeps requirement paths inside the repository", () => {
    const value = spec();
    value.members[2].toolchain = [{ tool: "rustc" }];
    value.members[0].requirements[0].path = "../escape.js";
    const result = validateExternalCohortSpec(value);
    expect(result.errors).toEqual(expect.arrayContaining([
      "members[2].toolchain does not declare cargo, which its commands execute",
      "members[0].requirements[0].path must be a relative path inside the repository",
    ]));
  });

  it("reports missing toolchains as blockers instead of installing them", () => {
    const report = checkCohortToolchains(spec(), { resolveTool: (tool) => (tool === "cargo" ? null : `/usr/bin/${tool}`) });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["cargo"]);
    expect(report.tools.find((entry) => entry.tool === "node")).toEqual({ tool: "node", present: true, path: "/usr/bin/node" });
  });

  it("exposes cohort validation on the CLI without requiring a manifest", () => {
    const result = spawnSync("bun", [checker, "--cohort", pinnedCohortSpec, "--json"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.valid).toBe(true);
    expect(report.members.map((member) => member.id)).toEqual(["yocto-queue", "more-itertools", "semver"]);
    expect(report.toolchains).toBeNull();
  });
});
