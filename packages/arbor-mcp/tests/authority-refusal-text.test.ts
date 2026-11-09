// ADR-118: a scope refusal must state the authority held (permitted write
// paths / command argv) alongside the authority denied, not only the denial.
// Covers `highRiskScopeFailure`'s two denial branches (native-tool-host.ts)
// and the shared, bounded description helper it builds the text from
// (native-tools/contracts.ts).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolRequest } from "@arbor/harness";
import {
  createNativeRepositoryToolHost,
  describeAuthorizedWritePaths,
  describeAuthorizedCommands,
  AUTHORITY_DESCRIPTION_ITEM_LIMIT,
  type NativeHighRiskToolScope,
  type NativeHighRiskScopeDenialReason,
  type NativeToolAuditRecord,
} from "../src/native-tool-host.js";

const created: string[] = [];

function directory(prefix: string): string {
  const result = mkdtempSync(join(tmpdir(), prefix));
  created.push(result);
  return result;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function request(root: string, input: unknown, networkAllowed = false): NativeToolRequest {
  return { session_id: "session-a", turn: 1, call_id: "call-a", input, workspace_roots: [root], filesystem: "workspace_write", intent_evidence: [], network_allowed: networkAllowed };
}

function host(root: string, scope: NativeHighRiskToolScope | null, records: NativeToolAuditRecord[] = [], denialReason: NativeHighRiskScopeDenialReason | null = null) {
  const descriptors = createNativeRepositoryToolHost({
    filesystem: "workspace_write",
    workspace_roots: [root],
    allowed_commands: [process.execPath],
    resolve_intent: () => ({ purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } }),
    resolve_high_risk_scope: () => scope,
    resolve_high_risk_scope_denial_reason: () => denialReason,
    on_audit: (record) => records.push(record),
  });
  return new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));
}

function baseScope(root: string, overrides: Partial<NativeHighRiskToolScope>): NativeHighRiskToolScope {
  return {
    scope_id: "scope-a", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: root,
    provenance: { tag: "claimed", claimant: "test" }, write_paths: [], command_argv: [],
    ...overrides,
  };
}

describe("ADR-118: refusal states the authority held, not only the authority denied", () => {
  it("names the authorized write paths in a denied file.write", async () => {
    const root = directory("arbor-authority-");
    mkdirSync(join(root, "docs"));
    const scope = baseScope(root, { write_paths: ["docs/allowed.md"], command_argv: [] });
    const tools = host(root, scope);

    const denied = await tools.get("file.write")!.execute(request(root, { path: "docs/other.md", content: "no", create: true }), null, new AbortController().signal);
    expect(denied.evidence).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_path_denied" });
    expect(denied.result_summary).toBe(
      "execution refused: write path exceeds the system-owned action scope; authorized write paths: docs/allowed.md",
    );
  });

  it("states zero write authority plainly for a command-only scope, rather than an empty list", async () => {
    const root = directory("arbor-authority-");
    mkdirSync(join(root, "docs"));
    const scope = baseScope(root, { write_paths: [], command_argv: [[process.execPath, "-e", "1"]] });
    const tools = host(root, scope);

    const denied = await tools.get("file.write")!.execute(request(root, { path: "docs/anything.md", content: "no", create: true }), null, new AbortController().signal);
    expect(denied.result_summary).toBe(
      "execution refused: write path exceeds the system-owned action scope; no write paths are authorized for this task",
    );
  });

  it("names the authorized commands in a denied shell.execute when the scope is write-only (zero command authority)", async () => {
    const root = directory("arbor-authority-");
    mkdirSync(join(root, "docs"));
    const scope = baseScope(root, { write_paths: ["docs/allowed.md"], command_argv: [] });
    const tools = host(root, scope);

    const denied = await tools.get("shell.execute")!.execute(request(root, { argv: [process.execPath, "-e", "1"] }), null, new AbortController().signal);
    expect(denied.evidence).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_command_denied" });
    expect(denied.result_summary).toBe(
      "execution refused: command argv exceeds the system-owned action scope; no commands are authorized for this task",
    );
  });

  it("names the authorized argv shape in a denied shell.execute for a command-bearing scope", async () => {
    const root = directory("arbor-authority-");
    const scope = baseScope(root, { command_argv: [[process.execPath, "-e", "process.stdout.write('safe')"]] });
    const tools = host(root, scope);

    const denied = await tools.get("shell.execute")!.execute(request(root, { argv: [process.execPath, "-e", "process.stdout.write('other')"] }), null, new AbortController().signal);
    expect(denied.result_summary).toBe(
      `execution refused: command argv exceeds the system-owned action scope; authorized commands: ${process.execPath} -e process.stdout.write('safe')`,
    );
  });

  it("truncates a large authorized-path list deterministically instead of producing an unbounded string", () => {
    const paths = Array.from({ length: AUTHORITY_DESCRIPTION_ITEM_LIMIT + 137 }, (_, index) => `docs/file-${index}.md`);
    const description = describeAuthorizedWritePaths(paths);

    const shown = description.split("authorized write paths: ")[1]!.split(" (+")[0]!.split(", ");
    expect(shown).toHaveLength(AUTHORITY_DESCRIPTION_ITEM_LIMIT);
    expect(shown).toEqual(paths.slice(0, AUTHORITY_DESCRIPTION_ITEM_LIMIT));
    expect(description).toContain(`(+${paths.length - AUTHORITY_DESCRIPTION_ITEM_LIMIT} more, not listed)`);
    // Deterministic: same input always yields the same bounded string.
    expect(describeAuthorizedWritePaths(paths)).toBe(description);
  });

  it("truncates a large authorized-command list deterministically instead of producing an unbounded string", () => {
    const commandArgv = Array.from({ length: AUTHORITY_DESCRIPTION_ITEM_LIMIT + 42 }, (_, index) => [process.execPath, "-e", String(index)]);
    const description = describeAuthorizedCommands(commandArgv);

    expect(description).toContain(`(+${commandArgv.length - AUTHORITY_DESCRIPTION_ITEM_LIMIT} more, not listed)`);
    expect(description.split("; ").length).toBe(AUTHORITY_DESCRIPTION_ITEM_LIMIT);
  });

  it("states zero authority plainly for both dimensions rather than an empty list", () => {
    expect(describeAuthorizedWritePaths([])).toBe("no write paths are authorized for this task");
    expect(describeAuthorizedCommands([])).toBe("no commands are authorized for this task");
  });
});

// Gap 3 (audit/2026-09-06-remediation manifest, S02): "distinguish tier
// denial from missing per-action authority. Never broaden authority
// silently." Before this fix, EVERY `scope === null` refusal claimed "the
// plan declared none" — false exactly when the action DID declare a
// high-risk scope and the campaign's governance tier refused it (e.g. an
// intent-style command entry declared on a `governed`-tier action). These
// tests assert the message text actually differs by cause, not merely that
// a denial occurred.
describe("S02: a null-scope refusal distinguishes tier denial from missing/invalid per-action authority", () => {
  it("says tier policy refused an actually-declared scope, not that nothing was declared, when resolve_high_risk_scope_denial_reason says so", async () => {
    const root = directory("arbor-authority-tier-denial-");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, null, records, "tier_forbids_declared_scope");

    const denied = await tools.get("file.write")!.execute(request(root, { path: "docs/x.md", content: "no", create: true }), null, new AbortController().signal);
    expect(denied.evidence).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_missing_or_stale" });
    expect(denied.result_summary).toContain("this campaign's governance tier does not permit that declaration shape");
    expect(denied.result_summary).toContain("tier policy, not a missing declaration");
    expect(denied.result_summary).not.toContain("the plan declared none");
  });

  it("names a structurally invalid declaration distinctly from both a tier denial and a bare absence", async () => {
    const root = directory("arbor-authority-invalid-declaration-");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, null, records, "declared_scope_invalid");

    const denied = await tools.get("file.write")!.execute(request(root, { path: "docs/x.md", content: "no", create: true }), null, new AbortController().signal);
    expect(denied.result_summary).toContain("the action's declared high-risk scope is structurally invalid");
    expect(denied.result_summary).not.toContain("the plan declared none");
    expect(denied.result_summary).not.toContain("governance tier does not permit");
  });

  it("keeps the original absence wording when no reason is supplied (unknown/absent denial reason)", async () => {
    const root = directory("arbor-authority-no-reason-");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, null, records, null);

    const denied = await tools.get("file.write")!.execute(request(root, { path: "docs/x.md", content: "no", create: true }), null, new AbortController().signal);
    expect(denied.result_summary).toContain("the plan declared none, and none could be derived from the task's declared write paths or commands");
  });
});
