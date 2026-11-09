import { describe, expect, it } from "vitest";
import { evaluateTrunkSubmitHookAuthority } from "../trunk-submit-hook-authority.mjs";

const base = { schema_version: 1, id: "tx", hook_token: "secret", owner_pid: 42 };
const evaluate = (journal, stagedPaths, overrides = {}) => evaluateTrunkSubmitHookAuthority({
  journal, stagedPaths, id: "tx", token: "secret", lockExists: true, ...overrides,
});

describe("trunk-submit pre-commit authority", () => {
  it("authorizes source-only and evidence-only transaction phases", () => {
    expect(evaluate({ ...base, phase: "started" }, ["scripts/trunk-submit.mjs"])).toMatchObject({ ok: true, phase: "source" });
    expect(evaluate({ ...base, phase: "evidence_staged" }, [".claim-ledger/manifest.json", ".visual-intelligence/manifest.json"])).toMatchObject({ ok: true, phase: "evidence" });
  });

  it("fails closed without exact lock, token, phase, and staged-path shape", () => {
    expect(evaluate({ ...base, phase: "started" }, [".claim-ledger/manifest.json"])).toMatchObject({ ok: false });
    expect(evaluate({ ...base, phase: "evidence_staged" }, ["scripts/source.ts", ".claim-ledger/manifest.json"])).toMatchObject({ ok: false });
    expect(evaluate({ ...base, phase: "evidence_staged" }, [".visual-intelligence/manifest.json"])).toMatchObject({ ok: false });
    expect(evaluate({ ...base, phase: "started" }, ["scripts/source.ts"], { lockExists: false })).toMatchObject({ ok: false });
    expect(evaluate({ ...base, phase: "started" }, ["scripts/source.ts"], { token: "wrong" })).toMatchObject({ ok: false });
  });
});
