/**
 * persistence-containment.test.ts — every campaign-data path `WorktreeManager`
 * constructs must resolve INSIDE the guarded persistence root, never off
 * `<repoRoot>/.arbor`.
 *
 * The expected set is stated from the CONSTRUCTION SITES, by hand, and is
 * deliberately NOT derived from the manager's own resolved fields: a control
 * whose oracle comes from the thing it checks approves any widening by
 * construction — the shape that produced four false greens in this repository.
 * Each construction is asserted separately so a regression in one cannot hide
 * behind the other three.
 *
 * The construction sites, enumerated from source rather than from the register
 * (which cited a package path that does not exist — see the todo-6 evidence):
 *   packages/arbor-campaign-support/src/worktree.ts:319  leasesDir
 *   packages/arbor-campaign-support/src/worktree.ts:320  orphanMarksFile
 *   packages/arbor-campaign-support/src/worktree.ts:321  objectCacheDir
 *   packages/arbor-campaign-support/src/worktree.ts:847  preservedRoot
 *
 * `.git`-rooted governance sinks are a different, deliberate class — see
 * `shared-git-dir-sinks.test.ts`, which asserts they are OUTSIDE the worktree.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WorktreeManager } from "@arbor/campaign-support";
import { resolvePersistenceDir } from "../src/persistence-path.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arbor-containment-")));
  scratch.push(dir);
  return dir;
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("campaign-data paths resolve through the guarded persistence root", () => {
  // Stated independently, one entry per construction site. `read` is a narrow
  // accessor the manager exposes; the manager is not asked to enumerate itself.
  const CASES = [
    { name: "leasesDir (worktree.ts:319)", read: (m: WorktreeManager) => m.leasesPath },
    { name: "orphanMarksFile (worktree.ts:320)", read: (m: WorktreeManager) => m.orphanMarksPath },
    { name: "objectCacheDir (worktree.ts:321)", read: (m: WorktreeManager) => m.objectCachePath },
    { name: "preservedRoot (worktree.ts:847)", read: (m: WorktreeManager) => m.preservedRoot },
  ] as const;

  for (const testCase of CASES) {
    it(`${testCase.name} lands inside a configured persistence root`, () => {
      const repo = makeRepo();
      const persistence = resolvePersistenceDir(repo, ".arbor/campaign");
      const manager = new WorktreeManager({ repoRoot: repo, persistenceDir: persistence });

      expect(isInside(persistence, testCase.read(manager))).toBe(true);
    });

    it(`${testCase.name} lands inside the default persistence root`, () => {
      const repo = makeRepo();
      const manager = new WorktreeManager({ repoRoot: repo });
      const persistence = resolvePersistenceDir(repo);

      expect(isInside(persistence, testCase.read(manager))).toBe(true);
    });

    it(`${testCase.name} follows the configured root, not the repo-root default`, () => {
      // The regression this todo exists for: a custom persistence dir was
      // ignored and campaign data landed in `<repoRoot>/.arbor` regardless.
      const repo = makeRepo();
      const persistence = resolvePersistenceDir(repo, ".arbor/custom");
      const manager = new WorktreeManager({ repoRoot: repo, persistenceDir: persistence });

      expect(testCase.read(manager).startsWith(persistence)).toBe(true);
    });
  }

  it("a manager given NO repoRoot still lands under its own persistence root", () => {
    // Covers the dry-run `new WorktreeManager({}, true)` in `loop.ts`, which
    // resolves `repoRoot` from process.cwd().
    const persistence = resolvePersistenceDir(process.cwd());
    const manager = new WorktreeManager({}, true);
    for (const testCase of CASES) {
      expect(isInside(persistence, testCase.read(manager))).toBe(true);
    }
  });

  it("a persistence dir outside the repository is refused, not silently used", () => {
    const repo = makeRepo();
    expect(() => new WorktreeManager({ repoRoot: repo, persistenceDir: resolve(tmpdir(), "elsewhere-persistence") }))
      .toThrow(/must remain within/);
  });

  it("the async worker's serialized options carry the persistence root", () => {
    // `acquireLeaseAsync` spawns a child that rebuilds every path from these
    // options. It runs only under Bun; under Node (this lane) the child is
    // never spawned, so WITHOUT this assertion an option dropped here — and the
    // escape restored one process boundary away — leaves the suite green.
    // Mutation-verified: deleting `persistenceDir` from `asyncWorkerOptions`
    // turns this red and nothing else does.
    const repo = makeRepo();
    const persistence = resolvePersistenceDir(repo, ".arbor/campaign");
    const manager = new WorktreeManager({ repoRoot: repo, persistenceDir: persistence });

    const options = manager.asyncWorkerPathOptions;
    expect(options.persistenceDir).toBe(persistence);

    // And the child, given exactly these options, resolves the same paths.
    const child = new WorktreeManager(options);
    for (const testCase of CASES) {
      expect(testCase.read(child)).toBe(testCase.read(manager));
    }
  });
});
