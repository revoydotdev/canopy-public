import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditIntegrityError, OutputEvidenceStore } from "../src/index.js";

let root: string;
const metadata = {
  campaign_id: "camp-1", node_id: "node-1", operation_id: "expand-1", stream: "model" as const,
  media_type: "text/plain; charset=utf-8", provenance: { tag: "claimed" as const, claimant: "heartwood" },
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "arbor-output-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("OutputEvidenceStore", () => {
  it("persists and verifies full output across restart", () => {
    const content = "complete model output\nwith detail";
    const record = new OutputEvidenceStore(root).put(metadata, content);
    const restarted = new OutputEvidenceStore(root);
    expect(restarted.verify(record.id)).toEqual(record);
    expect(Buffer.from(restarted.readRaw(record.id, {
      actor: "audit-agent", capability: "auditor", reason: "evidence review",
    })).toString("utf8")).toBe(content);
  });

  it("is idempotent for duplicates and rejects operation identity conflicts", () => {
    const store = new OutputEvidenceStore(root, { now: () => "2026-08-01T00:00:00.000Z" });
    const first = store.put(metadata, "same");
    expect(store.put(metadata, "same")).toEqual(first);
    expect(() => store.put(metadata, "different")).toThrow(/conflicting output artifact/);
    expect(() => store.put({ ...metadata, media_type: "application/json" }, "same"))
      .toThrow(/conflicting output artifact/);
  });

  it("rejects verified provenance missing stdout_hash (G-26)", () => {
    const store = new OutputEvidenceStore(root);
    expect(() => store.put({ ...metadata, provenance: { tag: "verified", cmd: "pytest", exit: 0 } as never }, "content"))
      .toThrow(/invalid verified output provenance/);
  });

  it("rejects each malformed provenance field independently", () => {
    const store = new OutputEvidenceStore(root);
    const invalid = [
      { tag: "verified", cmd: 42, exit: 0, stdout_hash: "sha256:output" },
      { tag: "verified", cmd: "vitest", exit: 1, stdout_hash: "sha256:output" },
      { tag: "verified", cmd: "vitest", exit: 0, stdout_hash: "" },
      { tag: "verified", cmd: "vitest", exit: 0, stdout_hash: "sha256:output", check: "not-a-check" },
      { tag: "critic_approved", critic: "lenticel", rationale: 42 },
      { tag: "generated", generator: "reporter", input_hash: 42 },
    ] as const;

    for (const [index, provenance] of invalid.entries()) {
      expect(() => store.put({ ...metadata, operation_id: `invalid-provenance-${index}`, provenance: provenance as never }, "content"))
        .toThrow(/invalid .* output provenance/);
    }
  });

  it("persists every complete provenance variant and rejects malformed metadata before writing", () => {
    const store = new OutputEvidenceStore(root);
    const variants = [
      { operation_id: "verified", provenance: { tag: "verified", cmd: "vitest run", exit: 0, stdout_hash: "sha256:real-output" } },
      { operation_id: "critic", provenance: { tag: "critic_approved", critic: "lenticel", rationale: "reviewed output" } },
      { operation_id: "generated", provenance: { tag: "generated", generator: "reporter", input_hash: "sha256:inputs" } },
    ] as const;
    for (const variant of variants) {
      const record = store.put({ ...metadata, ...variant, provenance: variant.provenance as never }, new Uint8Array([1, 2, 3]));
      expect(store.verify(record.id).provenance).toEqual(variant.provenance);
    }

    expect(() => store.put({ ...metadata, campaign_id: "", operation_id: "bad-field" }, "x"))
      .toThrow("invalid output artifact campaign_id");
    expect(() => store.put({ ...metadata, operation_id: "bad-stream", stream: "binary" as never }, "x"))
      .toThrow("invalid output artifact stream");
    expect(() => store.put({ ...metadata, operation_id: "bad-provenance", provenance: { tag: "unknown" } as never }, "x"))
      .toThrow("invalid output artifact provenance tag");
    expect(() => store.put({ ...metadata, operation_id: "missing-provenance", provenance: null as never }, "x"))
      .toThrow("output artifact provenance is required");
    expect(() => store.put({ ...metadata, operation_id: "empty-claimant", provenance: { tag: "claimed", claimant: "" } }, "x"))
      .toThrow("invalid claimed output provenance");
    expect(() => store.put({ ...metadata, operation_id: "empty-critic", provenance: { tag: "critic_approved", critic: "", rationale: "" } }, "x"))
      .toThrow("invalid critic-approved output provenance");
    expect(() => store.put({ ...metadata, operation_id: "empty-generator", provenance: { tag: "generated", generator: "", input_hash: "" } }, "x"))
      .toThrow("invalid generated output provenance");
    expect(() => store.put({ ...metadata, operation_id: "non-string-field", media_type: 42 as never }, "x"))
      .toThrow("invalid output artifact media_type");
    expect(() => store.put({ ...metadata, operation_id: "oversized-field", media_type: "x".repeat(1025) }, "x"))
      .toThrow("invalid output artifact media_type");
  });

  it("requires privileged raw access and honors the authorization policy", () => {
    const store = new OutputEvidenceStore(root, {
      authorize_raw_read: (_record, authorization) => authorization.actor === "allowed",
    });
    const record = store.put(metadata, "secret");
    expect(() => store.readRaw(record.id, { actor: "seed", capability: "auditor" as never, reason: "" }))
      .toThrow(AuditIntegrityError);
    expect(() => store.readRaw(record.id, { actor: "denied", capability: "auditor", reason: "review" }))
      .toThrow(/access denied/);
    expect(Buffer.from(store.readRaw(record.id, {
      actor: "allowed", capability: "orchestrator", reason: "operator requested raw evidence",
    })).toString()).toBe("secret");
  });

  it("rejects each malformed raw-output authorization field independently", () => {
    const store = new OutputEvidenceStore(root);
    const record = store.put(metadata, "secret");
    const invalid = [
      null,
      { actor: "auditor", capability: "seed", reason: "review" },
      { actor: 42, capability: "auditor", reason: "review" },
      { actor: "", capability: "auditor", reason: "review" },
      { actor: "auditor", capability: "auditor", reason: 42 },
      { actor: "auditor", capability: "auditor", reason: "" },
    ];

    for (const authorization of invalid) {
      expect(() => store.readRaw(record.id, authorization as never))
        .toThrow("auditor or orchestrator authorization with reason is required");
    }
  });

  it("detects blob and descriptor tampering", () => {
    const store = new OutputEvidenceStore(root);
    const record = store.put(metadata, "original");
    const blob = join(root, "audit", "output-artifacts", "blobs", record.sha256.slice(0, 2), record.sha256);
    writeFileSync(blob, "tampered");
    expect(() => store.verify(record.id)).toThrow(/byte count mismatch|hash mismatch/);

    const second = store.put({ ...metadata, operation_id: "expand-2" }, "other");
    const descriptor = join(root, "audit", "output-artifacts", "records", `${second.id}.json`);
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as { byte_count: number };
    parsed.byte_count += 1;
    writeFileSync(descriptor, JSON.stringify(parsed));
    expect(() => store.verify(second.id)).toThrow(/record hash mismatch/);
  });

  it("detects same-length blob tampering by hash after the byte-count check passes", () => {
    const store = new OutputEvidenceStore(root);
    const record = store.put(metadata, "original");
    const blob = join(root, "audit", "output-artifacts", "blobs", record.sha256.slice(0, 2), record.sha256);
    writeFileSync(blob, "tampered");
    expect(() => store.verify(record.id)).toThrow(/hash mismatch/);
  });

  it("rejects each malformed descriptor structure independently", () => {
    const store = new OutputEvidenceStore(root);
    const record = store.put(metadata, "original");
    const descriptor = join(root, "audit", "output-artifacts", "records", `${record.id}.json`);
    const invalidRecords = [
      { ...record, schema: "arbor.output-artifact/v0" },
      { ...record, sha256: "not-a-hash" },
      { ...record, record_hash: "not-a-hash" },
      { ...record, byte_count: 1.5 },
      { ...record, byte_count: -1 },
      { ...record, stored_at: 42 },
    ];

    for (const invalid of invalidRecords) {
      writeFileSync(descriptor, JSON.stringify(invalid));
      expect(() => store.getRecord(record.id)).toThrow(`invalid output artifact record ${record.id}`);
    }
  });

  it("keeps invalid ids, missing blobs, and malformed descriptors visibly distinct", () => {
    const store = new OutputEvidenceStore(root);
    const record = store.put({ ...metadata, operation_id: "missing-blob" }, "original");
    const blob = join(root, "audit", "output-artifacts", "blobs", record.sha256.slice(0, 2), record.sha256);
    unlinkSync(blob);
    expect(() => store.readRaw(record.id, { actor: "auditor", capability: "auditor", reason: "check missing blob" }))
      .toThrow("missing output artifact blob");
    expect(store.getRecord(`out_${"0".repeat(64)}`)).toBeNull();
    expect(() => store.getRecord("not-an-output-id")).toThrow("invalid output artifact id");

    const malformed = store.put({ ...metadata, operation_id: "malformed-descriptor" }, "present");
    const descriptor = join(root, "audit", "output-artifacts", "records", `${malformed.id}.json`);
    writeFileSync(descriptor, "{ not json", "utf8");
    const listed = store.list();
    expect(listed.find((entry) => entry.status === "corrupt")).toMatchObject({ status: "corrupt", id: malformed.id });
  });

  it("lists stored records deterministically, most-recent first", () => {
    const stamps = ["2026-08-01T00:00:00.000Z", "2026-08-01T00:00:01.000Z", "2026-08-01T00:00:02.000Z"];
    const store = new OutputEvidenceStore(root, { now: () => stamps.shift() ?? "2026-08-01T00:00:03.000Z" });
    const first = store.put({ ...metadata, operation_id: "op-a" }, "a");
    const second = store.put({ ...metadata, operation_id: "op-b" }, "b");
    const third = store.put({ ...metadata, operation_id: "op-c" }, "c");

    const listed = store.list();
    expect(listed.map((e) => (e.status === "ok" ? e.record.id : e.id))).toEqual([third.id, second.id, first.id]);
    expect(listed.every((e) => e.status === "ok")).toBe(true);

    // Deterministic across repeated calls (no reliance on readdir order).
    expect(store.list()).toEqual(listed);
  });

  it("bounds the returned list by `limit`", () => {
    const store = new OutputEvidenceStore(root);
    for (let i = 0; i < 5; i++) store.put({ ...metadata, operation_id: `op-${i}` }, `content-${i}`);
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list()).toHaveLength(5);
    expect(() => store.list({ limit: 0 })).toThrow(/positive safe integer/);
    expect(() => store.list({ limit: -1 })).toThrow(/positive safe integer/);
  });

  it("returns an empty list rather than throwing when nothing has been captured yet", () => {
    const store = new OutputEvidenceStore(root);
    expect(store.list()).toEqual([]);
  });

  it("surfaces a corrupt record distinctly instead of silently dropping it (corrupt is not absent)", () => {
    const store = new OutputEvidenceStore(root);
    const good = store.put({ ...metadata, operation_id: "op-good" }, "fine");
    const bad = store.put({ ...metadata, operation_id: "op-bad" }, "will be corrupted");
    const descriptorPath = join(root, "audit", "output-artifacts", "records", `${bad.id}.json`);
    const parsed = JSON.parse(readFileSync(descriptorPath, "utf8")) as { record_hash: string };
    parsed.record_hash = "0".repeat(64);
    writeFileSync(descriptorPath, JSON.stringify(parsed));

    const listed = store.list();
    expect(listed).toHaveLength(2);
    const corrupt = listed.find((e) => e.status === "corrupt");
    const ok = listed.find((e) => e.status === "ok");
    expect(corrupt).toMatchObject({ status: "corrupt", id: bad.id });
    expect((corrupt as { error: string }).error).toMatch(/record hash mismatch/);
    expect(ok).toMatchObject({ status: "ok", record: { id: good.id } });
  });

  it("stores a large adversarial no-newline output exactly and enforces the byte bound", () => {
    const content = "x".repeat(1024 * 1024 + 17);
    const store = new OutputEvidenceStore(root, { max_artifact_bytes: Buffer.byteLength(content) });
    const record = store.put(metadata, content);
    expect(record.byte_count).toBe(Buffer.byteLength(content));
    expect(Buffer.from(store.readRaw(record.id, {
      actor: "crown", capability: "orchestrator", reason: "debug full output",
    })).toString()).toBe(content);
    expect(() => new OutputEvidenceStore(root, { max_artifact_bytes: 3 })
      .put({ ...metadata, operation_id: "expand-too-large" }, "four")).toThrow(/exceeds 3 byte/);
    expect(() => new OutputEvidenceStore(root, { max_artifact_bytes: 0 })).toThrow(/positive safe integer/);
    expect(() => new OutputEvidenceStore(root, { max_artifact_bytes: 1.5 })).toThrow(/positive safe integer/);
  });

  describe("execution_context binding", () => {
    const knownContext = {
      shell: { known: true as const, value: "none" },
      cwd: { known: true as const, value: "/worktrees/node-1" },
      timeout_ms: { known: true as const, value: 300_000 },
      max_output_bytes: { known: true as const, value: 262_144 },
      platform: { known: true as const, value: "linux" },
      path_hash: { known: true as const, value: "sha256:abc123" },
    };

    it("persists a caller-supplied execution_context across restart", () => {
      const store = new OutputEvidenceStore(root);
      const record = store.put({ ...metadata, execution_context: knownContext }, "content");
      expect(record.execution_context).toEqual(knownContext);
      const restarted = new OutputEvidenceStore(root);
      expect(restarted.verify(record.id).execution_context).toEqual(knownContext);
    });

    it("stamps a typed unavailable execution_context when the caller supplies none, never an omitted field", () => {
      const store = new OutputEvidenceStore(root);
      const record = store.put(metadata, "content");
      expect(record.execution_context).toEqual({
        shell: { known: false, reason: "caller did not supply execution context" },
        cwd: { known: false, reason: "caller did not supply execution context" },
        timeout_ms: { known: false, reason: "caller did not supply execution context" },
        max_output_bytes: { known: false, reason: "caller did not supply execution context" },
        platform: { known: false, reason: "caller did not supply execution context" },
        path_hash: { known: false, reason: "caller did not supply execution context" },
      });
      // Every fact is present and typed, never a bare `undefined`.
      for (const fact of Object.values(record.execution_context)) {
        expect(fact.known).toBe(false);
        expect(typeof (fact as { reason: string }).reason).toBe("string");
      }
    });

    it("supports mixed known/unknown facts within one execution_context", () => {
      const store = new OutputEvidenceStore(root);
      const mixed = {
        ...knownContext,
        platform: { known: false as const, reason: "sandboxed port does not surface the host platform" },
      };
      const record = store.put({ ...metadata, execution_context: mixed }, "content");
      expect(record.execution_context.platform).toEqual(mixed.platform);
      expect(record.execution_context.shell).toEqual(knownContext.shell);
    });

    it("rejects each malformed execution_context fact independently", () => {
      const store = new OutputEvidenceStore(root);
      const invalidContexts = [
        { ...knownContext, shell: { known: true, value: 42 } },
        { ...knownContext, shell: { known: true, value: "" } },
        { ...knownContext, timeout_ms: { known: true, value: "300000" } },
        { ...knownContext, cwd: { known: false, reason: "" } },
        { ...knownContext, cwd: { known: false } },
        { ...knownContext, path_hash: "sha256:abc123" },
      ];
      for (const [index, execution_context] of invalidContexts.entries()) {
        expect(() => store.put({ ...metadata, operation_id: `bad-context-${index}`, execution_context: execution_context as never }, "x"))
          .toThrow(/invalid output artifact execution_context/);
      }
    });

    it("treats a differing execution_context on the same operation identity as a conflict", () => {
      const store = new OutputEvidenceStore(root);
      store.put({ ...metadata, execution_context: knownContext }, "same");
      expect(() => store.put({ ...metadata, execution_context: { ...knownContext, cwd: { known: true, value: "/elsewhere" } } }, "same"))
        .toThrow(/conflicting output artifact/);
    });

    it("is idempotent when the execution_context is identical on re-put", () => {
      const store = new OutputEvidenceStore(root);
      const first = store.put({ ...metadata, execution_context: knownContext }, "same");
      expect(store.put({ ...metadata, execution_context: knownContext }, "same")).toEqual(first);
    });

    it("rejects a persisted descriptor missing execution_context entirely", () => {
      const store = new OutputEvidenceStore(root);
      const record = store.put(metadata, "original");
      const descriptor = join(root, "audit", "output-artifacts", "records", `${record.id}.json`);
      const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
      delete parsed.execution_context;
      // record_hash intentionally stale here too, but the missing-field check must fire first and independently.
      writeFileSync(descriptor, JSON.stringify(parsed));
      expect(() => store.getRecord(record.id)).toThrow(/missing execution_context/);
    });
  });
});
