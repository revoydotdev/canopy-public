import { expect, test } from "vitest";

// Canary placeholder. The real file of this name is the projection's own
// fixture suite; the gate's wiring and export legs are what this canary
// exercises, and those read source text, not this file's assertions. This test
// exists so the gate's vitest leg passes and the wiring failure stands alone.
test("canary placeholder", () => {
  expect(true).toBe(true);
});
