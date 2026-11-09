// Canary fixture: the one test file the registry above names. It exists so
// `test_id` reachability passes and the fixture's only defect remains the
// schema_version. It is never executed — `--verify` only checks that the path
// resolves to a collected test file.
import { expect, it } from "vitest";

it("canary", () => {
  expect(true).toBe(true);
});
