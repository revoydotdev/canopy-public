import { describe, it, expect } from "vitest";
import { CONFORMANCE_SPEC, resolveElementTargets } from "../lib/conformance-spec.mjs";

describe("CONFORMANCE_SPEC — shape and classification", () => {
  it("is frozen (single source of truth, not mutable by a consumer)", () => {
    expect(Object.isFrozen(CONFORMANCE_SPEC)).toBe(true);
  });

  it("every element has id, kind, target, requirement, remedy", () => {
    for (const element of CONFORMANCE_SPEC) {
      expect(typeof element.id).toBe("string");
      expect(["dir", "file", "script", "marker"]).toContain(element.kind);
      expect(element.target).toBeDefined();
      expect(["required", "required_via_profile", "optional"]).toContain(element.requirement);
      expect(typeof element.remedy).toBe("string");
    }
  });

  it("has no duplicate ids", () => {
    const ids = CONFORMANCE_SPEC.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a marker-kind element carries a marker string", () => {
    for (const element of CONFORMANCE_SPEC.filter((e) => e.kind === "marker")) {
      expect(typeof element.marker).toBe("string");
      expect(element.marker.length).toBeGreaterThan(0);
    }
  });

  it("includes at least one required, one required_via_profile, and one optional element", () => {
    const requirements = new Set(CONFORMANCE_SPEC.map((e) => e.requirement));
    expect(requirements.has("required")).toBe(true);
    expect(requirements.has("required_via_profile")).toBe(true);
    expect(requirements.has("optional")).toBe(true);
  });
});

describe("resolveElementTargets — the one place that interprets a profile-derived target", () => {
  const profile = {
    source_roots: ["packages", "crates"],
    commands: { typecheck: "typecheck", test: "" },
  };

  it("returns a literal string target unchanged, as a single-element array", () => {
    expect(resolveElementTargets({ target: "decisions" }, profile)).toEqual(["decisions"]);
  });

  it("resolves a profilePath pointing at an array field to every entry", () => {
    expect(resolveElementTargets({ target: { profilePath: "source_roots" } }, profile)).toEqual(["packages", "crates"]);
  });

  it("resolves a profilePath pointing at a nested string field", () => {
    expect(resolveElementTargets({ target: { profilePath: "commands.typecheck" } }, profile)).toEqual(["typecheck"]);
  });

  it("returns an empty array when the profile omits the referenced field", () => {
    expect(resolveElementTargets({ target: { profilePath: "commands.reachability" } }, profile)).toEqual([]);
  });

  it("returns an empty array for an empty-string field rather than a bogus target", () => {
    expect(resolveElementTargets({ target: { profilePath: "commands.test" } }, profile)).toEqual([]);
  });

  it("filters out non-string entries from an array field defensively", () => {
    const dirty = { source_roots: ["packages", 42, null] };
    expect(resolveElementTargets({ target: { profilePath: "source_roots" } }, dirty)).toEqual(["packages"]);
  });
});
