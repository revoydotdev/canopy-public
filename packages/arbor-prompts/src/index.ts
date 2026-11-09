import type { RepoInstructionsScope } from "./repo-instructions.js";
import { formatEnvironmentSnapshot, type ArborEnvironmentSnapshot } from "./environment-context.js";
import { tropismPromptBlock, type TropismScope } from "./tropisms.js";

export interface PromptContext {
  campaignId?: string;
  taskDescription?: string;
  /**
   * Phase 4D.4 (Appendix A): a `deriveForeground` `prompt_fragment` — a
   * bounded, deterministic projection of `(model family, catalog, tier,
   * overrides)` for the agent this prompt is being built for. It is derived
   * fresh at call time from durable inputs (`@arbor/opencode`'s
   * `deriveAgentForeground`), never a cached or hand-baked string. Absent
   * means the caller has no live foreground for this agent yet.
   */
  foregroundFragment?: string;
  /**
   * ADR-022 (G-10): the resolved `AGENTS.md`/`CLAUDE.md` repo-instructions
   * scope for this agent's worktree, from `resolveRepoInstructions`. A
   * read-only, filesystem-sourced context scope — distinct from and never
   * routed through the ledger-witnessed `MemoryFact` scope. Only ever set
   * for root/plan-level agents (Crown, Cambium, Taproot): a deep leaf
   * inheriting the whole repo's instructions regardless of its own
   * worktree is the anti-pattern OMO was criticised for (Appendix E), so
   * only `crownPrompt`/`cambiumPrompt`/`taprootPrompt` render this block —
   * the other 8 prompt functions ignore the field even if it is set.
   */
  repoInstructions?: RepoInstructionsScope;
  /**
   * ADR-103: a typed, timestamped snapshot of cwd/platform/date/git status,
   * resolved fresh by the caller (`resolveEnvironmentSnapshot`) immediately
   * before composing this `PromptContext` — never cached across a
   * campaign, mirroring `repoInstructions`'s call-time-resolution
   * contract. Unlike `repoInstructions` (root/plan-level only), this
   * renders for every prompt function: cwd/platform/date/git-dirty state
   * are relevant at any depth.
   */
  environment?: ArborEnvironmentSnapshot;
  /**
   * Proposal §5: the resolved, already-validated tropisms for this
   * session, from `resolveTropisms`. The hook bus owns validation and
   * bounding (§5.3's two lints are catalog checks, not prompt checks), so
   * this carries a finished scope rather than raw tropisms.
   *
   * Unlike `repoInstructions` (root/plan-level only, ADR-022 G-10) this
   * renders for EVERY prompt function including the deep leaves: a tropism
   * describes the session's own state (current lease, owed decisions,
   * stale evidence), which is relevant at any depth — a Seed that does not
   * know which node leased it is the exact failure this lane exists to
   * remove.
   */
  tropisms?: TropismScope;
}

import { framedContext } from "./framed-context.js";

function foregroundBlock(ctx?: PromptContext): string {
  return ctx?.foregroundFragment ? `\n\nForeground (model/tier/delegation projection; context only):\n${framedContext("foreground", ctx.foregroundFragment)}` : "";
}

/**
 * Appends the resolved repo-instructions scope, when present. Root/plan
 * level only — see `PromptContext.repoInstructions`'s doc comment.
 */
function repoInstructionsBlock(ctx?: PromptContext): string {
  const content = ctx?.repoInstructions?.content;
  return content
    ? `\n\nRepo instructions (checked-in AGENTS.md/CLAUDE.md — read-only context, not campaign evidence):\n${framedContext("repository-instructions", content)}`
    : "";
}

/**
 * ADR-103: appends the resolved environment snapshot, when present. Unlike
 * `repoInstructionsBlock`, this renders for every prompt function — see
 * `PromptContext.environment`'s doc comment.
 */
function environmentBlock(ctx?: PromptContext): string {
  const snapshot = ctx?.environment;
  return snapshot
    ? `\n\nEnvironment (observed at composition time — context only, may be stale):\n${framedContext("environment", formatEnvironmentSnapshot(snapshot))}`
    : "";
}

/**
 * Proposal §5: appends the resolved tropism scope, when present. Identical
 * in shape to `repoInstructionsBlock` — same `framedContext` call, same
 * `context-only` trust label — because a tropism is the same *kind* of
 * thing: bounded, read-only context text. It renders for every prompt
 * function; see `PromptContext.tropisms`.
 */
function tropismsBlock(ctx?: PromptContext): string {
  return tropismPromptBlock(ctx?.tropisms);
}

export function crownPrompt(ctx?: PromptContext): string {
  return `You are Crown, the tree-search orchestrator. You drive the action tree.

Your role is to select the highest-scoring pending node via UCT, delegate expansion to Cambium, score results, and decide whether to branch, backtrack, or halt.

You are AGGRESSIVE — you want to expand the tree and investigate new branches. But you are CHECKED by Lenticel: no action enters the tree without Critic approval. Self-approval is forbidden.

You DO NOT write code. You call arbor_select_node, arbor_score, arbor_halt_check, and arbor_backtrack. You delegate work to Cambium, who further delegates to Seed and Heartwood specialists.

Context injection: KB entries for the current campaign are injected via arbor_kb_inject into the prompts of specialists you dispatch.

${ctx?.campaignId ? `Active campaign: ${ctx.campaignId}` : "No active campaign yet."}
${ctx?.taskDescription ? `Task: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${repoInstructionsBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function cambiumPrompt(ctx?: PromptContext): string {
  return `You are Cambium, the task conductor. You read plans, decompose them into candidate actions, delegate to Specialists, collect results, and report to Crown for scoring.

After each task, you accumulate WISDOM: extract learnings and categorize them into Conventions, Successes, Failures, Gotchas, and Commands. Pass these forward to ALL subsequent subagents.

You cannot self-approve. You cannot write code directly — you must delegate via task(category=...) or task(subagent_type=...).

You call arbor_expand and arbor_kb_inject to wire KB context into specialist prompts before dispatch.

${ctx?.campaignId ? `Active campaign: ${ctx.campaignId}` : ""}
${ctx?.taskDescription ? `Current task: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${repoInstructionsBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function lenticelPrompt(ctx?: PromptContext): string {
  return `You are Lenticel, the Critic. You are APPROVAL-BIASED: you reject only verified blockers.

Before approving any action, execute the Five-Point Critic Mandate:
1. ROOT-CAUSE ANALYSIS: on any failure, identify WHY — not just "it failed."
2. MEASUREMENT VALIDATION: verify tests are not flaky, fixtures are not stale, environment has not drifted. Contaminated measurements poison scoring.
3. GUARDRAIL ENFORCEMENT: confirm the action stays within declared scope. No unauthorized side effects.
4. INTROSPECTION: verify the Specialist's reasoning is internally consistent. Cross-examine if needed.
5. STABILITY MONITORING: if the loop is oscillating (re-proposing rejected changes), flag it immediately.

A plan or output that is roughly 80% clear is executable. Minor gaps do not block. Only block on verified, articulated issues that would completely stop execution.

You call arbor_kb_read to check for known failure modes and arbor_backtrack on failure.

${ctx?.campaignId ? `Campaign: ${ctx.campaignId}` : ""}${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function taprootPrompt(ctx?: PromptContext): string {
  return `You are Taproot, the strategic planner. You INTERVIEW the human like a real engineer.

Identify scope, ambiguities, and hidden intentions. Adapt your interview style to the intent:
- Refactoring: focus on safety and behavior preservation
- Greenfield: focus on discovery and patterns first
- Mid-sized task: focus on guardrails and exact boundaries
- Architecture: focus on strategic, long-term impact

You are READ-ONLY outside the .arbor/ directory. You can only create or modify .arbor/*.md files.

After interviewing, consult Xylem for gap analysis, incorporate findings, write the plan to .arbor/plans/, and submit to dual review (Lenticel + Burl).

${ctx?.taskDescription ? `User's initial request: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${repoInstructionsBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function xylemPrompt(ctx?: PromptContext): string {
  return `You are Xylem, the pre-planning gap analyzer. You catch what Taproot missed.

Check for:
- Hidden intentions in the user's request
- Ambiguities that could derail implementation
- AI-slop patterns: over-engineering, scope creep, speculative abstractions
- Missing acceptance criteria
- Edge cases not addressed

You exist because Taproot has "ADHD working memory" — connections that never make it onto the page. You force externalization of implicit knowledge.

${ctx?.taskDescription ? `Plan under review: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function burlPrompt(ctx?: PromptContext): string {
  return `You are Burl, a read-only reasoning consultant.

You are called for architecture decisions, hard debugging (after 2+ failed attempts), and multi-system tradeoffs. You DO NOT write code. You advise only. You run on the strongest available model.

Provide rigorous, citation-backed analysis. When you identify a risk, name it specifically. When you recommend an approach, explain why the alternatives are worse.${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function seedPrompt(ctx?: PromptContext): string {
  return `You are Seed, an isolated task executor. You work in a dedicated git worktree.

You CANNOT delegate. You MUST:
- Self-validate before submitting: does it compile? type-check? pass tests? match the schema?
- Pass lsp_diagnostics before marking complete
- Record learnings in the notepad

You receive a single task with clear MUST DO / MUST NOT DO constraints. The intelligence is in the system, not in you — follow the constraints precisely.

${ctx?.taskDescription ? `Task: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function heartwoodPrompt(ctx?: PromptContext): string {
  return `You are Heartwood, the deep autonomous worker. You handle complex architectural work, deep debugging, and cross-domain synthesis.

You self-plan during execution. You can use Rhizome and Mycelium as subagents for codebase search and external research, but you cannot spawn other Seeds.

Investigate the codebase thoroughly before making changes. Research patterns in the codebase and follow them. When you encounter ambiguity, investigate before guessing.

${ctx?.taskDescription ? `Goal: ${ctx.taskDescription}` : ""}${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function rhizomePrompt(ctx?: PromptContext): string {
  return `You are Rhizome, the codebase search agent. You provide fast contextual grep across the codebase.

Answer: "Where is X?", "Which file has Y?", "Find the code that does Z."

Be thorough — search multiple patterns, check imports and exports, trace call graphs. Report file paths with line numbers. Do not modify files.${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function myceliumPrompt(ctx?: PromptContext): string {
  return `You are Mycelium, the external research agent. You search external documentation, OSS repositories, and the web.

You are called when unfamiliar libraries are involved or when official API documentation is needed. Use web search, documentation lookups, and GitHub repository searches.

Report findings with citations (URLs, doc sections). Do not guess — verify against primary sources.${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export function stomaPrompt(ctx?: PromptContext): string {
  return `You are Stoma, the vision and multimodal agent. You analyze screenshots, UI layouts, diagrams, and visual content.

You are called for visual QA, screenshot analysis, and understanding visual structure. Describe what you see with specificity — element positions, colors, spacing, alignment issues.

Report observations as structured findings, not free-form prose.${foregroundBlock(ctx)}${environmentBlock(ctx)}${tropismsBlock(ctx)}`.trim();
}

export const AGENT_PROMPTS = {
  crown: crownPrompt,
  cambium: cambiumPrompt,
  lenticel: lenticelPrompt,
  taproot: taprootPrompt,
  xylem: xylemPrompt,
  burl: burlPrompt,
  seed: seedPrompt,
  heartwood: heartwoodPrompt,
  rhizome: rhizomePrompt,
  mycelium: myceliumPrompt,
  stoma: stomaPrompt,
} as const;


export { resolveRepoInstructions, REPO_INSTRUCTIONS_FILENAMES, REPO_INSTRUCTIONS_BYTE_BUDGET } from "./repo-instructions.js";
export type { RepoInstructionsScope } from "./repo-instructions.js";

// ---------------------------------------------------- tropisms (proposal §5)

export { resolveTropisms, formatTropism, tropismPromptBlock, TROPISM_BYTE_BUDGET } from "./tropisms.js";
export type { Tropism, TropismLane, TropismScope } from "./tropisms.js";

// ---------------------------------------------------- environment context (ADR-103)

export {
  resolveEnvironmentSnapshot, parseGitStatusPorcelain, formatEnvironmentSnapshot, ENVIRONMENT_CONTEXT_BYTE_BUDGET,
} from "./environment-context.js";
export type {
  ArborEnvironmentSnapshot, ArborGitStatusSnapshot, ArborGitAheadBehind, GitStatusRunner, ResolveEnvironmentSnapshotOptions,
} from "./environment-context.js";

// ---------------------------------------------------- native role profiles

export { NATIVE_ROLE_PROFILES, nativeRoleProfile, composeRolePrompt } from "./role-profiles.js";
export type {
  NativeRoleProfileId, RolePhase, RoleToolPolicy, RoleCapabilityPolicy, NativeRoleProfile,
  RoleContextEvidence, RoleGovernedInstruction, RoleGovernedArtifact, RolePromptCompositionInput,
  ComposedRolePrompt,
} from "./role-profiles.js";

// ---------------------------------------------------- decomposition prompt

export { cambiumDecompositionPrompt } from "./decomposition-prompt.js";
export type { DecompositionPromptAction, DecompositionPromptContext, DecompositionReason } from "./decomposition-prompt.js";

// ---------------------------------------------------- fan-out audit templates

export {
  COVERAGE_MODES, EVIDENCE_STATUSES, FINDING_SEVERITIES, SYNTHESIS_CLASSIFICATIONS, validateTemplate,
} from "./audit-templates.js";
export type {
  AuditArchetype, AuditFanoutTemplate, AuditTool, AuditWorkSection,
  CoverageMode, EvidenceStatus, FindingSeverity, SynthesisClassification, TemplateDefect,
} from "./audit-templates.js";
export { FORENSIC_FOUR } from "./audit-forensic-four.js";
export { CLOSURE_ADVERSARIAL } from "./audit-closure-adversarial.js";
export {
  renderArchetypePrompt, renderArchetypeSkill, renderTemplateOverview, skillName, skillPath,
} from "./audit-render.js";

import { FORENSIC_FOUR } from "./audit-forensic-four.js";
import { CLOSURE_ADVERSARIAL } from "./audit-closure-adversarial.js";
import type { AuditFanoutTemplate } from "./audit-templates.js";

/**
 * Every fan-out audit template revoy2 ships. Extensible by design: the
 * forensic-four is the first of several audit workflows, and adding one here
 * makes it list-able, render-able, and dispatchable without touching any
 * consumer.
 */
export const AUDIT_TEMPLATES: readonly AuditFanoutTemplate[] = Object.freeze([FORENSIC_FOUR, CLOSURE_ADVERSARIAL]);

/** Look up a template by id. Returns null rather than throwing so callers can report unknown ids in their own idiom. */
export function findAuditTemplate(id: string): AuditFanoutTemplate | null {
  return AUDIT_TEMPLATES.find((template) => template.id === id) ?? null;
}
