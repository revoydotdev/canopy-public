import { describe, expect, it } from "vitest";
import { scriptArguments, validateCommandArguments } from "../record-terminal-session.mjs";

describe("secret-safe terminal recording launcher", () => {
  it("accepts ordinary argv and preserves argument boundaries through script", () => {
    const command = validateCommandArguments(["bun", "tool.mjs", "value with spaces"], {});
    expect(scriptArguments(command, "/mnt/sda2/raw", "/mnt/sda2/timing")).toEqual([
      "--quiet", "--flush", "--log-out", "/mnt/sda2/raw", "--log-timing", "/mnt/sda2/timing", "--command", "'bun' 'tool.mjs' 'value with spaces'",
    ]);
  });

  it("rejects credential assignments and inherited secret values without echoing either", () => {
    const secret = "test-secret-value-123456";
    for (const command of [["env", `OPENROUTER_API_KEY=${secret}`, "bun"], ["bun", "tool.mjs", secret]]) {
      expect(() => validateCommandArguments(command, { OPENROUTER_API_KEY: secret })).toThrow("inherit secrets through the environment");
      try { validateCommandArguments(command, { OPENROUTER_API_KEY: secret }); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });
});
