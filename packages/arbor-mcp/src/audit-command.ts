/**
 * audit-command.ts — `arbor-mcp audit`, the operator surface for revoy2's
 * fan-out audit templates.
 *
 * This is what makes the templates LOADED AND USED rather than a folder of
 * markdown. Four actions:
 *
 *   audit list                          — every shipped template
 *   audit show <template>               — the fan, its lenses, and its tooling
 *   audit prompt <template> <archetype> — the specialist prompt for dispatch
 *   audit sync [--check]                — regenerate the checked-in SKILL.md files
 *
 * `sync --check` is the drift gate: Claude Code reads skills from disk and
 * cannot call a renderer, so the generated files are checked in, and this
 * proves they still match their source. A generated artifact whose
 * regeneration is not diff-checked is just a copy that has not drifted yet.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AUDIT_TEMPLATES,
  findAuditTemplate,
  renderArchetypePrompt,
  renderArchetypeSkill,
  renderTemplateOverview,
  skillPath,
  validateTemplate,
} from "@arbor/prompts";
import { EXIT_CODES } from "./exit-codes.js";

export interface AuditCommandEnvironment {
  cwd: string;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

const USAGE =
  "Usage: arbor-mcp audit <list|show|prompt|sync>\n"
  + "  audit list                            List every shipped fan-out audit template\n"
  + "  audit show <template>                 Describe a template's fan, lenses and tooling\n"
  + "  audit prompt <template> <archetype>   Print one archetype's dispatch prompt\n"
  + "  audit sync [--check]                  Regenerate SKILL.md files; --check fails on drift\n";

export function auditCommand(args: readonly string[], environment: AuditCommandEnvironment): number {
  const action = args[0];

  if (action === "list") {
    for (const template of AUDIT_TEMPLATES) {
      environment.stdout.write(`${template.id}  (1 x ${template.fanWidth})  ${template.title}\n`);
      environment.stdout.write(`  ${template.summary}\n`);
    }
    return EXIT_CODES.SUCCESS;
  }

  if (action === "show") {
    const template = findAuditTemplate(args[1] ?? "");
    if (!template) {
      environment.stderr.write(`audit show: unknown template "${args[1] ?? ""}"\n${USAGE}`);
      return EXIT_CODES.USAGE;
    }
    // A template that promises a wider fan than it defines would dispatch a
    // campaign auditing less than it claims. Report it as a violation rather
    // than printing a confident overview of a malformed template.
    const defects = validateTemplate(template);
    environment.stdout.write(renderTemplateOverview(template));
    if (defects.length > 0) {
      for (const defect of defects) environment.stderr.write(`audit: template defect — ${defect.detail}\n`);
      return EXIT_CODES.VIOLATION;
    }
    return EXIT_CODES.SUCCESS;
  }

  if (action === "prompt") {
    const template = findAuditTemplate(args[1] ?? "");
    if (!template) {
      environment.stderr.write(`audit prompt: unknown template "${args[1] ?? ""}"\n${USAGE}`);
      return EXIT_CODES.USAGE;
    }
    try {
      environment.stdout.write(renderArchetypePrompt(template, args[2] ?? ""));
      return EXIT_CODES.SUCCESS;
    } catch (error) {
      environment.stderr.write(`audit prompt: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_CODES.USAGE;
    }
  }

  if (action === "sync") {
    const checkOnly = args.includes("--check");
    const drifted: string[] = [];
    let written = 0;

    for (const template of AUDIT_TEMPLATES) {
      for (const archetype of template.archetypes) {
        const relative = skillPath(template, archetype);
        const absolute = resolve(environment.cwd, relative);
        const rendered = renderArchetypeSkill(template, archetype.id);
        let current: string | null = null;
        try { current = readFileSync(absolute, "utf8"); } catch { current = null; }

        if (current === rendered) continue;
        if (checkOnly) { drifted.push(relative); continue; }
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, rendered, "utf8");
        written += 1;
        environment.stdout.write(`wrote ${relative}\n`);
      }
    }

    if (checkOnly) {
      if (drifted.length === 0) {
        environment.stdout.write("audit sync --check: generated skills match their source\n");
        return EXIT_CODES.SUCCESS;
      }
      environment.stderr.write(
        `audit sync --check: ${drifted.length} generated skill(s) differ from their source:\n`
        + drifted.map((path) => `  ${path}\n`).join("")
        + "Run `arbor-mcp audit sync` and commit the result.\n",
      );
      return EXIT_CODES.VIOLATION;
    }

    if (written === 0) environment.stdout.write("audit sync: already up to date\n");
    return EXIT_CODES.SUCCESS;
  }

  environment.stderr.write(USAGE);
  return EXIT_CODES.USAGE;
}
