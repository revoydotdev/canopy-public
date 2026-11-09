/**
 * scripts/tests/tui-catalog-parity-root.test.mjs — ADR-073 follow-up
 * (Roadmap 23 B2) for scripts/tui-catalog-parity.mjs.
 *
 * `--root` already existed on this script before this migration; what was
 * still hardcoded was the DEFAULT `--catalog` path's `packages/` prefix.
 * This migration makes that default read the target root's
 * `arbor.profile.jsonc` `source_roots` (via `profileOrDefaults`, which never
 * throws) instead of the literal string "packages".
 *
 * Per Roadmap 23 §5, "the flag is accepted" is not the property worth
 * proving — a script that accepts --root but keeps reading revoy2's files
 * would report every gate green about files it never opened. So this file
 * proves two things:
 *
 *   1. Parity: revoy2's own verdict is identical whether --root is implicit
 *      or passed explicitly.
 *   2. Real retargeting: a fixture project with its OWN arbor.profile.jsonc
 *      (source_roots: ["src"], not "packages") and its own runtime catalog
 *      under that source root produces a verdict DERIVED FROM the fixture's
 *      catalog (a different supported-entry count than revoy2's real 110),
 *      not from revoy2's packages/arbor-mcp/src/runtime-catalog.ts.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../tui-catalog-parity.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("tui-catalog-parity --root default catalog path — profile-derived (Roadmap 23 B2)", () => {
  it("parity: revoy2's verdict is identical whether --root is implicit or explicit", () => {
    const implicit = run(["--json"]);
    const explicit = run(["--root", REPO_ROOT, "--json"]);
    expect(explicit.code).toBe(implicit.code);
    expect(explicit.report).toEqual(implicit.report);
    // And it is still the real revoy2 catalog, not an accidental empty read.
    expect(implicit.report.supported_catalog_entries).toBe(163);
  });

  it("retargeting: a fixture with source_roots: [\"src\"] is read from ITS OWN catalog, not revoy2's", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-catalog-parity-root-"));
    try {
      writeFileSync(
        join(dir, "arbor.profile.jsonc"),
        JSON.stringify({ schema_version: 1, project_id: "fixture", language: "typescript", source_roots: ["src"] }, null, 2),
      );
      const catalogDir = join(dir, "src", "arbor-mcp", "src");
      mkdirSync(catalogDir, { recursive: true });
      // Two supported entries — deliberately far from revoy2's real 110, so
      // a script that ignored the profile and kept reading revoy2's own
      // packages/arbor-mcp/src/runtime-catalog.ts would report 110 here too.
      writeFileSync(
        join(catalogDir, "runtime-catalog.ts"),
        [
          "export const RUNTIME_CATALOG = [",
          '  { kind: "fixture.query", direction: "query", supported: true },',
          '  { kind: "fixture.command", direction: "command", supported: true },',
          "];",
          "",
        ].join("\n"),
      );

      const dispositionsDir = join(dir, "scripts", "tui-catalog-parity");
      mkdirSync(dispositionsDir, { recursive: true });
      writeFileSync(
        join(dispositionsDir, "dispositions.json"),
        JSON.stringify({
          schema_version: 1,
          entries: [
            { kind: "fixture.query", operator_visible: true, disposition: "live_query", trigger: "Fixture screen: q" },
            { kind: "fixture.command", operator_visible: true, disposition: "authoring_required", reason: "fixture placeholder" },
          ],
        }, null, 2),
      );

      const result = run(["--root", dir, "--json"]);
      expect(result.report.errors).toEqual([]);
      expect(result.report.supported_catalog_entries).toBe(2);
      expect(result.report.disposition_entries).toBe(2);
      // The load-bearing assertion: this is NOT revoy2's own count, proving
      // the default catalog path was resolved against the fixture's
      // profile-declared "src" source root, not a hardcoded "packages".
      expect(result.report.supported_catalog_entries).not.toBe(102);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty directory (no profile) falls back to the default-profile \"packages\" source root and finds nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-catalog-parity-empty-"));
    try {
      const result = run(["--root", dir, "--json"]);
      expect(result.code).toBe(1);
      expect(result.report.errors.some((e) => e.startsWith("cannot read runtime catalog"))).toBe(true);
      expect(result.report.errors.some((e) => e.includes(join(dir, "packages", "arbor-mcp", "src", "runtime-catalog.ts")))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
