import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptDecision, allocateDecision, contentId, nextAllocation, newPendingDecision, readRegistry, verifyRegistry } from "../lib/adr-registry.mjs";
import { ADR_COUNT_DOCUMENTS } from "../render-governance-counts.mjs";
import { deriveRepositoryCounts } from "../../packages/arbor-governance/src/counts/derive.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "adr-registry.mjs");
let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(path, text) {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function registry(overrides = {}) {
  write("decisions/registry.json", `${JSON.stringify({ schema_version: 1, next_available: 44, reserved: [45, 86], reserved_reason: { 45: "external", 86: "external" }, allocations: [], ...overrides }, null, 2)}\n`);
}

function pending(slug, title) {
  const revision = git("rev-parse", "HEAD");
  const createdAt = "2026-08-12";
  const id = contentId({ title, createdAt, authoringRevision: revision });
  write(`decisions/ADR-PENDING-${slug}.md`, `# ADR-PENDING: ${title}\n\n**Status:** Proposed\n**Date:** ${createdAt}\n**Authoring Revision:** ${revision}\n**Content ID:** ${id}\n\n## Context\n\nFixture.\n`);
  return id;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adr-registry-"));
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  git("config", "user.email", "registry@test.invalid");
  git("config", "user.name", "Registry Test");
  write("decisions/README.md", "# ADR Index\n\n| # | Title | Status |\n|---|---|---|\n");
  registry();
  write("base.txt", "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

function writeCountDocs() {
  const marker = "doc content\n<!-- governance:adr_total --><!-- /governance:adr_total -->\n";
  for (const path of ADR_COUNT_DOCUMENTS) write(path, marker);
}

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("decision allocation", () => {
  it("strictly increases and never repeats allocations", () => {
    pending("alpha", "Alpha");
    const alpha = allocateDecision({ repo, slug: "alpha", commit: false });
    pending("beta", "Beta");
    const beta = allocateDecision({ repo, slug: "beta", commit: false });
    expect([alpha.number, beta.number]).toEqual([44, 46]);
    expect(beta.next_available).toBe(47);
    expect(new Set(readRegistry(repo).allocations.map((entry) => entry.number)).size).toBe(2);
  });

  it("skips every reserved number and reports the skip", () => {
    const first = nextAllocation({ next_available: 44, reserved: [45, 86], allocations: [] });
    const second = nextAllocation({ next_available: first.next_available, reserved: [45, 86], allocations: [{ number: first.number }] });
    const third = nextAllocation({ next_available: second.next_available, reserved: [45, 86], allocations: [{ number: first.number }, { number: second.number }] });
    expect([first.number, second.number, third.number]).toEqual([44, 46, 47]);
    expect(first.skipped).toEqual([45]);
  });

  it("renames the draft, rewrites its title, and appends the index row", () => {
    const id = pending("alpha", "Alpha Decision");
    const result = allocateDecision({ repo, slug: "alpha", commit: false });
    expect(result.content_id).toBe(id);
    expect(readFileSync(join(repo, "decisions/ADR-044-alpha.md"), "utf8")).toContain("# ADR-044: Alpha Decision");
    expect(readFileSync(join(repo, "decisions/README.md"), "utf8")).toContain("[044](ADR-044-alpha.md) | Alpha Decision | Proposed");
  });

  it("two simultaneous allocators cannot both allocate from one starting state", async () => {
    pending("alpha", "Alpha");
    pending("beta", "Beta");
    const run = (slug) => new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [CLI, "allocate", slug, "--repo", repo, "--no-commit"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (code) => resolvePromise({ code, output }));
    });
    const results = await Promise.all([run("alpha"), run("beta")]);
    expect(results.some((result) => result.code === 0)).toBe(true);
    for (const failed of results.filter((result) => result.code !== 0)) {
      expect(failed.output).toMatch(/locked by another allocator/);
    }
    const allocated = readRegistry(repo).allocations.map((entry) => entry.number);
    expect(new Set(allocated).size).toBe(allocated.length);
    expect([[44], [44, 46]]).toContainEqual(allocated.sort((a, b) => a - b));
  });
});

describe("new — scaffolding a pending draft (X-1, fixes D1)", () => {
  it("writes a pending file allocate accepts end-to-end with zero hand-editing", () => {
    const scaffolded = newPendingDecision({ repo, slug: "gamma", title: "Gamma Decision" });
    expect(scaffolded.ok).toBe(true);
    expect(scaffolded.file).toBe("decisions/ADR-PENDING-gamma.md");
    expect(scaffolded.next_step).toBe("bun scripts/adr-registry.mjs allocate gamma");

    const text = readFileSync(join(repo, scaffolded.file), "utf8");
    expect(text).toContain("# ADR-PENDING: Gamma Decision");
    expect(text).toContain("**Status:** Proposed");
    expect(text).toContain(`**Content ID:** ${scaffolded.content_id}`);
    // Every required section is a real heading, not just emulated from other ADRs.
    expect(text).toMatch(/^## Context$/m);
    expect(text).toMatch(/^## Decision$/m);
    expect(text).toMatch(/^## Consequences$/m);
    expect(text).toMatch(/^## Alternatives \/ Roads not taken$/m);
    expect(text).toMatch(/^## Obligations$/m);
    expect(text).toMatch(/^### O1 — <the durable, checkable claim this obligation upholds>$/m);
    expect(text).toMatch(/proof: symbol= file= roundtrip=/);
    expect(text).toMatch(/top-level EXPORTED symbol/);
    expect(text).toMatch(/bun run proof/);

    const allocated = allocateDecision({ repo, slug: "gamma", commit: false });
    expect(allocated.ok).toBe(true);
    expect(allocated.content_id).toBe(scaffolded.content_id);
  });

  it("refuses to overwrite an existing pending file", () => {
    newPendingDecision({ repo, slug: "gamma", title: "Gamma Decision" });
    expect(() => newPendingDecision({ repo, slug: "gamma", title: "Gamma Again" })).toThrow(/already exists/);
  });

  it("rejects a non-kebab-case slug", () => {
    expect(() => newPendingDecision({ repo, slug: "Gamma_Decision", title: "Gamma" })).toThrow(/kebab-case/);
  });

  it("never touches the registry, index, or git", () => {
    const registrySnapshot = readFileSync(join(repo, "decisions/registry.json"), "utf8");
    const indexSnapshot = readFileSync(join(repo, "decisions/README.md"), "utf8");
    newPendingDecision({ repo, slug: "gamma", title: "Gamma Decision" });
    expect(readFileSync(join(repo, "decisions/registry.json"), "utf8")).toBe(registrySnapshot);
    expect(readFileSync(join(repo, "decisions/README.md"), "utf8")).toBe(indexSnapshot);
    expect(git("status", "--porcelain", "--", "decisions/registry.json", "decisions/README.md")).toBe("");
  });

  it("the CLI's new subcommand emits {ok, file, content_id, next_step} JSON", () => {
    const output = execFileSync(process.execPath, [CLI, "new", "delta", "--title", "Delta Decision", "--repo", repo], { encoding: "utf8" });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ ok: true, file: "decisions/ADR-PENDING-delta.md", next_step: "bun scripts/adr-registry.mjs allocate delta" });
    expect(result.content_id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("allocate — D2 regression: a never-tracked pending file", () => {
  it("succeeds with commit:true when the pending draft was never git-added", () => {
    pending("alpha", "Alpha");
    // Confirm the fixture reproduces D2's precondition: untracked.
    expect(() => git("ls-files", "--error-unmatch", "--", "decisions/ADR-PENDING-alpha.md")).toThrow();

    const result = allocateDecision({ repo, slug: "alpha", commit: true });
    expect(result.ok).toBe(true);

    expect(git("status", "--porcelain")).toBe("");
    const committedFiles = git("show", "--name-only", "--pretty=format:", "HEAD");
    expect(committedFiles).not.toMatch(/ADR-PENDING-alpha/);
    expect(committedFiles).toContain("decisions/ADR-044-alpha.md");
    // The commit cites the record it allocates, so the governed-path
    // commit-msg guard accepts the allocator's own commit.
    expect(git("log", "-1", "--format=%(trailers:key=ADR,valueonly)").trim()).toBe("044");
  });
});

describe("allocate — D3 regression: complete rollback on a post-render failure", () => {
  it("restores every governance count document after a forced git failure, and releases the lock", () => {
    writeCountDocs();
    git("add", ".");
    git("commit", "-q", "-m", "count docs");
    const beforeDocs = new Map(ADR_COUNT_DOCUMENTS.map((path) => [path, readFileSync(join(repo, path), "utf8")]));

    pending("alpha", "Alpha");
    // Force the git step (which runs AFTER renderGovernanceCounts) to fail,
    // using real git: an index.lock makes `git add`/`git commit` fail exactly
    // as they would under any real lock contention — no test-only hook.
    writeFileSync(join(repo, ".git", "index.lock"), "");

    expect(() => allocateDecision({ repo, slug: "alpha", commit: true })).toThrow();

    rmSync(join(repo, ".git", "index.lock"), { force: true });

    for (const path of ADR_COUNT_DOCUMENTS) {
      expect(readFileSync(join(repo, path), "utf8")).toBe(beforeDocs.get(path));
    }
    const status = git("status", "--porcelain");
    for (const path of ADR_COUNT_DOCUMENTS) expect(status).not.toContain(path);
    expect(status).not.toContain("ADR-044-alpha.md");
    expect(existsSync(join(repo, "decisions/ADR-PENDING-alpha.md"))).toBe(true);
    expect(existsSync(join(repo, "decisions/ADR-044-alpha.md"))).toBe(false);
    expect(existsSync(join(repo, ".git", "adr-registry.lock"))).toBe(false);

    // The registry still verifies and re-allocating the same draft now works.
    const retried = allocateDecision({ repo, slug: "alpha", commit: false });
    expect(retried.ok).toBe(true);
  });
});

describe("registry verification", () => {
  it("fails when a cross-namespace citation is not reserved", () => {
    write("decisions/ADR-PENDING-external.md", "# ADR-PENDING: External\n\nDerived from revoy-spec's protocol (ADR-999).\n");
    const report = verifyRegistry(repo);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/999 is absent from registry\.reserved/);
  });

  it("pending ADRs do not inflate the registry-derived count", () => {
    pending("alpha", "Alpha");
    expect(deriveRepositoryCounts(repo).adr_total).toBe(0);
    expect(deriveRepositoryCounts(repo).unmeasured).not.toContain("adr_total");
  });
});

describe("decision acceptance", () => {
  function numberedAdr(number, slug, title, status = "Proposed") {
    write(`decisions/ADR-${number}-${slug}.md`, `# ADR-${number}: ${title}\n\n**Status:** ${status}\n**Date:** 2026-08-12\n\n## Context\n\nFixture.\n`);
    const index = readFileSync(join(repo, "decisions/README.md"), "utf8");
    write("decisions/README.md", `${index}| [${number}](ADR-${number}-${slug}.md) | ${title} | ${status} |\n`);
  }
  function interview(covered, deferred = {}) {
    write("decisions/interviews.jsonl", `${JSON.stringify({ held_at: "2026-08-20", covered, outcomes: {}, deferred_to: deferred })}\n`);
  }

  it("carries a covered decision through to the record and the index row", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    const result = acceptDecision({ repo, number: "ADR-101", commit: false, today: "2026-08-21" });
    expect(result).toMatchObject({ ok: true, id: "ADR-101", from: "Proposed", to: "Accepted", interview_held_at: "2026-08-20" });
    expect(readFileSync(join(repo, "decisions/ADR-101-alpha.md"), "utf8")).toMatch(/^\*\*Status:\*\* Accepted$/m);
    expect(readFileSync(join(repo, "decisions/README.md"), "utf8")).toContain("| [101](ADR-101-alpha.md) | Alpha | Accepted |");
  });

  it("rejects when the interview redlit the record", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    const result = acceptDecision({ repo, number: 101, reject: true, commit: false, today: "2026-08-21" });
    expect(result.to).toBe("Rejected");
    expect(readFileSync(join(repo, "decisions/ADR-101-alpha.md"), "utf8")).toMatch(/^\*\*Status:\*\* Rejected$/m);
  });

  it("retires an Accepted record as Superseded, naming the record that replaces it", () => {
    numberedAdr("101", "alpha", "Alpha", "Accepted");
    numberedAdr("102", "beta", "Beta", "Accepted");
    interview(["ADR-101"]);
    const result = acceptDecision({ repo, number: "ADR-101", supersededBy: "142", commit: false, today: "2026-08-21" });
    expect(result).toMatchObject({ ok: true, id: "ADR-101", from: "Accepted", to: "Superseded", superseded_by: "ADR-142" });
    expect(readFileSync(join(repo, "decisions/ADR-101-alpha.md"), "utf8")).toMatch(/^\*\*Status:\*\* Superseded$/m);
    expect(readFileSync(join(repo, "decisions/README.md"), "utf8")).toContain("| [101](ADR-101-alpha.md) | Alpha | Superseded |");
  });

  it("refuses to supersede a record that was never Accepted", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    expect(() => acceptDecision({ repo, number: "101", supersededBy: "142", commit: false, today: "2026-08-21" }))
      .toThrow(/illegal transition Proposed -> Superseded/);
  });

  it("refuses an ADR no standing interview covers — it executes decisions, never makes them", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-999"]);
    expect(() => acceptDecision({ repo, number: "101", commit: false, today: "2026-08-21" })).toThrow(/no standing interview covers ADR-101/);
    expect(readFileSync(join(repo, "decisions/ADR-101-alpha.md"), "utf8")).toMatch(/^\*\*Status:\*\* Proposed$/m);
  });

  it("refuses a record the interview deferred into the future", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"], { "ADR-101": "2099-01-01" });
    expect(() => acceptDecision({ repo, number: "101", commit: false, today: "2026-08-21" })).toThrow(/deferred to 2099-01-01/);
  });

  it("refuses an illegal transition and leaves both files untouched", () => {
    numberedAdr("101", "alpha", "Alpha", "Rejected");
    interview(["ADR-101"]);
    expect(() => acceptDecision({ repo, number: "101", commit: false, today: "2026-08-21" })).toThrow(/illegal transition Rejected -> Accepted/);
    expect(readFileSync(join(repo, "decisions/README.md"), "utf8")).toContain("| Alpha | Rejected |");
  });

  it("warns followup_required when an accepted record declares zero obligations", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    const result = acceptDecision({ repo, number: "101", commit: false, today: "2026-08-21" });
    expect(result.followup_required).toMatch(/gate:obligations POL-04 will fail/);
  });

  it("carries no followup_required when the record already declares an obligation", () => {
    write("decisions/ADR-102-beta.md", `# ADR-102: Beta\n\n**Status:** Proposed\n**Date:** 2026-08-12\n\n## Context\n\nFixture.\n\n## Obligations\n\n### O1 — Something checkable\n\n<!-- unverifiable: not yet resolvable -->\n`);
    const idx = readFileSync(join(repo, "decisions/README.md"), "utf8");
    write("decisions/README.md", `${idx}| [102](ADR-102-beta.md) | Beta | Proposed |\n`);
    interview(["ADR-102"]);
    const result = acceptDecision({ repo, number: "102", commit: false, today: "2026-08-21" });
    expect(result.followup_required).toBeUndefined();
  });

  it("does not warn on rejection — only an Accepted record can fail gate:obligations", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    const result = acceptDecision({ repo, number: "101", reject: true, commit: false, today: "2026-08-21" });
    expect(result.followup_required).toBeUndefined();
  });

  it("commits status-only: exactly the record and the index row", () => {
    numberedAdr("101", "alpha", "Alpha");
    interview(["ADR-101"]);
    git("add", "decisions");
    git("commit", "-q", "-m", "fixtures");
    acceptDecision({ repo, number: "101", today: "2026-08-21" });
    expect(git("log", "-1", "--format=%s")).toBe("docs(decisions): accept ADR-101");
    expect(git("log", "-1", "--format=%(trailers:key=ADR,valueonly)").trim()).toBe("101");
    const touched = git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
    expect(touched).toEqual(["decisions/ADR-101-alpha.md", "decisions/README.md"]);
    expect(git("show", "HEAD", "--", "decisions/ADR-101-alpha.md")).toContain("-**Status:** Proposed");
  });
});
