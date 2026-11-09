/**
 * verify-kind-coverage.test.ts — every record kind must be structurally
 * validated by verifyIntegrity.
 *
 * WHY THIS EXISTS. `verifyIntegrity` dispatches per record kind through a
 * hand-maintained if/else chain. TypeScript does not require that chain to be
 * exhaustive: a twelfth `AuditRecord` member would type-check perfectly while
 * silently skipping structural validation, so a malformed instance of the new
 * kind would pass an integrity check it should fail. The hash chain would still
 * be verified — only the per-kind payload validation would be missed, which is
 * exactly the part that is invisible until someone looks for it.
 *
 * This is not a speculative failure mode. It has already happened three times
 * in this same file: `phase_message`, `request_user_input` and
 * `user_input_answer` were each added with a new id prefix while `parseTraceId`
 * — another hand-maintained per-kind list — was left behind, producing colliding
 * ids and breaking ADR-019 interviews after the first question. Same shape, same
 * file, different consumer.
 *
 * A compile-time `never` guard was considered and rejected: it needs an
 * `else` branch that is unreachable by construction, which is dead code the
 * coverage floors would then have to tolerate. A source scan costs no runtime
 * code and, unlike a hand-listed union of "kinds we validate", cannot drift —
 * both sides are read from the implementation itself.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8");

/**
 * Kinds declared by the record interfaces, e.g. `kind: "gate_checkpoint";`.
 * `TracePacket` is excluded by construction: it declares `kind?: "trace"`
 * (optional), and it is the fallback the chain handles last rather than a
 * dispatched case.
 */
function declaredKinds(): string[] {
  const found = new Set<string>();
  const pattern = /^\s+kind: "([a-z_]+)";/gm;
  for (let m = pattern.exec(SOURCE); m !== null; m = pattern.exec(SOURCE)) found.add(m[1]);
  return [...found].sort();
}

/** The body of verifyIntegrity, so getters elsewhere that switch on kind are not counted. */
function verifyIntegrityBody(): string {
  const start = SOURCE.indexOf("  verifyIntegrity(): IntegrityCheck {");
  if (start === -1) throw new Error("could not locate verifyIntegrity — the scan must fail loudly, not pass vacuously");
  const end = SOURCE.indexOf("\n  stats(campaignId: string)", start);
  if (end === -1) throw new Error("could not locate the method after verifyIntegrity");
  return SOURCE.slice(start, end);
}

function dispatchedKinds(): string[] {
  const body = verifyIntegrityBody();
  const found = new Set<string>();
  const pattern = /packet\.kind === "([a-z_]+)"/g;
  for (let m = pattern.exec(body); m !== null; m = pattern.exec(body)) found.add(m[1]);
  return [...found].sort();
}

describe("verifyIntegrity per-kind dispatch", () => {
  it("validates every declared record kind", () => {
    const declared = declaredKinds();
    // Guard against a scan that silently matches nothing and passes vacuously.
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(declared).toContain("gate_checkpoint");
    expect(declared).toContain("user_input_answer");

    const missing = declared.filter((kind) => !dispatchedKinds().includes(kind));
    expect(missing, `verifyIntegrity does not validate record kind(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("does not dispatch on a kind that no record declares", () => {
    // The other direction: a branch left behind after a kind is renamed or
    // removed is dead validation that reads as coverage it no longer provides.
    const stale = dispatchedKinds().filter((kind) => !declaredKinds().includes(kind));
    expect(stale, `verifyIntegrity validates kind(s) no record declares: ${stale.join(", ")}`).toEqual([]);
  });

  it("scopes the scan to verifyIntegrity, not the whole file", () => {
    // getGateCheckpoints/getRecoveryDecisions also compare packet.kind. If the
    // slice were wrong, those would be counted as dispatch and the first test
    // would pass without verifyIntegrity handling anything at all.
    const body = verifyIntegrityBody();
    expect(body).toContain("verifyIntegrity(): IntegrityCheck");
    expect(body).not.toContain("getGateCheckpoints(campaignId: string)");
    expect(body.length).toBeLessThan(SOURCE.length / 2);
  });
});
