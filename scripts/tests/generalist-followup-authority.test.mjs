import { describe, expect, it } from "vitest";
import { RUST_LANE } from "../generalist-demo.mjs";

describe("generalist lifecycle follow-up authority", () => {
  it("marks every committed acceptance oracle immutable and outside Specialist write authority", () => {
    expect(RUST_LANE.followups).toHaveLength(2);
    expect(RUST_LANE.followups[0].task).toContain("tests/checkpoint.rs is an operator-owned acceptance oracle and must not be modified");
    expect(RUST_LANE.followups[1].task).toContain("tests/retry_schedule.rs is an operator-owned acceptance oracle and must not be modified");
    for (const followup of RUST_LANE.followups) {
      for (const path of Object.keys(followup.files)) expect(followup.task).not.toContain(`authorized write paths are ${path}`);
    }
  });
});
