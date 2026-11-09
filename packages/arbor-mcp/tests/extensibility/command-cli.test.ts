import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../../src/cli.js";
import { createTaskIntakeFilesystemFixture } from "../helpers/task-intake-filesystem-fixture.js";

describe("user command CLI", () => {
  it("submits a rendered command through the governed task-composer boundary", async () => {
    const fixture = createTaskIntakeFilesystemFixture(); const root = fixture.root;
    try {
      const directory = join(root, ".arbor", "commands"); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "deliver.md"), "---\ndescription: Deliver a verified file\nallowed_tools: [file.write]\nexecution_role: specialist-executor\nargument_hint: <requirement>\nskill_id: deliver-file\nskill_version: 1.0.0\nskill_input_arguments: requirement=$1\n---\nCreate delivered.txt with $1");
      const stdout = new PassThrough(); const stderr = new PassThrough(); let output = ""; let errors = "";
      stdout.on("data", (chunk) => { output += chunk.toString(); }); stderr.on("data", (chunk) => { errors += chunk.toString(); });
      const code = await main(["command", "deliver", "the", "requested", "verified", "content"], { cwd: root, persistence_dir: fixture.persistence, stdin: new PassThrough(), stdout, stderr, env: {}, runtime_factory: () => fixture.runtime });
      expect(code).toBe(0); expect(errors).toBe(""); expect(output).toContain('"accepted": true'); expect(output).toContain("governed-command:deliver"); expect(readFileSync(fixture.targetFile, "utf8")).toBe(fixture.expectedContent);
      const drafts = fixture.runtime.taskComposer.query({ kind: "taskcomposer.list", limit: 1 });
      const action = drafts !== null && "items" in drafts ? drafts.items[0]?.proposal?.actions[0] : undefined;
      expect(action).toMatchObject({ skill_id: "deliver-file", skill_version: "1.0.0", skill_inputs: { requirement: "the" }, skill_inputs_provenance: { tag: "claimed", claimant: "cli-command", command_name: "deliver", command_descriptor_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), input_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
