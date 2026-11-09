/**
 * audit-templates.ts — revoy2's fan-out audit workflow templates.
 *
 * WHAT THIS IS. A fan-out template describes a 1×N audit campaign: one
 * orchestrator dispatching N sub-agents that each traverse the WHOLE repository
 * through a different analytical lens. These ship with revoy2 as executable
 * demonstrations of what the system can drive.
 *
 * WHY IT IS DATA AND NOT PROSE — the Q1 shape decision.
 *
 * The obvious move is to write each archetype as a SKILL.md and be done. That
 * fails this repository's own DRY discipline immediately: revoy2 needs these
 * templates in at least three places — the campaign dispatcher (which needs a
 * prompt string per specialist), Claude Code (which needs SKILL.md frontmatter
 * on disk), and the CLI/TUI (which needs to list and explain what is
 * available). Hand-maintaining three copies of the same archetype is exactly
 * the duplicated-knowledge defect this repository audits other code for, and
 * the copies would drift within a week.
 *
 * So the template is TYPED DATA and every surface is RENDERED from it:
 *
 *     AuditFanoutTemplate  (this file — the single source of truth)
 *          |
 *          +-- renderArchetypePrompt()  -> campaign dispatch (a specialist prompt)
 *          +-- renderArchetypeSkill()   -> .claude/skills/<id>/SKILL.md (generated)
 *          +-- renderTemplateOverview() -> `arbor-mcp audit show <id>`
 *
 * The generated SKILL.md files are checked in (Claude Code reads from disk and
 * cannot call a renderer), and a test regenerates them and fails on any diff.
 * That is the §23 generated-surface discipline: a generated artifact whose
 * regeneration is not diff-checked is just a copy that has not drifted yet.
 *
 * WHY THE LENSES ARE NOT "frontend / backend / tests / docs". Splitting an
 * audit team by directory creates gaps at precisely the boundaries where the
 * serious defects live — the seam between a route and its handler, between an
 * emitted event and its consumer, between an ADR and the code that claims to
 * implement it. Every archetype here traverses everything; they differ only in
 * what they consider proof. The four lenses are chosen so that they can
 * CORROBORATE OR FALSIFY each other rather than producing four similar
 * code-review notes: legitimacy, connectivity, durability, observable reality.
 */

// --------------------------------------------------------------- evidence

/**
 * How a claim was established. Ordered from strongest to weakest, then the
 * two negative outcomes.
 *
 * `CLAIMED_ONLY` and `UNVERIFIABLE` are deliberately distinct from
 * `CONTRADICTED`: "nobody checked" and "the check failed" are different facts,
 * and collapsing them is the fail-open shape revoy2's own audit rejects at
 * authority boundaries (see @arbor/governance's AuthorityVerdict, which keeps
 * `unknown` and `unverifiable` separate from `denied` for the same reason).
 */
export type EvidenceStatus =
  | "OBSERVED_DYNAMICALLY"
  | "OBSERVED_STATICALLY"
  | "CORROBORATED"
  | "INFERRED"
  | "CLAIMED_ONLY"
  | "CONTRADICTED"
  | "UNVERIFIABLE";

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = Object.freeze([
  "OBSERVED_DYNAMICALLY",
  "OBSERVED_STATICALLY",
  "CORROBORATED",
  "INFERRED",
  "CLAIMED_ONLY",
  "CONTRADICTED",
  "UNVERIFIABLE",
]);

/** S0 existential … S4 minor. */
export type FindingSeverity = "S0" | "S1" | "S2" | "S3" | "S4";

export const FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze(["S0", "S1", "S2", "S3", "S4"]);

/** The verdict a component receives in the joint synthesis. */
export type SynthesisClassification =
  | "VERIFIED_COMPLETE"
  | "VERIFIED_WITH_LIMITATIONS"
  | "PARTIALLY_IMPLEMENTED"
  | "PRESENT_BUT_UNWIRED"
  | "REACHABLE_BUT_NONFUNCTIONAL"
  | "FUNCTIONAL_BUT_UNGOVERNED"
  | "FUNCTIONAL_BUT_UNOBSERVABLE"
  | "UNSAFE_UNDER_FAILURE"
  | "DEAD_OR_OBSOLETE"
  | "UNVERIFIABLE";

export const SYNTHESIS_CLASSIFICATIONS: readonly SynthesisClassification[] = Object.freeze([
  "VERIFIED_COMPLETE",
  "VERIFIED_WITH_LIMITATIONS",
  "PARTIALLY_IMPLEMENTED",
  "PRESENT_BUT_UNWIRED",
  "REACHABLE_BUT_NONFUNCTIONAL",
  "FUNCTIONAL_BUT_UNGOVERNED",
  "FUNCTIONAL_BUT_UNOBSERVABLE",
  "UNSAFE_UNDER_FAILURE",
  "DEAD_OR_OBSOLETE",
  "UNVERIFIABLE",
]);

/**
 * How completely a deliverable was actually produced.
 *
 * WHY THIS EXISTS. Several archetype deliverables ask for whole-repository
 * registries — "Caller/callee registry", "Reachability classification for
 * every significant component", "Whole-repository component graph". Taken
 * literally against a repository of this size, one agent cannot both enumerate
 * everything AND meet the evidence standard above, which asks for claims that
 * were observed rather than inferred. Before this vocabulary existed the
 * template gave the agent no way to say which it had done, so a sampled
 * registry and an exhaustive one arrived looking identical — the template
 * induced, in its own agents, precisely the unwitnessed-claim defect it
 * dispatches them to hunt.
 *
 * These are deliberately NOT evidence statuses. `EvidenceStatus` grades ONE
 * claim; a coverage mode grades the SCOPE a deliverable swept to arrive at its
 * claims. `UNVERIFIABLE` (verification was blocked) and `NOT_ATTEMPTED` (it
 * was never in budget) are different facts, and the same fail-open reasoning
 * that keeps `CLAIMED_ONLY` separate from `CONTRADICTED` keeps these apart.
 *
 * `NOT_APPLICABLE` is the same kind of fourth fact, and was missing until a
 * real dispatch surfaced the gap: an agent auditing a component with no
 * network code was asked for a "network partition" recovery row and had
 * nothing to write but `NOT_ATTEMPTED` — which means blocked or out of
 * budget, not "does not exist on this component's surface". Conflating "I
 * didn't get to it" with "there was nothing here" hides which gaps are real.
 */
export type CoverageMode = "EXHAUSTIVE" | "SAMPLED" | "NOT_ATTEMPTED" | "NOT_APPLICABLE";

export const COVERAGE_MODES: readonly CoverageMode[] = Object.freeze([
  "EXHAUSTIVE",
  "SAMPLED",
  "NOT_ATTEMPTED",
  "NOT_APPLICABLE",
]);

// --------------------------------------------------------------- tooling

/**
 * A concrete instrument an archetype should reach for, and how far to trust it.
 *
 * `status` is load-bearing. The prior-art survey of revoy-spec found several
 * code-intelligence subsystems whose ADRs read as authoritative but whose
 * `implementation:` field was `Design-only` — recommending them as if they
 * existed would make this template the very kind of unwitnessed claim it asks
 * its agents to hunt.
 */
export interface AuditTool {
  /** Invocation or identifier, e.g. `node scripts/reachability.mjs --json`. */
  readonly invocation: string;
  /** What question it actually answers. */
  readonly answers: string;
  /** `available` = present and wired in revoy2 today. `proposed` = not built; do not cite as evidence. */
  readonly status: "available" | "proposed";
  /** Why it is trustworthy, or what it cannot see. Every tool has a blind spot; name it. */
  readonly limits: string;
}

// --------------------------------------------------------------- archetype

export interface AuditWorkSection {
  readonly title: string;
  /** Imperative instructions. Rendered as a numbered section body. */
  readonly directives: readonly string[];
}

export interface AuditArchetype {
  /** Stable slug; also the generated skill directory name suffix. */
  readonly id: string;
  readonly ordinal: number;
  readonly role: string;
  /** The one question this lens exists to answer. */
  readonly primaryQuestion: string;
  /** One line naming what is being audited, e.g. "the codebase's nervous system". */
  readonly auditing: string;
  readonly anchors: readonly string[];
  readonly work: readonly AuditWorkSection[];
  /** What this archetype must NOT own — the anti-sprawl clause. */
  readonly exclusions: string;
  readonly deliverables: readonly string[];
  /** Questions the final report must answer. */
  readonly concludingQuestions: readonly string[];
  readonly tools: readonly AuditTool[];
}

export interface AuditFanoutTemplate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Fan width. `archetypes.length` must equal this; validated by validateTemplate. */
  readonly fanWidth: number;
  /**
   * Repo-relative path of the file this template is defined in.
   *
   * Declared rather than derived: the generated SKILL.md files carry a
   * "GENERATED FROM <path>" provenance line, and that line was hardcoded to
   * forensic-four's source until a second template made it wrong — the new
   * template's skills pointed a reader at the wrong file to edit. A convention
   * (`audit-<id>.ts`) would have re-created the same silent-drift risk one
   * level up; validateTemplate checks this field instead.
   */
  readonly sourcePath: string;
  readonly sharedMission: string;
  readonly completenessRule: string;
  /**
   * How the agent must declare the scope each deliverable actually swept.
   * Rendered alongside `COVERAGE_MODES` into every archetype surface, because
   * the trade-off it governs is made while the work is done, not at synthesis.
   */
  readonly coverageRule: string;
  readonly distinctionsRequired: readonly string[];
  readonly findingFormat: string;
  readonly handoffProtocol: string;
  readonly synthesisInstruction: string;
  readonly archetypes: readonly AuditArchetype[];
}

// --------------------------------------------------------------- validation

export interface TemplateDefect {
  readonly templateId: string;
  readonly detail: string;
}

/**
 * Structural checks a template must pass before it can be dispatched.
 *
 * A template that promises a 1×4 fan and ships three archetypes, or that
 * declares two archetypes with the same id, would dispatch a campaign that
 * silently audits less than it claims. Cheap to check, so checked.
 */
export function validateTemplate(template: AuditFanoutTemplate): readonly TemplateDefect[] {
  const defects: TemplateDefect[] = [];
  const defect = (detail: string): void => { defects.push({ templateId: template.id, detail }); };

  if (template.archetypes.length !== template.fanWidth) {
    defect(`fanWidth is ${template.fanWidth} but ${template.archetypes.length} archetype(s) are defined`);
  }
  // A blank coverage rule type-checks but dispatches a fan that demands
  // whole-repository registries while telling the agent nothing about how to
  // declare what it actually swept.
  if (template.coverageRule.trim() === "") defect("coverageRule is empty; deliverable scope would go undeclared");
  // A blank or wrong sourcePath sends a reader of a generated skill to the
  // wrong file; the path must at least name a real-looking template module.
  if (!/^packages\/arbor-prompts\/src\/.+\.ts$/.test(template.sourcePath)) {
    defect(`sourcePath "${template.sourcePath}" is not a packages/arbor-prompts/src/*.ts path`);
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const archetype of template.archetypes) {
    if (ids.has(archetype.id)) defect(`duplicate archetype id "${archetype.id}"`);
    ids.add(archetype.id);
    if (ordinals.has(archetype.ordinal)) defect(`duplicate ordinal ${archetype.ordinal}`);
    ordinals.add(archetype.ordinal);
    if (archetype.work.length === 0) defect(`archetype "${archetype.id}" defines no required work`);
    if (archetype.deliverables.length === 0) defect(`archetype "${archetype.id}" defines no deliverables`);
    if (archetype.tools.length === 0) defect(`archetype "${archetype.id}" names no tools`);
  }
  return defects;
}
