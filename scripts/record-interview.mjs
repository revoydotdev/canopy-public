#!/usr/bin/env node
/**
 * scripts/record-interview.mjs — the LOW-LEVEL payload writer over
 * `recordInterviewAnswer` (scripts/lib/discharge-store.mjs). Not the entry
 * point for recording an interview: that is `bun run interview:record`
 * (scripts/interview-record.mjs), which validates the operator's verbatim
 * answers against the question pack they answered and builds the ADR-178
 * witness.
 *
 * This file stays because fixtures and historical replay need to write a
 * payload directly. It adds nothing the writer does not check: an interview
 * held after ADR-178's cutoff (`WITNESS_REQUIRED_AFTER`) is refused unless the
 * payload carries a schema-valid `witness`, and nothing here can produce one —
 * so it cannot be used to record a live interview around the native flow.
 *
 * Usage:
 *   bun scripts/record-interview.mjs <payload.json>
 *   bun scripts/record-interview.mjs -   # read the payload from stdin
 *
 * Payload shape:
 *   {
 *     "heldAt": "2026-08-27",
 *     "answers": [
 *       { "itemId": "vi:09a11e41a63c075b", "itemKind": "vi_triage",
 *         "option": "re-attest",
 *         "outcome": "re-attest with the same verdict; reopened only by the symbol set growing" }
 *     ],
 *     "note": "optional",
 *     "witness": { ...optional; required after WITNESS_REQUIRED_AFTER — see validateWitness }
 *   }
 *
 * `itemKind`/`option` must be declared in scripts/lib/discharge-catalog.mjs —
 * see that module's header for the closed set of options per item kind and
 * why an undeclared one is refused rather than silently treated as having no
 * consequence (ADR-137 Decision §4).
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { recordInterviewAnswer } from "./lib/discharge-store.mjs";

function readPayload(source) {
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  return JSON.parse(raw);
}

export function main(argv = process.argv.slice(2)) {
  const source = argv[0];
  if (!source) {
    console.error("Usage: bun scripts/record-interview.mjs <payload.json>|-");
    console.error("  (low-level writer; to record an interview use `bun run interview:record --pack <pack.json> --answers <answers.json>`)");
    return 1;
  }
  const repo = resolvePath(process.cwd());
  const payload = readPayload(source);
  const { interviewRecord, obligations } = recordInterviewAnswer(repo, payload);
  console.log(`recorded interview held_at=${interviewRecord.held_at}, covered ${interviewRecord.covered.length} item(s)`);
  if (obligations.length) {
    console.log(`queued ${obligations.length} discharge obligation(s):`);
    for (const obligation of obligations) {
      console.log(`  ${obligation.id}  due ${obligation.due}  — ${obligation.mechanism}`);
    }
  } else {
    console.log("no discharge obligations queued (every answered option declared discharge: null)");
  }
  return 0;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
