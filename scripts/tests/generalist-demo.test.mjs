import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, GENERALIST_LANES, RUST_LANE, verifyPackage } from "../generalist-demo.mjs";
import { GENERALIST_INTEGRATIONS, readinessCommandForIntegration, resolveGeneralistIntegration } from "../lib/generalist-integrations.mjs";

describe("cross-language generalist exemplar", () => {
  it("defines disjoint TypeScript, Python, and Go lanes with native acceptance", () => {
    expect(GENERALIST_LANES.map((lane) => lane.id)).toEqual(["typescript", "python", "go"]);
    expect(new Set(GENERALIST_LANES.map((lane) => lane.verify[0])).size).toBe(3);
  });

  it("creates a committed, intentionally incomplete fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "revoy-generalist-"));
    try {
      createFixture(root, GENERALIST_LANES[0]);
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain("empirical Revoy2 fixture");
      expect(readFileSync(join(root, "src", "intervals.ts"), "utf8")).toContain("intervals.sort");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defines a Rust/OpenCode breadth lane with a second committed lifecycle requirement", () => {
    expect(RUST_LANE.verify).toEqual(["cargo", "test", "--quiet"]);
    expect(RUST_LANE.followup_task).toContain("checkpoint continuation API");
    expect(RUST_LANE.followup_files["tests/checkpoint.rs"]).toContain("checkpoint_resumes_only_remaining");
  });

  it("uses one closed provider catalog for Claude Code, OpenCode, and Codex recordings", () => {
    expect(Object.keys(GENERALIST_INTEGRATIONS)).toEqual(["claude-code", "opencode", "codex"]);
    expect(readinessCommandForIntegration("codex")).toEqual(["codex", ["login", "status"]]);
    expect(GENERALIST_INTEGRATIONS.codex.disclosure).toContain("Codex CLI integration");
    expect(() => resolveGeneralistIntegration("unregistered")).toThrow(/claude-code, opencode, codex/);
  });

  it("rejects a package without successful independent acceptance", () => {
    expect(() => verifyPackage("/tmp", { lanes: GENERALIST_LANES.map((lane) => ({ id: lane.id, campaign_id: "campaign-x", initial_acceptance_exit_code: 1, final_acceptance_exit_code: lane.id === "go" ? 1 : 0, adoption_exit_code: 0, media: "missing.webm" })) })).toThrow();
  });
});
