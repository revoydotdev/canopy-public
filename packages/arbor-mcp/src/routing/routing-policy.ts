import type { DifficultyTaskFeatures } from "./difficulty.js";
import { DifficultyCalibrator } from "./difficulty.js";

export type RoutingModelTier = "economical" | "balanced" | "capable";
export interface RoutingDecision { readonly difficulty: number; readonly expansion_depth: number; readonly model_tier: RoutingModelTier; readonly evidence_ref: string }
export interface ModelRoutingDescriptor { readonly tier: RoutingModelTier; readonly relative_quality: number; readonly relative_cost: number; readonly relative_latency: number }

export class DifficultyRoutingPolicy {
  constructor(private readonly calibrator: DifficultyCalibrator, private readonly maxDepth = 3, private readonly models: readonly ModelRoutingDescriptor[] = DEFAULT_MODELS) {}
  route(task: DifficultyTaskFeatures): RoutingDecision {
    const difficulty = this.calibrator.estimate(task);
    const expansion_depth = Math.max(1, Math.ceil(difficulty * this.maxDepth));
    const requiredQuality = Math.min(0.95, difficulty + 0.15);
    const viable = this.models.filter((model) => model.relative_quality >= requiredQuality);
    const candidates = viable.length > 0 ? viable : this.models;
    const selected = [...candidates].sort((left, right) => objective(left, difficulty) - objective(right, difficulty))[0] ?? DEFAULT_MODELS[1]!;
    return Object.freeze({ difficulty, expansion_depth, model_tier: selected.tier, evidence_ref: `difficulty:${difficulty.toFixed(4)}:depth:${expansion_depth}:tier:${selected.tier}` });
  }
  recordOutcome(input: { readonly category: string; readonly succeeded: boolean }): void { this.calibrator.record(input.category, input.succeeded); }
}
const DEFAULT_MODELS: readonly ModelRoutingDescriptor[] = Object.freeze([
  { tier: "economical", relative_quality: 0.35, relative_cost: 0.2, relative_latency: 0.2 },
  { tier: "balanced", relative_quality: 0.65, relative_cost: 0.5, relative_latency: 0.5 },
  { tier: "capable", relative_quality: 0.95, relative_cost: 1, relative_latency: 0.8 },
]);
function objective(model: ModelRoutingDescriptor, difficulty: number): number { return model.relative_cost * 0.55 + model.relative_latency * 0.15 + Math.max(0, difficulty - model.relative_quality) * 4; }
