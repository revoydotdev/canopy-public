#!/usr/bin/env node
/** Opt-in, hermetic staged native-safety episode runner. */
import { evaluateStagedNativeSafety, stagedNativeSafetyScenarios } from "./staged-native-safety.js";

async function main(): Promise<void> {
  const episodes = await evaluateStagedNativeSafety();
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    evaluator: "staged-native-safety",
    scenarios: stagedNativeSafetyScenarios,
    episodes,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "staged native-safety evaluation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
