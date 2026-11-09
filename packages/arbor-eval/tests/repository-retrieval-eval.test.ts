import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateRepositoryRetrieval, evaluateRepositoryRetrievalAblation, type RepositoryRetrievalCohort } from "../src/repository-retrieval-eval.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "arbor-retrieval-eval-")); roots.push(root); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "alpha.ts"), 'import { Beta } from "./beta.js";\nexport function alphaFeature(): Beta { return new Beta(); }\n');
  writeFileSync(join(root, "src", "beta.ts"), "export class Beta {}\n");
  for (let index = 0; index < 30; index++) writeFileSync(join(root, "src", `unrelated-${index}.ts`), `export const unrelated${index} = ${index};\n`);
  return root;
}

function cohort(scope: "calibration" | "held_out", count = 100): RepositoryRetrievalCohort {
  return {
    cohort_id: `retrieval-${scope}-v1`, scope,
    provenance: scope === "held_out"
      ? { tag: "verified", cmd: "verify sealed retrieval cohort", exit: 0, stdout_hash: "sha256:sealed-retrieval-cohort" }
      : { tag: "generated", generator: "test-calibration", input_hash: "calibration" },
    tasks: Array.from({ length: count }, (_, index) => ({ task_id: `task-${index}`, prompt: "repair alpha feature", required_path_groups: [["src/alpha.ts"]] })),
  };
}

const policy = { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.05, min_token_reduction_ratio: 0.2 };

describe("repository retrieval economization evaluation", () => {
  it("measures a bounded graph seed against full metadata but refuses calibration promotion", () => {
    const result = evaluateRepositoryRetrieval({ root: repository(), cohort: cohort("calibration"), count_tokens: (text) => Buffer.byteLength(text), guard_policy: policy });
    expect(result).toMatchObject({ schema: "arbor.repository-retrieval-eval/v1", files_indexed: 32, exact_task_recall: 1, guard: { decision: "unresolved" } });
    expect(result.mean_projection_reduction).toBeGreaterThan(0.2);
    expect(result.task_results.every((task) => task.candidate_paths.includes("src/alpha.ts"))).toBe(true);
  });

  it("permits a sealed verified held-out cohort to reach the accuracy gate", () => {
    const result = evaluateRepositoryRetrieval({ root: repository(), cohort: cohort("held_out"), count_tokens: (text) => Buffer.byteLength(text), guard_policy: policy });
    expect(result.guard).toMatchObject({ decision: "eligible", paired_tasks: 100 });
  });

  it("fails closed on unknown labels and invalid token measurement", () => {
    const root = repository();
    const invalid = { ...cohort("calibration", 1), tasks: [{ task_id: "missing", prompt: "alpha", required_path_groups: [["src/missing.ts"]] }] };
    expect(() => evaluateRepositoryRetrieval({ root, cohort: invalid, count_tokens: (text) => text.length, guard_policy: policy })).toThrow("unknown paths");
    expect(() => evaluateRepositoryRetrieval({ root, cohort: cohort("calibration", 1), count_tokens: () => -1, guard_policy: policy })).toThrow("token counter");
  });

  it("attributes recall recovery to delta and verified-memory signals", () => {
    const base = cohort("calibration", 2);
    const signalled: RepositoryRetrievalCohort = { ...base, tasks: [
      { task_id: "delta", prompt: "retry generic failure", required_path_groups: [["src/alpha.ts"]], signals: { changed_paths: ["src/alpha.ts"] } },
      { task_id: "memory", prompt: "investigate generic failure", required_path_groups: [["src/beta.ts"]], signals: { memory: [{ terms: ["Beta"], evidence_pointer: "audit:test:1", provenance: { tag: "verified", cmd: "test", exit: 0, stdout_hash: "sha256:test" } }] } },
    ] };
    const result = evaluateRepositoryRetrievalAblation({ root: repository(), cohort: signalled, count_tokens: (text) => Buffer.byteLength(text), guard_policy: policy });
    expect(result.arms.map(({ arm, evaluation }) => [arm, evaluation.exact_task_recall])).toEqual([
      ["lexical", 0], ["lexical+delta", 0.5], ["lexical+delta+verified_memory", 1], ["lexical+delta+verified_memory+structure", 1],
    ]);
  });
});
