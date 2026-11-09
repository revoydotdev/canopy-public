/**
 * scripts/tests/waiver-store.test.mjs — unit coverage for
 * scripts/lib/waiver-store.mjs, the one waiver primitive shared by
 * reachability.mjs's allowlist, branch-accounting.mjs's dispositions, and
 * anti-stub.mjs's triage store.
 *
 * The gate-level fail-then-pass proofs (an expired/malformed entry actually
 * failing each real gate) live beside each store's own tests
 * (reachability's are inline in the gate's own test suite pattern via
 * `--allowlist`, branch-accounting.test.mjs's `--dispositions`, and
 * anti-stub-triage-expiry.test.mjs's `--triage`). This file is the narrower
 * unit surface: the validator, the expiry predicate, and the CRUD helpers
 * exactly as documented in the module itself.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WAIVER_SCHEMAS,
  validateWaiverEntry,
  isWaiverExpired,
  findWaiverEntry,
  loadWaiverFile,
  writeWaiverFile,
  addWaiverEntry,
  renewWaiverEntry,
  removeWaiverEntry,
} from "../lib/waiver-store.mjs";

describe("WAIVER_SCHEMAS", () => {
  it("declares exactly the five migrated stores", () => {
    expect(Object.keys(WAIVER_SCHEMAS).sort()).toEqual(["anti-stub", "branch-accounting", "closed-enum-hygiene", "reachability", "tui-catalog-parity"]);
  });

  it("reachability and branch-accounting always require an expiry; anti-stub only for accepted_tradeoff", () => {
    expect(WAIVER_SCHEMAS.reachability.requiresExpiry({})).toBe(true);
    expect(WAIVER_SCHEMAS["branch-accounting"].requiresExpiry({})).toBe(true);
    expect(WAIVER_SCHEMAS["anti-stub"].requiresExpiry({ verdict: "false_positive" })).toBe(false);
    expect(WAIVER_SCHEMAS["anti-stub"].requiresExpiry({ verdict: "accepted_tradeoff" })).toBe(true);
  });
});

describe("validateWaiverEntry", () => {
  it("accepts a well-formed reachability entry", () => {
    const { ok, errors } = validateWaiverEntry(
      { symbol: "foo", file: "packages/x/src/y.ts", reason: "still needed", expires: "2099-01-01" },
      "reachability",
    );
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it("rejects a reachability entry missing a key field", () => {
    const { ok, errors } = validateWaiverEntry({ file: "y.ts", reason: "x", expires: "2099-01-01" }, "reachability");
    expect(ok).toBe(false);
    expect(errors.join(" ")).toMatch(/symbol/);
  });

  it("rejects a reachability entry missing reason", () => {
    const { ok, errors } = validateWaiverEntry({ symbol: "foo", file: "y.ts", expires: "2099-01-01" }, "reachability");
    expect(ok).toBe(false);
    expect(errors.join(" ")).toMatch(/reason/);
  });

  it("rejects an unparseable expires date", () => {
    const { ok, errors } = validateWaiverEntry({ symbol: "foo", file: "y.ts", reason: "x", expires: "not-a-date" }, "reachability");
    expect(ok).toBe(false);
    expect(errors.join(" ")).toMatch(/expires/);
  });

  it("branch-accounting requires branch, reason, expires", () => {
    expect(validateWaiverEntry({ branch: "b", reason: "r", expires: "2099-01-01" }, "branch-accounting").ok).toBe(true);
    expect(validateWaiverEntry({ reason: "r", expires: "2099-01-01" }, "branch-accounting").ok).toBe(false);
  });

  it("anti-stub false_positive needs no expires; accepted_tradeoff does", () => {
    expect(
      validateWaiverEntry({ rule: "rule1", file: "f.ts", symbol: "s", verdict: "false_positive", reason: "r" }, "anti-stub").ok,
    ).toBe(true);
    expect(
      validateWaiverEntry({ rule: "rule1", file: "f.ts", symbol: "s", verdict: "accepted_tradeoff", reason: "r" }, "anti-stub").ok,
    ).toBe(false);
    expect(
      validateWaiverEntry(
        { rule: "rule1", file: "f.ts", symbol: "s", verdict: "accepted_tradeoff", reason: "r", expires: "2099-01-01" },
        "anti-stub",
      ).ok,
    ).toBe(true);
  });

  it("rejects an unknown verdict for anti-stub", () => {
    const { ok, errors } = validateWaiverEntry({ rule: "rule1", file: "f.ts", symbol: "s", verdict: "maybe", reason: "r" }, "anti-stub");
    expect(ok).toBe(false);
    expect(errors.join(" ")).toMatch(/verdict/);
  });

  it("throws on an unknown store name", () => {
    expect(() => validateWaiverEntry({}, "not-a-real-store")).toThrow(/unknown schema/);
  });
});

describe("isWaiverExpired", () => {
  it("an in-date entry is not expired", () => {
    expect(isWaiverExpired({ expires: "2099-01-01" }, "reachability", "2026-08-18")).toBe(false);
  });
  it("a past-date entry is expired", () => {
    expect(isWaiverExpired({ expires: "2020-01-01" }, "reachability", "2026-08-18")).toBe(true);
  });
  it("a false_positive anti-stub entry never expires, even with no expires field", () => {
    expect(isWaiverExpired({ verdict: "false_positive" }, "anti-stub", "2099-01-01")).toBe(false);
  });
  it("an accepted_tradeoff anti-stub entry with a missing/malformed expires is treated as expired (fail closed)", () => {
    expect(isWaiverExpired({ verdict: "accepted_tradeoff" }, "anti-stub", "2026-08-18")).toBe(true);
    expect(isWaiverExpired({ verdict: "accepted_tradeoff", expires: "not-a-date" }, "anti-stub", "2026-08-18")).toBe(true);
  });
});

describe("findWaiverEntry", () => {
  it("finds by every key field, not just one", () => {
    const entries = [
      { symbol: "a", file: "x.ts", reason: "r", expires: "2099-01-01" },
      { symbol: "a", file: "y.ts", reason: "r", expires: "2099-01-01" },
    ];
    expect(findWaiverEntry(entries, { symbol: "a", file: "y.ts" }, "reachability")).toBe(entries[1]);
    expect(findWaiverEntry(entries, { symbol: "a", file: "z.ts" }, "reachability")).toBeUndefined();
  });
});

describe("loadWaiverFile / writeWaiverFile round trip", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "waiver-store-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing file is an empty store with no error", () => {
    const { entries, error } = loadWaiverFile(join(dir, "nope.json"));
    expect(entries).toEqual([]);
    expect(error).toBeNull();
  });

  it("an unparseable file is an empty store WITH an error (fail closed)", () => {
    const path = join(dir, "bad.json");
    fsWriteFileSync(path, "{ not json");
    const { entries, error } = loadWaiverFile(path);
    expect(entries).toEqual([]);
    expect(error).toMatch(/unparseable/);
  });

  it("a file with no entries array is an empty store WITH an error", () => {
    const path = join(dir, "no-entries.json");
    fsWriteFileSync(path, JSON.stringify({ version: 1 }));
    const { entries, error } = loadWaiverFile(path);
    expect(entries).toEqual([]);
    expect(error).toMatch(/entries/);
  });

  it("writeWaiverFile preserves wrapper fields other than entries", () => {
    const path = join(dir, "store.json");
    writeWaiverFile(path, [{ symbol: "a", file: "x.ts", reason: "r", expires: "2099-01-01" }], { version: 1, $schemaNote: "note" });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.version).toBe(1);
    expect(written.$schemaNote).toBe("note");
    expect(written.entries).toHaveLength(1);
  });

  it("round-trips through loadWaiverFile", () => {
    const path = join(dir, "store.json");
    writeWaiverFile(path, [{ symbol: "a", file: "x.ts", reason: "r", expires: "2099-01-01" }], { version: 1 });
    const { entries, error, wrapper } = loadWaiverFile(path);
    expect(error).toBeNull();
    expect(entries).toHaveLength(1);
    expect(wrapper.version).toBe(1);
  });
});

describe("CRUD helpers", () => {
  const schema = "reachability";
  const valid = { symbol: "a", file: "x.ts", reason: "r", expires: "2099-01-01" };

  it("addWaiverEntry appends a valid entry", () => {
    const next = addWaiverEntry([], valid, schema);
    expect(next).toEqual([valid]);
  });

  it("addWaiverEntry throws on an invalid entry", () => {
    expect(() => addWaiverEntry([], { symbol: "a", file: "x.ts" }, schema)).toThrow(/invalid waiver entry/);
  });

  it("addWaiverEntry throws on a duplicate key", () => {
    expect(() => addWaiverEntry([valid], valid, schema)).toThrow(/already exists/);
  });

  it("renewWaiverEntry updates expires/reason and re-validates", () => {
    const next = renewWaiverEntry([valid], { symbol: "a", file: "x.ts" }, { expires: "2100-01-01" }, schema);
    expect(next[0].expires).toBe("2100-01-01");
    expect(next[0].reason).toBe("r");
  });

  it("renewWaiverEntry throws if the renewal would be invalid", () => {
    expect(() => renewWaiverEntry([valid], { symbol: "a", file: "x.ts" }, { expires: "garbage" }, schema)).toThrow(
      /invalid waiver entry after renewal/,
    );
  });

  it("renewWaiverEntry throws if no entry matches", () => {
    expect(() => renewWaiverEntry([valid], { symbol: "nope", file: "x.ts" }, {}, schema)).toThrow(/no matching/);
  });

  it("removeWaiverEntry removes the matching entry", () => {
    const next = removeWaiverEntry([valid], { symbol: "a", file: "x.ts" }, schema);
    expect(next).toEqual([]);
  });

  it("removeWaiverEntry throws if no entry matches", () => {
    expect(() => removeWaiverEntry([], { symbol: "a", file: "x.ts" }, schema)).toThrow(/no matching/);
  });
});

describe("`waiver add` CLI — decision-queue consequence message", () => {
  // Real surface: spawn the actual CLI arm (runCli), not the exported
  // addWaiverEntry helper — the message this proves is printed by `main`,
  // not by the library function.
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "waiver-store.mjs");
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "waiver-store-cli-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("prints the interview-owed date and the /revoy2-interview pointer for a dated entry", () => {
    const path = join(dir, "dispositions.json");
    fsWriteFileSync(path, JSON.stringify({ entries: [] }));
    const entry = JSON.stringify({ branch: "codex/example", reason: "under active review", expires: "2026-09-08" });
    const result = spawnSync("node", [CLI, "add", "branch-accounting", path, entry], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    // 3-day due-soon window (DEFAULT_DUE_SOON_DAYS in decision-queue.mjs): an
    // interview is owed by 2026-09-05, not the expiry date itself.
    expect(result.stdout).toMatch(/interview.*by 2026-09-05/s);
    expect(result.stdout).toContain("/revoy2-interview");
  });

  it("prints nothing extra for a schema entry with no expires (anti-stub false_positive)", () => {
    const path = join(dir, "triage.json");
    fsWriteFileSync(path, JSON.stringify({ entries: [] }));
    const entry = JSON.stringify({ rule: "r1", file: "f.ts", symbol: "s", verdict: "false_positive", reason: "wrong here" });
    const result = spawnSync("node", [CLI, "add", "anti-stub", path, entry], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("/revoy2-interview");
  });
});

describe("DECISION_QUEUE_DUE_SOON_DAYS stays in sync with decision-queue.mjs", () => {
  // waiver-store.mjs cannot import decision-queue.mjs (decision-queue.mjs
  // already imports waiver-store.mjs; the reverse would be circular), so the
  // due-soon window is restated as a local constant. This is the guard
  // against the two drifting apart silently.
  it("matches DEFAULT_DUE_SOON_DAYS exactly", async () => {
    const { DEFAULT_DUE_SOON_DAYS } = await import("../decision-queue.mjs");
    const cliOutput = spawnSync("node", [
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "waiver-store.mjs"),
      "add", "anti-stub", join(mkdtempSync(join(tmpdir(), "waiver-store-sync-")), "t.json"),
      JSON.stringify({ rule: "r", file: "f.ts", symbol: "s", verdict: "accepted_tradeoff", reason: "x", expires: "2026-01-10" }),
    ], { encoding: "utf-8" });
    const match = /within (\d+) day/.exec(cliOutput.stdout);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(DEFAULT_DUE_SOON_DAYS);
  });
});
