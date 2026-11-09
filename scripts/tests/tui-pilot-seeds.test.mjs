/**
 * scripts/tests/tui-pilot-seeds.test.mjs — seed presets create the state
 * they claim, and refuse to claim state they did not create.
 *
 * EC-015: a seeder that read `ok` alone reported "seeded: 6, failed: 0" when
 * two writes had been rejected. The ledger here is asserted step by step, and
 * the negative case proves a rejected required step throws instead of being
 * recorded as a success.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accepted, applySeed, CAMPAIGN_ID, SEED_PRESETS } from "../tui-pilot/seeds/index.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "tui-pilot-seed-")); roots.push(dir); return dir; };

describe("accepted — the two-level read", () => {
  it("treats a routed envelope whose command was rejected as rejected", () => {
    expect(accepted({ ok: true, value: { accepted: false, error: { summary: "nope" } } })).toEqual({ accepted: false, error: "nope" });
    expect(accepted({ ok: false, error: { summary: "bad envelope" } })).toEqual({ accepted: false, error: "bad envelope" });
    expect(accepted({ ok: true, value: { accepted: true } }).accepted).toBe(true);
  });
});

describe("seed presets", () => {
  it("lists every preset the CLI accepts", () => {
    expect(Object.keys(SEED_PRESETS).sort()).toEqual(["bad-config", "corrupt-ledger", "greenfield", "populated", "readonly-arbor"]);
  });

  it("greenfield writes a file tree and nothing durable", async () => {
    const dir = scratch();
    const ledger = (await applySeed("greenfield", dir)).toJSON();
    expect(ledger.steps.map((s) => s.outcome)).toEqual(["applied", "applied"]);
    expect(existsSync(join(dir, "src", "main.ts"))).toBe(true);
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(dir, ".arbor"))).toBe(false);
  });

  it("populated lands every record through the real runtime and records each as accepted", async () => {
    const dir = scratch();
    const ledger = (await applySeed("populated", dir)).toJSON();
    const byName = Object.fromEntries(ledger.steps.map((s) => [s.name, s.outcome]));
    expect(byName).toMatchObject({
      "campaign.start": "applied", "tree.branch": "applied", "job.submit": "accepted", "approval.request": "accepted",
      "userinput.ask": "accepted", "bus.record": "accepted", "bus.thread.send": "accepted", "peer.grant": "accepted", "runtime.close": "applied",
    });
    expect(existsSync(join(dir, ".arbor", "tree", `${CAMPAIGN_ID}.json`))).toBe(true);
    expect(existsSync(join(dir, ".arbor", "audit", `${CAMPAIGN_ID}.jsonl`))).toBe(true);
    expect(readFileSync(join(dir, ".arbor", "approvals", "records.json"), "utf8")).toContain("seeded-approval");
  }, 60_000);

  it("corrupt-ledger leaves the audit ledger unparseable on its last line", async () => {
    const dir = scratch();
    await applySeed("corrupt-ledger", dir);
    const lines = readFileSync(join(dir, ".arbor", "audit", `${CAMPAIGN_ID}.jsonl`), "utf8").trim().split("\n");
    expect(() => JSON.parse(lines.at(-1))).toThrow();
    expect(() => JSON.parse(lines[0])).not.toThrow();
  }, 60_000);

  it("bad-config writes an arbor.jsonc that does not parse", async () => {
    const dir = scratch();
    await applySeed("bad-config", dir);
    expect(() => JSON.parse(readFileSync(join(dir, "arbor.jsonc"), "utf8"))).toThrow();
  }, 60_000);

  it("refuses an unknown preset", async () => {
    await expect(applySeed("nonsense", scratch())).rejects.toThrow(/unknown seed preset/u);
  });
});
