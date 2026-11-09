import type { Provenance } from "@arbor/core";

export type ScheduleTrigger =
  | Readonly<{ kind: "once"; at: string }>
  | Readonly<{ kind: "cron"; expression: string }>
  | Readonly<{ kind: "external"; key: string }>;
export type CatchUpPolicy = "fire_once" | "skip" | "backfill_all";
export type ScheduleState = "active" | "paused" | "human_required" | "completed";

export interface CampaignSchedule {
  readonly schema_version: 1;
  readonly schedule_id: string;
  readonly campaign_id: string;
  readonly task_template: string;
  readonly trigger: ScheduleTrigger;
  readonly catch_up: CatchUpPolicy;
  readonly state: ScheduleState;
  readonly version: number;
  readonly next_fire_at: string | null;
  readonly last_fire_at: string | null;
  readonly created_at: string;
  readonly human_reason: string | null;
  readonly max_backfill: number;
}

export interface ScheduledRunRecord {
  readonly run_id: string;
  readonly schedule_id: string;
  readonly schedule_version: number;
  readonly campaign_id: string;
  readonly due_at: string;
  readonly fired_at: string;
  readonly decision: "fired" | "skipped" | "human_required" | "completed" | "failed";
  readonly plan_source: "fresh" | "reused";
  readonly evidence_ref: string;
}

export interface VerifiedPlanTemplate {
  readonly template_id: string;
  readonly intent_category: string;
  readonly task_template: string;
  readonly plan: readonly Readonly<Record<string, unknown>>[];
  readonly provenance: Extract<Provenance, { tag: "verified" }>;
}

export interface ReusedPlan {
  readonly template_id: string;
  readonly plan: readonly Readonly<Record<string, unknown>>[];
  /** Reuse never inherits verified authority; this run must verify again. */
  readonly provenance: Extract<Provenance, { tag: "claimed" }>;
}

export interface ScheduledCampaignLauncher {
  launch(input: { readonly schedule: CampaignSchedule; readonly run: ScheduledRunRecord; readonly reused_plan: ReusedPlan | null }): Promise<{ readonly kind: "completed" | "failed" | "human_required"; readonly reason?: string }>;
}
