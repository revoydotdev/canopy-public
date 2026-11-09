import type { DecomposerPort } from "@arbor/core";
import type { LoopExecutor, ReviewerRunner } from "@arbor/opencode";
import type { ConnectorInspection } from "@arbor/harness";
import type { ArborRuntime } from "./runtime.js";
import type { RuntimePortAdapter } from "./tui-adapter.js";

export interface CampaignHarnessIntegrationInput {
  readonly runtime: ArborRuntime;
  readonly campaign_id: string;
  readonly adapter: RuntimePortAdapter;
  readonly cwd: string;
  readonly connector: ConnectorInspection;
}

/**
 * Host-owned executable binding for a capability-admitted harness connector.
 * Upstream SDKs and processes stay behind implementations of this port; the
 * campaign runner selects the port through @arbor/harness and remains the sole
 * campaign.run authority.
 */
export interface CampaignHarnessIntegration {
  createExecutor(input: CampaignHarnessIntegrationInput): LoopExecutor;
  createReviewer(input: CampaignHarnessIntegrationInput): ReviewerRunner;
  createDecomposer?(input: CampaignHarnessIntegrationInput): DecomposerPort;
}
