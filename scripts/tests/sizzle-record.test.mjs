import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeFlightEventHash, renderFlightFrames, validateFlightEvents } from "../flight-control-replay.mjs";
import { assertSecretFree, scanTextForSecrets } from "../lib/sizzle-redaction.mjs";
import { resolvePublicationSourceRevision } from "../sizzle-record.mjs";

const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function event(sequence, previousHash = null) {
  const value = {
    schema_version: 1, sequence, event_id: `event-${sequence}`, run_id: "flight-test", timestamp: `2026-08-20T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    stage: "topology", kind: "topology.online", status: "pass", caption: `Agent ${sequence} online`, source_repo_id: `repo-${sequence}`, actor_id: `crown-${sequence}`, actor_role: "orchestrator", previous_hash: previousHash,
  };
  return { ...value, hash: computeFlightEventHash(value) };
}

describe("flight-control publication primitives", () => {
  it("derives an exact source revision for publication manifests", () => {
    const repository = mkdtempSync(join(tmpdir(), "sizzle-source-revision-test-"));
    scratch.push(repository);
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "fixture@invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Fixture"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-q", "-m", "fixture"]);
    expect(resolvePublicationSourceRevision(repository)).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(repository, "README.md"), "tracked change\n");
    expect(() => resolvePublicationSourceRevision(repository)).toThrow(/tracked changes/);
  });

  it("accepts a contiguous hash chain when completeness is intentionally disabled for unit scope", () => {
    const first = event(1);
    const second = event(2, first.hash);
    expect(validateFlightEvents([first, second], { require_complete: false })).toHaveLength(2);
    expect(() => validateFlightEvents([{ ...first, caption: "tampered" }], { require_complete: false })).toThrow(/hash is invalid/);
  });

  it("rejects credential-shaped material without reproducing it in the finding", () => {
    const findings = scanTextForSecrets("authorization: Bearer abcdefghijklmnop");
    expect(findings.map((finding) => finding.code)).toContain("authorization_header");
    expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnop");
    expect(() => assertSecretFree("OPENAI_API_KEY=sk-proj-abcdefghijklmnop")).toThrow(/secret scan/);
  });

  it("renders deterministic 1920x1080 SVG source frames and a concat plan", () => {
    const directory = mkdtempSync(join(tmpdir(), "sizzle-render-test-"));
    scratch.push(directory);
    const first = event(1);
    const second = event(2, first.hash);
    const plan = renderFlightFrames([first, second], directory, { require_complete: false, seconds_per_event: 0.5, title: "TEST FLIGHT" });
    expect(plan).toMatchObject({ width: 1920, height: 1080, frames: 2 });
    expect(readFileSync(plan.frame_paths[0], "utf8")).toContain('viewBox="0 0 1920 1080"');
    expect(readFileSync(plan.concat_path, "utf8")).toContain("duration 1.050");
    expect(createHash("sha256").update(readFileSync(plan.frame_paths[0])).digest("hex")).toHaveLength(64);
  });
});
