/** Deterministic production-function benchmarks for FOI search and disclosure. */
import { performance } from "node:perf_hooks";
import { buildDefaultCatalog } from "./default-catalog.js";
import { paletteView } from "./overlays.js";
import { resultReviewScreen } from "./screens/result-review.js";

export interface FOIInteractionBenchmark {
  readonly search: {
    readonly samples: number;
    readonly p95_ms: number;
    readonly max_ms: number;
    readonly budget_ms: number;
    readonly pass: boolean;
  };
  readonly disclosure: {
    readonly samples: number;
    readonly p95_ms: number;
    readonly max_ms: number;
    readonly budget_ms: number;
    readonly diff_lines: 1000;
    readonly bounded_render_rows: number;
    readonly pass: boolean;
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function resultWorkspace(): Readonly<Record<string, unknown>> {
  const unified = [
    { file_path: "src/large.ts", old_line: null, new_line: null, kind: "header", text: "@@ -1,500 +1,500 @@" },
    ...Array.from({ length: 1000 }, (_, index) => ({
      file_path: "src/large.ts",
      old_line: index % 2 === 0 ? index + 1 : null,
      new_line: index % 2 === 0 ? null : index + 1,
      kind: index % 2 === 0 ? "deletion" : "addition",
      text: `const value_${index} = ${index};`,
    })),
  ];
  return Object.freeze({
    campaign_id: "foi-benchmark",
    node_id: "foi-disclosure",
    review_revision: 1,
    patch_sha256: "deterministic",
    truncated: true,
    view_mode: "unified",
    counts: Object.freeze({ files: 1, additions: 500, deletions: 500 }),
    files: Object.freeze([{ path: "src/large.ts", status: "modified", additions: 500, deletions: 500 }]),
    unified: Object.freeze(unified),
    conflict_preview: Object.freeze({ status: "clean" }),
    relationships: Object.freeze({ provenance: Object.freeze({ capture: "!generated" }), capture: Object.freeze({ declared_write_paths: Object.freeze(["src/large.ts"]), scope_violations: Object.freeze([]) }) }),
  });
}

/** Run bounded samples against the same pure functions the reachable TUI uses. */
export function captureFOIInteractionBenchmark(samples = 100): FOIInteractionBenchmark {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10_000) throw new Error("interaction benchmark samples must be from 1 to 10000");
  const catalog = buildDefaultCatalog();
  const queries = ["interrupt", "result", "session", "review", "help", "no-such-command"];
  const searchDurations: number[] = [];
  const disclosureDurations: number[] = [];
  const workspace = resultWorkspace();
  let boundedRows = 0;
  for (let index = 0; index < samples; index += 1) {
    const searchStarted = performance.now();
    paletteView(catalog, { query: queries[index % queries.length], expanded: true, limit: 200 });
    searchDurations.push(performance.now() - searchStarted);

    const disclosureStarted = performance.now();
    const projected = resultReviewScreen.project(workspace, { width: 100, height: 30 });
    const rendered = resultReviewScreen.render({ projection: projected, width: 100, height: 30, color: false });
    disclosureDurations.push(performance.now() - disclosureStarted);
    boundedRows = Math.max(boundedRows, rendered.length);
    if (rendered.length > 30) throw new Error("result disclosure exceeded its viewport bound");
  }
  const searchP95 = percentile(searchDurations, 0.95);
  const disclosureP95 = percentile(disclosureDurations, 0.95);
  const searchBudget = 50;
  const disclosureBudget = 50;
  return Object.freeze({
    search: Object.freeze({ samples, p95_ms: searchP95, max_ms: Math.max(...searchDurations), budget_ms: searchBudget, pass: searchP95 < searchBudget }),
    disclosure: Object.freeze({ samples, p95_ms: disclosureP95, max_ms: Math.max(...disclosureDurations), budget_ms: disclosureBudget, diff_lines: 1000 as const, bounded_render_rows: boundedRows, pass: disclosureP95 < disclosureBudget }),
  });
}
