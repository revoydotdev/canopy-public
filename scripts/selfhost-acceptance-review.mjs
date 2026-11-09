import { createHash, verify } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const SELFHOST_REVIEW_SCHEMA = "revoy2.selfhost.independent-review.v1";

function reject(message) { throw new Error(message); }

export function readBoundArtifact(evidenceDir, artifact, sha256, label) {
  if (typeof artifact !== "string" || artifact.trim() === "" || isAbsolute(artifact)) reject(`${label} path must be relative`);
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) reject(`${label} requires a lowercase SHA-256 digest`);
  const root = realpathSync(evidenceDir);
  const absolute = resolve(root, artifact);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) reject(`${label} path escapes the evidence directory`);
  if (!existsSync(absolute)) reject(`${label} artifact is missing: ${artifact}`);
  const actual = realpathSync(absolute);
  const actualRel = relative(root, actual);
  if (actualRel.startsWith("..") || isAbsolute(actualRel)) reject(`${label} symlink escapes the evidence directory`);
  const bytes = readFileSync(actual);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) reject(`${label} SHA-256 does not match`);
  return { bytes, path: actual };
}

export function verifyReviewAttestation({ artifact, runIndex, evidenceDir, reviewerPublicKey }) {
  if (!artifact || !Array.isArray(artifact.runs) || !Number.isInteger(runIndex) || !artifact.runs[runIndex]) reject("review refers to an absent run");
  if (!reviewerPublicKey) reject("trusted reviewer public key is required for observed selfhost acceptance");
  const run = artifact.runs[runIndex];
  const binding = run.review_attestation;
  if (!binding || typeof binding !== "object") reject("review attestation binding is missing");
  const reviewBytes = readBoundArtifact(evidenceDir, binding.artifact, binding.sha256, "review attestation").bytes;
  const signatureBytes = readBoundArtifact(evidenceDir, binding.signature_artifact, binding.signature_sha256, "review signature").bytes;
  let review;
  try { review = JSON.parse(reviewBytes.toString("utf8")); }
  catch (error) { reject(`review attestation is invalid JSON: ${error.message}`); }
  const signature = Buffer.from(signatureBytes.toString("utf8").trim(), "base64");
  if (signature.length === 0 || !verify(null, reviewBytes, reviewerPublicKey, signature)) reject("review attestation signature is invalid for the trusted reviewer key");
  if (review.schema !== SELFHOST_REVIEW_SCHEMA || review.decision !== "accept") reject("signed review must use the acceptance schema and decision");
  if (review.candidate_commit !== artifact.candidate_commit || review.cohort_id !== artifact.cohort_id || review.run_index !== runIndex) reject("signed review is bound to a different candidate, cohort, or run");
  if (review.selected_integration_id !== "revoy-native" || run.selected_integration_id !== review.selected_integration_id) reject("signed review does not confirm the selected revoy-native integration");
  if (typeof review.reviewer_id !== "string" || review.reviewer_id.trim() === "" || review.reviewer_id === artifact.producer) reject("reviewer identity must be present and independent of the run producer");
  if (review.run_evidence?.stdout_sha256 !== run.stdout_sha256 || review.run_evidence?.stderr_sha256 !== run.stderr_sha256) reject("signed review does not bind the captured stdout and stderr");
  if (run.exit_code !== 0) reject("reviewed native campaign did not exit successfully");
  const stdout = readBoundArtifact(evidenceDir, run.stdout_artifact, run.stdout_sha256, "selfhost stdout").bytes.toString("utf8");
  readBoundArtifact(evidenceDir, run.stderr_artifact, run.stderr_sha256, "selfhost stderr");
  const verifiedCount = stdout.match(/^\s*verified:\s*(\d+)\b/m);
  if (!/^\s*selected integration: revoy-native\s*$/m.test(stdout) || !verifiedCount || Number(verifiedCount[1]) < 1) reject("captured CLI output does not prove native selection and at least one verified result");
  const campaignId = `selfhost-${artifact.cohort_id}`;
  if (!stdout.includes(`selfhost RAN campaign ${campaignId}\n`)) reject("captured CLI output does not identify the reviewed campaign id");
  const adoption = review.adoption;
  if (!adoption || adoption.campaign_id !== campaignId || adoption.apply_exit_code !== 0 || !Array.isArray(adoption.apply_argv)) reject("signed review lacks successful adoption evidence for this campaign");
  if (!adoption.apply_argv.includes("adopt") || !adoption.apply_argv.includes("--apply") || !adoption.apply_argv.includes("--campaign") || !adoption.apply_argv.includes(campaignId)) reject("adoption evidence must record arbor adopt --campaign <campaign> --apply");
  readBoundArtifact(evidenceDir, adoption.apply_stdout_artifact, adoption.apply_stdout_sha256, "adoption output");
  if (!Array.isArray(adoption.post_adoption_checks) || adoption.post_adoption_checks.length === 0) reject("at least one independent post-adoption check is required");
  for (const [index, check] of adoption.post_adoption_checks.entries()) {
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.exit_code !== 0) reject(`post-adoption check ${index} must record a successful command`);
    readBoundArtifact(evidenceDir, check.stdout_artifact, check.stdout_sha256, `post-adoption check ${index} output`);
  }
  return review;
}
