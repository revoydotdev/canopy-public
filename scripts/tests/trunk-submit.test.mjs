import { describe, expect, it } from "vitest";
import { EVIDENCE_PATH_PREFIXES, TrunkSubmitError, evidenceRefreshIsComplete, parseTrunkSubmitArgs } from "../trunk-submit.mjs";

const completeReport = {
  ok: true,
  error: null,
  scope: "all",
  graph_precheck: { ran: true, stale: true, action: "refreshed" },
  suite_check: { ran: false, green: null },
  stores: [
    { name: "vi-observed", action: "refreshed" },
    { name: "claim-ledger", action: "refreshed" },
    { name: "completion-depth", action: "refreshed" },
    { name: "determinism-baseline", action: "skipped" },
  ],
};

describe("trunk submit transaction contract", () => {
  it("requires a message for a new transaction and derives all resume inputs from its journal", () => {
    expect(parseTrunkSubmitArgs(["--message", "seal current HEAD"])).toMatchObject({ message: "seal current HEAD", includes: [], remote: null });
    expect(parseTrunkSubmitArgs(["--resume", "123e4567-e89b-12d3-a456-426614174000"])).toMatchObject({ resume: "123e4567-e89b-12d3-a456-426614174000", message: null });
    expect(() => parseTrunkSubmitArgs(["--resume", "123e4567-e89b-12d3-a456-426614174000", "--message", "transport fix"])).toThrow("continues the original transaction");
    expect(() => parseTrunkSubmitArgs(["--resume", "123e4567-e89b-12d3-a456-426614174000", "--include", "scripts/trunk-submit.mjs"])).toThrow("continues the original transaction");
  });

  it("requires explicit, repository-contained source includes", () => {
    expect(parseTrunkSubmitArgs(["--message", "source", "--include", "packages/arbor-mcp", "--include", "packages/arbor-mcp"])).toMatchObject({ includes: ["packages/arbor-mcp"] });
    expect(() => parseTrunkSubmitArgs(["--message", "source", "--include", "../outside"])).toThrow(TrunkSubmitError);
    expect(() => parseTrunkSubmitArgs(["--message", "source", "--include", ".claim-ledger"])).toThrow("generated evidence");
    expect(() => parseTrunkSubmitArgs(["--include", "scripts"])).toThrow("Usage: bun run trunk:submit");
  });

  it("accepts automatic evidence closure only when determinism remains manual", () => {
    expect(evidenceRefreshIsComplete(completeReport)).toEqual({ ok: true });
    expect(evidenceRefreshIsComplete({ ...completeReport, suite_check: { ran: true, green: true } })).toMatchObject({ ok: false });
    expect(evidenceRefreshIsComplete({ ...completeReport, stores: completeReport.stores.map((store) => store.name === "determinism-baseline" ? { ...store, action: "refreshed" } : store) })).toMatchObject({ ok: false });
    expect(evidenceRefreshIsComplete({ ...completeReport, stores: completeReport.stores.map((store) => store.name === "determinism-baseline" ? { ...store, action: "refused" } : store) })).toMatchObject({ ok: false });
    expect(evidenceRefreshIsComplete({ ...completeReport, scope: "auto" })).toMatchObject({ ok: false });
  });

  it("keeps the generated-path allowlist limited to committed evidence roots", () => {
    expect(EVIDENCE_PATH_PREFIXES).toEqual([
      ".visual-intelligence/",
      ".claim-ledger/",
      ".completion-depth/",
      ".determinism-baseline/",
    ]);
  });
});
