import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_POLICY } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "arbor-output-runtime-")); roots.push(value); return value; }
function capture(operationId: string, idempotencyKey: string, content: string) {
  return {
    schema_version: 1 as const,
    metadata: { operation_id: operationId, idempotency_key: idempotencyKey, correlation_id: "corr", actor_id: "seed", requested_at: "2026-08-01T00:00:00.000Z" },
    command: {
      kind: "output.capture" as const,
      artifact: { campaign_id: "campaign", node_id: "node", stream: "stdout" as const, media_type: "text/plain", provenance: { tag: "claimed" as const, claimant: "seed" } },
      content,
    },
  };
}
function query(kind: "output.descriptor" | "output.raw", evidenceId: string, approvalId?: string) {
  return { schema_version: 1 as const, query_id: "query", query: { kind, evidence_id: evidenceId, ...(kind === "output.raw" ? { approval_id: approvalId ?? "" } : {}) } };
}
function approveRaw(runtime: ArborRuntime, evidenceId: string, requestId = "raw-approval"): string {
  const requested = runtime.approvals.request({ request_id: requestId, idempotency_key: `idem-${requestId}`, action: "output.raw", subject: "review captured output", resource_id: evidenceId, proposer: "operator-a", rationale: "incident review", expires_at: "2099-01-01T00:00:00.000Z" });
  if (!requested.ok) throw new Error(requested.error);
  const approved = runtime.approvals.approve({ request_id: requestId, actor: "auditor-b", clock: runtime.approvals.now() });
  if (!approved.ok) throw new Error(approved.error);
  return requestId;
}

describe("runtime output evidence boundary", () => {
  it("composes one durable store and retrieves a bounded descriptor after restart", async () => {
    const persistence = root();
    const runtime = new ArborRuntime({ persistence_dir: persistence });
    const router = new RuntimeCatalogRouter(runtime);
    const result = await router.dispatchCommand(capture("op-one", "idem-one", "durable output"));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.accepted || !("output" in result.value)) throw new Error("capture failed");
    const id = result.value.output.descriptor.id;
    await runtime.close();

    const restarted = new ArborRuntime({ persistence_dir: persistence });
    const retrieved = new RuntimeCatalogRouter(restarted).executeQuery(query("output.descriptor", id));
    expect(retrieved.ok).toBe(true);
    if (retrieved.ok) expect(retrieved.value).toMatchObject({ descriptor: { id } });
  });

  it("replays identical operations but rejects an idempotency conflict", async () => {
    const router = new RuntimeCatalogRouter(new ArborRuntime({ persistence_dir: root() }));
    const first = await router.dispatchCommand(capture("op-one", "idem-one", "first"));
    const replay = await router.dispatchCommand(capture("op-one", "idem-one", "first"));
    const conflict = await router.dispatchCommand(capture("op-two", "idem-one", "different"));
    expect(first.ok && first.value.accepted).toBe(true);
    expect(replay.ok && replay.value.accepted).toBe(true);
    expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("requires both output.raw capability and a durable matching approval", async () => {
    const persistence = root();
    const runtime = new ArborRuntime({ persistence_dir: persistence });
    const writer = new RuntimeCatalogRouter(runtime);
    const captured = await writer.dispatchCommand(capture("op-one", "idem-one", "secret"));
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    const id = captured.value.output.descriptor.id;
    const noCapability = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["output.read"]) });
    expect(noCapability.executeQuery(query("output.raw", id, "approval"))).toMatchObject({ ok: false, error: { code: "permission" } });
    const noApproval = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["output.raw"]) });
    expect(noApproval.executeQuery(query("output.raw", id, "approval"))).toMatchObject({ ok: false, error: { code: "permission" } });
  });

  it("output.descriptor does not hand raw bytes to a caller output.raw would refuse", async () => {
    // The bypass this closes: the descriptor branch used to call readRaw with a
    // self-manufactured `{capability:"orchestrator"}` authorization, which
    // satisfies OutputEvidenceStore.authorize_raw_read by construction (its
    // default predicate is `() => true`). A caller holding only `output.read`
    // was refused by output.raw on the line above and then handed up to 12KB of
    // the same artifact's bytes by output.descriptor.
    const runtime = new ArborRuntime({ persistence_dir: root() });
    const secret = "AKIA_SUPER_SECRET_CREDENTIAL_abcdef0123456789";
    const captured = await new RuntimeCatalogRouter(runtime).dispatchCommand(capture("op-one", "idem-one", secret));
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    const id = captured.value.output.descriptor.id;

    const reader = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["output.read"]) });
    expect(reader.executeQuery(query("output.raw", id, "approval"))).toMatchObject({ ok: false, error: { code: "permission" } });

    const descriptor = reader.executeQuery(query("output.descriptor", id));
    // The descriptor itself is legitimately readable at this tier — metadata,
    // hashes and counts only. Omitting the preview is the fail-closed outcome;
    // denying the whole query would be a larger change than the defect warrants.
    expect(descriptor).toMatchObject({ ok: true, value: { descriptor: { id } } });
    if (!descriptor.ok) throw new Error("descriptor query should still succeed");
    expect(JSON.stringify(descriptor.value)).not.toContain(secret);
    expect((descriptor.value as { preview?: unknown }).preview).toBeUndefined();
  });

  it("serves raw bytes only to a caller presenting an approved matching disclosure", async () => {
    const runtime = new ArborRuntime({ persistence_dir: root() });
    const captured = await new RuntimeCatalogRouter(runtime).dispatchCommand(capture("op-one", "idem-one", "visible output"));
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    const id = captured.value.output.descriptor.id;

    const approvalId = approveRaw(runtime, id);
    const auditor = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["output.read", "output.raw"]) });
    expect(auditor.executeQuery(query("output.raw", id, approvalId))).toMatchObject({ ok: true, value: { content: "visible output" } });
    expect(auditor.executeQuery(query("output.descriptor", id)))
      .toMatchObject({ ok: true, value: { descriptor: { id } } });
  });

  it("bounds adversarial no-newline previews without publishing raw events", async () => {
    const runtime = new ArborRuntime({ persistence_dir: root() });
    const router = new RuntimeCatalogRouter(runtime);
    const content = "x".repeat(DEFAULT_OUTPUT_POLICY.preview.max_bytes * 10);
    const before = runtime.eventStream.cursor().sequence;
    const captured = await router.dispatchCommand(capture("op-large", "idem-large", content));
    if (!captured.ok || !captured.value.accepted || !("output" in captured.value)) throw new Error("capture failed");
    expect(Buffer.byteLength(captured.value.output.preview.text, "utf8")).toBeLessThanOrEqual(DEFAULT_OUTPUT_POLICY.preview.max_bytes);
    expect(captured.value.output.preview.abbreviated).toBe(true);
    expect(runtime.eventStream.cursor().sequence).toBe(before);
    const raw = router.executeQuery(query("output.raw", captured.value.output.descriptor.id, approveRaw(runtime, captured.value.output.descriptor.id)));
    expect(raw).toMatchObject({ ok: true, value: { content } });
    expect(runtime.eventStream.cursor().sequence).toBe(before);
  });
});
