import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  composeOrganizationPolicy,
  isPolicyDomainAllowed,
  loadConfig,
  loadOrganizationPolicyFromString,
  loadOrganizationPolicyOverlayFromString,
} from "../src/index.js";

const policy = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: 1,
  policy_id: "company-network-v1",
  network: { allowed_domains: ["API.Example.test.", "docs.example.test"] },
  native_approval: { allowed_tools: ["file.patch", "file.write", "shell.execute"] },
  startup: { safe_mode: false },
  ...overrides,
});

describe("organization policy floor", () => {
  it("normalizes an explicit domain allowlist and matches exact domains only", () => {
    const loaded = loadOrganizationPolicyFromString(policy());
    expect(loaded.network.allowed_domains).toEqual(["api.example.test", "docs.example.test"]);
    expect(isPolicyDomainAllowed(loaded, "API.EXAMPLE.TEST.")).toBe(true);
    expect(isPolicyDomainAllowed(loaded, "sub.api.example.test")).toBe(false);
    expect(isPolicyDomainAllowed(loaded, "https://api.example.test")).toBe(false);
  });

  it("allows project and user layers to narrow, never expand, the organization floor", () => {
    const organization = loadOrganizationPolicyFromString(policy());
    const project = loadOrganizationPolicyOverlayFromString(JSON.stringify({
      network: { allowed_domains: ["api.example.test"] },
      native_approval: { allowed_tools: ["file.patch", "file.write"] },
      startup: { safe_mode: true },
    }));
    const user = loadOrganizationPolicyOverlayFromString(JSON.stringify({
      native_approval: { allowed_tools: ["file.write"] },
    }));
    expect(composeOrganizationPolicy({ organization, project, user })).toMatchObject({
      network: { allowed_domains: ["api.example.test"] },
      native_approval: { allowed_tools: ["file.write"] },
      startup: { safe_mode: true },
    });

    expect(() => composeOrganizationPolicy({ organization, project: loadOrganizationPolicyOverlayFromString(JSON.stringify({ network: { allowed_domains: ["other.example.test"] } })) })).toThrow(/weakens organization policy/);
    expect(() => composeOrganizationPolicy({ organization, project: loadOrganizationPolicyOverlayFromString(JSON.stringify({ native_approval: { allowed_tools: ["shell.execute", "deploy.publish"] } })) })).toThrow(/weakens organization policy/);
  });

  it("fails closed when a lower layer attempts to turn off an organization safe-mode floor", () => {
    const organization = loadOrganizationPolicyFromString(policy({ startup: { safe_mode: true } }));
    const weak = loadOrganizationPolicyOverlayFromString(JSON.stringify({ startup: { safe_mode: false } }));
    expect(() => composeOrganizationPolicy({ organization, project: weak })).toThrow(/startup.safe_mode/);
  });

  it("fails closed for malformed, unknown, and ambiguous policy input", () => {
    expect(() => loadOrganizationPolicyFromString("{ nope")).toThrow(/malformed/);
    expect(() => loadOrganizationPolicyFromString(policy({ network: { allowed_domains: ["*.example.test"] } }))).toThrow(/invalid policy domain/);
    expect(() => loadOrganizationPolicyFromString(policy({ ignored: true }))).toThrow(/unknown field/);
    expect(() => loadOrganizationPolicyOverlayFromString(JSON.stringify({ startup: { safe_mode: "false" } }))).toThrow(/must be boolean/);
  });

  describe("coexistence with loader.ts's precedence chain (ADR-110 Decision 3)", () => {
    let projectDir: string;
    let userDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "arbor-config-test-project-"));
      userDir = mkdtempSync(join(tmpdir(), "arbor-config-test-user-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    });

    it("ArborConfig (the precedence-chain schema) declares none of the floor's knob paths, so the two mechanisms cannot collide on the same path", () => {
      expect(Object.keys(DEFAULT_CONFIG)).not.toContain("network");
      expect(Object.keys(DEFAULT_CONFIG)).not.toContain("native_approval");
      expect(Object.keys(DEFAULT_CONFIG)).not.toContain("startup");
    });

    it("a project arbor.jsonc can freely override an ordinary preference knob while the organization floor keeps rejecting any weakening of its own knobs, in the same process", () => {
      // Ordinary precedence: project always wins over what a lower scope would have supplied — no ratchet.
      writeFileSync(join(projectDir, "arbor.jsonc"), JSON.stringify({ kb: { backend: "sqlite" } }));
      const config = loadConfig(projectDir, { ARBOR_USER_CONFIG_DIR: userDir });
      expect(config.kb.backend).toBe("sqlite");

      // Floor: a lower layer may narrow but never widen, regardless of what the sibling arbor.jsonc precedence chain just did.
      const organization = loadOrganizationPolicyFromString(policy({ startup: { safe_mode: true } }));
      expect(() => composeOrganizationPolicy({
        organization,
        project: loadOrganizationPolicyOverlayFromString(JSON.stringify({ startup: { safe_mode: false } })),
      })).toThrow(/startup.safe_mode/);
    });
  });
});
