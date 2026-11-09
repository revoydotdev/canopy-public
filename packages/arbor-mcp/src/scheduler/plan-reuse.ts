import type { ReusedPlan, VerifiedPlanTemplate } from "./contracts.js";

/** Small deterministic intent-template cache; deployments may hydrate it from the provenance-typed KB. */
export class PlanReuseCache {
  private readonly plans = new Map<string, VerifiedPlanTemplate>();
  store(value: VerifiedPlanTemplate): void { this.plans.set(value.template_id, Object.freeze({ ...value, plan: structuredClone(value.plan) })); }
  find(task: string): ReusedPlan | null {
    const intent = intentTemplate(task);
    const candidates = [...this.plans.values()].filter((plan) => plan.intent_category === intent.category);
    let best: { plan: VerifiedPlanTemplate; similarity: number } | null = null;
    for (const plan of candidates) {
      const similarity = jaccard(tokens(plan.task_template), tokens(intent.template));
      if (best === null || similarity > best.similarity) best = { plan, similarity };
    }
    if (best === null || best.similarity < 0.75) return null;
    return Object.freeze({ template_id: best.plan.template_id, plan: structuredClone(best.plan.plan), provenance: { tag: "claimed" as const, claimant: "scheduler-plan-reuse" } });
  }
}
export function intentTemplate(task: string): { category: string; template: string } {
  const normalized = task.toLowerCase().replace(/\b\d+(?:\.\d+)?\b/g, "{number}").replace(/\s+/g, " ").trim();
  const category = normalized.split(" ").slice(0, 2).join(" ") || "uncategorized";
  return { category, template: normalized };
}
function tokens(value: string): Set<string> { return new Set(value.toLowerCase().match(/[a-z{}]+/g) ?? []); }
function jaccard(left: Set<string>, right: Set<string>): number { const union = new Set([...left, ...right]); if (union.size === 0) return 1; let common = 0; for (const token of left) if (right.has(token)) common += 1; return common / union.size; }
