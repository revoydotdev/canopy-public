import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolvePaths,
  generate,
  extractGateTiers,
  extractHookAdvisory,
  extractTopLevelCliVerbs,
  extractSecondLevelCliVerbs,
  extractScopedSecondLevelCliVerbs,
  extractNativeToolNames,
  extractPackageScripts,
} from "../generate-procedure-tables.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let scratchDir;
afterEach(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

/**
 * This is the freshness proof the plan requires: mutate the declarative
 * execution profile in a scratch copy (never the real one), regenerate
 * against that copy, and assert the
 * rendered dispatch table changed. If this test ever passes on an
 * unmodified generator, the generator has stopped being sourced from
 * profile and has silently become prose that happens to match.
 */
describe("generate-procedure-tables freshness", () => {
  it("changes the rendered dispatch table when profile cost_class changes in a scratch copy", async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "procedure-tables-"));
    const realProfileSource = readFileSync(resolve(REPO_ROOT, "scripts/execution-profile.json"), "utf8");

    // Sanity precondition: the gate we're about to flip must exist and be
    // "stop" in the real profile, or this test would be proving nothing.
    const realTiers = extractGateTiers(realProfileSource);
    expect(realTiers["gate:adr-registry"]).toBe("stop");

    const mutatedProfile = JSON.parse(realProfileSource);
    mutatedProfile.gates["gate:adr-registry"].cost_class = "full";
    const mutatedSource = `${JSON.stringify(mutatedProfile, null, 2)}\n`;
    expect(mutatedSource).not.toBe(realProfileSource);
    const mutatedTiers = extractGateTiers(mutatedSource);
    expect(mutatedTiers["gate:adr-registry"]).toBe("full");

    const scratchProfile = join(scratchDir, "execution-profile.json");
    writeFileSync(scratchProfile, mutatedSource);

    const realPaths = resolvePaths([], REPO_ROOT);
    const mutatedPaths = { ...realPaths, executionProfile: scratchProfile };

    const before = await generate(realPaths);
    const after = await generate(mutatedPaths);

    // The mutated gate must appear in the "about to push" row's push-only
    // gate list after the mutation and must not have appeared there before
    // (it was "stop", i.e. visible at every Stop hook run already). Scoped
    // to that one row specifically — "gate:adr-registry" legitimately
    // appears elsewhere in the table (the "authoring a decision" row) so a
    // whole-table containment check would prove nothing about THIS tier flip.
    const pushRow = (table) => table.split("\n").find((line) => line.startsWith("| about to push"));
    expect(pushRow(before.dispatchTable)).not.toContain("gate:adr-registry");
    expect(pushRow(after.dispatchTable)).toContain("gate:adr-registry");
    expect(after.dispatchTable).not.toEqual(before.dispatchTable);
  });

  it("changing HOOK_ADVISORY membership in a scratch copy changes the advisory count", async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "procedure-tables-"));
    const realGateAllSource = readFileSync(resolve(REPO_ROOT, "scripts/gate-all.mjs"), "utf8");
    const realAdvisory = extractHookAdvisory(realGateAllSource);
    expect(realAdvisory.has("gate:vi-findings")).toBe(true);
    expect(realAdvisory.has("gate:reachability")).toBe(false);

    const mutatedSource = realGateAllSource.replace(
      "const HOOK_ADVISORY = new Map([",
      'const HOOK_ADVISORY = new Map([\n  [\n    "gate:reachability",\n    "MUTATED BY procedure-tables-freshness.test.mjs",\n  ],',
    );
    expect(mutatedSource).not.toBe(realGateAllSource);
    const mutatedAdvisory = extractHookAdvisory(mutatedSource);
    expect(mutatedAdvisory.has("gate:reachability")).toBe(true);
    expect(mutatedAdvisory.size).toBe(realAdvisory.size + 1);

    const scratchGateAll = join(scratchDir, "gate-all.mjs");
    writeFileSync(scratchGateAll, mutatedSource);

    const realPaths = resolvePaths([], REPO_ROOT);
    const mutatedPaths = { ...realPaths, gateAll: scratchGateAll };

    const before = await generate(realPaths);
    const after = await generate(mutatedPaths);
    expect(after.advisoryCount).toBe(before.advisoryCount + 1);
  });
});

describe("generate-procedure-tables extraction — proves derivation, not assertion", () => {
  it("extracts the real execution-profile cost map with every declared gate classified", () => {
    const source = readFileSync(resolve(REPO_ROOT, "scripts/execution-profile.json"), "utf8");
    const tiers = extractGateTiers(source);
    expect(Object.keys(tiers).length).toBeGreaterThan(20);
    for (const tier of Object.values(tiers)) expect(["stop", "fast", "full"]).toContain(tier);
  });

  it("extracts the real HOOK_ADVISORY set matching the known advisory gates", () => {
    const source = readFileSync(resolve(REPO_ROOT, "scripts/gate-all.mjs"), "utf8");
    const advisory = extractHookAdvisory(source);
    // gate:decision-queue was briefly a third member under ADR-081 and was
    // removed by ADR-082: the agent does not interview itself, it asks the
    // operator, so a veto IS resolvable at Stop. This assertion is that
    // record's O5 evidence — if decision-queue reappears here, the Stop no
    // longer blocks and operator calls can accrue behind a warning again.
    expect(advisory).toEqual(new Set(["gate:store-freshness", "gate:vi-findings", "gate:hollow-parity"]));
  });

  it("extracts real top-level CLI verbs from cli.ts, including the new `evidence` verb", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/cli.ts"), "utf8");
    const verbs = extractTopLevelCliVerbs(source);
    expect(verbs.has("evidence")).toBe(true);
    expect(verbs.has("doctor")).toBe(true);
    expect(verbs.has("project")).toBe(true);
    expect(verbs.has("ledger")).toBe(true);
  });

  it("extracts real second-level CLI verbs from cli.ts", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/cli.ts"), "utf8");
    const verbs = extractSecondLevelCliVerbs(source);
    for (const expected of ["status", "enroll", "repair", "registry", "manage"]) {
      expect(verbs.has(expected)).toBe(true);
    }
  });

  it("extracts the real native MCP tool registrations, including evidence.refresh", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/native-tool-host.ts"), "utf8");
    const tools = extractNativeToolNames(source);
    expect(tools.has("evidence.refresh")).toBe(true);
    expect(tools.has("repository.search")).toBe(true);
    // No project/campaign/waiver/ADR/gap-register native tool exists yet —
    // this is exactly what makes those CRUD rows legitimately
    // "none — hand-edit" rather than an unchecked assumption.
    for (const tool of tools) expect(tool.startsWith("project.") || tool.startsWith("campaign.")).toBe(false);
  });

  it("extracts the real package.json scripts, including adr:allocate and the four refresh scripts", () => {
    const source = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    const scripts = extractPackageScripts(source);
    for (const expected of ["adr:allocate", "claims:refresh", "completion-depth:refresh", "vi:observe", "determinism:refresh"]) {
      expect(scripts.has(expected)).toBe(true);
    }
  });
});

describe("generate-procedure-tables --check against the committed files", () => {
  it("the committed dispatch table (SKILL.md) and CRUD appendix (reference/crud-reference.md) match what the generator currently produces", async () => {
    const paths = resolvePaths([], REPO_ROOT);
    const result = await generate(paths);
    // The dispatch table lives inline in SKILL.md (loaded on every invocation);
    // the CRUD appendix lives in the on-demand companion so a routine dispatch
    // invocation does not carry the full entity matrix.
    const committedSkill = readFileSync(paths.skill, "utf8");
    const committedCrud = readFileSync(paths.crudReference, "utf8");
    expect(committedSkill).toContain(result.dispatchTable);
    expect(committedSkill).not.toContain(result.crudTable);
    expect(committedCrud).toContain(result.crudTable);
  });
});

/**
 * D13a: `extractSecondLevelCliVerbs` pools every `subcommand === "x"` /
 * `action === "x"` literal in cli.ts into ONE flat set regardless of which
 * top-level verb it belongs to, so CRUD_ENTITIES derivation used to be able
 * to attribute a generic word (e.g. "status") to the wrong parent verb.
 * `extractScopedSecondLevelCliVerbs` fixes this by scoping each second-level
 * verb to the real top-level block (or same-file delegate function) that
 * declares it. These tests prove the scoping on synthetic sources where two
 * different parents legitimately share a child verb name — the exact shape
 * the flat pool could not distinguish.
 */
describe("extractScopedSecondLevelCliVerbs — D13 flat-namespace fix", () => {
  it("attributes an inline second-level verb only to its real parent, not to an unrelated parent using the same word", () => {
    const synthetic = `
      if (args[0] === "alpha") {
        const subcommand = args[1];
        if (subcommand === "status") { return 0; }
        if (subcommand === "widen") { return 0; }
      }
      if (args[0] === "beta") {
        const subcommand = args[1];
        if (subcommand === "status") { return 0; }
      }
    `;
    const scoped = extractScopedSecondLevelCliVerbs(synthetic);
    expect(scoped.get("alpha")).toEqual(new Set(["status", "widen"]));
    expect(scoped.get("beta")).toEqual(new Set(["status"]));
    // "widen" is real under alpha only — the OLD flat pool would have
    // reported it present for beta too, since both verbs shared one Set.
    expect(scoped.get("beta").has("widen")).toBe(false);
  });

  it("follows a same-file delegated dispatch function (the `task` shape) and still keeps it scoped to its own parent", () => {
    const synthetic = `
      if (args[0] === "gamma") {
        return gammaCommand(args.slice(1), environment);
      }
      if (args[0] === "delta") {
        const subcommand = args[1];
        if (subcommand === "widen") { return 0; }
      }
      async function gammaCommand(args) {
        const subcommand = args[0];
        if (subcommand === "widen") { return 0; }
        if (subcommand === "narrow") { return 0; }
      }
    `;
    const scoped = extractScopedSecondLevelCliVerbs(synthetic);
    expect(scoped.get("gamma")).toEqual(new Set(["widen", "narrow"]));
    expect(scoped.get("delta")).toEqual(new Set(["widen"]));
    // "narrow" belongs to gamma's delegate only.
    expect(scoped.get("delta").has("narrow")).toBe(false);
  });

  it("real cli.ts: `project`'s children are scoped to `project` and are absent from an unrelated verb's scope", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/src/cli.ts"), "utf8");
    const scoped = extractScopedSecondLevelCliVerbs(source);
    for (const expected of ["status", "enroll", "repair", "registry", "manage"]) {
      expect(scoped.get("project")?.has(expected)).toBe(true);
    }
    // `task`'s own second-level verbs (scoped via its same-file delegate,
    // taskComposerCommand) must NOT bleed into `project`'s scope. `retry` is
    // the canonical fresh-authority retry verb for a retained composer draft.
    expect(scoped.get("project")?.has("follow-up")).toBe(false);
    expect(scoped.get("task")).toEqual(new Set(["list", "show", "answer", "confirm", "retry", "reject", "follow-up"]));
  });
});

/**
 * D13b: a CRUD_ENTITIES `store` field is curated prose, and used to be
 * accepted unchecked — the historical failure this reproduces is anti-stub's
 * store being described as "an inline JS array literal" long after it became
 * a real file (`scripts/anti-stub/triage.json`), with `--check` never
 * catching it because rendering only ever proved the table matched its own
 * declaration, not that the declaration matched reality.
 *
 * This constructs that exact failure mode in a SCRATCH COPY of the real
 * generator (never the committed one) by rewriting one entity's `store` to a
 * path that does not exist, then proves the full `generate()` pipeline
 * (which both `--write` and `--check` run through) throws rather than
 * silently rendering the stale text — the bar the task set: "a stale
 * declaration should FAIL --check rather than render cleanly."
 */
describe("CRUD_ENTITIES store verification — D13 stale-declaration proof", () => {
  it("BEFORE: the real, unmodified generator's store declarations all verify and generate() succeeds", async () => {
    const paths = resolvePaths([], REPO_ROOT);
    await expect(generate(paths)).resolves.toBeDefined();
  });

  it("AFTER: a store rewritten to a nonexistent path fails generate() with an actionable error, proving the check is real", async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "procedure-tables-stale-store-"));
    const realGeneratorSource = readFileSync(resolve(REPO_ROOT, "scripts/generate-procedure-tables.mjs"), "utf8");

    // Sanity precondition: the exact literal we are about to stale-ify must
    // be present in the real file, or this test would be proving nothing.
    const originalDeclaration = 'store: "scripts/anti-stub/triage.json"';
    expect(realGeneratorSource).toContain(originalDeclaration);

    const mutatedSource = realGeneratorSource.replace(
      originalDeclaration,
      'store: "scripts/anti-stub/an-inline-js-array-literal-that-does-not-exist.json"',
    );
    expect(mutatedSource).not.toBe(realGeneratorSource);

    const scratchGeneratorPath = join(scratchDir, "generate-procedure-tables.mjs");
    writeFileSync(scratchGeneratorPath, mutatedSource);

    const { generate: generateFromScratch } = await import(pathToFileURL(scratchGeneratorPath).href);
    const paths = resolvePaths([], REPO_ROOT);

    await expect(generateFromScratch(paths)).rejects.toThrow(/anti-stub TRIAGE.*does not exist on disk|store declaration/is);
  });
});
