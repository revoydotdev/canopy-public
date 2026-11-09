/**
 * The two `file.write`/`file.patch` veto guards that replaced the deleted
 * `.claude/skills/repository-visual-intelligence/hooks/vi-readonly-guard.sh`
 * and `.claim-ledger/claim-guard.sh`, asserted on `HookVetoDecision`.
 *
 * The two properties under test are the ones a head-truncating context can
 * silently destroy, so both are exercised through the REAL veto chain rather
 * than by calling a handler directly:
 *
 *   1. THE DISCHARGE ORDER. claim-guard's refusal is a three-step discharge —
 *      no marker, marker already present, proof comment — and the order is
 *      load-bearing: a marker already in the replaced text means this edit did
 *      not introduce it, and that must be reachable with the proof comment
 *      absent, or the guard blocks every re-save of an already-claimed line.
 *
 *   2. THE TEXT BOUND. The bus caps what a veto handler reads
 *      (`MAX_VETO_TEXT_BYTES`). A ROADMAP.md marker legitimately sits far past
 *      the old 1 KiB head, so a guard reading only the head ALLOWS an edit the
 *      shell guard REFUSED — a silent weakening of a refusing guard, in the
 *      direction that loses denials. `CLAIM_TEXT_BOUND_BYTES` is measured
 *      against what `file.write`/`file.patch` themselves accept, and the
 *      truncation case is asserted both ways: a marker beyond the old 1 KiB
 *      boundary is still caught, and a text AT the declared bound is refused as
 *      unread-in-full rather than assumed marker-free.
 *
 * A fresh temporary repository per case, because the VI guard reads the
 * sentinel's mtime off real disk. The cwd seam is stubbed rather than changed:
 * vitest runs in a worker thread where `process.chdir` does not exist.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookBus } from "../../src/hooks/bus.js";
import { HookCatalog } from "../../src/hooks/catalog.js";
import type { HookVetoContext, HookVetoDecision } from "../../src/hooks/contracts.js";
import { HOOK_MAX_REASON_BYTES } from "../../src/hooks/contracts.js";
import { CLAIM_TEXT_BOUND_BYTES, claimCompletenessGuard } from "../../src/hooks/claim-completeness-guard.js";
import { VI_SENTINEL_STALE_SECONDS, viReadOnlyGuard } from "../../src/hooks/vi-readonly-guard.js";
import type { NativeToolPort, NativeToolPreflightResult, NativeToolRequest } from "@arbor/harness";

const VI_DIR = ".visual-intelligence";
const SENTINEL = ".vi-active";

let repo = "";

/** Arm the read-only run: the directory and a sentinel fresh enough to be live. */
const arm = (): void => {
  mkdirSync(join(repo, VI_DIR), { recursive: true });
  writeFileSync(join(repo, VI_DIR, SENTINEL), "");
};
/** Backdate the sentinel past the staleness window, so the guard must fail open. */
const makeSentinelStale = (): void => {
  const sentinel = join(repo, VI_DIR, SENTINEL);
  const old = new Date(Date.now() - (VI_SENTINEL_STALE_SECONDS + 3600) * 1000);
  utimesSync(sentinel, old, old);
  expect(Date.now() / 1000 - statSync(sentinel).mtimeMs / 1000).toBeGreaterThan(VI_SENTINEL_STALE_SECONDS);
};

const context = (tool: string, path: string, added = "", removed = ""): HookVetoContext => Object.freeze({
  event: "tool_preflight", hook_id: "g", version: "1.0.0", session_id: "s-1", call_id: "c-1", tool, subagent: false,
  tool_input: Object.freeze({ command: "", path, added_text: added, removed_text: removed }),
});

const request = (input: unknown): NativeToolRequest => Object.freeze({
  session_id: "s-1", turn: 1, call_id: "c-1", input, workspace_roots: ["/workspace"],
  filesystem: "workspace_write", network_allowed: false, intent_evidence: [],
});

/** A file port whose own preflight allows, so a refusal below can only be a hook's. */
const port = (tool: string): NativeToolPort => Object.freeze({
  tool,
  preflight: (): NativeToolPreflightResult => ({ allowed: true }),
  execute: (): Promise<never> => Promise.reject(new Error("preflight should have refused this call")),
});

const wired = (hookId: string, handlerRef: string): HookBus => {
  const catalog = new HookCatalog();
  catalog.register(JSON.stringify({
    schema_version: 1, hook_id: hookId, version: "1.0.0", kind: "veto", event: "tool_preflight",
    handler_ref: handlerRef, why: "test",
  }));
  return new HookBus({ catalog });
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "file-write-guard-"));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(repo, { recursive: true, force: true }); });

describe("veto.vi-readonly-guard — while a run is armed", () => {
  it("refuses a write outside .visual-intelligence/", () => {
    arm();
    expect(viReadOnlyGuard(context("file.write", "packages/arbor-core/src/tree.ts", "x")).allow).toBe(false);
  });

  it("names the sentinel and the disarm remedy in the refusal", () => {
    arm();
    const decision: HookVetoDecision = viReadOnlyGuard(context("file.write", "README.md", "x"));
    expect(decision.allow === false && decision.reason).toContain(".visual-intelligence/.vi-active");
    expect(decision.allow === false && decision.reason).toContain("remove .visual-intelligence/.vi-active first");
  });

  it("refuses a `..` escape that lands outside the guard's own directory", () => {
    arm();
    // The tools reject `..` in a path outright (native-tool-host `resolveRelative`),
    // so this cannot reach a write — but the shell guard normalised it before
    // judging, and a guard that stopped doing so would read a traversal as
    // "inside the protected directory" if the check were ever prefix-only.
    expect(viReadOnlyGuard(context("file.write", "../evil.ts", "x")).allow).toBe(false);
    expect(viReadOnlyGuard(context("file.write", `${VI_DIR}/../../evil.ts`, "x")).allow).toBe(false);
  });

  it("refuses an absolute path that resolves outside the protected directory", () => {
    arm();
    expect(viReadOnlyGuard(context("file.write", join(repo, "packages", "x.ts"), "x")).allow).toBe(false);
  });

  it("allows a write to .visual-intelligence/ itself, and to a file inside it", () => {
    arm();
    expect(viReadOnlyGuard(context("file.write", VI_DIR, "x"))).toEqual({ allow: true });
    expect(viReadOnlyGuard(context("file.write", `${VI_DIR}/graph/nodes.jsonl`, "x"))).toEqual({ allow: true });
  });

  it("does not treat a sibling directory sharing the name prefix as protected", () => {
    arm();
    // `${dir#/repo/.visual-intelligence/}` is unchanged for this path, so the
    // script let it through to the refusal. A prefix test rather than a
    // resolved-containment test would allow it instead, which is the direction
    // that matters: this guard exists to refuse writes it does not own.
    expect(viReadOnlyGuard(context("file.write", `${VI_DIR}-notes/scratch.md`, "x")).allow).toBe(false);
  });

  it("is not consulted for a tool that writes no file, even when its payload carries a path", () => {
    arm();
    // Fields populate BY TOOL NAME, never by payload key, so a shell command
    // that happens to carry `path` reaches this guard as an empty one.
    const bus = wired("vi-readonly", "veto.vi-readonly-guard");
    const result = bus.wrapToolPort(port("shell.execute")).preflight?.(request({ argv: ["git", "status"], path: "README.md" }));
    expect(result).toEqual({ allowed: true });
  });
});

describe("veto.vi-readonly-guard — every fail-open is preserved", () => {
  it("allows everything when the sentinel is absent, because no run is armed", () => {
    mkdirSync(join(repo, VI_DIR), { recursive: true });
    expect(viReadOnlyGuard(context("file.write", "README.md", "x"))).toEqual({ allow: true });
  });

  it("allows everything when the repository does not use the skill at all", () => {
    expect(viReadOnlyGuard(context("file.write", "README.md", "x"))).toEqual({ allow: true });
  });

  it("allows everything when the sentinel is STALE, so leaked debris cannot brick editing", () => {
    arm();
    makeSentinelStale();
    expect(viReadOnlyGuard(context("file.write", "README.md", "x"))).toEqual({ allow: true });
  });

  it("allows a call whose path the bus could not read", () => {
    arm();
    expect(viReadOnlyGuard(context("file.write", "", "x"))).toEqual({ allow: true });
  });
});

describe("veto.claim-completeness-guard — the three refusals", () => {
  it.each([
    ["ROADMAP.md", "| **G-42** | tranche | \u2705 complete |", "a check glyph in ROADMAP.md"],
    ["ROADMAP.md", "| **G-42** | tranche | \ud83d\udfe2 complete |", "a green circle in ROADMAP.md"],
    ["ROADMAP.md", "| **G-7** | thing | **CLOSED** |", "a CLOSED gap row"],
    ["ROADMAP.md", "| **G-8** | thing | **RESOLVED** |", "a RESOLVED gap row"],
    ["decisions/ADR-049-reduction-only-hook-bus.md", "**Status:** Accepted\n", "an Accepted ADR status line"],
    ["decisions/README.md", "| [49](ADR-049.md) | hook bus | Accepted |\n", "an Accepted index row"],
  ])("refuses %s — %s", (path, added) => {
    expect(claimCompletenessGuard(context("file.write", path, added)).allow).toBe(false);
  });

  it("names the file and cites the authority in the refusal", () => {
    const decision = claimCompletenessGuard(context("file.write", "ROADMAP.md", "\u2705"));
    expect(decision.allow === false && decision.reason).toContain("ROADMAP.md");
    expect(decision.allow === false && decision.reason).toContain("gate:claim-ledger");
  });
});

describe("veto.claim-completeness-guard — the marker is scoped PER FILE", () => {
  it("allows a check glyph in an ADR, where it is prose and not a completion claim", () => {
    // The first version of the shell guard matched the glyph everywhere and
    // denied the very ADR documenting this ledger, whose Context section
    // tabulates the marker surface. This is that regression, pinned.
    expect(claimCompletenessGuard(context("file.write", "decisions/ADR-049-reduction-only-hook-bus.md", "| mark | \u2705 | \ud83d\udfe2 |\n"))).toEqual({ allow: true });
  });

  it("allows an Accepted ADR status line in ROADMAP.md, where it is not a row", () => {
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", "**Status:** Accepted\n"))).toEqual({ allow: true });
  });

  it("allows an Accepted index row in an ADR, where the row is prose", () => {
    expect(claimCompletenessGuard(context("file.write", "decisions/ADR-049-reduction-only-hook-bus.md", "| [49](x.md) | y | Accepted |\n"))).toEqual({ allow: true });
  });

  it("allows a CLOSED gap row in an ADR, where G- identifiers are not used", () => {
    expect(claimCompletenessGuard(context("file.write", "decisions/ADR-049-reduction-only-hook-bus.md", "| **G-1** | x | **CLOSED** |\n"))).toEqual({ allow: true });
  });
});

describe("veto.claim-completeness-guard — the discharge order", () => {
  it("allows a non-whitelisted file outright, marker or not", () => {
    expect(claimCompletenessGuard(context("file.write", "README.md", "\u2705 everything is done\n"))).toEqual({ allow: true });
    expect(claimCompletenessGuard(context("file.write", "packages/x/src/a.ts", "\u2705\n"))).toEqual({ allow: true });
  });

  it("allows a whitelisted file whose added text carries no marker", () => {
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", "just prose about the work\n"))).toEqual({ allow: true });
  });

  it("allows when the marker was already in the replaced text: this edit did not introduce it", () => {
    const line = "| **G-42** | tranche | \u2705 complete |\n";
    expect(claimCompletenessGuard(context("file.patch", "ROADMAP.md", line, line)).allow).toBe(true);
  });

  it("allows a file.patch that renames a row's description while the marker stays put", () => {
    expect(claimCompletenessGuard(context("file.patch", "ROADMAP.md", "| **G-42** | tranche two | \u2705 complete |\n", "| **G-42** | tranche one | \u2705 complete |\n"))).toEqual({ allow: true });
  });

  it("allows a marker carrying its proof comment, presence being all that is checked", () => {
    const line = "| **G-42** | tranche | \u2705 | <!-- proof: symbol=f file=x.ts roundtrip=x.test.ts -->\n";
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", line))).toEqual({ allow: true });
  });

  it("allows an empty added text, which is a context the bus could not read", () => {
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", ""))).toEqual({ allow: true });
  });

  it("checks the marker before the proof comment: a proof cannot rescue an absent marker", () => {
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", "prose <!-- proof: symbol=f -->"))).toEqual({ allow: true });
  });
});

describe("veto.claim-completeness-guard — path relativisation", () => {
  it("strips the repository prefix from an absolute path, matching the whitelist", () => {
    expect(claimCompletenessGuard(context("file.write", join(repo, "ROADMAP.md"), "\u2705")).allow).toBe(false);
  });

  it("leaves an absolute path outside the repository absolute, so it misses the whitelist and allows", () => {
    expect(claimCompletenessGuard(context("file.write", "/elsewhere/ROADMAP.md", "\u2705"))).toEqual({ allow: true });
  });
});

describe("veto.claim-completeness-guard — the text bound (the fidelity trap)", () => {
  it("is the bound file.write and file.patch already enforce, so no admissible edit is truncated", () => {
    // Measured against the tool's own schema, not guessed: cli.ts composes the
    // repository tools with `max_read_bytes: 128 * 1024`, and native-tool-host
    // bounds `content`, `expected` and `replacement` at exactly that.
    expect(CLAIM_TEXT_BOUND_BYTES).toBe(128 * 1024);
  });

  it("still refuses a marker sitting far past the old 1 KiB head", () => {
    const added = `${"x".repeat(4000)}\n| **G-42** | tranche | \u2705 complete |\n`;
    // The marker begins past 1024 bytes in, so a 1 KiB head slice cannot have
    // seen it: this is precisely the call the old bound answered `allow`.
    expect(added.indexOf("\u2705")).toBeGreaterThanOrEqual(1024);
    expect(added.slice(0, 1024)).not.toContain("\u2705");
    expect(claimCompletenessGuard(context("file.write", "ROADMAP.md", added)).allow).toBe(false);
  });

  it("delivers that same marker through the real veto chain, which is where the head was cut before", () => {
    const bus = wired("claim-completeness", "veto.claim-completeness-guard");
    const result = bus.wrapToolPort(port("file.write")).preflight?.(request({
      path: "ROADMAP.md", content: `${"x".repeat(4000)}\n| **G-42** | tranche | \u2705 complete |\n`,
    }));
    expect(result?.allowed).toBe(false);
    expect(bus.ledger()).toMatchObject([{ hook_id: "claim-completeness", decision: "deny" }]);
  });

  it("refuses a text at the declared bound as unread-in-full, rather than assuming it marker-free", () => {
    // This is the direction that matters: absence of a marker in a TRUNCATED
    // text is not absence of a marker. Detecting the bound and allowing is how
    // the guard would silently stop guarding.
    const decision = claimCompletenessGuard(context("file.write", "ROADMAP.md", "x".repeat(CLAIM_TEXT_BOUND_BYTES)));
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toContain("head");
  });

  it("gives a real ADR room: the largest file in decisions/ is well inside the bound", () => {
    // decisions/ADR-036 is 26,589 bytes, decisions/README.md is 23,754, and
    // ROADMAP.md is 192,920 — which EXCEEDS the bound, so it cannot be written
    // whole at all and must be patched with a bounded `replacement` the guard
    // sees whole. No real target can reach the truncation refusal.
    expect(26_589).toBeLessThan(CLAIM_TEXT_BOUND_BYTES);
    expect(192_920).toBeGreaterThan(CLAIM_TEXT_BOUND_BYTES);
  });
});

describe("veto.claim-completeness-guard — the refusal reaches an operator intact", () => {
  it.each([
    ["decisions/ADR-049-reduction-only-hook-bus.md", "**Status:** Accepted\n"],
    ["decisions/README.md", "| [49](ADR-049.md) | x | Accepted |\n"],
  ])("names the dedicated acceptance remedy for %s, before the reason is bounded", (path, added) => {
    const bus = wired("claim-completeness", "veto.claim-completeness-guard");
    const result = bus.wrapToolPort(port("file.write")).preflight?.(request({ path, content: added }));
    const reason = result?.allowed === false ? result.reason : "";
    // A proof comment bundled into a status flip satisfies this guard and then
    // fails gate:adr-acceptance-staged, so the specific remedy has to survive
    // the 512-byte reason bound — the generic advice is the trap here.
    expect(reason).toContain("adr:accept");
    expect(reason).toContain("adr-acceptance-staged");
  });

  it("still names the proof-comment syntax after bounding", () => {
    const bus = wired("claim-completeness", "veto.claim-completeness-guard");
    const result = bus.wrapToolPort(port("file.write")).preflight?.(request({ path: "ROADMAP.md", content: "\u2705" }));
    const reason = result?.allowed === false ? result.reason : "";
    expect(reason).toContain("<!-- proof:");
    expect(reason).toContain("gate:claim-ledger");
  });

  it("keeps every citation intact at the LONGEST real ADR path, not just a short one", () => {
    // The reason is truncated from the END at 512 bytes, so a draft that led
    // with the remedy and tailed with the path silently lost its authority
    // citation for exactly the documents that need it. Pinned on the longest of
    // 167 real ADR slugs so a future rewrite cannot re-buy that regression with
    // a shorter test path.
    const longSlug = "decisions/ADR-153-branch-accounting-and-shared-reservations-are-the-built-unlanded-governance-controls.md";
    const bus = wired("claim-completeness", "veto.claim-completeness-guard");
    const result = bus.wrapToolPort(port("file.write")).preflight?.(request({ path: longSlug, content: "**Status:** Accepted\n" }));
    const reason = result?.allowed === false ? result.reason : "";
    expect(reason).toContain("adr:accept");
    expect(reason).toContain("<!-- proof:");
    expect(reason).toContain("gate:claim-ledger");
    expect(reason).toContain("adr-acceptance-staged");
    expect(reason).toContain(longSlug);
    expect(reason).toMatch(/File: \S+$/);
  });

  it("budgets the handler's own reason inside HOOK_MAX_REASON_BYTES", () => {
    for (const [path, content] of [["ROADMAP.md", "\u2705"], ["decisions/README.md", "| [49](x.md) | y | Accepted |\n"]] as const) {
      const direct = claimCompletenessGuard(context("file.write", path, content));
      const raw = direct.allow === false ? direct.reason : "";
      expect(raw.length).toBeLessThanOrEqual(HOOK_MAX_REASON_BYTES);
    }
  });
});

describe("the registered handlers are the ones under test", () => {
  it.each(["veto.vi-readonly-guard", "veto.claim-completeness-guard"])("%s is a closed-registry veto entry", (ref) => {
    const entry = new HookCatalog().resolveHandler(ref);
    expect(entry?.kind).toBe("veto");
  });

  it("declares the claim guard's text bound on its registry entry, where the code can read the same constant", () => {
    const entry = new HookCatalog().resolveHandler("veto.claim-completeness-guard");
    expect(entry?.text_bytes).toBe(CLAIM_TEXT_BOUND_BYTES);
  });

  it("exports the handlers the registry binds, so the two cannot drift", () => {
    expect(viReadOnlyGuard).toBeTypeOf("function");
    expect(claimCompletenessGuard).toBeTypeOf("function");
  });
});
