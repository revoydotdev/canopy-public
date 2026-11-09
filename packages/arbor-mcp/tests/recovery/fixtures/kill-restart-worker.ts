#!/usr/bin/env bun
/**
 * ADR-101 O3 fixture — a real, standalone OS process that repeatedly saves a
 * campaign snapshot through @arbor/core's production `saveCampaign`, so the
 * parent test can SIGKILL it mid-flight and prove `loadCampaignResult`
 * recovers cleanly against a genuine process death rather than an in-process
 * replay. Not itself a test: it is driven by
 * `../persist-kill-restart.test.ts`.
 *
 * Modes:
 *   write <dir> <campaignId> <iterations>  — save an evolving campaign
 *     snapshot `iterations` times, printing `progress:<n>\n` after each
 *     durable write so the parent can observe genuine forward progress
 *     before it kills this process.
 *   read <dir> <campaignId>                — load the campaign snapshot and
 *     print `PersistenceLoadResult` as one line of JSON.
 */
import { createCampaign, saveCampaign, loadCampaignResult } from "@arbor/core";

const [mode, dir, campaignId, iterationsArg] = process.argv.slice(2);

const rootAction = {
  description: "ADR-101 kill-restart fixture root",
  estimated_gain: 1,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
} as const;

async function runWrite(): Promise<void> {
  if (!dir || !campaignId) {
    process.stderr.write("write mode requires <dir> <campaignId> [iterations]\n");
    process.exitCode = 1;
    return;
  }
  const iterations = Number.parseInt(iterationsArg ?? "500", 10);
  const campaign = createCampaign(campaignId, "plan.md", rootAction);
  for (let i = 1; i <= iterations; i += 1) {
    campaign.iterations_completed = i;
    campaign.best_score = i / iterations;
    saveCampaign(campaign, dir);
    process.stdout.write(`progress:${i}\n`);
    // Yield so a parent's SIGKILL has a real scheduling window between
    // durable writes. No artificial delay — the loop runs as fast as the
    // real fsync-then-rename write allows, which is exactly the timing a
    // genuine crash mid-campaign would race against.
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
}

function runRead(): void {
  if (!dir || !campaignId) {
    process.stderr.write("read mode requires <dir> <campaignId>\n");
    process.exitCode = 1;
    return;
  }
  const result = loadCampaignResult(campaignId, dir);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (mode === "write") {
  await runWrite();
} else if (mode === "read") {
  runRead();
} else {
  process.stderr.write(`unknown mode: ${JSON.stringify(mode)} (expected "write" or "read")\n`);
  process.exitCode = 1;
}
