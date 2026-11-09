import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPSULE_MAX_BYTES,
  PROJECTION_MAX_BYTES,
  FIELD_MAX_BYTES,
  MAX_LIST_ITEMS,
  MAX_TOOL_SIGNATURES,
  buildRetryContextCapsule,
  projectRetryContextCapsule,
  decideRetryContinuation,
  deriveFailureFingerprint,
  type RetryContextCapsuleInput,
  type RetryContextCapsule,
  type TaskFact,
} from "@arbor/campaign-support";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function baseInput(overrides: Partial<RetryContextCapsuleInput> = {}): RetryContextCapsuleInput {
  return {
    identity: { campaignId: "campaign-1", nodeId: "node-1" },
    failure: {
      failure_class: "operational",
      kind: "test_failure",
      normalized_root_cause: "assertion failed in suite/case",
    },
    stableContextDigest: sha256Hex("stable-context-v1"),
    attempt: 1,
    priorPromptDigest: sha256Hex("prior-prompt-v1"),
    taskFacts: [{ id: "fact-1", summary: "target file needs a null guard" }],
    changedFiles: [{ path: "src/widget.ts", changeKind: "modified", deltaDigest: sha256Hex("delta-content"), summary: "added null guard" }],
    evidence: [{
      id: "ev-1",
      kind: "test-report",
      digest: sha256Hex("report-content"),
      pointer: "artifacts/report.json",
      provenance: { tag: "claimed", claimant: "seed" },
    }],
    requirements: [{ id: "req-1", description: "add null guard before dereference", status: "unresolved" }],
    toolSignatures: [{ name: "run_tests", argsDigest: sha256Hex("[]") }],
    ...overrides,
  };
}

function expectOk<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
}

describe("buildRetryContextCapsule — contract shape", () => {
  it("produces the exact semantically-complete contract shape", () => {
    const result = buildRetryContextCapsule(baseInput());
    expectOk(result);
    const capsule = result.capsule;

    expect(capsule.version).toBe(1);
    expect(capsule.identity).toEqual({ campaignId: "campaign-1", nodeId: "node-1" });
    expect(capsule.failure.failure_class).toBe("operational");
    expect(capsule.failure.kind).toBe("test_failure");
    expect(capsule.failure.normalized_root_cause).toBe("assertion failed in suite/case");
    expect(capsule.failure.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(capsule.failure.fingerprint).toBe(deriveFailureFingerprint(baseInput().failure));
    expect(capsule.stableContextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(capsule.attempt).toBe(1);
    expect(capsule.priorPromptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(capsule.taskFacts).toEqual([{ id: "fact-1", summary: "target file needs a null guard" }]);
    expect(capsule.changedFiles).toEqual([{
      path: "src/widget.ts", changeKind: "modified",
      deltaDigest: sha256Hex("delta-content"), summary: "added null guard",
    }]);
    expect(capsule.evidence[0]).toMatchObject({ id: "ev-1", kind: "test-report", provenance: { tag: "claimed", claimant: "seed" } });
    expect(capsule.requirements[0]).toMatchObject({ id: "req-1", status: "unresolved" });
    expect(capsule.toolSignatures[0]).toMatchObject({ name: "run_tests" });
    expect(capsule.truncation).toEqual([]);
    expect(capsule.capsuleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the fingerprint canonically — identical classification always produces the identical fingerprint", () => {
    const first = buildRetryContextCapsule(baseInput());
    const second = buildRetryContextCapsule(baseInput({ identity: { campaignId: "campaign-2", nodeId: "node-2" } }));
    expectOk(first);
    expectOk(second);
    expect(first.capsule.failure.fingerprint).toBe(second.capsule.failure.fingerprint);
  });

  it("derives a different fingerprint when the normalized root cause differs", () => {
    const first = buildRetryContextCapsule(baseInput());
    const second = buildRetryContextCapsule(baseInput({ failure: { failure_class: "operational", kind: "test_failure", normalized_root_cause: "a different root cause" } }));
    expectOk(first);
    expectOk(second);
    expect(first.capsule.failure.fingerprint).not.toBe(second.capsule.failure.fingerprint);
  });

  it("deep-freezes the returned capsule, including nested arrays and objects", () => {
    const result = buildRetryContextCapsule(baseInput());
    expectOk(result);
    const capsule = result.capsule;

    expect(Object.isFrozen(capsule)).toBe(true);
    expect(Object.isFrozen(capsule.identity)).toBe(true);
    expect(Object.isFrozen(capsule.taskFacts)).toBe(true);
    expect(Object.isFrozen(capsule.taskFacts[0])).toBe(true);
    expect(() => {
      (capsule as unknown as { version: number }).version = 2;
    }).toThrow();
  });
});

describe("buildRetryContextCapsule — forbidden raw content", () => {
  it("never contains raw prior prompt text, raw tool output, raw file content, raw diffs, secrets, or timestamps", () => {
    const result = buildRetryContextCapsule(baseInput());
    expectOk(result);
    const serialized = JSON.stringify(result.capsule);

    for (const forbiddenKey of ["rawOutput", "rawContent", "diff", "patch", "timestamp", "secret", "createdAt", "updatedAt"]) {
      expect(serialized.toLowerCase()).not.toContain(forbiddenKey.toLowerCase());
    }
    // Only a digest of the prompt may appear (`priorPromptDigest`) — never a raw `prompt` field/value.
    expect(serialized).not.toMatch(/"prompt"\s*:/i);
  });

  it("stores only digests for evidence and tool arguments, never the underlying content", () => {
    const result = buildRetryContextCapsule(baseInput());
    expectOk(result);
    expect(result.capsule.evidence[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.capsule.toolSignatures[0]!.argsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildRetryContextCapsule — per-field byte ceiling", () => {
  it("rejects a task fact summary exceeding the per-text-field ceiling instead of truncating it", () => {
    const oversized = "x".repeat(FIELD_MAX_BYTES + 1);
    const result = buildRetryContextCapsule(baseInput({ taskFacts: [{ id: "fact-1", summary: oversized }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain(`${FIELD_MAX_BYTES}-byte`);
    }
  });

  it("accepts a field exactly at the ceiling using Buffer.byteLength for measurement", () => {
    const exact = "y".repeat(FIELD_MAX_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(FIELD_MAX_BYTES);
    const result = buildRetryContextCapsule(baseInput({ taskFacts: [{ id: "fact-1", summary: exact }] }));
    expect(result.ok).toBe(true);
  });

  it("measures multi-byte UTF-8 text by byte length, not character length", () => {
    // Each snowman is 3 bytes in UTF-8; 700 chars = 2100 bytes > 2048 ceiling.
    const multiByte = "☃".repeat(700);
    expect(multiByte.length).toBeLessThan(FIELD_MAX_BYTES);
    expect(Buffer.byteLength(multiByte, "utf8")).toBeGreaterThan(FIELD_MAX_BYTES);
    const result = buildRetryContextCapsule(baseInput({ taskFacts: [{ id: "fact-1", summary: multiByte }] }));
    expect(result.ok).toBe(false);
  });
});

describe("buildRetryContextCapsule — deterministic sort and whole-row truncation", () => {
  function manyTaskFacts(count: number): TaskFact[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `fact-${String(index).padStart(3, "0")}`,
      summary: `summary ${index}`,
    }));
  }

  it("sorts task facts deterministically before applying the list cap", () => {
    const shuffled = manyTaskFacts(MAX_LIST_ITEMS).reverse();
    const result = buildRetryContextCapsule(baseInput({ taskFacts: shuffled }));
    expectOk(result);
    const ids = result.capsule.taskFacts.map((fact) => fact.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("caps task facts at MAX_LIST_ITEMS and drops whole lowest-priority rows with recorded omission metadata", () => {
    const facts = manyTaskFacts(MAX_LIST_ITEMS + 5);
    const result = buildRetryContextCapsule(baseInput({ taskFacts: facts }));
    expectOk(result);
    const capsule = result.capsule;

    expect(capsule.taskFacts).toHaveLength(MAX_LIST_ITEMS);
    // Whole rows only: every kept row has both id and summary populated.
    for (const fact of capsule.taskFacts) {
      expect(fact.id).toBeTruthy();
      expect(fact.summary).toBeTruthy();
    }

    const record = capsule.truncation.find((entry) => entry.field === "taskFacts");
    expect(record).toBeDefined();
    expect(record!.omittedCount).toBe(5);
    expect(record!.omittedDigests).toHaveLength(5);
    for (const digest of record!.omittedDigests) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }

    // The five highest (lexicographically last) ids are the ones dropped.
    const keptIds = new Set(capsule.taskFacts.map((f) => f.id));
    const droppedExpected = facts
      .map((f) => f.id)
      .sort()
      .slice(MAX_LIST_ITEMS);
    for (const id of droppedExpected) {
      expect(keptIds.has(id)).toBe(false);
    }
  });

  it("caps tool signatures at MAX_TOOL_SIGNATURES", () => {
    const signatures = Array.from({ length: MAX_TOOL_SIGNATURES + 3 }, (_, index) => ({
      name: `tool-${String(index).padStart(3, "0")}`,
      argsDigest: sha256Hex(`args-${index}`),
    }));
    const result = buildRetryContextCapsule(baseInput({ toolSignatures: signatures }));
    expectOk(result);
    expect(result.capsule.toolSignatures).toHaveLength(MAX_TOOL_SIGNATURES);
    const record = result.capsule.truncation.find((entry) => entry.field === "toolSignatures");
    expect(record?.omittedCount).toBe(3);
  });

  it("drops whole lowest-priority rows to stay within the capsule byte budget", () => {
    // Force a budget-driven truncation pass beyond the list-count cap by using
    // near-ceiling summaries for many task facts.
    const bigFacts = manyTaskFacts(MAX_LIST_ITEMS).map((fact) => ({
      ...fact,
      summary: "z".repeat(500),
    }));
    const result = buildRetryContextCapsule(baseInput({ taskFacts: bigFacts }));
    expectOk(result);

    const serializedSize = Buffer.byteLength(JSON.stringify(result.capsule), "utf8");
    expect(serializedSize).toBeLessThanOrEqual(CAPSULE_MAX_BYTES);

    for (const fact of result.capsule.taskFacts) {
      expect(fact.id).toBeTruthy();
      expect(fact.summary).toBeTruthy();
    }
  });
});

describe("buildRetryContextCapsule — deterministic byte bounds", () => {
  it("keeps the capsule within CAPSULE_MAX_BYTES as measured by Buffer.byteLength", () => {
    const result = buildRetryContextCapsule(baseInput());
    expectOk(result);
    const size = Buffer.byteLength(JSON.stringify(result.capsule), "utf8");
    expect(size).toBeLessThanOrEqual(CAPSULE_MAX_BYTES);
  });

  it("produces identical byte size for identical input across repeated calls", () => {
    const first = buildRetryContextCapsule(baseInput());
    const second = buildRetryContextCapsule(baseInput());
    expectOk(first);
    expectOk(second);
    const firstSize = Buffer.byteLength(JSON.stringify(first.capsule), "utf8");
    const secondSize = Buffer.byteLength(JSON.stringify(second.capsule), "utf8");
    expect(firstSize).toBe(secondSize);
    expect(first.capsule.capsuleDigest).toBe(second.capsule.capsuleDigest);
  });
});

describe("projectRetryContextCapsule", () => {
  function buildCapsule(overrides: Partial<RetryContextCapsuleInput> = {}): RetryContextCapsule {
    const result = buildRetryContextCapsule(baseInput(overrides));
    expectOk(result);
    return result.capsule;
  }

  it("produces a projection within PROJECTION_MAX_BYTES containing only deltas, digests, and pointers", () => {
    const capsule = buildCapsule();
    const result = projectRetryContextCapsule(capsule);
    expectOk(result);
    const projection = result.projection;

    const size = Buffer.byteLength(JSON.stringify(projection), "utf8");
    expect(size).toBeLessThanOrEqual(PROJECTION_MAX_BYTES);

    expect(projection.identity).toEqual(capsule.identity);
    expect(projection.failure.fingerprint).toBe(capsule.failure.fingerprint);
    expect(projection.stableContextDigest).toBe(capsule.stableContextDigest);
    expect(projection.sourceCapsuleDigest).toBe(capsule.capsuleDigest);
    expect(projection.taskFacts).toEqual(capsule.taskFacts);

    const serialized = JSON.stringify(projection).toLowerCase();
    for (const forbiddenKey of ["rawoutput", "rawcontent", "diff", "patch", "timestamp"]) {
      expect(serialized).not.toContain(forbiddenKey);
    }
    expect(serialized).not.toMatch(/"prompt"\s*:/);
  });

  it("deep-freezes the returned projection", () => {
    const capsule = buildCapsule();
    const result = projectRetryContextCapsule(capsule);
    expectOk(result);
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.taskFacts)).toBe(true);
  });

  it("further truncates whole rows with recorded omissions when the capsule already exceeds the projection budget", () => {
    const facts = Array.from({ length: MAX_LIST_ITEMS }, (_, index) => ({
      id: `fact-${String(index).padStart(3, "0")}`,
      summary: "w".repeat(400),
    }));
    const capsule = buildCapsule({ taskFacts: facts });
    const result = projectRetryContextCapsule(capsule);
    expectOk(result);

    const size = Buffer.byteLength(JSON.stringify(result.projection), "utf8");
    expect(size).toBeLessThanOrEqual(PROJECTION_MAX_BYTES);

    const record = result.projection.truncation.find((entry) => entry.field === "taskFacts");
    if (result.projection.taskFacts.length < capsule.taskFacts.length) {
      expect(record).toBeDefined();
      expect(record!.omittedCount).toBeGreaterThan(0);
      for (const digest of record!.omittedDigests) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("decideRetryContinuation", () => {
  const fingerprint = sha256Hex("test_failure:ETEST:suite/case");
  const stableDigest = sha256Hex("stable-context-v1");

  it("returns continue with no previous fingerprint (first attempt)", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 1,
    });
    expect(decision.action).toBe("continue");
    expect(decision.advisory).toBe(true);
    expect(decision.occurrenceCount).toBe(1);
    expect(decision.reason).toBeTruthy();
  });

  it("returns continue when new evidence is present, even on a repeated identical failure", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: true,
      hasTaskOrFileDelta: false,
      occurrenceCount: 3,
    });
    expect(decision.action).toBe("continue");
    expect(decision.reason).toMatch(/evidence/i);
  });

  it("returns continue when a task/file delta is present", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: true,
      occurrenceCount: 3,
    });
    expect(decision.action).toBe("continue");
    expect(decision.reason).toMatch(/delta/i);
  });

  it("returns continue when stable_context_digest changes", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: sha256Hex("stable-context-v2"),
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 3,
    });
    expect(decision.action).toBe("continue");
    expect(decision.reason).toMatch(/stable_context_digest/i);
  });

  it("returns continue when the failure fingerprint changes (changed root cause)", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: sha256Hex("different-root-cause"),
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 3,
    });
    expect(decision.action).toBe("continue");
    expect(decision.reason).toMatch(/fingerprint/i);
  });

  it("returns decompose for a repeated identical failure at occurrence threshold 2", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 2,
    });
    expect(decision.action).toBe("decompose");
    expect(decision.occurrenceCount).toBe(2);
  });

  it("returns stop for a repeated identical failure at occurrence threshold 3", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 3,
    });
    expect(decision.action).toBe("stop");
    expect(decision.occurrenceCount).toBe(3);
  });

  it("keeps returning stop beyond the threshold and stays advisory-only (labeled, not enforced)", () => {
    const decision = decideRetryContinuation({
      currentFingerprint: fingerprint,
      previousFingerprint: fingerprint,
      stableContextDigest: stableDigest,
      previousStableContextDigest: stableDigest,
      hasNewEvidence: false,
      hasTaskOrFileDelta: false,
      occurrenceCount: 7,
    });
    expect(decision.action).toBe("stop");
    expect(decision.advisory).toBe(true);
  });
});
