import { describe, expect, it } from "vitest";
import { UPSTREAM_CANARIES, assessCanaryEvidence, canaryPersistenceDirectory, pinnedFetchArgs, prepareGeneratorDependencies, requirementFiles, sanitizeText, summarizeFailureAudit } from "../upstream-canary.mjs";

describe("pinned upstream repository canary", () => {
  it("uses a closed, exact-revision catalog and labels the task as injected evidence", () => {
    const spec = UPSTREAM_CANARIES.byteorder;
    expect(Object.keys(UPSTREAM_CANARIES)).toEqual(["byteorder", "yocto-queue"]);
    expect(spec.repository).toBe("https://github.com/BurntSushi/byteorder.git");
    expect(spec.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(spec.license).toBe("Unlicense OR MIT");
    expect(spec.requirement_path).toBe("tests/revoy_u40_canary.rs");
    expect(spec.requirement_contents).toContain("read_u40");
    expect(spec.verification).toEqual(["cargo", "test", "--quiet"]);
  });

  it("covers a dependency-backed JavaScript production repository with an atomic iterable requirement", () => {
    const spec = UPSTREAM_CANARIES["yocto-queue"];
    expect(spec.repository).toBe("https://github.com/sindresorhus/yocto-queue.git");
    expect(spec.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(spec.license).toBe("MIT");
    expect(spec.prepare).toEqual(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]);
    expect(spec.verification).toEqual(["npm", "test"]);
    expect(requirementFiles(spec)).toEqual([
      expect.objectContaining({ path: "revoy-enqueue-all.test.js", contents: expect.stringContaining("is atomic") }),
    ]);
  });

  it("normalizes the legacy single-file requirement into the cohort contract", () => {
    expect(requirementFiles(UPSTREAM_CANARIES.byteorder)).toEqual([
      { path: "tests/revoy_u40_canary.rs", contents: expect.stringContaining("read_u40") },
    ]);
  });

  it("fetches complete ancestry rather than constructing a shallow isolation input", () => {
    expect(pinnedFetchArgs(UPSTREAM_CANARIES.byteorder)).toEqual([
      "fetch", "--quiet", "origin", UPSTREAM_CANARIES.byteorder.revision,
    ]);
  });

  it("reduces failed audit evidence without publishing specialist output", () => {
    const reduced = summarizeFailureAudit([JSON.stringify({
      kind: "trace", node_id: "node-1", parent_id: "root", action_description: "bounded action",
      node_state_before: "pending", node_state_after: "failed", provenance: { tag: "claimed" },
      critic_agent: "lenticel", critic_verdict_approved: false, critic_root_cause: "tests failed",
      specialist_output: "private provider transcript", gates: [{ gate: "evidence", result: "fail", detail: "missing" }],
    })]);
    expect(reduced).toEqual([expect.objectContaining({ node_id: "node-1", critic_root_cause: "tests failed" })]);
    expect(JSON.stringify(reduced)).not.toContain("private provider transcript");
  });

  it("redacts credential shapes without corrupting task-composer identifiers", () => {
    expect(sanitizeText("task-composer-run:draft-1", [])).toBe("task-composer-run:draft-1");
    expect(sanitizeText("token=abcdefghijklmnop", [])).toBe("token=abcdefghijklmnop");
    expect(sanitizeText("sk-abcdefghijklmnop", [])).toBe("[credential withheld]");
  });

  it("requires a red baseline, attributable campaign, adoption, native acceptance, and a source change", () => {
    expect(assessCanaryEvidence({
      upstream_revision: UPSTREAM_CANARIES.byteorder.revision,
      baseline_exit_code: 101,
      campaign_ok: true,
      campaign_id: "composer-draft-example",
      adoption_exit_code: 0,
      verification_exit_code: 0,
      changed_paths: ["src/lib.rs"],
    })).toEqual({ ok: true, gaps: [] });
  });

  it("keeps campaign persistence inside the governed upstream workspace", () => {
    expect(canaryPersistenceDirectory("/tmp/upstream-workspace")).toBe("/tmp/upstream-workspace/.arbor-evidence");
  });

  it("materializes a clean generator from its frozen lockfile and rechecks source identity", () => {
    const calls = [];
    const command = prepareGeneratorDependencies({ root: "/tmp/generator" }, (program, args, options) => {
      calls.push({ program, args, options });
      return { exit_code: 0, stdout: "", stderr: "" };
    });
    expect(command).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(calls).toEqual([
      { program: "bun", args: ["install", "--frozen-lockfile"], options: { cwd: "/tmp/generator", timeout: 600_000 } },
      { program: "git", args: ["status", "--porcelain"], options: { cwd: "/tmp/generator" } },
    ]);
  });

  it("refuses a generator whose dependency preparation changes source bytes", () => {
    expect(() => prepareGeneratorDependencies({ root: "/tmp/generator" }, (program) => ({
      exit_code: 0,
      stdout: program === "git" ? " M bun.lock\n" : "",
      stderr: "",
    }))).toThrow("generator dependency preparation changed tracked or untracked source bytes");
  });

  it("fails closed on every hollow success shape", () => {
    expect(assessCanaryEvidence({
      upstream_revision: "HEAD",
      baseline_exit_code: 0,
      campaign_ok: false,
      campaign_id: "",
      adoption_exit_code: 1,
      verification_exit_code: 1,
      changed_paths: [],
    })).toEqual({
      ok: false,
      gaps: [
        "unpinned_upstream_revision",
        "baseline_not_failing",
        "campaign_not_attributable",
        "verified_result_not_adopted",
        "native_acceptance_not_green",
        "no_adopted_source_change",
      ],
    });
  });
});
