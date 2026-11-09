/**
 * audit-render.ts — every audit-template surface, rendered from one source.
 *
 * See audit-templates.ts's header for why the template is data rather than
 * prose. This module is the other half of that decision: three renderers, no
 * hand-maintained copies.
 *
 *   renderArchetypePrompt()  -> a specialist prompt for campaign dispatch
 *   renderArchetypeSkill()   -> .claude/skills/<...>/SKILL.md (generated, diff-checked)
 *   renderTemplateOverview() -> the human-readable summary the CLI prints
 *
 * All three are PURE and DETERMINISTIC: same template in, byte-identical text
 * out, with no clock and no environment read. That is what lets the generated
 * SKILL.md files be regenerated in a test and compared byte-for-byte — a
 * generated artifact whose regeneration is not diff-checked is just a copy
 * that has not drifted yet.
 */

import type { AuditArchetype, AuditFanoutTemplate, AuditTool } from "./audit-templates.js";
import { COVERAGE_MODES, EVIDENCE_STATUSES, FINDING_SEVERITIES, SYNTHESIS_CLASSIFICATIONS } from "./audit-templates.js";

const SEVERITY_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  S0: "existential, systemic, or integrity-destroying",
  S1: "critical security, corruption, authorization, or availability failure",
  S2: "major feature, reliability, or architectural failure",
  S3: "localized defect, drift, or maintainability hazard",
  S4: "minor defect, ambiguity, or improvement opportunity",
});

const COVERAGE_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  EXHAUSTIVE: "every instance in scope was enumerated, and you can state the mechanical basis for saying so",
  SAMPLED: "a deliberate subset was examined; state the selection rule and the size",
  NOT_ATTEMPTED: "out of budget or blocked; state which, and what it would take to close",
  NOT_APPLICABLE: "the item does not exist on this component's actual surface — not blocked, not skipped; state why",
});

const EVIDENCE_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  OBSERVED_DYNAMICALLY: "reproduced through execution, tests, traces, requests, interaction, or runtime inspection",
  OBSERVED_STATICALLY: "directly established from source, configuration, schema, or generated artifacts",
  CORROBORATED: "supported by multiple independent forms of evidence",
  INFERRED: "strongly suggested but not directly verified",
  CLAIMED_ONLY: "asserted by documentation, naming, comments, or tests without implementation evidence",
  CONTRADICTED: "evidence shows the documented or intended claim is false",
  UNVERIFIABLE: "verification is blocked by unavailable dependencies, credentials, environments, or artifacts",
});

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function toolBlock(tool: AuditTool): string {
  const marker = tool.status === "available" ? "AVAILABLE" : "PROPOSED — NOT BUILT";
  return `- \`${tool.invocation}\` — [${marker}]\n  - Answers: ${tool.answers}\n  - Limits: ${tool.limits}`;
}

/** The shared spine every archetype prompt carries. Identical across the fan by design. */
function sharedSpine(template: AuditFanoutTemplate): string {
  return [
    "## Shared mission",
    "",
    template.sharedMission,
    "",
    "## Evidence standard",
    "",
    "Every material claim must carry exactly one evidence status:",
    "",
    bullets(EVIDENCE_STATUSES.map((status) => `\`${status}\` — ${EVIDENCE_MEANINGS[status]}`)),
    "",
    template.completenessRule,
    "",
    "## Coverage declaration",
    "",
    template.coverageRule,
    "",
    "Every deliverable carries exactly one coverage mode:",
    "",
    bullets(COVERAGE_MODES.map((mode) => `\`${mode}\` — ${COVERAGE_MEANINGS[mode]}`)),
    "",
    "You must explicitly distinguish:",
    "",
    bullets(template.distinctionsRequired),
    "",
    "## Finding format",
    "",
    "```yaml",
    template.findingFormat,
    "```",
    "",
    "Severity:",
    "",
    bullets(FINDING_SEVERITIES.map((severity) => `\`${severity}\`: ${SEVERITY_MEANINGS[severity]}`)),
    "",
    "## Handoff protocol",
    "",
    template.handoffProtocol,
  ].join("\n");
}

function archetypeBody(template: AuditFanoutTemplate, archetype: AuditArchetype): string {
  const sections = archetype.work.map((section, index) => [
    `### ${index + 1}. ${section.title}`,
    "",
    bullets(section.directives),
  ].join("\n"));

  return [
    `# Agent ${archetype.ordinal} of ${template.fanWidth}: ${archetype.role}`,
    "",
    `You are the **${archetype.role}**. You are auditing ${archetype.auditing}.`,
    "",
    "## Primary question",
    "",
    `> ${archetype.primaryQuestion}`,
    "",
    "## Primary anchors",
    "",
    `Concentrate on: ${archetype.anchors.join(", ")}.`,
    "",
    "## Required work",
    "",
    sections.join("\n\n"),
    "",
    "## Deliberate exclusions",
    "",
    archetype.exclusions,
    "",
    "## Instruments",
    "",
    "Tools marked PROPOSED do not exist in this repository. Do not cite them as evidence, and do not",
    "pretend to have run them — a fabricated tool result is the exact defect class you are hunting.",
    "",
    archetype.tools.map(toolBlock).join("\n"),
    "",
    "## Deliverables",
    "",
    numbered(archetype.deliverables),
    "",
    "Your final conclusion must answer:",
    "",
    bullets(archetype.concludingQuestions),
  ].join("\n");
}

/**
 * The specialist prompt dispatched to one agent of the fan.
 *
 * Carries the shared spine plus this archetype's lens, and names the sibling
 * lenses so the agent knows precisely what it must hand off rather than absorb.
 */
export function renderArchetypePrompt(template: AuditFanoutTemplate, archetypeId: string): string {
  const archetype = template.archetypes.find((candidate) => candidate.id === archetypeId);
  if (!archetype) {
    throw new Error(
      `unknown archetype "${archetypeId}" for template "${template.id}" `
      + `(known: ${template.archetypes.map((a) => a.id).join(", ")})`,
    );
  }
  const siblings = template.archetypes
    .filter((candidate) => candidate.id !== archetype.id)
    .map((candidate) => `Agent ${candidate.ordinal} (${candidate.role}) — ${candidate.auditing}`);

  return [
    archetypeBody(template, archetype),
    "",
    "## Your siblings in this fan",
    "",
    "Each traverses the same repository through a different lens. Hand off across these boundaries; do not absorb them.",
    "",
    bullets(siblings),
    "",
    sharedSpine(template),
  ].join("\n").trim() + "\n";
}

/**
 * The generated SKILL.md for one archetype.
 *
 * Claude Code reads skills from disk and cannot call a renderer, so these are
 * checked in — and `audit-command.test.ts` regenerates them and fails on any
 * diff, which is what keeps the checked-in copy honest.
 */
export function renderArchetypeSkill(template: AuditFanoutTemplate, archetypeId: string): string {
  const archetype = template.archetypes.find((candidate) => candidate.id === archetypeId);
  if (!archetype) {
    throw new Error(`unknown archetype "${archetypeId}" for template "${template.id}"`);
  }
  const description =
    `${archetype.role} — agent ${archetype.ordinal} of ${template.fanWidth} in revoy2's ${template.id} `
    + `fan-out audit. Audits ${archetype.auditing}. ${archetype.primaryQuestion}`;

  return [
    "---",
    `name: ${skillName(template, archetype)}`,
    "description: >-",
    ...wrap(description, 92).map((line) => `  ${line}`),
    "license: MIT",
    `argument-hint: "[--scope <path>] [--depth recon|standard|exhaustive]"`,
    "---",
    "",
    `<!-- GENERATED FROM ${template.sourcePath} — DO NOT EDIT BY HAND.`,
    `     Regenerate with \`arbor-mcp audit sync\`; audit-command.test.ts fails on drift. -->`,
    "",
    archetypeBody(template, archetype),
    "",
    sharedSpine(template),
    "",
    "## Synthesis",
    "",
    template.synthesisInstruction,
    "",
    "Final classifications:",
    "",
    bullets(SYNTHESIS_CLASSIFICATIONS.map((classification) => `\`${classification}\``)),
  ].join("\n").trim() + "\n";
}

/** Stable skill directory/name for an archetype. */
export function skillName(template: AuditFanoutTemplate, archetype: AuditArchetype): string {
  return `${template.id}-${archetype.id}-auditor`;
}

/** Repo-relative path of an archetype's generated SKILL.md. */
export function skillPath(template: AuditFanoutTemplate, archetype: AuditArchetype): string {
  return `.claude/skills/${skillName(template, archetype)}/SKILL.md`;
}

/** Human-readable summary for `arbor-mcp audit show <id>`. */
export function renderTemplateOverview(template: AuditFanoutTemplate): string {
  const rows = template.archetypes.map((archetype) => {
    const available = archetype.tools.filter((tool) => tool.status === "available").length;
    return [
      `  ${archetype.ordinal}. ${archetype.role}`,
      `     lens      : ${archetype.auditing}`,
      `     question  : ${archetype.primaryQuestion}`,
      `     work      : ${archetype.work.length} section(s), ${archetype.deliverables.length} deliverable(s)`,
      `     tools     : ${available} available, ${archetype.tools.length - available} proposed`,
      `     skill     : ${skillPath(template, archetype)}`,
    ].join("\n");
  });

  return [
    `${template.title}  [${template.id}]`,
    "",
    template.summary,
    "",
    `Fan width: 1 x ${template.fanWidth}`,
    "",
    rows.join("\n\n"),
    "",
  ].join("\n");
}

/** Greedy wrap; pure, so generated frontmatter is byte-stable. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current === "") { current = word; continue; }
    if (current.length + 1 + word.length > width) { lines.push(current); current = word; continue; }
    current = `${current} ${word}`;
  }
  if (current !== "") lines.push(current);
  return lines;
}
