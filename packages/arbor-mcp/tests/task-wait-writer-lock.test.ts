/**
 * WA-15 (audit/2026-08-23-50-defects.md; packet X-1 in
 * audit/2026-08-23-55-crosscuts.md): `task confirm --wait` and `task
 * follow-up` used to release the ADR-029 writer lock BEFORE
 * `awaitConfirmedCampaign`, while this same process kept writing the
 * ledger/snapshot for the campaign's whole run. A second `serve`/`webui`/
 * `task` invocation against the same persistence directory could acquire the
 * lock and race those still-in-flight writes.
 *
 * This drives real `main([...])` invocations against the same persistence
 * directory, exactly like `cli.test.ts`'s own webui writer-lock test, using
 * a `CampaignRunner` that never settles (the same "deferred" pattern
 * `campaign-run-wait.test.ts` uses) so the first invocation genuinely blocks
 * inside `awaitConfirmedCampaign`.
 *
 * `awaitConfirmedCampaign`'s FIRST await is `runtime.awaitCampaignRun(...)`
 * (see cli.ts): nothing before it awaits anything, and — in the buggy
 * version this proves against — the lock-release statement is the line
 * immediately preceding the call into `awaitConfirmedCampaign`. Hooking
 * `runtime.awaitCampaignRun` itself is therefore the precise, non-racy
 * synchronization point: by the time it fires, dispatch() has already
 * resolved and any pre-wait lock release has already happened, so the
 * second `main()` call below observes the TRUE state of the lock at that
 * instant rather than winning or losing an unrelated microtask race.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { ArborRuntime, type CampaignRunner, type CampaignRunOutcome, type CampaignRunSettlement } from "../src/runtime.js";
import { EXIT_CODES } from "../src/exit-codes.js";

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

function makeEnv(cwd: string, overrides: Partial<{ persistence_dir: string; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; runtime_factory: (cwd: string, persistenceDir?: string) => ArborRuntime }> = {}) {
  return {
    cwd,
    persistence_dir: overrides.persistence_dir,
    stdin: overrides.stdin ?? new PassThrough(),
    stdout: overrides.stdout ?? new PassThrough(),
    stderr: overrides.stderr ?? new PassThrough(),
    runtime_factory: overrides.runtime_factory,
  };
}

/** Never settles until the test resolves it — same shape as campaign-run-wait.test.ts's `deferredCampaignRunner`. */
function deferredCampaignRunner(): { runner: CampaignRunner; resolve: (outcome: CampaignRunOutcome) => void } {
  let resolveRun!: (outcome: CampaignRunOutcome) => void;
  return {
    resolve: (outcome) => resolveRun(outcome),
    runner: {
      run(): Promise<CampaignRunOutcome> {
        return new Promise<CampaignRunOutcome>((resolve) => { resolveRun = resolve; });
      },
    },
  };
}

/**
 * Builds an `ArborRuntime` with a deferred `CampaignRunner`, and returns a
 * promise that resolves exactly when `awaitConfirmedCampaign` makes its
 * first (and only pre-settlement) await call into `runtime.awaitCampaignRun`
 * — the precise "now genuinely waiting" instant, not an approximation of it.
 */
function runtimeWithWaitGate(cwd: string, persistenceDir: string | undefined): { runtime: ArborRuntime; waiting: Promise<void>; deferred: ReturnType<typeof deferredCampaignRunner> } {
  const deferred = deferredCampaignRunner();
  const runtime = new ArborRuntime({
    persistence_dir: resolvePersistenceDir(cwd, persistenceDir),
    workspace_root: cwd,
    campaign_runner: deferred.runner,
  });
  let resolveWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { resolveWaiting = resolve; });
  const original = runtime.awaitCampaignRun.bind(runtime);
  runtime.awaitCampaignRun = (campaignId: string): Promise<CampaignRunSettlement> => {
    resolveWaiting();
    return original(campaignId);
  };
  return { runtime, waiting, deferred };
}

async function waitUntilCampaignAwait(waiting: Promise<void>, command: Promise<number>, diagnostic: () => string): Promise<void> {
  await Promise.race([
    waiting,
    command.then((code) => { throw new Error(`task command exited with code ${code} before awaiting its campaign: ${diagnostic()}`); }),
  ]);
}

describe("WA-15: `task confirm --wait`/`task follow-up` hold the writer lock through the wait", () => {
  it("`task confirm --wait` holds the writer lock through the wait — a concurrent write is refused with CONFLICT while it is still awaiting the campaign", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-task-wait-lock-"));
    try {
      // 1) Create an unconfirmed, "proposed" draft. Plan-only, so this call
      // never reaches admission and can use the default runtime composition.
      const planOut = new PassThrough();
      const planned = collect(planOut);
      const planEnv = makeEnv(root, { stdout: planOut });
      const planCode = await main(["task", "inspect the widget and report findings", "--tier", "direct", "--plan", "--json"], planEnv);
      expect(planCode).toBe(EXIT_CODES.SUCCESS);
      const draft = JSON.parse(planned.text()).value.draft as { id: string; revision: number; status: string };
      expect(draft.status).toBe("proposed");

      // 2) Confirm it with --wait against a runtime whose campaign runner is
      // a deferred fake, so this invocation blocks inside
      // `awaitConfirmedCampaign` until the test releases it.
      const { runtime, waiting, deferred } = runtimeWithWaitGate(root, undefined);
      const confirmOut = new PassThrough();
      const confirmErr = new PassThrough();
      const confirmed = collect(confirmOut);
      const confirmFailure = collect(confirmErr);
      const confirmEnv = makeEnv(root, { stdout: confirmOut, stderr: confirmErr, runtime_factory: () => runtime });
      const firstDone = main(["task", "confirm", draft.id, String(draft.revision), "--wait", "--json"], confirmEnv);
      await waitUntilCampaignAwait(waiting, firstDone, () => `${confirmFailure.text()}${confirmed.text()}`);

      // 3) Second, independent `main()` invocation against the SAME
      // persistence directory, issued only once the first invocation has
      // genuinely reached `runtime.awaitCampaignRun` (see `runtimeWithWaitGate`).
      // Before the fix this succeeded (the confirm branch released the lock
      // right after dispatching confirm, before this exact point); after the
      // fix it must be refused immediately, at start.
      const secondOut = new PassThrough();
      const secondEnv = makeEnv(root, { stdout: secondOut });
      const secondCode = await main(["task", "a second, unrelated task"], secondEnv);
      expect(secondCode).toBe(EXIT_CODES.CONFLICT);

      // Let the first invocation's campaign settle and confirm it completes
      // cleanly — the lock's job is to block the SECOND writer, not to wedge
      // the first one forever.
      deferred.resolve({ halted: true, halt_reason: "manual", cancelled: false, awaiting_user_input: false });
      const firstCode = await firstDone;
      expect(firstCode).not.toBe(EXIT_CODES.CONFLICT);
      const firstResult = JSON.parse(confirmed.text());
      expect(firstResult.campaign_result).toBeDefined();
      expect(firstResult.campaign_result.campaign_id).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bare `task follow-up` holds the writer lock through the wait the same way", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-followup-wait-lock-"));
    try {
      // A parent campaign id is only used as free-text lineage on the
      // follow-up submission — it need not resolve to a real campaign for
      // this test, which only cares about lock timing around the wait.
      const { runtime, waiting, deferred } = runtimeWithWaitGate(root, undefined);
      const followOut = new PassThrough();
      const followErr = new PassThrough();
      const followed = collect(followOut);
      const followFailure = collect(followErr);
      const followEnv = makeEnv(root, { stdout: followOut, stderr: followErr, runtime_factory: () => runtime });
      const firstDone = main(["task", "follow-up", "parent-campaign-1", "inspect one more thing and report findings", "--tier", "direct", "--json"], followEnv);
      await waitUntilCampaignAwait(waiting, firstDone, () => `${followFailure.text()}${followed.text()}`);

      const secondOut = new PassThrough();
      const secondEnv = makeEnv(root, { stdout: secondOut });
      const secondCode = await main(["task", "a second, unrelated task"], secondEnv);
      expect(secondCode).toBe(EXIT_CODES.CONFLICT);

      deferred.resolve({ halted: true, halt_reason: "manual", cancelled: false, awaiting_user_input: false });
      const firstCode = await firstDone;
      expect(firstCode).not.toBe(EXIT_CODES.CONFLICT);
      const firstResult = JSON.parse(followed.text());
      expect(firstResult.campaign_result).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
