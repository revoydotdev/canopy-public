import { canaryState, seedBranch } from "../src/seed.js";

test("turns the branch on", () => {
  canaryState.flag = true;
  expect(seedBranch()).toBe(1);
});
