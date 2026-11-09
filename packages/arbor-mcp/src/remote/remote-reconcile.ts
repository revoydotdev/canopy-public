import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { Provenance } from "@arbor/core";
import { capturedMetaPath, capturedPatchPath, type CapturedResult } from "../result-adoption.js";

export interface RemoteResultClaim { campaign_id: string; node_id: string; operation_id: string; output: string; provenance: Provenance; confinement_grade?: "remote_attested" | "remote_unattested" }

/**
 * WA-14: a verifier's honest outcome. `provenance` is only ever set from an
 * ACTUALLY-EXECUTED acceptance command (`worktree-machine-verifier.ts`'s own
 * rule: `!verified` only from an observed zero exit) — never fabricated from
 * a weaker check such as patch applicability. `reason` is always populated so
 * a `null` outcome is never silently indistinguishable from "not implemented".
 */
export interface RemoteResultVerification { readonly provenance: Extract<Provenance, { tag: "verified" }> | null; readonly reason: string }
export interface LocalRemoteResultVerifier { verify(input: Omit<RemoteResultClaim, "provenance"> & { remote_claimant: string }): Promise<RemoteResultVerification> }

/**
 * Real local verifier for HTTP-submitted remote results (WA-14). Remote
 * grants (`remote-grant issue`) do not yet carry a declared acceptance
 * command for this verifier to re-run, so it cannot honestly claim
 * Provenance `"verified"` — that would misrepresent the evidence strength
 * (see the doc comment above). What it does for real: check that the
 * claimed patch actually applies to the local checkout with `git apply
 * --check` (side-effect free — it mutates nothing), so a garbled or
 * non-applying remote claim is flagged as such before an operator ever runs
 * `arbor adopt`, instead of being silently accepted as "unverified" for an
 * indistinguishable reason.
 */
export class LocalPatchApplicabilityVerifier implements LocalRemoteResultVerifier {
  constructor(private readonly repoRoot: string) {}
  async verify(input: { readonly output: string }): Promise<RemoteResultVerification> {
    const check = spawnSync("git", ["apply", "--check", "-"], { cwd: this.repoRoot, input: input.output, encoding: "utf8" });
    if (check.status !== 0) {
      const detail = (check.stderr || check.error?.message || "").trim().slice(0, 300);
      return { provenance: null, reason: `remote patch does not apply cleanly to the local checkout${detail ? `: ${detail}` : ""}` };
    }
    return { provenance: null, reason: "patch applies cleanly to the local checkout; this grant declares no local acceptance command to re-run, so evidence strength stays claimed rather than verified" };
  }
}

/** Crossing the boundary strips authority; only the injected local verifier can restore verified provenance. */
export class RemoteResultReconciler {
  constructor(
    private readonly verifier: LocalRemoteResultVerifier,
    private readonly options: { readonly persistence_dir?: string } = {},
  ) {}
  async reconcile(claim: RemoteResultClaim, remoteActor: string) {
    if (!claim.output.trim()) throw new Error("remote result output is required");
    const admitted = { ...claim, provenance: { tag: "claimed" as const, claimant: remoteActor }, confinement_grade: claim.confinement_grade === "remote_attested" ? "remote_attested" as const : "remote_unattested" as const };
    const verification = await this.verifier.verify({ campaign_id: claim.campaign_id, node_id: claim.node_id, operation_id: claim.operation_id, output: claim.output, confinement_grade: admitted.confinement_grade, remote_claimant: remoteActor });
    const reconciled = Object.freeze({
      ...admitted,
      provenance: verification.provenance ?? admitted.provenance,
      locally_verified: verification.provenance !== null,
      verification_reason: verification.reason,
    });
    // WA-14: previously the reconciled claim was only ever echoed back over
    // HTTP — nothing durable was written, so the result vanished the moment
    // the response was sent and the (single-use) grant token was consumed.
    // Persist it into the same flat-file adoption store `arbor adopt` /
    // `listCapturedResults` read (`result-adoption.ts`), using its exported
    // path helpers so a remote result becomes inspectable and adoptable
    // through the normal operator path.
    this.persist(reconciled);
    return reconciled;
  }

  private persist(record: { campaign_id: string; node_id: string; output: string; locally_verified: boolean }): void {
    const dir = this.options.persistence_dir;
    if (!dir || !isSafeId(record.campaign_id) || !isSafeId(record.node_id)) return;
    const captured: CapturedResult = {
      schema_version: 1,
      campaign_id: record.campaign_id,
      node_id: record.node_id,
      verified: record.locally_verified,
      // Remote submissions carry no evaluated score today; 0 is a real
      // captured value (untied to any node ranking), not a stand-in.
      score: 0,
      files: Object.freeze(filesFromPatch(record.output)),
      captured_at: new Date().toISOString(),
      patch_sha256: sha256(record.output),
    };
    const patchFile = capturedPatchPath(dir, record.campaign_id, record.node_id);
    const metaFile = capturedMetaPath(dir, record.campaign_id, record.node_id);
    mkdirSync(dirname(patchFile), { recursive: true });
    writeFileSync(patchFile, record.output, "utf8");
    writeFileSync(metaFile, `${JSON.stringify(captured, null, 2)}\n`, "utf8");
  }
}

function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function isSafeId(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== "." && value !== ".."; }
function filesFromPatch(patch: string): string[] {
  const files = new Set<string>();
  const pattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) files.add(match[2]!);
  return [...files];
}
