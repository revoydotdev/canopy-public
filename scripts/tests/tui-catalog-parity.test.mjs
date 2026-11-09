import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRuntimeCatalog, run, validateParity } from "../tui-catalog-parity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `parseRuntimeCatalog` now parses real TypeScript syntax (see
 * scripts/lib/tui-catalog-parity/catalog-parser.mjs) rather than scanning
 * bare lines, so a fixture entry must sit inside an actual
 * `RUNTIME_CATALOG` array-literal declaration instead of standing alone.
 */
function catalogSource(entryLiteral) {
  return `export const RUNTIME_CATALOG = [\n  ${entryLiteral}\n];\n`;
}

describe("TUI catalog parity gate", () => {
  it("covers every supported runtime catalog entry with an explicit disposition", () => {
    const result = run(["--root", ROOT, "--json"]);
    expect(result.code).toBe(0);
    expect(result.report.supported_catalog_entries).toBe(163);
    expect(result.report.disposition_entries).toBe(163);
    expect(result.report.errors).toEqual([]);
  });

  it("fails closed when a newly supported catalog kind lacks a disposition", () => {
    const catalog = parseRuntimeCatalog(catalogSource('{ kind: "task.inspect", direction: "query", capability: "task.read", idempotency: "not_applicable", supported: true },'));
    expect(validateParity(catalog, { entries: [] }, ROOT)).toContain("supported query task.inspect has no TUI disposition");
  });

  it("requires a live control to retain both a trigger and executable e2e evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-catalog-parity-"));
    try {
      writeFileSync(join(dir, "control.test.ts"), 'it("dispatches command", () => {});\n', "utf8");
      const catalog = parseRuntimeCatalog(catalogSource('{ kind: "task.retry", direction: "command", capability: "task.retry", idempotency: "required", supported: true },'));
      const missingTrigger = validateParity(catalog, {
        entries: [{ kind: "task.retry", operator_visible: true, disposition: "live_control", e2e: { file: "control.test.ts", title: "dispatches command" } }],
      }, dir);
      expect(missingTrigger).toContain("task.retry live_control requires an operator trigger");

      const staleEvidence = validateParity(catalog, {
        entries: [{ kind: "task.retry", operator_visible: true, disposition: "live_control", trigger: "Tasks: r", e2e: { file: "control.test.ts", title: "renamed test" } }],
      }, dir);
      expect(staleEvidence[0]).toContain("e2e title is not an executable it() case");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
