import { describe, expect, it } from "vitest";
import { formatFinalization, runFinalization } from "../finalize.mjs";

const HEAD = "a".repeat(40);
const clean = () => ({ head: HEAD, clean: true, source_paths: [], evidence_paths: [] });
const fresh = () => ({ ok: true, stores: [{ name: "claim-ledger", state: "ok" }] });
const stale = () => ({
  ok: false,
  stores: [
    { name: "vi-observed", state: "fail" },
    { name: "claim-ledger", state: "fail" },
  ],
});

describe("local finalization coordinator", () => {
  it("stops at source admission before freshness or verification", async () => {
    let freshnessCalls = 0;
    let verifyCalls = 0;
    const plan = await runFinalization({
      inspect: () => ({ head: HEAD, clean: false, source_paths: ["packages/example.ts"], evidence_paths: [] }),
      freshness: () => { freshnessCalls += 1; return fresh(); },
      verify: async () => { verifyCalls += 1; return { ok: true, status: "passed", gates: [] }; },
    });
    expect(plan.status).toBe("source_commit_required");
    expect(plan.current_phase).toBe("source_candidate");
    expect(freshnessCalls).toBe(0);
    expect(verifyCalls).toBe(0);
  });

  it("turns stale evidence into a cheap typed admission failure without running the battery", async () => {
    let verifyCalls = 0;
    const plan = await runFinalization({
      inspect: clean,
      freshness: stale,
      verify: async () => { verifyCalls += 1; return { ok: true, status: "passed", gates: [] }; },
    });
    expect(plan.status).toBe("evidence_refresh_required");
    expect(plan.current_phase).toBe("evidence_admission");
    expect(plan.phases.find((phase) => phase.id === "evidence_admission")?.evidence.stale_stores).toEqual(["claim-ledger", "vi-observed"]);
    expect(plan.remedy).toContain("bun run finalize -- --refresh");
    expect(verifyCalls).toBe(0);
  });

  it("uses atomic refresh and stops at the operator commit barrier", async () => {
    let inspectCalls = 0;
    let verifyCalls = 0;
    const plan = await runFinalization({
      refresh: true,
      inspect: () => {
        inspectCalls += 1;
        return inspectCalls === 1
          ? clean()
          : { head: HEAD, clean: false, source_paths: [], evidence_paths: [".claim-ledger/manifest.json"] };
      },
      freshness: stale,
      refreshEvidence: async () => ({ ok: true, published: true, transaction_id: "tx-1" }),
      verify: async () => { verifyCalls += 1; return { ok: true, status: "passed", gates: [] }; },
    });
    expect(plan.status).toBe("evidence_commit_required");
    expect(plan.current_phase).toBe("evidence_commit");
    expect(plan.phases.find((phase) => phase.id === "evidence_commit")?.evidence).toMatchObject({ transaction_id: "tx-1", published: true });
    expect(verifyCalls).toBe(0);
  });

  it("continues in the same invocation when a refresh is a clean no-op", async () => {
    let freshnessCalls = 0;
    let verifyCalls = 0;
    const plan = await runFinalization({
      refresh: true,
      inspect: clean,
      freshness: () => (++freshnessCalls === 1 ? stale() : fresh()),
      refreshEvidence: async () => ({ ok: true, published: false, transaction_id: "tx-noop" }),
      verify: async () => { verifyCalls += 1; return { ok: true, status: "passed", gates: [] }; },
    });
    expect(plan).toMatchObject({ ok: true, status: "verified", current_phase: "immutable_prepush" });
    expect(verifyCalls).toBe(1);
    expect(freshnessCalls).toBe(2);
  });

  it("runs the immutable battery exactly once only after clean, fresh admission", async () => {
    let verifyCalls = 0;
    const battery = { ok: true, status: "passed", candidate_oid: HEAD, gates: [] };
    const plan = await runFinalization({
      inspect: clean,
      freshness: fresh,
      verify: async ({ candidate }) => { verifyCalls += 1; expect(candidate).toBe(HEAD); return battery; },
    });
    expect(plan.status).toBe("verified");
    expect(plan.ok).toBe(true);
    expect(plan.battery).toBe(battery);
    expect(plan.phases.every((phase) => phase.status === "passed")).toBe(true);
    expect(verifyCalls).toBe(1);
  });

  it("emits the same five ordered phases and one exact next action", async () => {
    const plan = await runFinalization({ inspect: clean, freshness: stale, planOnly: true });
    const text = formatFinalization(plan).join("\n");
    expect(plan.phases.map((phase) => phase.id)).toEqual([
      "source_candidate",
      "evidence_admission",
      "evidence_closure",
      "evidence_commit",
      "immutable_prepush",
    ]);
    expect(text).toContain(">> 2. evidence_admission");
    expect(text.match(/^Next:/gm)).toHaveLength(1);
  });
});
