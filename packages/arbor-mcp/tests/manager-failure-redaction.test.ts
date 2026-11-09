/**
 * The manager's failure path is an independent redaction boundary: a
 * failure's free text may come from a connector that never ran the native
 * worker's redactor (a subprocess specialist, a critic dispatch error, a
 * verifier's diagnostic), and it is persisted as a ledger trace, a
 * failure_mode KB fact injected into later specialist prompts, and a node
 * error on the campaign snapshot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, CapabilityContext, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager, sanitizeMemoryEntryText } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
const workAction: Action = { description: "call the provider", estimated_gain: 50, estimated_cost: 10, category: "integration", delegate_to: "seed" };
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };
const specialistCap: CapabilityContext = { tier: "specialist" };
const isolated = { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true };

const SECRETS = Object.freeze({
  root_cause: "sk-proj-PLANTEDrootcause0123456789ab",
  output: "ghp_PLANTEDoutput0123456789abcdefghijkl",
  node_error: "AKIAPLANTEDNODEERR01",
  diagnostic: "xoxb-1234567890-PLANTED-diagnostic",
  review: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.PLANTEDreviewsig0123456789",
  run: "sk-ant-api03-PLANTEDrun0123456789abcdef",
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function allText(dir: string): string {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allText(path) : readFileSync(path, "utf8");
  }).join("\n");
}

describe("CampaignManager failure-path credential redaction", () => {
  it("redacts the trace packet, failure_mode KB fact, node error and the next specialist's KB injection", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-manager-failure-redaction-"));
    dirs.push(dir);
    const mgr = new CampaignManager({ persistence_dir: dir });
    mgr.startCampaign("redact-camp", "plan.md", rootAction);
    const [childId] = mgr.branch("redact-camp", "root", [workAction]);
    mgr.expandNode("redact-camp", childId!, isolated);
    mgr.recordResult("redact-camp", childId!, {
      specialist_output: `provider said: quota exceeded for ${SECRETS.output}`,
      specialist_agent: "seed",
      provenance: claimedProv,
      critic_agent: "lenticel",
      critic_approved: false,
      critic_rationale: `rejected because key ${SECRETS.root_cause} leaked`,
      critic_root_cause: `internal_error: quota exceeded for key ${SECRETS.root_cause}`,
      verification_failure: { code: "command_failed", exit: 1, diagnostic: `stderr: ${SECRETS.diagnostic}` },
      node_error: { kind: "internal_error", recoverable: false, provenance: claimedProv, message: `model port failed: id ${SECRETS.node_error}` },
      score_ctx: ctx,
    });

    const [siblingId] = mgr.branch("redact-camp", "root", [workAction]);
    const injected = mgr.kbInject("Do the task.", "redact-camp", specialistCap, siblingId);
    // The failure really reached the KB injection, redacted.
    expect(injected).toContain("[REDACTED]");
    const snapshot = JSON.stringify(mgr.getCampaignSnapshot("redact-camp"));
    expect(snapshot).toContain("[REDACTED]");
    const durable = allText(dir);
    expect(durable).toContain("[REDACTED]");
    for (const secret of [SECRETS.root_cause, SECRETS.output, SECRETS.node_error, SECRETS.diagnostic]) {
      expect(injected).not.toContain(secret);
      expect(snapshot).not.toContain(secret);
      expect(durable).not.toContain(secret);
    }
  });

  it("redacts a critic dispatch failure's node error and a durable run diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-manager-failure-redaction-"));
    dirs.push(dir);
    const mgr = new CampaignManager({ persistence_dir: dir });
    mgr.startCampaign("review-camp", "plan.md", rootAction);
    const [childId] = mgr.branch("review-camp", "root", [workAction]);
    mgr.expandNode("review-camp", childId!, isolated);
    mgr.recordCandidate("review-camp", childId!, { specialist_output: "done", specialist_agent: "seed", provenance: claimedProv });
    mgr.recordReviewFailure("review-camp", childId!, { kind: "transport_error", recoverable: true, provenance: claimedProv, message: `HTTP 401 for ${SECRETS.review}` });
    mgr.recordCampaignRunDiagnostic("review-camp", { message: `run failed for key ${SECRETS.run}`, stack_head: `Error: run failed for key ${SECRETS.run}\n    at x (y.ts:1:1)` });

    const snapshot = JSON.stringify(mgr.getCampaignSnapshot("review-camp"));
    expect(snapshot).toContain("HTTP 401 for [REDACTED]");
    expect(mgr.getCampaignSnapshot("review-camp")!.nodes.find((node) => node.id === childId)).toMatchObject({ outcome: { kind: "error", error: { kind: "transport_error", message: "HTTP 401 for [REDACTED]" } } });
    expect(mgr.getCampaignRunDiagnostic("review-camp")).toMatchObject({ message: "run failed for key [REDACTED]", stack_head: expect.stringContaining("Error: run failed for key [REDACTED]") });
    const durable = allText(dir);
    for (const secret of [SECRETS.review, SECRETS.run]) { expect(durable).not.toContain(secret); expect(snapshot).not.toContain(secret); }
  });

  it("redacts a KB entry at injection time even if it was stored before redaction existed", () => {
    expect(sanitizeMemoryEntryText(`prior failure with ${SECRETS.root_cause}\nsecond line`)).toBe("prior failure with [REDACTED] second line");
  });
});
