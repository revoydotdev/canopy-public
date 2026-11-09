import { describe, expect, it } from "vitest";
import { DurableInspectRecordStore, InspectService, MemoryInspectRecordStore, redactInspectValue } from "../src/inspect.js";
import type { RuntimePort } from "../src/runtime-port.js";

function runtime(overrides: Partial<RuntimePort> = {}): RuntimePort {
  return {
    command: async () => ({ ok: true, value: { accepted: true, operation_id: "main-op" }, capability: "task.write" }),
    query: async () => ({ ok: true, value: { owner: "seed", lifecycle: "running", evidence_ids: ["ev-1"], token: "must-not-leak" }, capability: "operation.read" }),
    activeOperationCount: () => 1,
    ...overrides,
  };
}

const clock = { now: (() => { let n = 0; return () => `2026-09-19T00:00:0${n++}Z`; })() };

describe("M6 Inspect service", () => {
  it("projects bounded structured action state and redacts sensitive fields", async () => {
    const inspected = await new InspectService(runtime(), { clock }).inspectAction("op-1");
    expect(inspected.ok).toBe(true);
    expect(inspected.snapshot?.actions[0]).toMatchObject({ action_id: "op-1", owner: "seed", lifecycle: "running", state: "known" });
    expect(inspected.snapshot?.actions[0]?.redacted_fields).toContain("action.token");
    expect(inspected.snapshot?.evidence_ids).toEqual(["ev-1"]);
  });

  it("keeps drafts and side-query records separate from the primary command path", async () => {
    const commands: string[] = [];
    const service = new InspectService(runtime({ command: async request => { commands.push(request.kind); return { ok: true, value: { accepted: true, operation_id: "main-op" }, capability: "task.write" }; } }), { clock });
    const inspected = await service.inspectAction("op-2");
    const snapshot = inspected.snapshot!;
    service.saveDraft("draft-a", "what is running?");
    const record = service.ask("what is the lifecycle?", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.draftsHistory).toHaveLength(1);
    expect(service.get(record.request_id)?.status).toBe("completed");
    expect(service.get(record.request_id)?.answer?.kind).toBe("deterministic");
    expect(commands).toEqual([]);
  });

  it("rejects mutation-shaped side questions and requires explicit promotion", async () => {
    const commands: string[] = [];
    const service = new InspectService(runtime({ command: async request => { commands.push(request.kind); return { ok: true, value: { accepted: true, operation_id: "promoted" }, capability: "task.write" }; } }), { clock });
    const snapshot = (await service.inspectAction("op-3")).snapshot!;
    const rejected = service.ask("change the plan and run it", snapshot);
    expect(rejected.status).toBe("rejected");
    expect(commands).toEqual([]);
    const answer = service.ask("how many actions are present?", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    const promoted = await service.promote(answer.request_id, "operator explicitly promoted this answer");
    expect(promoted.ok).toBe(true);
    expect(commands).toEqual(["taskcomposer.submit"]);
  });

  it("cancels only its own side request and leaves primary execution untouched", async () => {
    const signals: AbortSignal[] = [];
    const release: Array<() => void> = [];
    const model = async ({ signal }: { signal: AbortSignal }) => await new Promise<string>((resolve, reject) => {
      signals.push(signal);
      release.push(() => resolve(`model answer ${signals.length}`));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    let primaryState = "running";
    let primaryCommands = 0;
    const primary = runtime({
      command: async () => { primaryCommands += 1; return { ok: true, value: { accepted: true, operation_id: "main-op" }, capability: "task.write" }; },
      activeOperationCount: () => primaryState === "running" ? 1 : 0,
    });
    const service = new InspectService(primary, { clock, max_concurrent: 1, model });
    const snapshot = (await service.inspectAction("op-4")).snapshot!;
    const first = service.ask("summarize this work", snapshot);
    const second = service.ask("summarize that work", snapshot);
    expect(service.cancel(first.request_id)?.status).toBe("cancelled");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(primary.activeOperationCount()).toBe(1);
    expect(primaryState).toBe("running");
    expect(primaryCommands).toBe(0);

    // A normal command on the primary port remains available while only the
    // isolated side-query signal is aborted.
    expect((await primary.command({ kind: "taskcomposer.submit", metadata: { operation_id: "primary-probe", idempotency_key: "primary-probe" }, params: { task: "probe", source: "tui", mode: "execute", auto_confirm: false } })).ok).toBe(true);
    expect(primaryCommands).toBe(1);
    release[1]?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.get(first.request_id)?.status).toBe("cancelled");
    expect(service.get(second.request_id)?.status).toBe("completed");
    expect(primaryState).toBe("running");
    expect(primary.activeOperationCount()).toBe(1);
  });

  it("records durable lifecycle revisions and unknown answers honestly", async () => {
    const store = new MemoryInspectRecordStore();
    const service = new InspectService(runtime(), { clock, store });
    const snapshot = (await service.inspectAction("op-5")).snapshot!;
    const record = service.ask("what color is the moon?", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.get(record.request_id)?.answer?.kind).toBe("unknown");
    expect(store.list().filter(entry => entry.request_id === record.request_id).length).toBeGreaterThanOrEqual(2);
    expect(store.list().at(-1)?.answer?.evidence_ids).toEqual(["ev-1"]);
  });

  it("redacts nested credentials before optional model access", () => {
    const redacted: string[] = [];
    expect(redactInspectValue({ nested: { api_key: "secret", okay: "yes" } }, "root", redacted)).toEqual({ nested: { api_key: "[REDACTED]", okay: "yes" } });
    expect(redacted).toEqual(["root.nested.api_key"]);
  });

  it("reconstructs side-query history after a persistence-backed restart", async () => {
    const lines: string[] = [];
    const persistence = { read: () => lines, append: (line: string) => { lines.push(line); } };
    const store = new DurableInspectRecordStore(persistence);
    const service = new InspectService(runtime(), { clock, store });
    const snapshot = (await service.inspectAction("op-restart")).snapshot!;
    const record = service.ask("how many actions are present?", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.list().some(entry => entry.request_id === record.request_id && entry.status === "completed")).toBe(true);
    const recovered = new DurableInspectRecordStore(persistence);
    expect(recovered.list().at(-1)?.request_id).toBe(record.request_id);
    expect(recovered.list().at(-1)?.answer?.evidence_ids).toEqual(["ev-1"]);
  });

  it("rehydrates completed records and keeps promotion idempotent after restart", async () => {
    const lines: string[] = [];
    const persistence = { read: () => lines, append: (line: string) => { lines.push(line); } };
    const commands: string[] = [];
    const first = new InspectService(runtime({ command: async request => { commands.push(request.kind); return { ok: true, value: { accepted: true, operation_id: "promoted" }, capability: "taskcomposer.write" }; } }), { clock, store: new DurableInspectRecordStore(persistence) });
    const snapshot = (await first.inspectAction("op-promotion-restart")).snapshot!;
    const record = first.ask("how many actions are present?", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await first.promote(record.request_id, "operator approved")).ok).toBe(true);

    const recovered = new InspectService(runtime({ command: async request => { commands.push(request.kind); return { ok: true, value: { accepted: true, operation_id: "promoted" }, capability: "taskcomposer.write" }; } }), { clock, store: new DurableInspectRecordStore(persistence) });
    expect(recovered.get(record.request_id)?.status).toBe("completed");
    const replay = await recovered.promote(record.request_id, "operator approved again");
    expect(replay.ok).toBe(true);
    expect(commands).toEqual(["taskcomposer.submit"]);
  });

  it("honors an authoritative stale snapshot marker", async () => {
    const inspected = await new InspectService(runtime({ query: async () => ({ ok: true, value: { freshness: "stale", as_of: "2026-09-19T00:00:00Z" }, capability: "operation.read" }) }), { clock }).inspectAction("op-stale");
    expect(inspected.snapshot?.freshness).toBe("stale");
  });

  it("redacts credentials in the durable side-query question", async () => {
    const service = new InspectService(runtime(), { clock });
    const snapshot = (await service.inspectAction("op-question-redact")).snapshot!;
    const record = service.ask("what is token=super-secret?", snapshot);
    expect(record.question).toContain("token: [REDACTED]");
    expect(record.question).not.toContain("super-secret");
    expect(record.redacted_fields).toContain("answer:text");
  });

  it("degrades unavailable models to a recorded unknown answer without affecting the main port", async () => {
    let commands = 0;
    const service = new InspectService(runtime({ command: async () => { commands += 1; return { ok: true, value: { accepted: true, operation_id: "main" }, capability: "task.write" }; } }), { clock, model: async () => { throw new Error("provider unavailable"); } });
    const snapshot = (await service.inspectAction("op-degraded")).snapshot!;
    const record = service.ask("summarize the evidence", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.get(record.request_id)).toMatchObject({ status: "completed", answer: { kind: "unknown" }, error: expect.stringContaining("model unavailable") });
    expect(commands).toBe(0);
  });

  it("rate-limits side queries independently and makes promotion idempotent", async () => {
    const commands: string[] = [];
    let release!: () => void;
    const service = new InspectService(runtime({ command: async request => { commands.push(request.kind); return { ok: true, value: { accepted: true, operation_id: "promoted" }, capability: "task.write" }; } }), { clock, max_pending: 1, model: async () => await new Promise<string>(resolve => { release = () => resolve("model answer"); }) });
    const snapshot = (await service.inspectAction("op-rate")).snapshot!;
    const first = service.ask("summarize the action", snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = service.ask("summarize another action", snapshot);
    expect(second.status).toBe("rejected");
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    const one = await service.promote(first.request_id, "operator approved");
    const two = await service.promote(first.request_id, "operator approved again");
    expect(one).toEqual(two);
    expect(commands).toEqual(["taskcomposer.submit"]);
  });
});
