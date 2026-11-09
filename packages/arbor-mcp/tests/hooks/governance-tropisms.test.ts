/**
 * The three SessionStart `inject` handlers that replaced the deleted shell
 * orientation hooks, asserted on the behaviour each hook had.
 *
 * Each case builds a throwaway git repository, drives the handler against
 * it, and asserts on the tropism body — not on a ledger row. A handler that
 * stopped measuring would be deduped by the bus into silence, so a body that
 * does not change when the tree does is precisely the defect these tests
 * exist to catch.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import { HOOK_HANDLERS } from "../../src/hooks/handlers.js";
import type { HookHandlerRegistry, HookInjectHandler } from "../../src/hooks/contracts.js";
import { governanceOrientTropism, owedDecisionsTropism, proposedRecords, readGovernedPosture, sessionIsolationTropism } from "../../src/hooks/governance-tropisms.js";
import { composeNativeRole } from "../../src/native-role-composer.js";

const TODAY = new Date("2026-09-29T00:00:00Z");

let repo = "";
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: repo, stdio: "ignore" }); };

const adr = (status: string, date: string, title: string): string =>
  `# ${title}\n\n**Status:** ${status}\n**Date:** ${date}\n\nRationale.\n`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tropism-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  mkdirSync(join(repo, "decisions"), { recursive: true });
  mkdirSync(join(repo, "packages", "x", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "x", "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "root");
});

afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("governance-orient tropism — the ordering index plus live posture", () => {
  it("reports a clean repository as clean, naming the ordering index", () => {
    const tropism = governanceOrientTropism(repo);
    expect(tropism?.lane).toBe("ADVISORY");
    expect(tropism?.provenance).toBe("generated");
    expect(tropism?.derived_from).toHaveLength(1);
    expect(tropism?.body).toContain("revoy2-governance/SKILL.md");
    expect(tropism?.body).toContain("graph-before-stores");
    expect(tropism?.body).toContain("HEAD is on master (trunk)");
    expect(tropism?.body).not.toContain("uncommitted path(s) under packages/");
  });

  it("counts uncommitted governed source separately from other dirt", () => {
    writeFileSync(join(repo, "packages", "x", "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "notes.txt"), "scratch\n");
    expect(readGovernedPosture(repo).governed_dirty).toBe(1);
    expect(governanceOrientTropism(repo)?.body).toContain("1 uncommitted path(s) under packages/ or decisions/");
  });

  it("names a held evidence lease, which is 'wait', not 'broken'", () => {
    mkdirSync(join(repo, ".git", "arbor", "evidence-refresh"), { recursive: true });
    writeFileSync(join(repo, ".git", "arbor", "evidence-refresh", "lock"), "");
    expect(governanceOrientTropism(repo)?.body).toContain("evidence:status");
  });

  it("reports a graph bound to an ancestor of HEAD as healthy, and a diverged one as not repairable in place", () => {
    mkdirSync(join(repo, ".visual-intelligence"), { recursive: true });
    const bind = (revision: string) => writeFileSync(join(repo, ".visual-intelligence", "manifest.json"), JSON.stringify({ repo_revision: revision }));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    bind(head);
    expect(governanceOrientTropism(repo)?.body).not.toContain("NOT an ancestor of HEAD");
    git("commit", "-q", "--allow-empty", "-m", "second");
    expect(governanceOrientTropism(repo)?.body).not.toContain("NOT an ancestor of HEAD");
    bind("0".repeat(40));
    expect(governanceOrientTropism(repo)?.body).toContain("NOT an ancestor of HEAD");
  });
});

describe("session-isolation tropism — observe-only checkout sharing", () => {
  it("says nothing about a clean repository on a non-trunk branch", () => {
    git("checkout", "-q", "-b", "feature");
    expect(sessionIsolationTropism(repo)).toBeNull();
  });

  it("reports pre-existing dirt as not this session's own", () => {
    writeFileSync(join(repo, "packages", "x", "src", "a.ts"), "export const a = 3;\n");
    const body = sessionIsolationTropism(repo)?.body ?? "";
    expect(body).toContain("1 uncommitted path(s)");
    expect(body).toContain("none of them yours yet");
  });

  it("reports trunk in the shared checkout, and a linked worktree as the safe place", () => {
    expect(sessionIsolationTropism(repo)?.body).toContain("on master in the shared checkout");
    const linked = mkdtempSync(join(tmpdir(), "tropism-wt-"));
    try {
      git("-C", repo, "worktree", "add", "-q", "-b", "wt", linked);
      expect(sessionIsolationTropism(linked)?.body).toContain("linked worktree");
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

describe("owed-decisions tropism — every Proposed ADR, with its age", () => {
  it("lists Proposed and Draft records with their age and the interview remedy", () => {
    writeFileSync(join(repo, "decisions", "ADR-001-first.md"), adr("Proposed", "2026-09-20", "First proposal"));
    writeFileSync(join(repo, "decisions", "ADR-002-draft.md"), adr("Draft", "2026-09-27", "Second draft"));
    const body = owedDecisionsTropism(repo, TODAY)?.body ?? "";
    expect(body).toContain("2 proposed ADR(s) awaiting a definitive green/redlight");
    expect(body).toContain("ADR-001 (9d old): First proposal");
    expect(body).toContain("ADR-002 (2d old): Second draft");
    expect(body).toContain("bun run interview:record");
    expect(body).not.toContain("/revoy2-interview");
  });

  it("ignores records that are not proposed or draft", () => {
    writeFileSync(join(repo, "decisions", "ADR-003-accepted.md"), adr("Accepted", "2026-01-01", "Already settled"));
    expect(owedDecisionsTropism(repo, TODAY)).toBeNull();
    expect(proposedRecords(repo, TODAY)).toEqual([]);
  });

  it("is silent when there is no decisions directory at all", () => {
    rmSync(join(repo, "decisions"), { recursive: true });
    expect(owedDecisionsTropism(repo, TODAY)).toBeNull();
  });
});

describe("the tropism reaches the model through the prompt path", () => {
  it("appears in the composed role prompt with the context-only trust label", async () => {
    writeFileSync(join(repo, "decisions", "ADR-001-first.md"), adr("Proposed", "2026-09-20", "First proposal"));
    const handlers: HookHandlerRegistry = { "inject.owed-decisions": { kind: "inject", handler: () => owedDecisionsTropism(repo, TODAY) } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({
      schema_version: 1, hook_id: "owed-decisions", version: "1.0.0", kind: "inject", event: "session_start",
      handler_ref: "inject.owed-decisions", why: "surface the operator's owed decisions",
    }));
    const bus = new HookBus({ catalog, handlers });
    const scope = await bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn: 0 });

    const composed = composeNativeRole({ role_id: "critic-reviewer", task: "review this", tropisms: scope, available_tools: [] });

    expect(composed.prompt).toContain("ADR-001 (9d old): First proposal");
    expect(composed.prompt).toContain('instruction-authority="context-only"');
    expect(composed.prompt).toContain("never instruction authority");
  });

  it("renders no tropism block at all when no inject hook is declared", async () => {
    const bus = new HookBus({ catalog: new HookCatalog() });
    const scope = await bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn: 0 });
    expect(composeNativeRole({ role_id: "critic-reviewer", task: "review this", tropisms: scope, available_tools: [] }).prompt).not.toContain("Tropisms");
  });

  it("the registered handlers are the closed-registry entries the catalog resolves", () => {
    const catalog = new HookCatalog();
    for (const ref of ["inject.governance-orient", "inject.session-isolation", "inject.owed-decisions"]) {
      const entry = catalog.resolveHandler(ref);
      expect(entry?.kind).toBe("inject");
      const handler: HookInjectHandler = entry?.kind === "inject" ? entry.handler : () => { throw new Error("not an inject entry"); };
      expect(handler).toBeTypeOf("function");
    }
  });
});

describe("hook-liveness equivalence", () => {
  it("a derivation that has not changed is deduped, so a stopped measurement goes silent rather than repeating", async () => {
    // The fixture carries the production entry's declared bound, so the test
    // measures the dedupe rather than how loaded the host is.
    const handlers: HookHandlerRegistry = { "inject.isolation": { kind: "inject", handler: () => sessionIsolationTropism(repo), timeout_ms: HOOK_HANDLERS["inject.session-isolation"]?.timeout_ms } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({
      schema_version: 1, hook_id: "isolation", version: "1.0.0", kind: "inject", event: "session_start",
      handler_ref: "inject.isolation", why: "test fixture",
    }));
    writeFileSync(join(repo, "packages", "x", "src", "a.ts"), "export const a = 4;\n");
    const bus = new HookBus({ catalog, handlers });
    const at = async (turn: number): Promise<string> => (await bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn })).content;
    expect(await at(0)).toContain("1 uncommitted path(s)");
    expect(await at(1)).toBe("");
    writeFileSync(join(repo, "packages", "x", "src", "a.ts"), "export const a = 5;\n");
    writeFileSync(join(repo, "other.txt"), "more\n");
    expect(await at(1)).toContain("2 uncommitted path(s)");
  });

  it("a handler that throws is dropped by the bus and renders nothing", async () => {
    const handlers: HookHandlerRegistry = { "inject.throws": { kind: "inject", handler: () => { throw new Error("boom"); } } };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({
      schema_version: 1, hook_id: "throws", version: "1.0.0", kind: "inject", event: "session_start",
      handler_ref: "inject.throws", why: "test fixture",
    }));
    const bus = new HookBus({ catalog, handlers });
    expect((await bus.injectForSession("session_start", { session_id: "s-1", campaign_id: "c-1", node_id: "n-1", turn: 0 })).content).toBe("");
  });
});

describe("no shell and no scripts/ dependency", () => {
  it("reads the tree with argv git, not a shell", () => {
    const probe = spawnSync("git", ["-C", repo, "status", "--porcelain=v2", "--branch", "-z"], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(governanceOrientTropism(repo)).not.toBeNull();
  });
});
