/**
 * id-prefix-coverage.test.ts — every minted id prefix must survive a reload.
 *
 * THE DEFECT THIS CLOSES. `parseTraceId` recovers the id counter after
 * `fromJSONL` by matching an id against a hard-coded alternation of prefixes.
 * Three kinds — `phase_`, `userinput_`, `useranswer_` — were minted with
 * prefixes that alternation never listed, so a reloaded ledger under-counted
 * and the next record of that kind reused an id already present.
 *
 * It fired in ordinary use, not just after a crash: `manager.ts` builds a fresh
 * `EvidenceLedger` and reseeds it via `fromJSONL` on EVERY `askForUserInput`
 * call, so the second interview question in a persisted campaign collided and
 * `saveLedger` refused it — permanently, because the manager only advances its
 * ledger on success.
 *
 * Two tests, deliberately different in kind:
 *   1. a behavioural round trip, proving the collision is really gone; and
 *   2. a mechanical scan of audit.ts's own minting sites, so a future record
 *      kind cannot reintroduce the defect by adding a prefix and forgetting the
 *      regex. The scan is what makes this durable rather than a spot fix.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EvidenceLedger } from "../src/index.js";

const SOURCE = readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8");

/** Every prefix this file actually mints from the shared counter. */
function mintedPrefixes(): string[] {
  const found = new Set<string>();
  // Matches e.g. `const id = `userinput_${(++this.nextId).toString(36)}`;`
  const pattern = /`([a-z]+)_\$\{\(\+\+this\.nextId\)/g;
  for (let m = pattern.exec(SOURCE); m !== null; m = pattern.exec(SOURCE)) found.add(m[1]);
  return [...found].sort();
}

/** The alternation `parseTraceId` recognizes. */
function recognizedPrefixes(): string[] {
  const declaration = /const match = \/\^\(\?:([a-z|]+)\)_/.exec(SOURCE);
  if (!declaration) throw new Error("could not locate parseTraceId's prefix alternation — the scan must fail loudly, not silently pass");
  return declaration[1].split("|").sort();
}

describe("ledger id prefixes", () => {
  it("recognizes every prefix the ledger actually mints", () => {
    const minted = mintedPrefixes();
    // Guard against the scan silently matching nothing and passing vacuously.
    expect(minted.length).toBeGreaterThanOrEqual(10);
    expect(minted).toContain("userinput");
    expect(minted).toContain("useranswer");
    expect(minted).toContain("phase");

    const unrecognized = minted.filter((prefix) => !recognizedPrefixes().includes(prefix));
    expect(unrecognized, `parseTraceId does not recognize minted prefix(es): ${unrecognized.join(", ")}`).toEqual([]);
  });

  it("mints a fresh id after a reload for a request_user_input — the second interview question", () => {
    const question = (key: string) => ({
      campaign_id: "c1", node_id: "root", operation_id: `op-${key}`,
      question: `Question ${key}?`,
      options: [{ id: "yes", text: "Yes", is_other: false }],
      authority: "lead" as const, blocking: "blocking" as const,
      requester_role: "taproot", idempotency_key: key, as_of: "2026-08-03T00:00:00.000Z",
    });

    const first = new EvidenceLedger();
    const firstId = first.recordRequestUserInput(question("k1"));

    // Exactly what manager.ts does on every call: a fresh ledger, reseeded.
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());
    const secondId = reloaded.recordRequestUserInput(question("k2"));

    expect(secondId).not.toBe(firstId);
    expect(new Set(reloaded.getRecords().map((record) => record.id)).size).toBe(reloaded.getRecords().length);
  });

  it("mints a fresh id after a reload for a phase_message", () => {
    const message = (key: string) => ({
      campaign_id: "c1", node_id: "root", operation_id: `op-${key}`,
      phase: "commentary" as const, role: "user" as const, content: `content ${key}`,
      content_length_bytes: `content ${key}`.length,
      provenance: { tag: "claimed" as const, claimant: "seed" },
      idempotency_key: key, timestamp: "2026-08-03T00:00:00.000Z",
    });

    const first = new EvidenceLedger();
    const firstId = first.recordPhaseMessage(message("k1"));
    const reloaded = new EvidenceLedger();
    reloaded.fromJSONL(first.toJSONL());

    expect(reloaded.recordPhaseMessage(message("k2"))).not.toBe(firstId);
  });
});
