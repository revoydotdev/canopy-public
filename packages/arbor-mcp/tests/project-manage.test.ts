/**
 * packages/arbor-mcp/tests/project-manage.test.ts — Roadmap 23 W6: the
 * multi-project management surface. Proves the six requirements against
 * real, git-backed, fully-enrolled fixture projects driven through the real
 * gate scripts (no mocked gate output) — matching this repo's standing
 * convention (`project-conform-root.test.mjs`, `project-registry.test.ts`)
 * that a mocked filesystem/subprocess cannot prove a gate battery is wired
 * to reality.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { enrollProject } from "../src/project-lifecycle.js";
import { registerProject } from "../src/project-registry.js";
import { classifyGateCatalog, manageProjects } from "../src/project-manage.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A real, freshly-scaffolded, git-backed project that passes project-conform,
 * anti-stub, lockfile, and tui-catalog-parity — not just conformance.
 * `enrollProject` alone only guarantees project-conform (Roadmap 23 W4); the
 * other three need a minimal-but-real bun.lock, runtime catalog, and
 * dispositions document, added here exactly as a real project would have
 * them. It still legitimately fails `typecheck-tests` (no installed
 * `node_modules/.bin/tsc`) and `vi-reproducible` (no `.visual-intelligence/`
 * graph) — real infrastructure this minimal fixture does not carry, not a
 * defect in the module under test. See the tests below for how that shared,
 * expected baseline is distinguished from a project-specific failure.
 */
function buildHealthyFixture(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `project-manage-healthy-${id}-`));
  enrollProject(dir, { mode: "new" });
  const scaffoldedName = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name;
  writeFileSync(join(dir, "bun.lock"), JSON.stringify({ workspaces: { "": { name: scaffoldedName } } }, null, 2));
  mkdirSync(join(dir, "src", "arbor-mcp", "src"), { recursive: true });
  writeFileSync(join(dir, "src", "arbor-mcp", "src", "runtime-catalog.ts"), '  { kind: "noop", direction: "query", supported: false },\n');
  mkdirSync(join(dir, "scripts", "tui-catalog-parity"), { recursive: true });
  writeFileSync(join(dir, "scripts", "tui-catalog-parity", "dispositions.json"), JSON.stringify({ entries: [] }, null, 2));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial scaffold"]);
  return dir;
}

/** The same healthy fixture, plus one real anti-stub Rule 3 violation (a
 * TODO comment standing in for a function body) — everything else about the
 * project, including its own conformance, stays passing. */
function buildAntiStubViolationFixture(id: string): string {
  const dir = buildHealthyFixture(id);
  mkdirSync(join(dir, "src", "widget", "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "widget", "src", "index.ts"),
    "export function doThing(): void {\n  // TODO: implement this\n  return;\n}\n",
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add stub"]);
  return dir;
}

function mkPersistenceDir(): string {
  return mkdtempSync(join(tmpdir(), "project-manage-persistence-"));
}

describe("requirement 1 — gate discovery is not a hardcoded list", () => {
  it("classifies the four Roadmap 23 W6 gates as retargetable, by reading each script's own --root parsing — not a hardcoded list", () => {
    const classified = classifyGateCatalog();
    const retargetable = new Set(classified.filter((c) => c.retargetable).map((c) => c.gate_id));
    // The four gates Roadmap 23 W6 names by hand — landed, stable code this
    // task does not touch, so asserted as an exact floor.
    for (const id of ["project-conform", "lockfile", "tui-catalog-parity"]) {
      expect(retargetable.has(id), `expected ${id} to be discovered retargetable`).toBe(true);
    }
    // anti-stub surfaces under the qualified npm alias because dedup prefers
    // it over the bare, permanently-exit-0 variant (see enumerateGateCatalog).
    expect(retargetable.has("anti-stub:blocking")).toBe(true);
    // Discovery is real, not a lookup table: it independently finds ANY
    // script whose own argv parsing resolves --root, which is why it also
    // catches `vi-refresh.mjs` (`gate:vi-reproducible`) — a gate Roadmap 23
    // W6's task text does not name — without a separate hardcoded entry.
    // Reproduced here by recomputing the same static signal directly against
    // the gate catalog's own source files, independently of the module under
    // test's internal regex, so this assertion cannot pass merely because
    // the implementation is self-consistent.
    for (const c of classified) {
      const source = readFileSync(c.script_path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const looksRetargetable = /resolveRootArg\(\s*process\.argv|argumentValue\(\s*args\s*,\s*["'`]--root["'`]\s*\)/.test(source);
      if (c.gate_id === "project-registry") continue; // deliberately excluded despite matching — see reason.
      expect(c.retargetable, `${c.gate_id}: classification disagreed with an independent re-scan of ${c.script_path}`).toBe(looksRetargetable);
    }
    // A large, real, non-retargetable gate is present and correctly classified.
    const docsTruth = classified.find((c) => c.gate_id === "docs-truth");
    expect(docsTruth?.retargetable).toBe(false);
    // The registry gate itself is discovered (it DOES parse --root) but is
    // explicitly, visibly excluded rather than silently vanishing.
    const registryGate = classified.find((c) => c.gate_id === "project-registry");
    expect(registryGate?.retargetable).toBe(false);
    expect(registryGate?.reason).toMatch(/excluded/i);
  });
});

describe("requirement 6 — empty registry", () => {
  it("succeeds, reporting zero governed projects", () => {
    const report = manageProjects(mkPersistenceDir());
    expect(report.ok).toBe(true);
    expect(report.entry_count).toBe(0);
    expect(report.entries).toEqual([]);
  });
});

describe("requirement 2 & 3 — per-project status, and not-applicable is never a pass", () => {
  it("two registered projects, one healthy and one failing anti-stub: output identifies exactly which project and which gate", () => {
    const persistenceDir = mkPersistenceDir();
    const healthy = buildHealthyFixture("h1");
    const broken = buildAntiStubViolationFixture("b1");
    try {
      expect(registerProject(persistenceDir, healthy, "healthy-project").registered).toBe(true);
      expect(registerProject(persistenceDir, broken, "broken-project").registered).toBe(true);

      const report = manageProjects(persistenceDir);
      expect(report.ok).toBe(false);
      expect(report.entry_count).toBe(2);

      const healthyEntry = report.entries.find((e) => e.project_id === "healthy-project")!;
      const brokenEntry = report.entries.find((e) => e.project_id === "broken-project")!;

      // Neither fixture carries an installed toolchain (`node_modules/.bin/tsc`)
      // or a `.visual-intelligence/` graph, so infra-gap gates this module's
      // honest discovery found beyond the four Roadmap 23 W6 names by hand
      // (`typecheck-tests`, `vi-reproducible`) legitimately fail on BOTH —
      // not hardcoded here, since which other gates a sibling repo state
      // exposes as retargetable can change independently of this test.
      // What must hold regardless is the DIFFERENCE: `anti-stub:blocking`
      // fails on the broken project ONLY, and the report attributes it
      // there and nowhere else.
      const healthyFails = healthyEntry.gates.filter((g) => g.status === "fail").map((g) => g.gate_id).sort();
      const failingGates = brokenEntry.gates.filter((g) => g.status === "fail");
      const brokenFails = failingGates.map((g) => g.gate_id).sort();
      expect(healthyFails).not.toContain("anti-stub:blocking");
      expect(brokenFails).toEqual([...healthyFails, "anti-stub:blocking"].sort());
      expect(failingGates.find((g) => g.gate_id === "anti-stub:blocking")!.detail).toMatch(/doThing|rule3|TODO/i);
      expect(brokenEntry.ok).toBe(false);

      // Not-applicable gates are reported for BOTH projects, never as "pass".
      for (const entry of [healthyEntry, brokenEntry]) {
        const na = entry.gates.filter((g) => g.status === "not_applicable");
        expect(na.length).toBeGreaterThan(0);
        expect(na.every((g) => g.status !== "pass")).toBe(true);
        expect(na.some((g) => g.gate_id === "docs-truth")).toBe(true);
      }
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
      rmSync(healthy, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("requirement 4 — a failed-discharge entry's gates are never reported passing", () => {
  it("an expired entry is reported failed and its gates are not_run_discharge_failed, not pass", () => {
    const persistenceDir = mkPersistenceDir();
    const dir = buildHealthyFixture("expired1");
    try {
      const outcome = registerProject(persistenceDir, dir, "expiring-project", { now: "2020-01-01T00:00:00.000Z", ttlDays: 1 });
      expect(outcome.registered).toBe(true);

      const report = manageProjects(persistenceDir);
      expect(report.ok).toBe(false);
      const entry = report.entries[0]!;
      expect(entry.discharge_ok).toBe(false);
      expect(entry.discharge_failures.some((f) => f.code === "expired")).toBe(true);
      expect(entry.gates.every((g) => g.status === "not_run_discharge_failed")).toBe(true);
      expect(entry.gates.some((g) => g.status === "pass")).toBe(false);
      expect(entry.ok).toBe(false);
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a drifted profile_hash is reported failed and its gates are not reported passing", () => {
    const persistenceDir = mkPersistenceDir();
    const dir = buildHealthyFixture("drift1");
    try {
      expect(registerProject(persistenceDir, dir, "drifted-project").registered).toBe(true);
      const profilePath = join(dir, "arbor.profile.jsonc");
      writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")}\n// drift\n`);

      const report = manageProjects(persistenceDir);
      const entry = report.entries[0]!;
      expect(entry.discharge_ok).toBe(false);
      expect(entry.discharge_failures.some((f) => f.code === "profile_drifted")).toBe(true);
      expect(entry.gates.every((g) => g.status !== "pass")).toBe(true);
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreachable path is reported failed and its gates are not reported passing", () => {
    const persistenceDir = mkPersistenceDir();
    const dir = buildHealthyFixture("gone1");
    registerProject(persistenceDir, dir, "vanished-project");
    rmSync(dir, { recursive: true, force: true });
    try {
      const report = manageProjects(persistenceDir);
      const entry = report.entries[0]!;
      expect(entry.discharge_ok).toBe(false);
      expect(entry.discharge_failures.some((f) => f.code === "path_unreachable")).toBe(true);
      expect(entry.gates.every((g) => g.status !== "pass")).toBe(true);
    } finally {
      rmSync(persistenceDir, { recursive: true, force: true });
    }
  });
});

describe("operator surface — arbor project manage", () => {
  function output(): { stream: PassThrough; text: () => string } {
    const stream = new PassThrough();
    let captured = "";
    stream.on("data", (chunk) => { captured += chunk.toString(); });
    return { stream, text: () => captured };
  }

  it("VIOLATION with a scannable per-project breakdown that attributes the extra failure to the right project", async () => {
    const governingCwd = mkPersistenceGoverningDir();
    const healthy = buildHealthyFixture("cli-h1");
    const broken = buildAntiStubViolationFixture("cli-b1");
    try {
      expect(await main(["project", "enroll", healthy], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);
      expect(await main(["project", "enroll", broken], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      })).toBe(EXIT_CODES.SUCCESS);

      const jsonOut = output();
      const jsonCode = await main(["project", "manage", "--json"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: jsonOut.stream, stderr: new PassThrough(),
      });
      expect(jsonCode).toBe(EXIT_CODES.VIOLATION);
      const parsed = JSON.parse(jsonOut.text());
      expect(parsed.ok).toBe(false);
      const cliHealthy = parsed.entries.find((e: { path: string }) => e.path === healthy);
      const cliBroken = parsed.entries.find((e: { path: string }) => e.path === broken);
      const healthyProjectId = cliHealthy.project_id as string;
      const brokenProjectId = cliBroken.project_id as string;
      const cliHealthyFails = cliHealthy.gates.filter((g: { status: string }) => g.status === "fail").map((g: { gate_id: string }) => g.gate_id).sort();
      const cliBrokenFails = cliBroken.gates.filter((g: { status: string }) => g.status === "fail").map((g: { gate_id: string }) => g.gate_id).sort();
      expect(cliHealthyFails).not.toContain("anti-stub:blocking");
      expect(cliBrokenFails).toEqual([...cliHealthyFails, "anti-stub:blocking"].sort());

      const humanOut = output();
      const code = await main(["project", "manage"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: humanOut.stream, stderr: new PassThrough(),
      });
      expect(code).toBe(EXIT_CODES.VIOLATION);
      const text = humanOut.text();
      expect(text).toMatch(new RegExp(`FAIL.*${healthyProjectId}`));
      expect(text).toMatch(new RegExp(`FAIL.*${brokenProjectId}`));
      expect(text).toContain("anti-stub:blocking");
      // The differentiating gate appears under the broken project's block,
      // not the healthy one's — proving attribution, not just presence.
      const brokenBlock = text.slice(text.indexOf(brokenProjectId));
      const healthyBlock = text.slice(text.indexOf(healthyProjectId), text.indexOf(brokenProjectId));
      expect(brokenBlock).toMatch(/FAIL\]\s+anti-stub:blocking/);
      expect(healthyBlock).not.toMatch(/FAIL\]\s+anti-stub:blocking/);
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
      rmSync(healthy, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("rejects an unknown project manage flag as a usage error", async () => {
    const governingCwd = mkPersistenceGoverningDir();
    try {
      const err = output();
      const code = await main(["project", "manage", "--wat"], {
        cwd: governingCwd, stdin: new PassThrough(), stdout: new PassThrough(), stderr: err.stream,
      });
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(err.text()).toContain("Usage: arbor project");
    } finally {
      rmSync(governingCwd, { recursive: true, force: true });
    }
  });
});

function mkPersistenceGoverningDir(): string {
  return mkdtempSync(join(tmpdir(), "project-manage-cli-governing-"));
}
