#!/usr/bin/env bun
/** Execute a revision-pinned self-host run through the shipped `arbor selfhost` CLI. */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SELFHOST_ACCEPTANCE_SCHEMA, SELFHOST_COHORT } from "./selfhost-acceptance-contract.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

function options(args) {
  const parsed = { candidate: "HEAD", output: undefined, maxIterations: "20", maxSeconds: "1800" };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--candidate", "--output", "--max-iterations", "--max-seconds"].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = args[++i];
    if (!value) throw new Error(`${key} requires a value`);
    parsed[key === "--candidate" ? "candidate" : key === "--output" ? "output" : key === "--max-iterations" ? "maxIterations" : "maxSeconds"] = value;
  }
  if (!/^\d+$/.test(parsed.maxIterations) || Number(parsed.maxIterations) < 1) throw new Error("--max-iterations must be a positive integer");
  if (!/^\d+$/.test(parsed.maxSeconds) || Number(parsed.maxSeconds) < 1) throw new Error("--max-seconds must be a positive integer");
  return parsed;
}

function execute(argv, cwd, stdoutPath, stderrPath, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const stdout = createWriteStream(stdoutPath, { flags: "wx" });
    const stderr = createWriteStream(stderrPath, { flags: "wx" });
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    let interrupted = false;
    const forward = (signal) => { interrupted = true; child.kill(signal); };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", (error) => {
      stdout.end();
      stderr.end();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      await Promise.all([new Promise((done) => stdout.end(done)), new Promise((done) => stderr.end(done))]);
      resolveRun({ code: code ?? 128, signal, interrupted });
    });
  });
}

async function main() {
  const parsed = options(process.argv.slice(2));
  const source = process.cwd();
  const candidate = git(source, ["rev-parse", `${parsed.candidate}^{commit}`]);
  const output = resolve(source, parsed.output ?? `.arbor/selfhost-acceptance-${candidate.slice(0, 12)}-${Date.now().toString(36)}`);
  if (existsSync(output)) throw new Error(`output already exists; preserving prior cohort evidence at ${output}`);
  mkdirSync(output, { recursive: true });
  const host = join(output, "host-checkout");
  const target = join(output, "candidate-target");
  for (const path of [host, target]) {
    const clone = spawnSync("git", ["clone", "--no-hardlinks", "--no-checkout", source, path], { encoding: "utf8" });
    if (clone.status !== 0) throw new Error(`cannot create isolated checkout ${path}: ${(clone.stderr || "").trim()}`);
    git(path, ["checkout", "--detach", candidate]);
  }

  const installPath = join(output, "host-install.stdout.log");
  const installErr = join(output, "host-install.stderr.log");
  const install = await execute(["bun", "install", "--frozen-lockfile"], host, installPath, installErr);
  if (install.code !== 0) throw new Error(`candidate host dependency install failed (${install.code}); logs retained at ${output}`);

  const startedAt = new Date().toISOString();
  const cohortId = `native-${candidate.slice(0, 12)}-${Date.now().toString(36)}`;
  const argv = ["selfhost", "--target", target, "--from-backlog", "--keep-worktree", "--run-id", cohortId, "--max-iterations", parsed.maxIterations, "--max-seconds", parsed.maxSeconds];
  const stdoutArtifact = "selfhost.stdout.log";
  const stderrArtifact = "selfhost.stderr.log";
  const actualCliArgv = ["bun", "packages/arbor-mcp/bin/arbor-mcp.mjs", ...argv];
  const run = await execute(actualCliArgv, host,
    join(output, stdoutArtifact), join(output, stderrArtifact), { ...process.env, ARBOR_HARNESS_INTEGRATION: "native" });
  const stdoutText = readFileSync(join(output, stdoutArtifact), "utf8");
  const stdoutSha256 = createHash("sha256").update(readFileSync(join(output, stdoutArtifact))).digest("hex");
  const stderrSha256 = createHash("sha256").update(readFileSync(join(output, stderrArtifact))).digest("hex");
  const selectedIntegrationId = stdoutText.match(/^  selected integration: ([^\r\n]+)$/m)?.[1] ?? "unresolved";
  const acceptedNativeSelection = selectedIntegrationId === "revoy-native";
  const record = {
    schema: SELFHOST_ACCEPTANCE_SCHEMA,
    kind: "observed",
    producer: "scripts/run-selfhost-acceptance.mjs",
    candidate_commit: candidate,
    cohort: SELFHOST_COHORT,
    cohort_id: cohortId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runs: [{ candidate_commit: candidate, campaign_id: `selfhost-${cohortId}`, argv, cli_argv: actualCliArgv, selected_integration_id: selectedIntegrationId, exit_code: run.code,
      outcome: run.interrupted ? "interrupted" : run.code === 0 && acceptedNativeSelection ? "awaiting_review" : "failed",
      stdout_artifact: stdoutArtifact, stdout_sha256: stdoutSha256,
      stderr_artifact: stderrArtifact, stderr_sha256: stderrSha256,
      artifacts_preserved: true, verified_result: false, adoption_check: "pending" }],
    execution: { host_checkout: "host-checkout", host_commit: git(host, ["rev-parse", "HEAD"]), target_checkout: "candidate-target", target_commit: git(target, ["rev-parse", "HEAD"]), install_exit_code: install.code },
    review_state: "pending-independent-result-and-adoption-review",
  };
  writeFileSync(join(output, "selfhost-acceptance.json"), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`Self-host CLI completed with exit ${run.code} and selected ${selectedIntegrationId}; evidence and checkouts retained under ${output}. Independent result and adoption review remain pending.\n`);
  if (run.code !== 0) process.exitCode = run.code;
  else if (!acceptedNativeSelection) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`selfhost acceptance runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
