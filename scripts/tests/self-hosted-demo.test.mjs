import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { canonicalizeForHash } from "@arbor/core";
import { assertPublicEventChain, assertSelfHostedDemoContract, auditTipProvenance, demoPersistencePath, digest, linkDependencyCache, projectEvents, publicationTextScanRequired, resolveDraftClarifications } from "../self-hosted-demo.mjs";
import { readOperatorLine } from "../operator-keypress.mjs";

function chainedEvent(previousHash, record) {
  const body = { schema_version: 1, ...record, previous_hash: previousHash };
  return { ...body, event_hash: digest(JSON.stringify(body)) };
}

describe("operator interview input fencing", () => {
  it("requires a fresh post-request line for each interview", async () => {
    const input = new PassThrough();
    const first = readOperatorLine(1_000, input);
    input.write("first authorization\nstale second authorization\n");
    await expect(first).resolves.toBe("first authorization");

    const second = readOperatorLine(1_000, input);
    setTimeout(() => input.write("fresh second authorization\n"), 10);
    await expect(second).resolves.toBe("fresh second authorization");
    input.destroy();
  });
});

function validChain() {
  const first = chainedEvent(null, { sequence: 1, event_kind: "demo.readiness" });
  const second = chainedEvent(first.event_hash, { sequence: 2, event_kind: "demo.task_started" });
  const third = chainedEvent(second.event_hash, { sequence: 3, event_kind: "demo.integrity_verified" });
  return [first, second, third];
}

function validPackage() {
  const runId = "selfhosted-demo-001";
  const hashes = Object.fromEntries(["admission", "branch", "review", "verification", "recovery", "adoption", "integrity"].map((id, index) => [id, `sha256:${String(index + 1).padStart(64, "0")}`]));
  return {
    run_id: runId,
    executor: { kind: "provider_backed", disclosure: "OpenAI-compatible / model revision recorded privately" },
    public_events: Object.values(hashes),
    chapters: [
      { id: "readiness", capture_ms: 0, rendered_ms: 0, timing: "real_time", evidence_hashes: [hashes.admission] },
      { id: "admission", capture_ms: 30_000, rendered_ms: 30_000, timing: "real_time", evidence_hashes: [hashes.admission] },
      { id: "search", capture_ms: 120_000, rendered_ms: 120_000, timing: "real_time", evidence_hashes: [hashes.branch] },
      { id: "independent-review", capture_ms: 240_000, rendered_ms: 240_000, timing: "real_time", evidence_hashes: [hashes.review, hashes.verification] },
      { id: "recovery", capture_ms: 360_000, rendered_ms: 360_000, timing: "real_time", evidence_hashes: [hashes.recovery], labeled_safety_exercise: true },
      { id: "result-boundary", capture_ms: 480_000, rendered_ms: 480_000, timing: "real_time", evidence_hashes: [hashes.adoption] },
      { id: "seal", capture_ms: 600_000, rendered_ms: 600_000, timing: "real_time", evidence_hashes: [hashes.integrity] },
    ],
    roles: [
      { actor_id: "crown", proposed: true, approved: false },
      { actor_id: "seed-a", proposed: true, approved: false, worktree_id: "worktree-a" },
      { actor_id: "lenticel", proposed: false, approved: true },
    ],
    verification: { provenance: "verified", command: "bun run test", exit_code: 0, output_sha256: hashes.verification },
    adoption: { patch_sha256: hashes.adoption, target_state_sha256: hashes.integrity, receipt_id: "receipt-001", selected_paths: ["packages/example/src/fix.ts"] },
    audit_tip: { campaign_id: "campaign-001", record_count: 1, ledger_sha256: hashes.integrity, chain_tip: hashes.review, sentinel: { file_sha256: hashes.branch, content_hash: hashes.verification, tip_hash: hashes.review }, manifest: { file_sha256: hashes.admission, content_hash: hashes.adoption } },
    safety: {
      specialist_dispatched: true,
      critic_dispatched: true,
      verified_result: true,
      collision_denied: true,
      cancellation_acknowledged: true,
      stale_lease_resolved: true,
      retry_fenced: true,
      operator_keypress_interview: true,
      adopted_integrity_guard_executed: true,
      adoption_applied: true,
      ledger_integrity: true,
    },
    privacy: { text_scan_passed: true, raw_pixels_published: false, visual_review_hashes: [] },
    manifest: { ledger_tip: hashes.integrity, checksums: { "proof.webm": hashes.branch, "proof-matrix.json": hashes.review } },
  };
}

function canonicalHash(value) { return createHash("sha256").update(canonicalizeForHash(value)).digest("hex"); }
function writeAuditTipFixture(root, campaign = "campaign-001") {
  mkdirSync(join(root, "audit"), { recursive: true });
  mkdirSync(join(root, "audit-tips"), { recursive: true });
  const record = { kind: "trace", id: "trace-1", campaign_id: campaign, node_id: "root", timestamp: "2026-08-22T00:00:00.000Z", previous_hash: null, content_hash: "a".repeat(64) };
  writeFileSync(join(root, "audit", `${campaign}.jsonl`), `${JSON.stringify(record)}\n`);
  const sentinelBody = { kind: "arbor_audit_tip_sentinel", version: 2, campaign_id: campaign, record_count: 1, tip_hash: record.content_hash, repair_count: 0, repair_tip_hash: null };
  writeFileSync(join(root, "audit-tips", `${campaign}.json`), `${JSON.stringify({ ...sentinelBody, content_hash: canonicalHash(sentinelBody) })}\n`);
  const manifestBody = { kind: "arbor_audit_tip_manifest", version: 1, campaigns: [campaign] };
  writeFileSync(join(root, "audit-tips", "manifest.json"), `${JSON.stringify({ ...manifestBody, content_hash: canonicalHash(manifestBody) })}\n`);
}

describe("self-hosted governed demo publication contract", () => {
  it("assigns an absent adopted chapter-order guard instead of the already-landed event-chain guard", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "self-hosted-demo.mjs"), "utf8");
    expect(source).toContain("Implement and use an exported assertPublicChapterOrder(chapters, durationMs)");
    expect(source).toContain("adoptedDemoModule.assertPublicChapterOrder(ordered, durationMs)");
    expect(source).toContain('run("bun", ["install", "--frozen-lockfile"]');
    expect(source).not.toContain("linkDependencyCache(repo, source)");
    expect(source).not.toContain("Implement and use an exported assertPublicEventChain(events)");
    expect(source).not.toMatch(/export function assertPublicChapterOrder\s*\(/);
  });

  it("routes text artifacts to secret scanning and binary videos to codec inspection", () => {
    expect(["index.html", "proof-matrix.json", "source/public-events.jsonl"].every(publicationTextScanRequired)).toBe(true);
    expect(["proof.mp4", "proof.webm", "trailer.mp4", "trailer.webm"].some(publicationTextScanRequired)).toBe(false);
  });

  it("drives every clarification round before confirmation", async () => {
    const questions = [{ id: "one", question: "first", answer: null }, { id: "two", question: "second", answer: null }];
    const observed = [];
    const resolved = await resolveDraftClarifications({ id: "draft", revision: 1, status: "awaiting_clarification", proposal: { questions } }, async ({ draft, question, round }) => {
      observed.push([question.id, round]);
      const nextQuestions = draft.proposal.questions.map((item) => item.id === question.id ? { ...item, answer: "answered" } : item);
      return { ...draft, revision: draft.revision + 1, status: nextQuestions.some((item) => item.answer === null) ? "awaiting_clarification" : "proposed", proposal: { questions: nextQuestions } };
    });
    expect(observed).toEqual([["one", 1], ["two", 2]]);
    expect(resolved.status).toBe("proposed");
  });

  it("projects selected-node lifecycle states as bounded causal evidence", () => {
    const events = projectEvents({
      driver_events: [], safety_events: [], capture_started_ms: Date.parse("2026-08-21T00:00:00.000Z"), campaign_id: "campaign",
      devtools_events: [
        { ts: "2026-08-21T00:00:01.000Z", event_kind: "tree.node_changed", campaign_id: "campaign", node_id: "node", event: { state: "expanding", private_detail: "excluded" } },
        { ts: "2026-08-21T00:00:02.000Z", event_kind: "tree.node_changed", campaign_id: "campaign", node_id: "node", event: { state: "awaiting_review" } },
        { ts: "2026-08-21T00:00:03.000Z", event_kind: "tree.node_changed", campaign_id: "campaign", node_id: "node", event: { state: "verified" } },
      ],
    });
    expect(events.map((event) => event.state)).toEqual(["expanding", "awaiting_review", "verified"]);
    expect(JSON.stringify(events)).not.toContain("private_detail");
  });

  it("emits one canonical sha256 prefix", () => {
    expect(digest("revoy2")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps runtime persistence inside the clone's ignored Arbor namespace", () => {
    expect(demoPersistencePath("/tmp/isolated-revoy2", "demo-001")).toBe("/tmp/isolated-revoy2/.arbor/publication-captures/demo-001");
  });

  it("rejects unsafe run identities before deriving a persistence path", () => {
    expect(() => demoPersistencePath("/tmp/isolated-revoy2", "../escape")).toThrow(/publication safe/);
    expect(() => demoPersistencePath("/tmp/isolated-revoy2", "")).toThrow(/publication safe/);
  });

  it("shares dependencies beneath a real ignored node_modules directory instead of a dirty root symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy2-demo-deps-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      mkdirSync(join(source, "node_modules", "fixture"), { recursive: true });
      mkdirSync(target);
      writeFileSync(join(source, "node_modules", "fixture", "index.js"), "export {};\n");
      expect(linkDependencyCache(source, target)).toBe(true);
      expect(lstatSync(join(target, "node_modules")).isDirectory()).toBe(true);
      expect(lstatSync(join(target, "node_modules", "fixture")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("accepts a real-time package with evidence-linked governance from admission through sealing", () => {
    expect(() => assertSelfHostedDemoContract(validPackage())).not.toThrow();
  });

  it("binds a private ledger to a validated external tip without exposing records", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy2-demo-audit-tip-"));
    try {
      writeAuditTipFixture(root);
      const provenance = auditTipProvenance(root, "campaign-001");
      expect(provenance).toMatchObject({ campaign_id: "campaign-001", record_count: 1, chain_tip: `sha256:${"a".repeat(64)}`, sentinel: { tip_hash: `sha256:${"a".repeat(64)}` } });
      expect(JSON.stringify(provenance)).not.toContain("trace-1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed on absent, mismatched, or self-hash-tampered audit-tip evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy2-demo-audit-tip-fail-"));
    try {
      expect(() => auditTipProvenance(root, "campaign-001")).toThrow(/ledger is absent/);
      writeAuditTipFixture(root);
      writeFileSync(join(root, "audit-tips", "campaign-001.json"), JSON.stringify({ kind: "arbor_audit_tip_sentinel", version: 1, campaign_id: "campaign-001", record_count: 2, tip_hash: "a".repeat(64), content_hash: "b".repeat(64) }));
      expect(() => auditTipProvenance(root, "campaign-001")).toThrow(/count/);
      writeAuditTipFixture(root);
      const sentinelPath = join(root, "audit-tips", "campaign-001.json");
      const sentinel = JSON.parse(require("node:fs").readFileSync(sentinelPath, "utf8"));
      sentinel.content_hash = "b".repeat(64);
      writeFileSync(sentinelPath, JSON.stringify(sentinel));
      expect(() => auditTipProvenance(root, "campaign-001")).toThrow(/self-hash/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when real-time footage or a chapter cannot be resolved to public evidence", () => {
    const pkg = validPackage();
    pkg.chapters[2].rendered_ms = 90_000;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/real-time/);
    pkg.chapters[2].rendered_ms = 120_000;
    pkg.chapters[2].evidence_hashes = ["sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"];
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/timecoded public evidence/);
  });

  it("fails closed on self-approval, missing verification or isolation, incomplete recovery, and unreviewed pixels", () => {
    const pkg = validPackage();
    pkg.roles[0].approved = true;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/role separation/);
    pkg.roles[0].approved = false;
    pkg.verification.provenance = "critic_approved";
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/machine verification/);
    pkg.verification.provenance = "verified";
    pkg.safety.retry_fenced = false;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/collision, cancellation/);
    pkg.safety.retry_fenced = true;
    pkg.privacy.raw_pixels_published = true;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/privacy review/);
  });

  it("requires the producer's verified_result safety field by its canonical name", () => {
    const pkg = validPackage();
    pkg.safety.verified_node_observed = pkg.safety.verified_result;
    delete pkg.safety.verified_result;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/collision, cancellation/);
  });

  it("requires public request and literal-keypress interview evidence", () => {
    const rejected = validPackage();
    rejected.safety.operator_keypress_interview = false;
    expect(() => assertSelfHostedDemoContract(rejected)).toThrow(/collision, cancellation, recovery, and retry proof/);

    const missing = validPackage();
    delete missing.safety.operator_keypress_interview;
    expect(() => assertSelfHostedDemoContract(missing)).toThrow(/operator keypress interview evidence/);
  });

  it("accepts a public event chain whose hashes and links independently recompute", () => {
    expect(() => assertPublicEventChain(validChain())).not.toThrow();
  });

  it("accepts the null genesis link on the first event", () => {
    const [first] = validChain();
    expect(first.previous_hash).toBeNull();
    expect(() => assertPublicEventChain([first])).not.toThrow();
  });

  it("rejects a chain whose event body was tampered with after hashing", () => {
    const events = validChain();
    events[1] = { ...events[1], event_kind: "demo.tampered" };
    expect(() => assertPublicEventChain(events)).toThrow(/public event hash mismatch/);
  });

  it("rejects a chain with a missing or incorrect previous_hash link", () => {
    const events = validChain();
    events[2] = { ...events[2], previous_hash: events[0].event_hash };
    expect(() => assertPublicEventChain(events)).toThrow(/public event chain link broken/);
  });

  it("rejects a mix of public and private events whose ledger includes an unlinked private insertion", () => {
    const [first, second, third] = validChain();
    const privateEvent = chainedEvent(second.event_hash, { sequence: 3, event_kind: "internal.private_diagnostic" });
    expect(() => assertPublicEventChain([first, second, privateEvent, third])).toThrow(/public event chain link broken/);
  });

  it("keeps the public event chain check independent from the media and text privacy boundary", () => {
    const events = validChain();
    expect(() => assertPublicEventChain(events)).not.toThrow();
    const pkg = validPackage();
    pkg.privacy.raw_pixels_published = true;
    expect(() => assertSelfHostedDemoContract(pkg)).toThrow(/privacy review/);
    expect(() => assertPublicEventChain(events)).not.toThrow();
  });
});
