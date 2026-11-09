import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADR_COUNT_DOCUMENTS, renderGovernanceCounts } from "../render-governance-counts.mjs";
import { deriveRepositoryCounts } from "../../packages/arbor-governance/src/counts/derive.ts";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "governance-render-"));
  roots.push(root);
  for (const path of ADR_COUNT_DOCUMENTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path));
  }
  mkdirSync(join(root, "decisions"), { recursive: true });
  cpSync(join(REPO_ROOT, "decisions/registry.json"), join(root, "decisions/registry.json"));
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("governance count rendering", () => {
  it("is derived, idempotent, and check mode refuses stale prose", () => {
    const root = fixture();
    const path = join(root, ADR_COUNT_DOCUMENTS[0]);
    writeFileSync(path, readFileSync(path, "utf8").replace(/(governance:adr_total -->)\d+ ADRs/, "$11 ADRs"));
    expect(renderGovernanceCounts(root, { check: true })).toMatchObject({ ok: false });
    expect(renderGovernanceCounts(root)).toMatchObject({ ok: false });
    expect(renderGovernanceCounts(root)).toEqual({ ok: true, changed: [] });
    const expected = deriveRepositoryCounts(root).adr_total;
    for (const doc of ADR_COUNT_DOCUMENTS) expect(readFileSync(join(root, doc), "utf8")).toContain(`>${expected} ADRs<`);
  });

  it("absorbs eight allocations with one final render", () => {
    const root = fixture();
    const registryPath = join(root, "decisions/registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    for (let index = 0; index < 8; index += 1) registry.allocations.push({ number: 900 + index, slug: `fixture-${index}`, placeholder_id: `fixture:${index}` });
    writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    const expected = registry.allocations.length;
    renderGovernanceCounts(root);
    for (const doc of ADR_COUNT_DOCUMENTS) expect(readFileSync(join(root, doc), "utf8")).toContain(`>${expected} ADRs<`);
  });

  it("keeps the decision index row count equal to registry allocations", () => {
    const counts = deriveRepositoryCounts(REPO_ROOT);
    const rows = readFileSync(join(REPO_ROOT, "decisions/README.md"), "utf8").split("\n").filter((line) => /^\| \[\d{3}\]\(ADR-\d{3}-/.test(line));
    expect(rows).toHaveLength(counts.adr_total);
  });
});
