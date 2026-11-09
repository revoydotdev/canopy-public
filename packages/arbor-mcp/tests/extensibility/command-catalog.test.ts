import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCatalog, CommandCatalogError, commandPaletteActions, invokeUserCommand } from "../../src/extensibility/command-catalog.js";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";

const command = (description: string, tools = "file.read, git.status") => `---\ndescription: ${description}\nallowed_tools: [${tools}]\nexecution_role: specialist-executor\nargument_hint: <path>\nskill_id: inspect-repository\n---\nInspect $1 with all arguments: $ARGUMENTS`;

describe("governed user commands", () => {
  it("rejects allowed_tools exceeding the selected role", () => {
    const catalog = new CommandCatalog();
    expect(() => catalog.register(command("unsafe", "file.read, made.up.root"), "unsafe.md")).toThrowError(CommandCatalogError);
    try { catalog.register(command("unsafe", "file.read, made.up.root"), "unsafe.md"); } catch (error) { expect((error as CommandCatalogError).code).toBe("command_escalation"); }
  });

  it("loads project over user, substitutes bounded arguments, fires lifecycle, and projects into the palette", () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-command-"));
    try {
      const user = join(root, "user"); const project = join(root, "project"); mkdirSync(user); mkdirSync(project);
      writeFileSync(join(user, "inspect.md"), command("user description"));
      writeFileSync(join(project, "inspect.md"), command("project description"));
      const catalog = CommandCatalog.fromLocations(user, project);
      expect(catalog.resolve("inspect")?.description).toBe("project description");
      const bus = new HookBus({ catalog: new HookCatalog() });
      const invoked = invokeUserCommand(catalog, "inspect", ["src/index.ts", "carefully"], bus);
      expect(invoked.rendered_prompt).toBe("Inspect src/index.ts with all arguments: src/index.ts carefully");
      expect(invoked.effective_tools).toEqual(["file.read", "git.status"]);
      expect(commandPaletteActions(catalog.list())).toMatchObject([{ id: "user-command:inspect", title: "/inspect", source: "command" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("captures only explicitly mapped positional values for an exact versioned skill", () => {
    const catalog = new CommandCatalog();
    catalog.register("---\ndescription: Process one supplied target\nallowed_tools: [file.read]\nexecution_role: specialist-executor\nskill_id: inspect-target\nskill_version: 1.2.3\nskill_input_arguments: target_path=$2, format=$1\n---\nProcess $ARGUMENTS", "process-target.md", "user");
    const invoked = invokeUserCommand(catalog, "process-target", ["brief", "src/main.ts"]);
    expect(invoked.skill_inputs).toEqual({ target_path: "src/main.ts", format: "brief" });
    expect(invoked.skill_inputs_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(invoked.command.descriptor_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails command invocation when a declared skill argument is missing", () => {
    const catalog = new CommandCatalog();
    catalog.register("---\ndescription: Process target\nallowed_tools: [file.read]\nexecution_role: specialist-executor\nskill_id: inspect-target\nskill_version: 1.2.3\nskill_input_arguments: target_path=$2\n---\nProcess target", "process-target.md", "user");
    expect(() => invokeUserCommand(catalog, "process-target", ["only-one"])).toThrow(/requires argument \$2/);
  });
});
