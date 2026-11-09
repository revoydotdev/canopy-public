import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLIGHT_CONTROL_EVENT_KINDS, FLIGHT_CONTROL_PUBLICATION_KINDS, runFlightControlStress } from "../src/flight-control-stress.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deterministic two-repository flight-control stress", () => {
  it("proves bidirectional A2A, collision refusal, cancellation, restart, and final integrity", async () => {
    const parent = mkdtempSync(join(tmpdir(), "revoy2-flight-control-test-"));
    roots.push(parent);
    const workRoot = join(parent, "work");
    const evidenceDir = join(parent, "evidence");
    mkdirSync(evidenceDir);
    const evidenceFile = join(evidenceDir, "flight-control.json");

    const report = await runFlightControlStress({
      work_root: workRoot,
      keep_artifacts: true,
      evidence_file: evidenceFile,
      scenario_id: "focused-flight-control-test",
    });

    expect(report.ok, report.gaps.join("\n")).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "orchestrator-child-bidirectional", ok: true }),
      expect.objectContaining({ id: "concurrent-real-bun-sessions", ok: true }),
      expect.objectContaining({ id: "concurrent-session-ipc-query-reply", ok: true }),
      expect.objectContaining({ id: "sibling-query-reply", ok: true }),
      expect.objectContaining({ id: "authenticated-cross-repository-bidirectional", ok: true }),
      expect.objectContaining({ id: "different-repository-independence", ok: true }),
      expect.objectContaining({ id: "same-repository-lease-collision", ok: true }),
      expect.objectContaining({ id: "thread-cas-collision", ok: true }),
      expect.objectContaining({ id: "same-persistence-writer-lock-refusal", ok: true }),
      expect.objectContaining({ id: "stale-dead-pid-writer-lock-reclaim", ok: true }),
      expect.objectContaining({ id: "protected-path-scope-refusal", ok: true }),
      expect.objectContaining({ id: "remote-attacks-no-mutation", ok: true }),
      expect.objectContaining({ id: "cancellation-releases-lease", ok: true }),
      expect.objectContaining({ id: "restart-replay-reconciliation", ok: true }),
      expect.objectContaining({ id: "concurrent-workers-clean-shutdown", ok: true }),
      expect.objectContaining({ id: "final-integrity-no-active-leases", ok: true }),
      expect.objectContaining({ id: "event-chain-integrity", ok: true }),
    ]));
    expect(report.events.map((event) => event.sequence)).toEqual(report.events.map((_, index) => index + 1));
    expect(report.events.every((event) => FLIGHT_CONTROL_EVENT_KINDS.includes(event.kind))).toBe(true);
    expect(report.events.at(-1)?.hash).toBe(report.event_chain_head);
    expect(report.publication_events.length).toBeGreaterThan(0);
    expect(report.publication_events.every((event) => FLIGHT_CONTROL_PUBLICATION_KINDS.includes(event.kind))).toBe(true);
    expect(report.publication_events.at(-1)?.hash).toBe(report.publication_chain_head);
    expect(report.repositories.every((repository) => repository.clean && repository.active_leases === 0 && repository.initial_head === repository.final_head && repository.initial_tree_hash === repository.final_tree_hash)).toBe(true);
    expect(JSON.parse(readFileSync(evidenceFile, "utf8"))).toMatchObject({ ok: true, scenario_id: "focused-flight-control-test" });
    expect(readFileSync(join(workRoot, "flight-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(report.publication_events);
  }, 120_000);
});
