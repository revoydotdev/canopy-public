import { describe, expect, it } from "vitest";
import { arborPlugin } from "../src/plugin.js";
import { permissionsFor } from "../src/permissions.js";

// WA-19: `mergePermissions` was last-write-wins with no floor — a project or
// user opencode.json override could grant a critic (lenticel/burl/xylem)
// `edit`/`write`/`task`, defeating ADR-001's structural no-self-approval
// guarantee (a critic must never both propose and approve its own work).
// This drives the real config hook end-to-end, not a private helper.
describe("WA-19: critic/auditor permission deny-wins clamp", () => {
  it("drops an override that loosens a critic's edit/write/task below base, and records why", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const config: Record<string, unknown> = {
      agent: { lenticel: { permission: { edit: "allow", write: "allow", task: { seed: "allow" } } } },
    };
    await hooks.config!({ config });

    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>;
    const base = permissionsFor("lenticel", { canDelegate: false });
    expect(agent.lenticel.permission.edit).toBe(base.edit);
    expect(agent.lenticel.permission.write).toBe(base.write);
    expect(agent.lenticel.permission.task).toBe(base.task);

    const diagnostics = config.arbor_permission_diagnostics as Array<{ agent: string; key: string; attempted: unknown }>;
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "lenticel", key: "edit", attempted: "allow" }),
      expect.objectContaining({ agent: "lenticel", key: "write", attempted: "allow" }),
      expect.objectContaining({ agent: "lenticel", key: "task", attempted: { seed: "allow" } }),
    ]));
  });

  it("still applies a tightening override for a critic", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const config: Record<string, unknown> = {
      agent: { burl: { permission: { bash: { "*": "deny" } } } },
    };
    await hooks.config!({ config });

    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>;
    expect(agent.burl.permission.bash).toMatchObject({ "*": "deny" });
    expect(config.arbor_permission_diagnostics).toBeUndefined();
  });

  it("mixed glob loosening (any allow entry) is clamped for a critic's task permission", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const config: Record<string, unknown> = {
      agent: { xylem: { permission: { task: { rhizome: "deny", mycelium: "allow" } } } },
    };
    await hooks.config!({ config });

    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>;
    const base = permissionsFor("xylem", { canDelegate: false });
    expect(agent.xylem.permission.task).toBe(base.task);
    const diagnostics = config.arbor_permission_diagnostics as Array<{ agent: string; key: string }>;
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "xylem", key: "task" })]));
  });

  it("is a no-op for non-critic tiers — a specialist's edit override still applies", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const config: Record<string, unknown> = {
      agent: { rhizome: { permission: { edit: "allow" } } },
    };
    await hooks.config!({ config });

    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>;
    expect(agent.rhizome.permission.edit).toBe("allow");
    expect(config.arbor_permission_diagnostics).toBeUndefined();
  });

  it("calls the opencode client's real /log diagnostics channel when the host supplies one, never console.log", async () => {
    const logged: Array<{ body: { message: string } }> = [];
    const hooks = await arborPlugin({
      project: {}, directory: ".", worktree: ".",
      client: { app: { log: async (options: { body: { message: string } }) => { logged.push(options); } } },
    } as never);
    const config: Record<string, unknown> = { agent: { lenticel: { permission: { edit: "allow" } } } };
    await hooks.config!({ config });
    expect(logged).toHaveLength(1);
    expect(logged[0]!.body.message).toContain("lenticel");
  });
});
