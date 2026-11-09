/**
 * ADR-107 obligation O3: `arbor session start`'s first message must classify
 * its actions and call `admission.admit(...)` exactly as
 * `TaskComposer.confirm()` does — a session opened this way must be
 * indistinguishable, from the ledger's perspective, from a campaign
 * submitted through `arbor task`, and that admission must complete BEFORE
 * any live turn ever dispatches (ADR-107 decision 1: "not a parallel command
 * loop... every message after the first is steering, never a new
 * admission").
 *
 * This drives a real `main(["session", "start", ...])` invocation (the same
 * pattern `task-wait-writer-lock.test.ts` uses) against an `ArborRuntime`
 * whose `CampaignRunner` is a deferred fake that never settles — the same
 * "deferred" shape `campaign-run-wait.test.ts` and `task-wait-writer-lock.
 * test.ts` already use. Because the runner never runs a turn, a campaign/
 * node existing in the manager's own ledger snapshot by the time this
 * command's `--json` result prints is proof the admission gate ran to
 * completion strictly before any turn could possibly have dispatched — not
 * a timing coincidence.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { ArborRuntime, type CampaignRunner, type CampaignRunOutcome } from "../src/runtime.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

/** Never settles and records whether it was ever invoked — same "deferred" shape task-wait-writer-lock.test.ts uses. */
function deferredCampaignRunner(): { runner: CampaignRunner; invoked: () => boolean } {
  let invoked = false;
  return {
    invoked: () => invoked,
    runner: {
      run(): Promise<CampaignRunOutcome> {
        invoked = true;
        return new Promise<CampaignRunOutcome>(() => { /* never settles: no live turn ever dispatches */ });
      },
    },
  };
}

describe("ADR-107 O3: `arbor session start` admits before any live turn dispatches", () => {
  it("records the campaign and its root node in the ledger via the exact same admission gate `arbor task` uses, before any live session ever registers", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-session-start-admission-"));
    try {
      const deferred = deferredCampaignRunner();
      const runtime = new ArborRuntime({
        persistence_dir: resolvePersistenceDir(root, undefined),
        workspace_root: root,
        campaign_runner: deferred.runner,
      });
      const out = new PassThrough();
      const err = new PassThrough();
      const stdout = collect(out);
      const stderr = collect(err);
      const code = await main(
        ["session", "start", "inspect the widget and report findings", "--tier", "direct", "--json"],
        { cwd: root, stdin: new PassThrough(), stdout: out, stderr: err, runtime_factory: () => runtime, live_session_attach_timeout_ms: 300 },
      );

      // The deferred runner never resolves, so no turn ever ran — yet a job
      // was genuinely dispatched (this is a live campaign, not a plan-only
      // draft), and no live session ever registered within the bounded wait.
      expect(deferred.invoked()).toBe(true);
      const value = JSON.parse(stdout.text()) as { ok: boolean; value: { draft: { status: string; campaign_id: string; job_id: string } }; live_session_id: string | null };
      expect(value.ok).toBe(true);
      expect(value.value.draft.status).toBe("admitted");
      expect(value.value.draft.campaign_id).toBeTruthy();
      expect(value.live_session_id).toBeNull();
      expect(code).toBe(EXIT_CODES.PARTIAL); // admitted, but no live session appeared in time
      expect(stderr.text()).toBe("");

      // The ledger-authoritative check: the campaign and its root node exist
      // in the manager's own snapshot — exactly what `arbor task`'s bare
      // submit would leave behind, and exactly what O3 requires exist
      // BEFORE any live turn ever dispatches.
      const campaignId = value.value.draft.campaign_id;
      const snapshot = runtime.manager.getCampaignSnapshot(campaignId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.nodes.length).toBeGreaterThan(0);
      expect(snapshot!.nodes[0]!.state).not.toBe("verified"); // never ran — still exactly where admission left it
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a --tier value outside direct/reviewed/governed as a usage error, never as a silent task-text fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-session-start-usage-"));
    try {
      const out = new PassThrough();
      const err = new PassThrough();
      const code = await main(["session", "start", "do a thing", "--tier", "bogus", "--json"], { cwd: root, stdin: new PassThrough(), stdout: out, stderr: err });
      expect(code).toBe(EXIT_CODES.USAGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints usage and does nothing when no task text is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-session-start-empty-"));
    try {
      const out = new PassThrough();
      const err = new PassThrough();
      const code = await main(["session", "start", "--json"], { cwd: root, stdin: new PassThrough(), stdout: out, stderr: err });
      expect(code).toBe(EXIT_CODES.USAGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
