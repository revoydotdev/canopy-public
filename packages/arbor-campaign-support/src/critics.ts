/**
 * arbor-opencode/critics — the panel-of-critics (ROADMAP §3.4).
 *
 * Lenticel is the primary critic (Five-Point Mandate, approval-biased). Burl is
 * the reasoning/architecture critic. Optional specialist critics (security,
 * performance, design) review on their domain. A panel rejects more bad actions
 * than Lenticel alone because the specialists catch issues Lenticel's generic
 * mandate skips.
 *
 * Decision rule:
 *   - Lenticel ALWAYS gets a vote and its word is binding on the primary verdict.
 *   - Burl is mandatory for high-stakes nodes (architecture, security-sensitive,
 *     irreversible). A low/medium Burl concern is advisory; a high Burl concern
 *     blocks.
 *   - Specialist critics are advisory on their domain: their high-severity
 *     findings block unless the node is low-stakes and Lenticel overrides.
 *
 * The panel returns a reconciled verdict that feeds arbor_record_result.
 */

/** A critic that participates in the panel. */
export interface PanelCritic {
  name: string;
  model_hint?: string;
  /** The severity at which this critic's concern is binding on the verdict. */
  binding_severity: "high" | "medium" | "low" | "never";
  /** Weighs the node to decide whether this critic's vote matters. */
  mandate: (ctx: { action_category: string; high_stakes: boolean; description: string }) => boolean;
}

/** Which reviewers participate (subset of the panel). */
export interface PanelReviewers {
  lenticel: boolean;
  burl: boolean;
  security?: boolean;
  performance?: boolean;
  design?: boolean;
}

/** Per-reviewer cost observation, structurally identical to the loop's `ExecutorUsageCost`. */
export interface ReviewerUsageCost {
  provider: import("@arbor/audit").TelemetryProvider;
  model_family: import("@arbor/audit").TelemetryModelFamily;
  cost: import("@arbor/core").Cost;
}

/** The verdict-esque result each reviewer returns. */
export interface ReviewerVerdict {
  approved: boolean;
  rationale: string;
  root_cause?: string;
  severity?: "high" | "medium" | "low";
  /** Provider-observed usage for this reviewer's independent token epoch. */
  token_usage?: import("@arbor/core").TokenUsage;
  /**
   * Honest cost observation for this reviewer's call, when the transport has
   * one. Mirrors `ExecutorUsageCost`; absent when the reviewer reported none.
   */
  usage_cost?: ReviewerUsageCost;
  /** TEL-1: which model actually reviewed (e.g. "native/deepseek-v4-flash" vs "claude-code/sonnet"); absent when the transport did not report one. */
  model_identity?: string;
  /** Full mandate emitted by the reviewer. The panel preserves these votes
   * and the loop deterministically reconciles them into one panel verdict. */
  verdict?: import("@arbor/core").CriticVerdict;
  /**
   * Set when this reviewer never rendered a verdict at all — the transport
   * failed, or its response could not be parsed.
   *
   * This field exists because its absence was actively manufacturing
   * governance evidence. Without it a reviewer adapter had no way to say "the
   * review did not happen", so the production adapter caught its own transport
   * failures and returned `approved: false` with the error text as the
   * rationale. That is indistinguishable, downstream, from a critic that read
   * the work and rejected it — and it was durably persisted as exactly that.
   *
   * A verdict and an error are mutually exclusive claims. When `error` is set
   * `approved` carries no meaning and must not be counted as a vote.
   */
  error?: import("@arbor/core").NodeError;
}

/** Reconciled panel verdict — fits arbor_record_result's critic fields. */
export interface PanelDecision {
  approved: boolean;
  critic_agent: string;
  critic_rationale: string;
  critic_root_cause?: string;
  /** Per-reviewer breakdown for the audit trail. */
  votes: Record<string, ReviewerVerdict>;
  /**
   * Set when the panel could not render a decision because reviewers it
   * needed never ran. `approved` is then not a judgement about the work, and
   * the loop must contain this rather than score it — `runCampaign` routes a
   * decision carrying an error to `recordReviewFailure`, which parks the node
   * `awaiting_review` with its candidate intact.
   */
  error?: import("@arbor/core").NodeError;
}

export interface PanelContext {
  action_category: string;
  high_stakes: boolean;
  description: string;
  /** Bounded candidate summary captured before independent review. */
  specialist_output?: string;
  /** Harness-owned machine-verification observation, never model-authored authority. */
  verification_note?: string;
  /** Isolated checkout containing the candidate diff for read-only reviewer inspection. */
  worktree_path?: string;
}

// ============================================================
// PANEL CONFIGURATION
// ============================================================

/** The four reviewers. Each maps by name to a model hint + binding severity. */
export const PANEL_CRITICS: Record<PanelCritic["name"], PanelCritic> = {
  lenticel: {
    name: "lenticel",
    model_hint: "anthropic/claude-opus-4",
    binding_severity: "high", // Lenticel's word on approval is always binding
    mandate: () => true,
  },
  burl: {
    name: "burl",
    model_hint: "anthropic/claude-opus-4",
    binding_severity: "high",
    // Architectural review is mandatory for high-stakes work.
    mandate: (ctx) => ctx.high_stakes || ctx.action_category === "architecture",
  },
  security: {
    name: "security",
    model_hint: "anthropic/claude-opus-4",
    binding_severity: "high",
    mandate: (ctx) => /(auth|security|encrypt|secret|input|sql|inject|token|permission)/i.test(ctx.description) || ctx.action_category === "security",
  },
  performance: {
    name: "performance",
    model_hint: "anthropic/claude-sonnet-4",
    binding_severity: "medium",
    mandate: (ctx) => /(perf|benchmark|latency|scale|hot path|memory|query)/i.test(ctx.description) || ctx.action_category === "performance",
  },
  design: {
    name: "design",
    model_hint: "anthropic/claude-sonnet-4",
    binding_severity: "low",
    mandate: (ctx) => ctx.action_category === "leaf-visual" || /(ui|ux|layout|visual|frontend)/i.test(ctx.description),
  },
};

// ============================================================
// THE PANEL
// ============================================================

export interface PanelOfCriticsOptions {
  /** Which reviewers to run. Defaults to all. */
  reviewers?: PanelReviewers;
  /** Override a reviewer's binding severity (e.g. make Burl advisory). */
  severity_overrides?: Partial<Record<PanelCritic["name"], PanelCritic["binding_severity"]>>;
}

export type ReviewerRunner = (criticName: string, ctx: PanelContext) => Promise<ReviewerVerdict>;

/**
 * Runs the configured reviewers and reconciles their verdicts.
 * `runReviewer` is injected so tests can stub it and the live `/arbor` loop can
 * delegate each reviewer to the right subagent.
 */
export class PanelOfCritics {
  private options: PanelOfCriticsOptions;

  constructor(options: PanelOfCriticsOptions = {}) {
    this.options = options;
  }

  /** Resolve which reviewers participate in a panel run for a node. */
  activeReviewers(ctx: PanelContext): PanelCritic[] {
    const r: Partial<PanelReviewers> = this.options.reviewers ?? {};
    const names: PanelCritic["name"][] = [];
    if (r.lenticel !== false) names.push("lenticel");
    if (r.burl !== false && PANEL_CRITICS.burl.mandate(ctx)) names.push("burl");
    if (r.security !== false && PANEL_CRITICS.security.mandate(ctx)) names.push("security");
    if (r.performance !== false && PANEL_CRITICS.performance.mandate(ctx)) names.push("performance");
    if (r.design !== false && PANEL_CRITICS.design.mandate(ctx)) names.push("design");

    // Lenticel is mandatory — never run an empty panel.
    if (!names.includes("lenticel")) names.unshift("lenticel");
    return names.map((n) => PANEL_CRITICS[n]);
  }

  /**
   * Run the panel and reconcile into a decision.
   * Runs reviewers in parallel; Lenticel's approved flag is the primary gate.
   */
  async review(ctx: PanelContext, runReviewer: ReviewerRunner): Promise<PanelDecision> {
    const reviewers = this.activeReviewers(ctx);
    const votes: Record<string, ReviewerVerdict> = {};

    await Promise.all(
      reviewers.map(async (c) => {
        votes[c.name] = await runReviewer(c.name, ctx);
      }),
    );

    return reconcile(votes, ctx, this.options.severity_overrides ?? {});
  }
}

/**
 * Reconcile per-reviewer verdicts into a single PanelDecision.
 *
 * Lenticel decides (must approve). A reviewer's concern is binding if its
 * severity >= that reviewer's binding_severity. For high-stakes nodes, Lenticel
 * alone is not sufficient — Burl must not raise a binding concern.
 */
export function reconcile(
  votes: Record<string, ReviewerVerdict>,
  ctx: { high_stakes: boolean },
  severityOverrides: PanelOfCriticsOptions["severity_overrides"] = {},
): PanelDecision {
  const lenticel = votes.lenticel;
  if (!lenticel) {
    throw new Error("PanelOfCritics requires a lenticel verdict");
  }

  // A reviewer that never rendered a verdict is not a vote, in either
  // direction. Counting one as a rejection was recording a network failure as
  // a critic's judgement; counting one as an approval would be worse. So the
  // panel decides only on reviewers that actually ran, and reports an error
  // whenever a missing reviewer means the decision it would otherwise return
  // is not supportable.
  const unreached = Object.entries(votes).filter(([, vote]) => vote.error !== undefined);
  const unreachedNames = unreached.map(([name]) => name);
  const panelError = unreached[0]?.[1].error;

  // Lenticel is mandatory and its word is binding on the primary verdict.
  // Without it there is no panel decision to make at all.
  if (lenticel.error !== undefined) {
    return {
      approved: false,
      critic_agent: "panel",
      critic_rationale: `Panel could not review: ${unreachedNames.join(", ")} did not render a verdict`,
      votes,
      error: lenticel.error,
    };
  }

  let approved = lenticel.approved;
  const blockers: string[] = [];

  if (!lenticel.approved) {
    blockers.push(`lenticel: ${lenticel.root_cause ?? lenticel.rationale}`);
  }

  for (const [name, vote] of Object.entries(votes)) {
    if (name === "lenticel") continue;
    if (vote.error !== undefined) continue;
    const critic = PANEL_CRITICS[name];
    if (!critic) continue;
    const bindingSeverity = severityOverrides[name] ?? critic.binding_severity;
    const severity = vote.severity ?? "high";
    const isBinding =
      (bindingSeverity !== "never" && severityRank(severity) >= severityRank(bindingSeverity)) ||
      (ctx.high_stakes && severity === "high");

    // A binding rejection from a non-Lenticel reviewer.
    if (isBinding && !vote.approved) {
      approved = false;
      blockers.push(`${name}: ${vote.root_cause ?? vote.rationale}`);
    }
  }

  // High-stakes: Burl binding rejection blocks even if Lenticel approved.
  if (ctx.high_stakes && votes.burl && votes.burl.error === undefined && !votes.burl.approved) {
    approved = false;
    blockers.push(`burl(high-stakes): ${votes.burl.root_cause ?? votes.burl.rationale}`);
  }

  // An approval requires every mandated reviewer to have actually reviewed.
  // Approving while a reviewer was unreachable would claim its domain check
  // passed when it never ran — which is precisely the laundering this file's
  // decision rule exists to prevent. A *rejection*, by contrast, stands on
  // its own: it came from a reviewer that did render a verdict, and losing an
  // unrelated reviewer does not make that finding less true.
  if (approved && panelError !== undefined) {
    return {
      approved: false,
      critic_agent: "panel",
      critic_rationale: `Panel incomplete: ${unreachedNames.join(", ")} did not render a verdict`,
      votes,
      error: panelError,
    };
  }

  const rationale = blockers.length > 0 ? `Panel blocked: ${blockers.join("; ")}` : "Panel approved";
  return {
    approved,
    critic_agent: "panel",
    critic_rationale: rationale,
    critic_root_cause: approved ? undefined : blockers.join("; "),
    votes,
  };
}

function severityRank(s: ReviewerVerdict["severity"]): number {
  switch (s) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 3;
  }
}

/**
 * Fold the per-reviewer cost observations of one panel review into the single
 * critic-span cost the loop attributes. Only reviewers that reported token
 * usage contribute (they are the calls whose tokens the span carries). The
 * result is priced only when every contributor is priced under one configured
 * schedule; otherwise it is an honest `unpriced` with the reason. Returns
 * `undefined` when no reviewer reported token usage, so an absent review is
 * never given a cost.
 */
export function aggregatePanelUsageCost(votes: Record<string, ReviewerVerdict>): ReviewerUsageCost | undefined {
  const contributors = Object.values(votes).filter((vote) => vote.token_usage !== undefined);
  if (contributors.length === 0) return undefined;
  const observed = contributors.map((vote) => vote.usage_cost);
  const providers = new Set(observed.map((entry) => entry?.provider));
  const families = new Set(observed.map((entry) => entry?.model_family));
  const provider = providers.size === 1 && observed[0] !== undefined ? observed[0].provider : "other";
  const model_family = families.size === 1 && observed[0] !== undefined ? observed[0].model_family : "other";
  const first = observed[0]?.cost;
  if (observed.some((entry) => entry === undefined)) {
    return { provider, model_family, cost: { kind: "unpriced", reason: "a panel reviewer reported token usage without an attributable cost" } };
  }
  if (first === undefined || first.kind !== "priced" || !observed.every((entry) => {
    const cost = entry!.cost;
    return cost.kind === "priced" && cost.currency === first.currency && cost.minor_unit_exponent === first.minor_unit_exponent && cost.price_source_id === first.price_source_id;
  })) {
    return { provider, model_family, cost: { kind: "unpriced", reason: "panel reviewer costs are unpriced or do not share one configured price schedule" } };
  }
  const total = observed.reduce((sum, entry) => sum + (entry!.cost.kind === "priced" ? entry!.cost.minor_units : 0), 0);
  return Number.isSafeInteger(total)
    ? { provider, model_family, cost: { ...first, minor_units: total } }
    : { provider, model_family, cost: { kind: "unpriced", reason: "panel cost exceeds safe integer range" } };
}
