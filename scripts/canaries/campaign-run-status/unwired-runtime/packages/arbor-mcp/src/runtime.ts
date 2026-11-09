// Canary runtime. A plausible ArborRuntime that simply never grew the durable
// campaign-run attempt index — the exact shape ADR-093 Decision §5 calls
// "existing alongside the runtime rather than wired into it". Every wiring
// marker the gate looks for is genuinely absent; nothing here is hidden.
export class ArborRuntime {
  readonly startedAt: string;
  constructor(startedAt: string) {
    this.startedAt = startedAt;
  }
  async runCampaignJob(request: { campaign_id: string }) {
    return { campaign_id: request.campaign_id, state: "started" };
  }
  shutdown(): void {}
}
