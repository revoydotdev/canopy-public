import type { Cost } from "@arbor/core";
import type { EvidenceLedger, TelemetryPhase, UsageCostObservation } from "@arbor/audit";
import { spawn } from "node:child_process";

export interface CostHudProjection {
  readonly campaign_id: string;
  readonly estimated_cost: Cost;
  readonly estimate_label: "list-rate estimate" | "unpriced";
  readonly context: { readonly used_tokens: number; readonly total_tokens: number; readonly percent: number } | null;
  readonly phase: TelemetryPhase | null;
  readonly assistant_messages_observed: number;
  readonly source_record_ids: readonly string[];
}

/** Pure ledger projection: every render re-reads authority and holds no running total. */
export function projectCostHud(ledger: EvidenceLedger, campaignId: string, contextCapacity: number | null): CostHudProjection {
  const integrity = ledger.verifyIntegrity();
  if (!integrity.valid) throw new Error(`cannot render cost HUD from an invalid ledger: ${integrity.error}`);
  const records = ledger.getTelemetryObservations(campaignId, 10_000);
  const usage = records.filter((record) => record.observation.type === "usage_cost");
  const priced = usage.map((record) => record.observation)
    .filter((observation): observation is UsageCostObservation => observation.type === "usage_cost")
    .map((observation) => observation.cost).filter((cost): cost is Extract<Cost, { kind: "priced" }> => cost.kind === "priced");
  const estimatedCost = addCosts(priced);
  const latestUsage = usage.at(-1)?.observation;
  const used = latestUsage?.type === "usage_cost" ? latestUsage.input_tokens + latestUsage.output_tokens + latestUsage.cache_read_tokens + latestUsage.cache_write_tokens : null;
  const context = used !== null && contextCapacity !== null && Number.isSafeInteger(contextCapacity) && contextCapacity > 0
    ? Object.freeze({ used_tokens: used, total_tokens: contextCapacity, percent: Math.min(100, used / contextCapacity * 100) }) : null;
  const latest = records.at(-1)?.observation;
  return Object.freeze({ campaign_id: campaignId, estimated_cost: estimatedCost,
    estimate_label: estimatedCost.kind === "priced" ? "list-rate estimate" : "unpriced", context,
    phase: latest?.phase ?? null, assistant_messages_observed: usage.length,
    source_record_ids: Object.freeze(records.map((record) => record.id)) });
}

export interface StatusLineRenderer { render(state: CostHudProjection): string | Promise<string> }

/** External statusLine-compatible renderer. No shell is involved; JSON is supplied only on stdin. */
export class ShellStatusLineRenderer implements StatusLineRenderer {
  constructor(private readonly command: string, private readonly args: readonly string[] = [], private readonly timeoutMs = 1_000) {
    if (!command.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("status line command and bounded timeout are required");
  }
  render(state: CostHudProjection): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 64 * 1024) stdout.push(chunk); else child.kill("SIGKILL"); });
      child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 8 * 1024) stderr.push(chunk); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error(`status line renderer failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8").trim()}`)); else resolve(Buffer.concat(stdout).toString("utf8").trimEnd()); });
      child.stdin.end(JSON.stringify(state));
    });
  }
}

/** Pluggable renderer seam; copied state confers no ledger or campaign authority. */
export async function renderCostStatusLine(projection: CostHudProjection, renderer: StatusLineRenderer): Promise<string> {
  return renderer.render(structuredClone(projection));
}

export function formatCostStatusLine(projection: CostHudProjection): string {
  const cost = projection.estimated_cost.kind === "priced"
    ? `${projection.estimated_cost.currency} ${(projection.estimated_cost.minor_units / 10 ** projection.estimated_cost.minor_unit_exponent).toFixed(projection.estimated_cost.minor_unit_exponent)} est.` : "cost unpriced";
  const context = projection.context === null ? "context —" : `context ${projection.context.used_tokens}/${projection.context.total_tokens} (${projection.context.percent.toFixed(1)}%)`;
  return `${cost} | ${context} | phase ${projection.phase ?? "—"}`;
}

function addCosts(costs: readonly Extract<Cost, { kind: "priced" }>[]): Cost {
  if (costs.length === 0) return { kind: "unpriced", reason: "no attributable configured list-rate observations" };
  const first = costs[0]!;
  if (!costs.every((cost) => cost.currency === first.currency && cost.minor_unit_exponent === first.minor_unit_exponent && cost.price_source_id === first.price_source_id)) return { kind: "unpriced", reason: "priced observations use different schedules or denominations" };
  const total = costs.reduce((sum, cost) => sum + cost.minor_units, 0);
  return Number.isSafeInteger(total) ? { ...first, minor_units: total } : { kind: "unpriced", reason: "projected cost exceeds safe integer range" };
}
