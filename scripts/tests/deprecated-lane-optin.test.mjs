import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDeprecatedLaneOptIn, deprecatedLaneOptInStatus } from "../lib/deprecated-lane-optin.mjs";

function project(config) {
  const root = mkdtempSync(join(tmpdir(), "optin-"));
  const user = mkdtempSync(join(tmpdir(), "optin-user-"));
  if (config !== undefined) writeFileSync(join(root, "arbor.jsonc"), config);
  return { root, env: { ARBOR_USER_CONFIG_DIR: user }, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(user, { recursive: true, force: true }); } };
}

describe("deprecated-lane script opt-in preflight (ADR-192)", () => {
  it("refuses without the config opt-in and names the remedy", () => {
    const p = project();
    try {
      expect(deprecatedLaneOptInStatus(p.root, p.env).admitted).toBe(false);
      expect(() => assertDeprecatedLaneOptIn(p.root, "claude-code", "x.mjs", p.env)).toThrow(/connectors\.allow_deprecated: true/);
    } finally { p.done(); }
  });

  it("admits with allow_deprecated and a reason", () => {
    const p = project('{ "connectors": { "allow_deprecated": true, "reason": "connector demo" } }');
    try {
      expect(assertDeprecatedLaneOptIn(p.root, "codex", "x.mjs", p.env)).toEqual({ admitted: true, reason: "connector demo" });
    } finally { p.done(); }
  });
});
