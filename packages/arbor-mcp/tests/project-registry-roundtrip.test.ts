import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRuntime } from "../src/cli.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

/**
 * The 6.3 roundtrip for the two project-registry query kinds: a real runtime,
 * a real registry on disk, the canonical query envelope, and the projection
 * the TUI's project-registry screen actually consumes.
 *
 * Why this exists separately from the screen tests. Those render a supplied
 * projection and prove the SCREEN is honest about what it was given. This
 * proves the projection itself is real — that the query kind is routed, that
 * it reads the registry rather than a fixture, and that an entry which cannot
 * discharge is reported as failing rather than quietly omitted. A screen
 * faithfully rendering a projection nothing produces is the exact
 * reachable-but-unexercised shape this repository names Hollow.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A registry holding one entry whose recorded root does not exist any more. */
function registryWithUndischargeableEntry(): { readonly root: string; readonly persistenceDir: string } {
  const root = scratch("project-registry-roundtrip-");
  const persistenceDir = join(root, ".arbor");
  mkdirSync(persistenceDir, { recursive: true });
  writeFileSync(
    join(persistenceDir, "project-registry.json"),
    JSON.stringify({
      schema_version: 1,
      entries: [{
        project_id: "vanished",
        path: join(root, "no-such-project"),
        profile_hash: "0".repeat(64),
        verified_at_revision: "0".repeat(40),
        verified_at: "2026-08-18T00:00:00.000Z",
        // Deliberately far in the future: the entry must fail because the
        // project is GONE, not because the waiver ran out. Otherwise this
        // test would pass for the wrong reason.
        expires: "2099-01-01",
      }],
    }, null, 2),
  );
  return { root, persistenceDir };
}

describe("project registry — runtime roundtrip (6.3)", () => {
  it("routes project.registry.list to a real registry read and reports an entry that cannot discharge", () => {
    const { root } = registryWithUndischargeableEntry();
    const router = new RuntimeCatalogRouter(createCliRuntime(root, ".arbor"));

    const result = router.executeQuery({
      schema_version: 1,
      query_id: "roundtrip-list",
      query: { kind: "project.registry.list" },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const projection = (result as { readonly value: Record<string, unknown> }).value;
    const entries = projection.entries as readonly Record<string, unknown>[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.project_id).toBe("vanished");
    // The point of the screen: a broken entry is visibly broken, not omitted.
    expect(entries[0]?.ok).toBe(false);
    expect((entries[0]?.failures as readonly unknown[]).length).toBeGreaterThan(0);
    // …and the whole projection reports itself unhealthy, so a caller that
    // reads only the top-level flag cannot conclude all is well.
    expect(projection.ok).toBe(false);
    expect(projection.present).toBe(true);
  });

  it("an empty registry roundtrips as a real, valid state rather than an error", () => {
    // A fresh checkout governs zero projects. If that read errored, the screen
    // would have to invent an empty state instead of rendering a true one.
    const root = scratch("project-registry-empty-");
    const router = new RuntimeCatalogRouter(createCliRuntime(root, ".arbor"));

    const result = router.executeQuery({
      schema_version: 1,
      query_id: "roundtrip-empty",
      query: { kind: "project.registry.list" },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const projection = (result as { readonly value: Record<string, unknown> }).value;
    expect(projection.entries).toEqual([]);
  });

  it("routes project.manage to a real reconcile pass over the registry", () => {
    const { root } = registryWithUndischargeableEntry();
    const router = new RuntimeCatalogRouter(createCliRuntime(root, ".arbor"));

    const result = router.executeQuery({
      schema_version: 1,
      query_id: "roundtrip-manage",
      query: { kind: "project.manage" },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const projection = (result as { readonly value: Record<string, unknown> }).value;
    // The reconcile pass must ACCOUNT for the entry it cannot discharge —
    // reporting zero projects while one is registered would be the projection
    // lying by omission, which is what the screen would then faithfully show.
    expect(projection).toHaveProperty("entries");
    const managed = projection.entries as readonly unknown[];
    expect(managed).toHaveLength(1);
    expect(projection.ok).toBe(false);
  });

  it("both kinds are declared supported in the runtime catalog", () => {
    // A routed query that the catalog does not declare is unreachable from
    // every operator surface that enumerates capabilities.
    const router = new RuntimeCatalogRouter(createCliRuntime(scratch("project-registry-cat-"), ".arbor"));
    for (const kind of ["project.registry.list", "project.manage"] as const) {
      const result = router.executeQuery({ schema_version: 1, query_id: `declared-${kind}`, query: { kind } });
      expect(result.ok, `${kind} must route: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});
