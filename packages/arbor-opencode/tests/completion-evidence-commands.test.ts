/**
 * The specialist is told exactly which acceptance commands the harness will
 * run (B1, EC-061): the plan's own literal argv when declared, else the
 * project's configured commands, and nothing when neither exists.
 */
import { describe, expect, it } from "vitest";
import { acceptanceCommandsForAction, completionEvidenceProtocol } from "../src/loop.js";

const action = { description: "add greet()", constraints: [], acceptance_checks: ["greet returns a friendly message"] };

describe("acceptance commands in the completion evidence protocol", () => {
  it("names the project's configured commands, in order, when the plan declares none", () => {
    const text = completionEvidenceProtocol(action, { acceptance_commands: [["bun", "run", "tests:typecheck"], ["bun", "run", "test"]] });
    expect(text).toContain("The harness will run these acceptance commands, in order, fail-fast,");
    expect(text).toContain("$ bun run tests:typecheck");
    expect(text).toContain("$ bun run test");
    expect(text).toContain("report the exit status");
  });
  it("prefers the plan's literal declared command and ignores an intent entry", () => {
    const declared = { ...action, high_risk_tool_scope: { write_paths: ["src/greeting.ts"], command_argv: [{ argv_prefix: ["bun", "test"], purpose: "bound later" }, ["node", "--test", "greet.test.js"]] } } as never;
    expect(acceptanceCommandsForAction(declared, [["bun", "run", "test"]])).toEqual([["node", "--test", "greet.test.js"]]);
    expect(completionEvidenceProtocol(declared, { acceptance_commands: [["bun", "run", "test"]] })).toContain("$ node --test greet.test.js");
  });
  it("says nothing about commands when neither the plan nor the project authored one", () => {
    expect(completionEvidenceProtocol(action)).not.toContain("The harness will run");
  });
});
