import { describe, expect, it } from "vitest";
import {
  AUDIT_TEMPLATES,
  CLOSURE_ADVERSARIAL,
  COVERAGE_MODES,
  FORENSIC_FOUR,
  findAuditTemplate,
  renderArchetypePrompt,
  renderArchetypeSkill,
  renderTemplateOverview,
  skillPath,
  validateTemplate,
} from "../src/index.js";

describe("audit fan-out templates — structural validity", () => {
  it("every shipped template passes its own structural validation", () => {
    for (const template of AUDIT_TEMPLATES) {
      expect(validateTemplate(template), `${template.id} has defects`).toEqual([]);
    }
  });

  it("forensic-four really is a 1x4 fan with four distinct lenses", () => {
    expect(FORENSIC_FOUR.fanWidth).toBe(4);
    expect(FORENSIC_FOUR.archetypes).toHaveLength(4);
    expect(FORENSIC_FOUR.archetypes.map((a) => a.id)).toEqual(["constitutional", "structural", "resilience", "runtime"]);
    // Distinct lenses are the whole premise: four agents that accept the same
    // thing as proof would produce four similar code-review notes instead of
    // conclusions that can corroborate or falsify each other.
    expect(new Set(FORENSIC_FOUR.archetypes.map((a) => a.auditing)).size).toBe(4);
    expect(new Set(FORENSIC_FOUR.archetypes.map((a) => a.primaryQuestion)).size).toBe(4);
  });

  it("validateTemplate actually fails on a malformed template", () => {
    // A validator that only ever passes is not a validator.
    const understated = { ...FORENSIC_FOUR, fanWidth: 7 };
    expect(validateTemplate(understated).length).toBeGreaterThan(0);

    const duplicated = {
      ...FORENSIC_FOUR,
      fanWidth: 2,
      archetypes: [FORENSIC_FOUR.archetypes[0], { ...FORENSIC_FOUR.archetypes[1], id: "constitutional" }],
    };
    expect(validateTemplate(duplicated).some((defect) => defect.detail.includes("duplicate archetype id"))).toBe(true);
  });

  it("validateTemplate rejects a template that would dispatch with no coverage rule", () => {
    // The deliverables ask for whole-repository registries. Dispatching that
    // demand with no way to declare what was actually swept is the defect this
    // rule closes, and a blank string type-checks perfectly.
    const silent = { ...FORENSIC_FOUR, coverageRule: "" };
    expect(validateTemplate(silent).some((defect) => defect.detail.includes("coverageRule is empty"))).toBe(true);
    const whitespace = { ...FORENSIC_FOUR, coverageRule: "   \n  " };
    expect(validateTemplate(whitespace).some((defect) => defect.detail.includes("coverageRule is empty"))).toBe(true);
    // And it must not fire on the real template — a check that always fails is
    // as useless as one that never does.
    expect(validateTemplate(FORENSIC_FOUR).some((defect) => defect.detail.includes("coverageRule"))).toBe(false);
  });

  it("rejects duplicate ordinals and archetypes with empty operational requirements", () => {
    // These checks protect independently meaningful dispatch invariants. Keep
    // them together so a future refactor cannot preserve the broad shape of a
    // template while quietly sending an agent without work, deliverables, or
    // usable tools.
    const first = FORENSIC_FOUR.archetypes[0]!;
    const second = FORENSIC_FOUR.archetypes[1]!;
    const malformed = {
      ...FORENSIC_FOUR,
      fanWidth: 2,
      archetypes: [
        first,
        {
          ...second,
          ordinal: first.ordinal,
          work: [],
          deliverables: [],
          tools: [],
        },
      ],
    };

    const defects = validateTemplate(malformed);
    expect(defects.some((defect) => defect.detail.includes("duplicate ordinal"))).toBe(true);
    expect(defects.some((defect) => defect.detail.includes("defines no required work"))).toBe(true);
    expect(defects.some((defect) => defect.detail.includes("defines no deliverables"))).toBe(true);
    expect(defects.some((defect) => defect.detail.includes("names no tools"))).toBe(true);
  });

  it("findAuditTemplate returns null for an unknown id rather than throwing", () => {
    expect(findAuditTemplate("forensic-four")).toBe(FORENSIC_FOUR);
    expect(findAuditTemplate("no-such-template")).toBeNull();
  });
});

describe("audit fan-out templates — tooling honesty", () => {
  it("every archetype names at least one tool that actually exists today", () => {
    for (const archetype of FORENSIC_FOUR.archetypes) {
      const available = archetype.tools.filter((tool) => tool.status === "available");
      expect(available.length, `${archetype.id} has no available tooling`).toBeGreaterThan(0);
    }
  });

  it("every tool states its limits — an instrument with no stated blind spot is a claim", () => {
    for (const archetype of FORENSIC_FOUR.archetypes) {
      for (const tool of archetype.tools) {
        expect(tool.limits.length, `${archetype.id}: ${tool.invocation}`).toBeGreaterThan(20);
      }
    }
  });

  it("proposed tools are marked unmistakably in the rendered prompt", () => {
    // The failure this guards: an agent reading the prompt, believing a
    // proposed tool exists, and reporting a fabricated result from it.
    for (const archetype of FORENSIC_FOUR.archetypes) {
      const proposed = archetype.tools.filter((tool) => tool.status === "proposed");
      if (proposed.length === 0) continue;
      const prompt = renderArchetypePrompt(FORENSIC_FOUR, archetype.id);
      expect(prompt).toContain("PROPOSED — NOT BUILT");
      expect(prompt).toContain("Do not cite them as evidence");
    }
  });
});

describe("audit fan-out templates — rendering", () => {
  it("renders a prompt for every archetype, carrying the shared spine", () => {
    for (const archetype of FORENSIC_FOUR.archetypes) {
      const prompt = renderArchetypePrompt(FORENSIC_FOUR, archetype.id);
      expect(prompt).toContain(`Agent ${archetype.ordinal} of 4`);
      expect(prompt).toContain(archetype.role);
      expect(prompt).toContain("## Evidence standard");
      expect(prompt).toContain("## Handoff protocol");
      expect(prompt).toContain("CLAIMED_ONLY");
      // Each prompt names its siblings so the agent knows what to hand off
      // rather than absorb — the anti-sprawl clause.
      for (const sibling of FORENSIC_FOUR.archetypes) {
        if (sibling.id === archetype.id) continue;
        expect(prompt).toContain(sibling.role);
      }
    }
  });

  it("carries the coverage declaration on BOTH surfaces, for every archetype", () => {
    // The dispatched prompt is the surface an agent actually receives. A
    // coverage rule that reached only the checked-in SKILL.md would leave
    // every campaign-dispatched specialist without it, which is the exact
    // shape of drift the single-source-of-truth design exists to prevent.
    for (const archetype of FORENSIC_FOUR.archetypes) {
      for (const surface of [
        renderArchetypePrompt(FORENSIC_FOUR, archetype.id),
        renderArchetypeSkill(FORENSIC_FOUR, archetype.id),
      ]) {
        expect(surface).toContain("## Coverage declaration");
        for (const mode of COVERAGE_MODES) expect(surface).toContain(mode);
        // The clause that resolves the contradiction: an unlabelled registry
        // is not credited merely for being long.
        expect(surface).toContain("An unlabelled registry is read as CLAIMED_ONLY");
      }
    }
  });

  it("reconciles whole-repository inspection with a caller-imposed dispatch scope, on BOTH surfaces", () => {
    // A real dispatch scopes each agent to one package. The spine's "inspect
    // the ENTIRE repository" line, read alone, contradicts that — three of
    // four agents in a real forensic-four run each had to guess the same
    // resolution independently. It must now be stated, not guessed, and it
    // must reach the dispatched prompt, not only the checked-in SKILL.md.
    for (const archetype of FORENSIC_FOUR.archetypes) {
      for (const surface of [
        renderArchetypePrompt(FORENSIC_FOUR, archetype.id),
        renderArchetypeSkill(FORENSIC_FOUR, archetype.id),
      ]) {
        expect(surface).toContain("READ broadly.");
        expect(surface).toContain("ORIGINATE narrowly.");
        expect(surface).toContain("Findings, deliverables and handoffs you author belong to your assigned scope only.");
      }
    }
  });

  it("states the handoff protocol is RAISED at dispatch and RESOLVED only in synthesis, on BOTH surfaces", () => {
    // The fan executes concurrently — no agent can see a sibling's output
    // while it works, so a dispatched agent can never truthfully record
    // whether a sibling corroborated a cross-domain finding. Recording it as
    // unresolved must be documented as compliance, not left implicit.
    for (const archetype of FORENSIC_FOUR.archetypes) {
      for (const surface of [
        renderArchetypePrompt(FORENSIC_FOUR, archetype.id),
        renderArchetypeSkill(FORENSIC_FOUR, archetype.id),
      ]) {
        expect(surface).toContain("run CONCURRENTLY");
        expect(surface).toContain("RAISED by you, now, during dispatch");
        expect(surface).toContain("RESOLVED later, in synthesis");
        expect(surface).toContain("is correct compliance with");
      }
    }
  });

  it("carries the NOT_APPLICABLE coverage mode, distinct from NOT_ATTEMPTED, on BOTH surfaces", () => {
    // NOT_ATTEMPTED means blocked or out of budget. An item that never
    // existed on a component's actual surface (e.g. a "network partition"
    // recovery row for a component with no network code) is a different
    // fact, and conflating them hid which gaps were real in a real dispatch.
    expect(COVERAGE_MODES).toContain("NOT_APPLICABLE");
    for (const archetype of FORENSIC_FOUR.archetypes) {
      for (const surface of [
        renderArchetypePrompt(FORENSIC_FOUR, archetype.id),
        renderArchetypeSkill(FORENSIC_FOUR, archetype.id),
      ]) {
        expect(surface).toContain("NOT_APPLICABLE");
        expect(surface).toContain("network partition — NOT_APPLICABLE");
        expect(surface).toContain(
          "Reach for NOT_APPLICABLE only when the item genuinely does not exist on your component's actual surface",
        );
      }
    }
  });

  it("is deterministic — same template in, byte-identical text out", () => {
    // This is what makes the checked-in SKILL.md files diff-checkable.
    for (const archetype of FORENSIC_FOUR.archetypes) {
      const runs = Array.from({ length: 5 }, () => renderArchetypeSkill(FORENSIC_FOUR, archetype.id));
      expect(new Set(runs).size).toBe(1);
      const prompts = Array.from({ length: 5 }, () => renderArchetypePrompt(FORENSIC_FOUR, archetype.id));
      expect(new Set(prompts).size).toBe(1);
    }
  });

  it("renders SKILL.md with valid frontmatter and a do-not-edit marker", () => {
    for (const archetype of FORENSIC_FOUR.archetypes) {
      const skill = renderArchetypeSkill(FORENSIC_FOUR, archetype.id);
      expect(skill.startsWith("---\n")).toBe(true);
      expect(skill).toContain(`name: forensic-four-${archetype.id}-auditor`);
      expect(skill).toContain("description: >-");
      expect(skill).toContain("GENERATED FROM packages/arbor-prompts/src/audit-forensic-four.ts");
      expect(skill).toContain("DO NOT EDIT BY HAND");
      // The synthesis vocabulary must reach the skill surface, or an agent
      // cannot assign the final classification the template asks for.
      expect(skill).toContain("PRESENT_BUT_UNWIRED");
    }
  });

  it("rejects an unknown archetype instead of rendering an empty prompt", () => {
    expect(() => renderArchetypePrompt(FORENSIC_FOUR, "nope")).toThrow(/unknown archetype/);
    expect(() => renderArchetypeSkill(FORENSIC_FOUR, "nope")).toThrow(/unknown archetype/);
  });

  it("the overview names every archetype and its skill path", () => {
    const overview = renderTemplateOverview(FORENSIC_FOUR);
    for (const archetype of FORENSIC_FOUR.archetypes) {
      expect(overview).toContain(archetype.role);
      expect(overview).toContain(skillPath(FORENSIC_FOUR, archetype));
    }
  });
});

describe("the registry holds more than one template", () => {
  it("ships at least two templates with distinct ids and genuinely different fan widths", () => {
    // The point of a second entry: a registry with one member cannot show
    // whether anything in it was written for one instance.
    expect(AUDIT_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    expect(new Set(AUDIT_TEMPLATES.map((t) => t.id)).size).toBe(AUDIT_TEMPLATES.length);
    expect(new Set(AUDIT_TEMPLATES.map((t) => t.fanWidth)).size).toBeGreaterThan(1);
  });

  it("closure-adversarial is a 1x2 fan whose two roles carry opposed burdens", () => {
    expect(CLOSURE_ADVERSARIAL.fanWidth).toBe(2);
    expect(CLOSURE_ADVERSARIAL.archetypes.map((a) => a.id)).toEqual(["challenger", "defender"]);
    // Both examine the SAME ground, unlike forensic-four's disjoint lenses, so
    // the anti-advocacy rule is what keeps it from becoming two motivated briefs.
    for (const archetype of CLOSURE_ADVERSARIAL.archetypes) {
      const prompt = renderArchetypePrompt(CLOSURE_ADVERSARIAL, archetype.id);
      expect(prompt).toContain("against your own assigned position");
    }
    // And it must say plainly that it has no lateral handoffs, or an agent
    // will invent the collaboration the other template's protocol implies.
    expect(CLOSURE_ADVERSARIAL.handoffProtocol).toContain("NO lateral handoffs");
  });

  it("every generated skill names ITS OWN source file, not another template's", () => {
    // The defect a second template exposed: renderArchetypeSkill hardcoded
    // forensic-four's path, so closure-adversarial's skills sent a reader to
    // the wrong file to edit. Checked for every template, not just the new one.
    for (const template of AUDIT_TEMPLATES) {
      for (const archetype of template.archetypes) {
        expect(renderArchetypeSkill(template, archetype.id)).toContain(`GENERATED FROM ${template.sourcePath}`);
      }
    }
    // Both directions: the two shipped templates must not share a source path,
    // or the assertion above would pass while pointing everything at one file.
    expect(new Set(AUDIT_TEMPLATES.map((t) => t.sourcePath)).size).toBe(AUDIT_TEMPLATES.length);
  });

  it("validateTemplate rejects a sourcePath that would misdirect a reader", () => {
    for (const bad of ["", "   ", "audit-forensic-four.ts", "packages/arbor-prompts/src/nope.md"]) {
      expect(
        validateTemplate({ ...CLOSURE_ADVERSARIAL, sourcePath: bad }).some((d) => d.detail.includes("sourcePath")),
        `expected "${bad}" to be rejected`,
      ).toBe(true);
    }
    // ...and does not fire on either real template.
    for (const template of AUDIT_TEMPLATES) {
      expect(validateTemplate(template).some((d) => d.detail.includes("sourcePath"))).toBe(false);
    }
  });
});
