import { describe, expect, it } from "vitest";
import {
  ACTION_CLASSES,
  CapabilityError,
  entitledActionClasses,
  enforceAction,
  isMutating,
  requiredCapability,
} from "../src/capability.js";

describe("capability action gate", () => {
  it("classifies preview-confirm as the only mutating class", () => {
    expect(isMutating("read")).toBe(false);
    expect(isMutating("plan")).toBe(false);
    expect(isMutating("preview-confirm")).toBe(true);
    expect(isMutating("forbidden")).toBe(false);
  });

  it("read and plan are junior; preview-confirm is senior; forbidden is never allowed", () => {
    expect(requiredCapability("read")).toBe("junior");
    expect(requiredCapability("plan")).toBe("junior");
    expect(requiredCapability("preview-confirm")).toBe("senior");
    expect(requiredCapability("forbidden")).toBeNull();
  });

  it("junior is entitled to read+plan but not preview-confirm", () => {
    const entitled = entitledActionClasses("junior");
    expect(entitled).toContain("read");
    expect(entitled).toContain("plan");
    expect(entitled).not.toContain("preview-confirm");
    expect(entitled).not.toContain("forbidden");
  });

  it("senior is entitled to all executable classes", () => {
    const entitled = entitledActionClasses("senior");
    expect(entitled).toContain("preview-confirm");
    expect(entitled).not.toContain("forbidden");
  });

  it("enforceAction allows a senior to mutate", () => {
    expect(() => enforceAction("preview-confirm", "senior", "ops_edit")).not.toThrow();
  });

  it("enforceAction raises CapabilityError for a junior mutation", () => {
    expect(() => enforceAction("preview-confirm", "junior", "ops_edit")).toThrow(CapabilityError);
    try {
      enforceAction("preview-confirm", "junior", "ops_edit");
    } catch (e) {
      const err = e as CapabilityError;
      expect(err.actionClass).toBe("preview-confirm");
      expect(err.tier).toBe("junior");
      expect(err.attemptedAction).toBe("ops_edit");
    }
  });

  it("forbidden raises even for senior", () => {
    expect(() => enforceAction("forbidden", "senior", "x")).toThrow(CapabilityError);
  });

  it("ACTION_CLASSES is the closed 4-element union", () => {
    expect(ACTION_CLASSES).toEqual(["read", "plan", "preview-confirm", "forbidden"]);
  });
});
