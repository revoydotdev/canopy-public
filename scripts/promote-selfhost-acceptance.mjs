#!/usr/bin/env bun
/** Promote a pending capture only with a trusted, detached reviewer signature and bound adoption evidence. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { readBoundArtifact, verifyReviewAttestation } from "./selfhost-acceptance-review.mjs";
import { validateSelfhostAcceptanceArtifact } from "./selfhost-acceptance-contract.mjs";

function parse(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--artifact", "--review", "--signature", "--reviewer-key", "--output"].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = args[++i];
    if (!value) throw new Error(`${key} requires a path`);
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  for (const key of ["artifact", "review", "signature", "reviewer_key", "output"]) if (!result[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  return result;
}

function main() {
  const args = parse(process.argv.slice(2));
  const inputPath = resolve(args.artifact);
  const evidenceDir = dirname(inputPath);
  const artifact = JSON.parse(readFileSync(inputPath, "utf8"));
  const shape = validateSelfhostAcceptanceArtifact(artifact, { expectedCommit: artifact.candidate_commit });
  if (!shape.valid) throw new Error(`candidate capture is invalid: ${shape.errors.join("; ")}`);
  if (artifact.schema !== "revoy2.selfhost.acceptance.v1" || artifact.kind !== "observed" || artifact.runs?.length !== 1) throw new Error("promotion requires one observed pending selfhost run");
  const run = artifact.runs[0];
  if (run.outcome !== "awaiting_review" || run.exit_code !== 0 || run.selected_integration_id !== "revoy-native") throw new Error("only a successful revoy-native run can be promoted");
  const stdout = readBoundArtifact(evidenceDir, run.stdout_artifact, run.stdout_sha256, "selfhost stdout").bytes.toString("utf8");
  const verified = stdout.match(/^\s*verified:\s*(\d+)\b/m);
  if (!verified || Number(verified[1]) < 1) throw new Error("captured CLI output does not report at least one verified result");
  const reviewPath = realpathSync(resolve(args.review));
  const signaturePath = realpathSync(resolve(args.signature));
  for (const path of [reviewPath, signaturePath]) {
    const pathRel = relative(evidenceDir, path);
    if (pathRel.startsWith("..") || isAbsolute(pathRel)) throw new Error("review and signature files must be retained inside the cohort evidence directory");
  }
  const reviewBytes = readFileSync(reviewPath);
  const signatureBytes = readFileSync(signaturePath);
  const reviewRelative = relative(evidenceDir, reviewPath);
  const signatureRelative = relative(evidenceDir, signaturePath);
  const promoted = structuredClone(artifact);
  promoted.runs[0] = {
    ...run,
    outcome: "passed",
    verified_result: true,
    adoption_check: "passed",
    review_attestation: {
      artifact: reviewRelative,
      sha256: createHash("sha256").update(reviewBytes).digest("hex"),
      signature_artifact: signatureRelative,
      signature_sha256: createHash("sha256").update(signatureBytes).digest("hex"),
    },
  };
  verifyReviewAttestation({ artifact: promoted, runIndex: 0, evidenceDir, reviewerPublicKey: readFileSync(args.reviewer_key, "utf8") });
  const outputPath = resolve(args.output);
  if (dirname(outputPath) !== evidenceDir || existsSync(outputPath) || outputPath === inputPath) throw new Error("promotion output must be a new file beside the original cohort evidence");
  writeFileSync(outputPath, `${JSON.stringify(promoted, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Promoted reviewed cohort artifact: ${basename(outputPath)}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`selfhost acceptance promotion failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
