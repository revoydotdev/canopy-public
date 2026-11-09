import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateRepositoryRetrievalAblation, type RepositoryRetrievalCohort } from "../src/repository-retrieval-eval.js";

const root = resolve(process.argv[2] ?? process.cwd());
const fixture = resolve(process.argv[3] ?? "packages/arbor-eval/fixtures/repository-retrieval-calibration.json");
const cohort = JSON.parse(readFileSync(fixture, "utf8")) as RepositoryRetrievalCohort;
const result = evaluateRepositoryRetrievalAblation({
  root, cohort,
  // UTF-8 bytes are a conservative provider-neutral upper-bound unit, not a
  // claim about any provider tokenizer.
  count_tokens: (text) => Buffer.byteLength(text),
  guard_policy: { max_r4r_regression: 0.05, max_false_acceptance_increase: 0.01, min_token_reduction_ratio: 0.2 },
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
