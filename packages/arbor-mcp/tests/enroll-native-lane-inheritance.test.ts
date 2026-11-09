import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollProject } from "../src/project-lifecycle.js";
import { stripJsonc } from "@arbor/config";

/**
 * A project enrollment must not shadow the machine's native lane.
 *
 * The machine's provider, auth route, and model live in the user scope
 * (`~/.arbor/arbor.jsonc`, ADR-110) and are inherited by every clone. The
 * enrollment template used to pin `provider_id: "openrouter"` with a concrete
 * model id, so enrolling any project replaced a working lane with a provider
 * that has no credential on most machines -- and the CLI auth routes
 * (claude_code_cli / openai_codex_cli) then hard-fail with
 * provider_native_route_required instead of falling back.
 *
 * A project may still pin a provider deliberately. What it must not do is pin
 * one by default.
 */
describe("enrollment template does not shadow the machine native lane", () => {
  it("writes a config that declares no native block", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-enroll-native-"));
    try {
      enrollProject(root, { now: "2026-09-27T00:00:00.000Z" });
      const written = readFileSync(join(root, "arbor.jsonc"), "utf8");

      // The pinned provider must be guidance, not configuration.
      expect(written).not.toMatch(/^\s*"native"\s*:/m);
      // ...and the operator still has a copy-pasteable example in the file.
      expect(written).toMatch(/"native"\s*:\s*\{/);

      const document = JSON.parse(stripJsonc(written) ?? "{}") as Record<string, unknown>;
      expect(Object.keys(document)).not.toContain("native");
      expect(document.kb).toMatchObject({ backend: "jsonl" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
