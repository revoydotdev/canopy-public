import { MINED_ACTION_SCOPE_GENERATOR } from "../src/native-tools/contracts.js";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeToolRequest } from "@arbor/harness";
import { NATIVE_DOCUMENTATION_WRITE_PATH_POLICY, boundedToolModelOutput, createNativeRepositoryToolHost, type NativeHighRiskToolScope, type NativeToolAuditRecord } from "../src/native-tool-host.js";
import { createSandboxBroker } from "../src/sandbox/sandbox-broker.js";
import type { SandboxBroker } from "../src/sandbox/contracts.js";

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

function host(root: string, records: NativeToolAuditRecord[], options: { filesystem?: "read_only" | "workspace_write"; intent?: boolean; output?: number; documentation_only?: boolean; scope?: NativeHighRiskToolScope | null; sandbox?: SandboxBroker } = {}) {
  const descriptors = createNativeRepositoryToolHost({
    filesystem: options.filesystem ?? "read_only",
    write_path_policy: options.documentation_only ? NATIVE_DOCUMENTATION_WRITE_PATH_POLICY : undefined,
    workspace_roots: [root],
    allowed_commands: [process.execPath],
    max_command_output_bytes: options.output,
    resolve_intent: () => options.intent === false ? null : { purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } },
    resolve_high_risk_scope: (request) => options.scope === undefined ? scopeForTestRequest(root, request) : options.scope,
    on_audit: (record) => records.push(record),
    sandbox_broker: options.sandbox,
  });
  return new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));
}

function scopeForTestRequest(root: string, request: NativeToolRequest): NativeHighRiskToolScope {
  const input = request.input !== null && typeof request.input === "object" && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {};
  const path = typeof input.path === "string" && input.path.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..") ? [input.path] : [];
  const argv = Array.isArray(input.argv) && input.argv.every((part) => typeof part === "string") ? [input.argv as string[]] : [];
  return { scope_id: "test-scope", campaign_id: "campaign", node_id: "node", session_id: request.session_id, worktree_root: root, provenance: { tag: "claimed", claimant: "test" }, write_paths: path, command_argv: argv };
}

async function call(tools: Map<string, { execute: (request: NativeToolRequest, secret: string | null, signal: AbortSignal) => Promise<{ model_output: string }> }>, tool: string, value: NativeToolRequest, signal = new AbortController().signal): Promise<Record<string, unknown>> {
  const response = await tools.get(tool)!.execute(value, null, signal);
  return JSON.parse(response.model_output) as Record<string, unknown>;
}

describe("native repository tool host", () => {
  it("compresses oversized model output into a bounded, evidence-addressed head/tail projection", () => {
    const raw = { outcome: "succeeded", stage: "execution", code: "ok", output: `first-marker ${"x".repeat(8_000)} last-marker` };
    const projected = boundedToolModelOutput(raw, 1_024, "repository.search");
    const parsed = JSON.parse(projected) as Record<string, unknown>;

    expect(Buffer.byteLength(projected)).toBeLessThanOrEqual(1_024);
    expect(parsed).toMatchObject({
      outcome: "succeeded",
      stage: "execution",
      code: "ok",
      truncated: true,
      original_bytes: expect.any(Number),
      omitted_bytes: expect.any(Number),
      content_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(parsed.head).toContain("first-marker");
    expect(parsed.tail).toContain("last-marker");
    expect(parsed.remediation).toContain("do not repeat");
  });

  it("acknowledges only canonical full-file writes as repeatable crash-protected effects", () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, []);
    const write = tools.get("file.write")!.recovery_protection!(request(root, { path: "a.txt", content: "one", create: true }));
    const same = tools.get("file.write")!.recovery_protection!(request(root, { create: true, content: "one", path: "a.txt" }));
    const patch = tools.get("file.patch")!.recovery_protection!(request(root, { path: "a.txt", find: "one", replace: "two" }));
    expect(write).toMatchObject({ effect_kind: "file_write", repeatable: true, idempotency_key_hash: expect.stringMatching(/^sha256:/), acknowledged_by: "revoy-native-repository-tool:file.write:v1" });
    expect(same.idempotency_key_hash).toBe(write.idempotency_key_hash);
    expect(patch).toEqual({ effect_kind: "file_patch", repeatable: false, idempotency_key_hash: null, acknowledged_by: null });
  });

  it("requires create-if-absent or a complete-read hash for every file write", async () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, [], { filesystem: "workspace_write" });
    writeFileSync(join(root, "existing.txt"), "before");

    const created = await call(tools, "file.write", request(root, { path: "new.txt", content: "created", create: true }));
    const collision = await call(tools, "file.write", request(root, { path: "existing.txt", content: "overwritten", create: true }));
    const bothModes = await call(tools, "file.write", request(root, { path: "existing.txt", content: "both", create: true, expected_sha256: `sha256:${"0".repeat(64)}` }));
    const missingHash = await call(tools, "file.write", request(root, { path: "existing.txt", content: "unguarded" }));
    const malformedHash = await call(tools, "file.write", request(root, { path: "existing.txt", content: "malformed", expected_sha256: "sha256:invalid" }));
    const stale = await call(tools, "file.write", request(root, { path: "existing.txt", content: "stale", expected_sha256: `sha256:${"0".repeat(64)}` }));
    const read = await call(tools, "file.read", request(root, { path: "existing.txt" }));
    if (typeof read.content_sha256 !== "string") throw new Error("complete read did not expose a content hash");
    const updated = await call(tools, "file.write", request(root, { path: "existing.txt", content: "after", expected_sha256: read.content_sha256 }));

    expect(created).toMatchObject({ outcome: "succeeded", path: "new.txt" });
    expect(collision).toMatchObject({ outcome: "refused", stage: "semantic", code: "file_exists" });
    // The create-XOR-update precondition is a schema-free runtime invariant
    // (cli.ts's file.write schema has no oneOf -- Anthropic rejects a
    // root-level combinator): a request sending both create:true and
    // expected_sha256 is refused here, not merely discouraged by the
    // schema/description.
    expect(bothModes).toMatchObject({ outcome: "refused", stage: "semantic", code: "write_mode_invalid" });
    expect(missingHash).toMatchObject({ outcome: "refused", stage: "semantic", code: "expected_sha256_required" });
    expect(malformedHash).toMatchObject({ outcome: "refused", stage: "semantic", code: "expected_sha256_invalid" });
    expect(stale).toMatchObject({ outcome: "refused", stage: "audit", code: "stale_write" });
    expect(updated).toMatchObject({ outcome: "succeeded", path: "existing.txt" });
  });
  it("rejects traversal before it can read outside a canonical workspace", async () => {
    const root = directory("arbor-native-tools-root-");
    const outside = directory("arbor-native-tools-outside-");
    writeFileSync(join(outside, "secret.txt"), "do-not-read");
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "file.read", request(root, { path: "../" + outside.split("/").pop() + "/secret.txt" }));

    expect(result).toMatchObject({ outcome: "refused", stage: "sandbox", code: "path_traversal" });
    expect(records[0]).toMatchObject({ outcome: "refused", stage: "sandbox", code: "path_traversal" });
    expect(JSON.stringify(records)).not.toContain("do-not-read");
  });

  it("rejects a symlink that points outside the admitted workspace", async () => {
    const root = directory("arbor-native-tools-root-");
    const outside = directory("arbor-native-tools-outside-");
    writeFileSync(join(outside, "secret.txt"), "do-not-read");
    symlinkSync(outside, join(root, "escape"));
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "file.read", request(root, { path: "escape/secret.txt" }));

    expect(result).toMatchObject({ outcome: "refused", stage: "sandbox", code: "symlink_escape" });
  });

  it("truncates an oversized file to the byte limit and flags it, instead of refusing the read", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "big.txt"), "x".repeat(10_000));
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records, { output: 10_000 }), "file.read", request(root, { path: "big.txt", max_bytes: 100 }));

    expect(result).toMatchObject({ truncated: true, bytes: 100, total_bytes: 10_000, content_sha256: null });
    expect((result.content as string).length).toBe(100);
    expect(records[0]).toMatchObject({ tool: "file.read", outcome: "succeeded" });
  });

  it("searches within a single file path, not only a directory (a model naturally greps one file)", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "target.ts"), "line one\nconst readiness = doctor();\nline three\n");
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "repository.search", request(root, { query: "readiness", path: "target.ts" }));

    expect(result).toMatchObject({ matches: [{ path: "target.ts", line: 2 }], files_scanned: 1 });
    expect(records[0]).toMatchObject({ tool: "repository.search", outcome: "succeeded" });
  });

  it("returns portable slash-canonical paths from nested repository roots", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "target.ts"), "export const readiness = true;\n");
    const tools = host(root, []);

    const listed = await call(tools, "repository.list", request(root, { path: "src" }));
    const searched = await call(tools, "repository.search", request(root, { query: "readiness", path: "src" }));
    const globbed = await call(tools, "repository.glob", request(root, { pattern: "**/*.ts" }));

    expect(listed).toMatchObject({ path: "src" });
    expect(searched).toMatchObject({ matches: [{ path: "src/target.ts", line: 1 }] });
    expect(globbed).toMatchObject({ matches: ["src/target.ts"] });
  });

  it("[ADR-105 O2] matches a regex query, case-insensitively, and returns bounded context lines", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "target.ts"), "before line\nconst readiness42 = doctor();\nafter line\n");
    const tools = host(root, []);

    const literal = await call(tools, "repository.search", request(root, { query: "READINESS", path: "target.ts" }));
    const caseInsensitive = await call(tools, "repository.search", request(root, { query: "READINESS", path: "target.ts", case_sensitive: false }));
    const regexMatch = await call(tools, "repository.search", request(root, { query: "readiness\\d+", path: "target.ts", regex: true }));
    const contextual = await call(tools, "repository.search", request(root, { query: "readiness42", path: "target.ts", context_lines: 1 }));

    expect(literal).toMatchObject({ matches: [] });
    expect(caseInsensitive).toMatchObject({ matches: [{ path: "target.ts", line: 2 }] });
    expect(regexMatch).toMatchObject({ matches: [{ path: "target.ts", line: 2, text: expect.stringContaining("readiness42") }] });
    expect(contextual).toMatchObject({
      matches: [{ path: "target.ts", line: 2, context_before: ["before line"], context_after: ["after line"] }],
    });
  });

  it("[ADR-105 O2] refuses an invalid or oversized regex pattern as a typed semantic refusal, not a raw exception", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "target.ts"), "some text\n");
    const tools = host(root, []);

    const invalid = await call(tools, "repository.search", request(root, { query: "(unterminated", path: "target.ts", regex: true }));
    const oversized = await call(tools, "repository.search", request(root, { query: "a".repeat(300), path: "target.ts", regex: true }));

    expect(invalid).toMatchObject({ outcome: "refused", stage: "semantic", code: "search_pattern_invalid" });
    expect(oversized).toMatchObject({ outcome: "refused", stage: "semantic", code: "search_pattern_invalid" });
  });

  it("accepts conventional repository-root aliases only on discovery tools", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "target.ts"), "export const readiness = true;\n");
    const tools = host(root, []);

    const listed = await call(tools, "repository.list", request(root, { path: "/" }));
    const listedEmpty = await call(tools, "repository.list", request(root, { path: "" }));
    const searched = await call(tools, "repository.search", request(root, { query: "readiness", path: "." }));
    const globbed = await call(tools, "repository.glob", request(root, { pattern: "**/*.ts", path: "\\" }));
    const exactRead = await call(tools, "file.read", request(root, { path: "/" }));
    const emptyExactRead = await call(tools, "file.read", request(root, { path: "" }));

    expect(listed).toMatchObject({ path: "", entries: [expect.objectContaining({ name: "target.ts" })] });
    expect(listedEmpty).toMatchObject({ path: "", entries: [expect.objectContaining({ name: "target.ts" })] });
    expect(searched).toMatchObject({ matches: [{ path: "target.ts", line: 1 }] });
    expect(globbed).toMatchObject({ matches: ["target.ts"] });
    expect(exactRead).toMatchObject({ outcome: "refused", stage: "semantic", code: "path_invalid" });
    expect(emptyExactRead).toMatchObject({ outcome: "refused", stage: "semantic", code: "path_invalid" });
  });

  it("exposes the focused repository graph as a repeatable read-only tool", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), 'import { Beta } from "./b.js"; export const alpha = new Beta();');
    writeFileSync(join(root, "src", "b.ts"), "export class Beta {}");
    const tools = host(root, []);

    const first = await call(tools, "repository.graph", request(root, { symbol: "Beta", depth: 1 }));
    const second = await call(tools, "repository.graph", request(root, { symbol: "Beta", depth: 1 }));

    expect(first).toMatchObject({ outcome: "succeeded", cache_hit: false, files_indexed: 2 });
    expect(second).toMatchObject({ outcome: "succeeded", cache_hit: true });
    expect(first.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/b.ts" })]));
    expect(tools.get("repository.graph")?.recovery_protection?.(request(root, { symbol: "Beta" }))).toMatchObject({ effect_kind: "read_only", repeatable: true });
    expect(tools.get("shell.poll")?.recovery_protection?.(request(root, { job_id: "live-job" }))).toMatchObject({ effect_kind: "read_only", repeatable: false });
  });

  it("[merge-critical ADR-044] routes every native file operation and command through the injected broker", async () => {
    const root = directory("arbor-native-tools-broker-routing-");
    writeFileSync(join(root, "read.txt"), "ambient-direct-filesystem-content");
    writeFileSync(join(root, "patch.txt"), "before");
    const operations: string[] = [];
    const broker: SandboxBroker = {
      confinement: "os_confined",
      diagnostic: "deterministic routing witness",
      run: async (sandboxRequest) => {
        if (sandboxRequest.stdin !== undefined) {
          const operation = JSON.parse(sandboxRequest.stdin.toString("utf8")) as { kind: string };
          operations.push(operation.kind);
          const value = operation.kind === "read"
            ? { ok: true, content_base64: Buffer.from("broker-returned-content").toString("base64"), total_bytes: 23, truncated: false }
            : { ok: true, sha256: `sha256:${"0".repeat(64)}` };
          return { kind: "exited" as const, exit: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0), confinement: "os_confined" as const };
        }
        operations.push("command");
        return { kind: "exited" as const, exit: 0, stdout: Buffer.from("broker-command"), stderr: Buffer.alloc(0), confinement: "os_confined" as const };
      },
    };
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write", sandbox: broker });

    const read = await call(tools, "file.read", request(root, { path: "read.txt" }));
    const write = await call(tools, "file.write", request(root, { path: "write.txt", content: "after", create: true }));
    const patch = await call(tools, "file.patch", request(root, { path: "patch.txt", expected: "before", replacement: "after" }));
    const shell = await call(tools, "shell.execute", request(root, { argv: [process.execPath, "-e", "process.exit(0)"] }, true));
    const verification = await call(tools, "verification.run", request(root, { argv: [process.execPath, "-e", "process.exit(0)"] }));

    // This reproduces the postmortem's clean textual merge shape: a direct
    // read still returns plausible content and passes ordinary read tests,
    // but cannot return this broker-only witness or record the read dispatch.
    expect(read).toMatchObject({ outcome: "succeeded", content: "broker-returned-content" });
    expect(write).toMatchObject({ outcome: "succeeded" });
    expect(patch).toMatchObject({ outcome: "succeeded" });
    expect(shell).toMatchObject({ outcome: "succeeded", output: "broker-command", confinement: "os_confined" });
    expect(verification).toMatchObject({ outcome: "succeeded", output: "broker-command", confinement: "os_confined" });
    expect(operations).toEqual(["read", "write", "patch", "command", "command"]);
    expect(records.map((record) => record.confinement)).toEqual(Array(5).fill("os_confined"));
  });

  it("lists directory entries for path discovery, elides .git, and reports a symlink without following it", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "alpha.ts"), "x".repeat(12));
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, ".git"));
    const outside = directory("arbor-native-tools-outside-");
    writeFileSync(join(outside, "secret.txt"), "do-not-read");
    symlinkSync(outside, join(root, "escape"));
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "repository.list", request(root, {}));

    expect(result).toMatchObject({ path: "", truncated: false, entries: [
      { name: "alpha.ts", kind: "file", bytes: 12 },
      { name: "escape", kind: "other", bytes: null },
      { name: "sub", kind: "directory", bytes: null },
    ] });
    expect(JSON.stringify(result)).not.toContain(".git");
    expect(JSON.stringify(result)).not.toContain("do-not-read");
    expect(records[0]).toMatchObject({ tool: "repository.list", outcome: "succeeded" });
  });

  it("globs files by name pattern recursively, excluding .git and never following a symlink out of the workspace", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "src", "a.test.ts"), "one");
    writeFileSync(join(root, "src", "b.ts"), "two");
    writeFileSync(join(root, ".git", "c.test.ts"), "ignored");
    const outside = directory("arbor-native-tools-outside-");
    writeFileSync(join(outside, "secret.test.ts"), "do-not-read");
    symlinkSync(outside, join(root, "escape"));
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "repository.glob", request(root, { pattern: "**/*.test.ts" }));

    expect(result).toMatchObject({ pattern: "**/*.test.ts", matches: ["src/a.test.ts"], truncated: false });
    expect(JSON.stringify(result)).not.toContain("do-not-read");
    expect(records[0]).toMatchObject({ tool: "repository.glob", outcome: "succeeded" });
  });

  it("refuses a glob pattern that tries to climb out of the workspace with ..", async () => {
    const root = directory("arbor-native-tools-root-");
    const records: NativeToolAuditRecord[] = [];

    const result = await call(host(root, records), "repository.glob", request(root, { pattern: "../*.ts" }));

    expect(result).toMatchObject({ outcome: "refused", stage: "sandbox", code: "path_traversal" });
  });

  it("executes argv directly, never interprets an argument as a shell program", async () => {
    const root = directory("arbor-native-tools-root-");
    const sentinel = join(root, "must-not-exist");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write" });

    const result = await call(tools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "process.stdout.write('safe')", `; touch ${sentinel}`],
    }, true));

    expect(result).toMatchObject({ outcome: "succeeded", exit_code: 0, output: "safe" });
    expect(existsSync(sentinel)).toBe(false);
    expect(records[0]).toMatchObject({ tool: "shell.execute", risk: "high", outcome: "succeeded" });
  });

  it("marks every command it runs as a Canopy governed run, so repository git hooks enforce inside it", async () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, [], { filesystem: "workspace_write" });

    const result = await call(tools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "process.stdout.write(String(process.env.ARBOR_GOVERNED_RUN))"],
    }, true));

    expect(result).toMatchObject({ outcome: "succeeded", exit_code: 0, output: "1" });
  });

  it("reports cancellation and output limits as execution outcomes", async () => {
    const root = directory("arbor-native-tools-root-");
    const cancellationRecords: NativeToolAuditRecord[] = [];
    const controller = new AbortController();
    const tools = host(root, cancellationRecords, { filesystem: "workspace_write" });
    const pending = call(tools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    }, true), controller.signal);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ outcome: "cancelled", stage: "execution", code: "cancelled" });

    const limitRecords: NativeToolAuditRecord[] = [];
    const limitedTools = host(root, limitRecords, { filesystem: "workspace_write", output: 16 });
    const limited = await call(limitedTools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1000))"],
    }, true));
    expect(limited).toMatchObject({ outcome: "failed", stage: "execution", code: "command_output_limit" });
    expect(limitRecords[0]).toMatchObject({ outcome: "failed", stage: "execution", code: "command_output_limit" });
  });

  it("[ADR-105 O2] shell.execute background mode returns a job_id immediately and shell.poll observes it settle", async () => {
    const root = directory("arbor-native-tools-root-");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write" });

    const started = await call(tools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "process.stdout.write('background-output')"], background: true,
    }, true));
    expect(started).toMatchObject({ outcome: "succeeded", status: "running" });
    const jobId = (started as { job_id: string }).job_id;
    expect(typeof jobId).toBe("string");

    let polled: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100 && polled.status !== "exited"; attempt += 1) {
      polled = await call(tools, "shell.poll", request(root, { job_id: jobId }));
      if (polled.status === "running") await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(polled).toMatchObject({ outcome: "succeeded", status: "exited", exit_code: 0, output: "background-output" });
  });

  it("[ADR-105 O2] shell.stop terminates a running background job and shell.poll reflects it", async () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, [], { filesystem: "workspace_write" });

    const started = await call(tools, "shell.execute", request(root, {
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], background: true,
    }, true));
    const jobId = (started as { job_id: string }).job_id;

    const stopped = await call(tools, "shell.stop", request(root, { job_id: jobId }));
    expect(stopped).toMatchObject({ outcome: "succeeded", status: "running" });

    let polled: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100 && polled.status !== "cancelled"; attempt += 1) {
      polled = await call(tools, "shell.poll", request(root, { job_id: jobId }));
      if (polled.status === "running") await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(polled).toMatchObject({ outcome: "succeeded", status: "cancelled" });
  });

  it("[ADR-105 O3] a background job is force-terminated when its owning session's signal aborts, and its table entry is removed with it", async () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, [], { filesystem: "workspace_write" });
    const sessionController = new AbortController();

    const started = await call(
      tools, "shell.execute",
      request(root, { argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], background: true }, true),
      sessionController.signal,
    );
    const jobId = (started as { job_id: string }).job_id;
    expect(started).toMatchObject({ outcome: "succeeded", status: "running" });

    // Simulate session end: the same signal this call received is aborted later.
    sessionController.abort();

    const polledAfter = await call(tools, "shell.poll", request(root, { job_id: jobId }));
    const stopAfter = await call(tools, "shell.stop", request(root, { job_id: jobId }));
    expect(polledAfter).toMatchObject({ outcome: "refused", stage: "semantic", code: "background_job_not_found" });
    expect(stopAfter).toMatchObject({ outcome: "refused", stage: "semantic", code: "background_job_not_found" });
  });

  it("refuses shell.poll/shell.stop for an unknown job id, and refuses background mode for verification.run", async () => {
    const root = directory("arbor-native-tools-root-");
    const tools = host(root, [], { filesystem: "workspace_write" });

    const poll = await call(tools, "shell.poll", request(root, { job_id: "does-not-exist" }));
    const stop = await call(tools, "shell.stop", request(root, { job_id: "does-not-exist" }));
    const verificationBackground = await call(tools, "verification.run", request(root, {
      argv: [process.execPath, "-e", "process.exit(0)"], background: true,
    }, true));

    expect(poll).toMatchObject({ outcome: "refused", stage: "semantic", code: "background_job_not_found" });
    expect(stop).toMatchObject({ outcome: "refused", stage: "semantic", code: "background_job_not_found" });
    expect(verificationBackground).toMatchObject({ outcome: "refused", stage: "semantic", code: "verification_background_unsupported" });
  });

  it("keeps semantic, audit, and sandbox refusal evidence distinct", async () => {
    const root = directory("arbor-native-tools-root-");
    writeFileSync(join(root, "note.txt"), "hello");
    const records: NativeToolAuditRecord[] = [];
    const readOnly = host(root, records);

    const semantic = await call(readOnly, "file.read", request(root, { path: 42 }));
    const sandbox = await call(readOnly, "file.write", request(root, { path: "note.txt", content: "changed" }));
    const auditRecords: NativeToolAuditRecord[] = [];
    const missingIntent = host(root, auditRecords, { intent: false });
    const audit = await call(missingIntent, "file.read", request(root, { path: "note.txt" }));

    expect(semantic).toMatchObject({ outcome: "refused", stage: "semantic", code: "path_invalid" });
    expect(sandbox).toMatchObject({ outcome: "refused", stage: "sandbox", code: "filesystem_read_only" });
    expect(audit).toMatchObject({ outcome: "refused", stage: "audit", code: "missing_trusted_intent" });
    expect(records.map((record) => record.stage)).toEqual(["semantic", "sandbox"]);
    expect(auditRecords[0]).toMatchObject({ intent: null, stage: "audit" });
  });

  it("uses exact-match patches and records only redacted audit summaries", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "readme.md"), "version=one\n");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write" });

    const result = await call(tools, "file.patch", request(root, { path: "docs/readme.md", expected: "version=one", replacement: "version=two version=three" }));
    const ambiguous = await call(tools, "file.patch", request(root, { path: "docs/readme.md", expected: "version", replacement: "release" }));

    expect(result).toMatchObject({ outcome: "succeeded", path: "docs/readme.md" });
    expect(ambiguous).toMatchObject({ outcome: "refused", stage: "audit", code: "patch_precondition_ambiguous" });
    expect(JSON.stringify(records)).not.toContain("version=one");
  });

  it("enforces the immutable documentation path classes after canonical traversal and symlink defenses", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".arbor"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "docs", "guide.md"), "old guide");
    writeFileSync(join(root, "src", "implementation.ts"), "old implementation");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write", documentation_only: true });

    const docsWrite = await call(tools, "file.write", request(root, { path: "docs/new-guide.md", content: "new guide", create: true }));
    const rootReadme = await call(tools, "file.write", request(root, { path: "README.md", content: "operator docs", create: true }));
    const arborWrite = await call(tools, "file.write", request(root, { path: ".arbor/runbook.md", content: "runbook", create: true }));
    const docsPatch = await call(tools, "file.patch", request(root, { path: "docs/guide.md", expected: "old guide", replacement: "current guide" }));
    const sourceWrite = await call(tools, "file.write", request(root, { path: "src/implementation.ts", content: "changed" }));
    const nonMarkdownDocs = await call(tools, "file.write", request(root, { path: "docs/config.json", content: "{}", create: true }));
    const traversal = await call(tools, "file.write", request(root, { path: "docs/../README.md", content: "no", create: true }));

    expect(docsWrite).toMatchObject({ outcome: "succeeded", path: "docs/new-guide.md" });
    expect(rootReadme).toMatchObject({ outcome: "succeeded", path: "README.md" });
    expect(arborWrite).toMatchObject({ outcome: "succeeded", path: ".arbor/runbook.md" });
    expect(docsPatch).toMatchObject({ outcome: "succeeded", path: "docs/guide.md" });
    expect(sourceWrite).toMatchObject({ outcome: "refused", stage: "sandbox", code: "documentation_path_denied" });
    expect(nonMarkdownDocs).toMatchObject({ outcome: "refused", stage: "sandbox", code: "documentation_path_denied" });
    expect(traversal).toMatchObject({ outcome: "refused", stage: "sandbox", code: "path_traversal" });
    expect(existsSync(join(root, "docs", "config.json"))).toBe(false);
    expect(records.slice(-3).map((record) => record.code)).toEqual(["documentation_path_denied", "documentation_path_denied", "path_traversal"]);
  });

  it("rejects a structural lookalike instead of accepting a caller-configured documentation allowlist", () => {
    const root = directory("arbor-native-tools-root-");
    expect(() => createNativeRepositoryToolHost({
      filesystem: "workspace_write",
      workspace_roots: [root],
      resolve_intent: () => ({ purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } }),
      write_path_policy: Object.freeze({ kind: "documentation_only" as const, path_classes: Object.freeze(["all_files"] as const) }) as never,
    })).toThrow("system-owned documentation policy");
  });

  it("binds a MINED scope in the audit tier: an undeclared write is allowed, an undeclared command still refused", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "src"));
    const records: NativeToolAuditRecord[] = [];
    const scope: NativeHighRiskToolScope = {
      scope_id: "mined-action-scope:a", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: root,
      provenance: { tag: "generated", generator: MINED_ACTION_SCOPE_GENERATOR, input_hash: "sha256:a" },
      write_paths: ["src/greeting.ts"], command_argv: [[process.execPath, "-e", "process.stdout.write('safe')"]],
    };
    const tools = host(root, records, { filesystem: "workspace_write", scope });
    const sibling = await call(tools, "file.write", request(root, { path: "src/greeting.test.ts", content: "test\n", create: true }));
    expect(sibling.outcome).toBe("succeeded");
    const command = await call(tools, "shell.execute", request(root, { argv: ["rm", "-rf", root] }, true));
    expect(command).toMatchObject({ outcome: "refused", code: "action_scope_command_denied" });
  });

  it("requires an exact action scope for high-risk path and argv effects", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "docs"));
    const sentinel = join(root, "must-not-exist");
    const records: NativeToolAuditRecord[] = [];
    const scope: NativeHighRiskToolScope = {
      scope_id: "scope-a", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: root,
      provenance: { tag: "generated", generator: "test-policy", input_hash: "scope-a" },
      write_paths: ["docs/allowed.md"], command_argv: [[process.execPath, "-e", "process.stdout.write('safe')"]],
    };
    const tools = host(root, records, { filesystem: "workspace_write", scope });
    const write = await call(tools, "file.write", request(root, { path: "docs/substituted.md", content: "no", create: true }));
    const command = await call(tools, "shell.execute", request(root, { argv: [process.execPath, "-e", "process.stdout.write('safe')", `; touch ${sentinel}`] }, true));
    const stale = await call(tools, "file.write", { ...request(root, { path: "docs/allowed.md", content: "no", create: true }), session_id: "session-b" });
    const missing = await call(host(root, records, { filesystem: "workspace_write", scope: null }), "file.write", request(root, { path: "docs/allowed.md", content: "no", create: true }));

    expect(write).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_path_denied" });
    expect(command).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_command_denied" });
    expect(stale).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_missing_or_stale" });
    expect(missing).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_missing_or_stale" });
    expect(existsSync(join(root, "docs", "substituted.md"))).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("refuses a high-risk write path check when the request's chosen admitted root is not the scope's own worktree_root (cross-root authority escape)", async () => {
    // Two DIFFERENT admitted workspace roots, each with its own coincidentally
    // identical relative path. The scope authorizes "shared.txt" only under
    // rootA (its worktree_root). A request that selects rootB as
    // workspace_root but reuses the SAME relative path must not be authorized
    // by rootA's scope -- write_paths are canonical-relative declarations
    // scoped to worktree_root (native-tools/contracts.ts:16-19), not bare
    // strings valid under any admitted root.
    const rootA = directory("arbor-native-tools-rootA-");
    const rootB = directory("arbor-native-tools-rootB-");
    const records: NativeToolAuditRecord[] = [];
    const scope: NativeHighRiskToolScope = {
      scope_id: "scope-cross-root", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: rootA,
      provenance: { tag: "generated", generator: "test-policy", input_hash: "scope-cross-root" },
      write_paths: ["shared.txt"], command_argv: [],
    };
    const descriptors = createNativeRepositoryToolHost({
      filesystem: "workspace_write",
      workspace_roots: [rootA, rootB],
      resolve_intent: () => ({ purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } }),
      resolve_high_risk_scope: () => scope,
      on_audit: (record) => records.push(record),
    });
    const tools = new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));
    const crossRootWrite = await call(tools, "file.write", {
      session_id: "session-a", turn: 1, call_id: "call-a",
      input: { workspace_root: rootB, path: "shared.txt", content: "written into the wrong root", create: true },
      workspace_roots: [rootA, rootB], filesystem: "workspace_write", intent_evidence: [], network_allowed: false,
    });
    expect(crossRootWrite).toMatchObject({ outcome: "refused" });
    expect(existsSync(join(rootB, "shared.txt"))).toBe(false);
  });

  it("honors a mined (derived, non-authored) high-risk scope: the declared path writes, an undeclared path writes in the audit tier, and it names what's missing when no scope was ever authorized", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "docs"));
    const records: NativeToolAuditRecord[] = [];
    // Provenance stamped exactly the way `CampaignManager.deriveNativeHighRiskToolScope`
    // stamps a fallback scope mined from an action's own declared task text
    // (manager.ts) when a reviewed-tier planner left `high_risk_tool_scope`
    // null -- distinct from an authored `governed-action-scope-v1` generator,
    // so the audit trail can tell mined authority apart from planner-authored
    // authority (2026-08-24 re-bench).
    const minedScope: NativeHighRiskToolScope = {
      scope_id: "mined-action-scope:abc", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: root,
      provenance: { tag: "generated", generator: "campaign-manager/mined-action-scope-v1", input_hash: "sha256:deadbeef" },
      write_paths: ["docs/declared.md"], command_argv: [],
    };
    const tools = host(root, records, { filesystem: "workspace_write", scope: minedScope });

    const declaredWrite = await call(tools, "file.write", request(root, { path: "docs/declared.md", content: "mined write", create: true }));
    expect(declaredWrite).toMatchObject({ outcome: "succeeded" });
    expect(existsSync(join(root, "docs", "declared.md"))).toBe(true);

    // Y-1 (ADR-065) at the host, 2026-09-03: a mined scope is guessed from
    // task text and cannot know the task's tests and siblings. An undeclared
    // write under it is journaled by the verifier as a scope observation
    // and weighed at adoption; the host no longer refuses it.
    const undeclaredWrite = await call(tools, "file.write", request(root, { path: "docs/undeclared.md", content: "sibling", create: true }));
    expect(undeclaredWrite).toMatchObject({ outcome: "succeeded" });
    expect(existsSync(join(root, "docs", "undeclared.md"))).toBe(true);
    expect(records.some((record) => record.code === "action_scope_path_denied")).toBe(false);

    const noScopeTools = host(root, records, { filesystem: "workspace_write", scope: null });
    const response = await noScopeTools.get("file.write")!.execute(request(root, { path: "docs/declared.md", content: "no", create: true }), null, new AbortController().signal);
    expect(response.evidence).toMatchObject({ outcome: "refused", stage: "audit", code: "action_scope_missing_or_stale" });
    expect(response.result_summary).toContain("no high-risk action scope is authorized");
  });

  it("allows a benign exact action-scoped write while retaining documentation policy intersection", async () => {
    const root = directory("arbor-native-tools-root-");
    mkdirSync(join(root, "docs"));
    const records: NativeToolAuditRecord[] = [];
    const scope: NativeHighRiskToolScope = {
      scope_id: "scope-doc", campaign_id: "campaign-a", node_id: "node-a", session_id: "session-a", worktree_root: root,
      provenance: { tag: "verified", cmd: "policy", exit: 0, stdout_hash: "sha256:scope" }, write_paths: ["docs/allowed.md"], command_argv: [],
    };
    const result = await call(host(root, records, { filesystem: "workspace_write", documentation_only: true, scope }), "file.write", request(root, { path: "docs/allowed.md", content: "safe", create: true }));
    expect(result).toMatchObject({ outcome: "succeeded", path: "docs/allowed.md" });
    expect(records[0]).toMatchObject({
      outcome: "succeeded", effect: "applied",
      action_scope: { status: "bound", provenance_tag: "verified", scope_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    });
    expect(JSON.stringify(records)).not.toContain("scope-doc");
  });

  it("honestly refuses arbitrary commands when network prohibition cannot be sandboxed", async () => {
    const root = directory("arbor-native-tools-root-");
    const records: NativeToolAuditRecord[] = [];
    const result = await call(host(root, records, { sandbox: createSandboxBroker({ disable_os_confinement: true }) }), "verification.run", request(root, { argv: [process.execPath, "-e", "process.stdout.write('ok')"] }, false));

    expect(result).toMatchObject({ outcome: "refused", stage: "sandbox", code: "network_isolation_unavailable" });
    expect(records[0]).toMatchObject({ confinement: "application_validated" });
  });

  it("executes denied-network commands only when the OS broker is active and records the actual grade", async () => {
    const root = directory("arbor-native-tools-root-");
    const records: NativeToolAuditRecord[] = [];
    const broker = createSandboxBroker();
    if (broker.confinement !== "os_confined") return;
    const result = await call(host(root, records, { filesystem: "workspace_write", sandbox: broker }), "verification.run", request(root, { argv: [process.execPath, "-e", "process.stdout.write('ok')"] }, false));
    expect(result).toMatchObject({ outcome: "succeeded", confinement: "os_confined" });
    expect(records[0]).toMatchObject({ outcome: "succeeded", confinement: "os_confined" });
  });

  it("wires evidence.refresh end to end: dispatched through the broker, dry_run never executes a refresh step", async () => {
    const root = directory("arbor-native-tools-evidence-refresh-");
    const argvCalls: string[][] = [];
    const broker: SandboxBroker = {
      confinement: "os_confined",
      diagnostic: "evidence.refresh wiring witness",
      run: async (sandboxRequest) => {
        argvCalls.push([...sandboxRequest.argv]);
        if (sandboxRequest.argv.join(" ") === "bun scripts/store-freshness-gate.mjs --json") {
          const body = JSON.stringify({ ok: false, stores: [{ name: "claim-ledger", state: "fail", detail: "trails HEAD", refresh: "bun run claims:refresh" }] });
          return { kind: "exited" as const, exit: 1, stdout: Buffer.from(body), stderr: Buffer.alloc(0), confinement: "os_confined" as const };
        }
        return { kind: "exited" as const, exit: 0, stdout: Buffer.from("unexpected refresh command executed"), stderr: Buffer.alloc(0), confinement: "os_confined" as const };
      },
    };
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "workspace_write", sandbox: broker });

    expect(tools.has("evidence.refresh")).toBe(true);
    const result = await call(tools, "evidence.refresh", request(root, { scope: "auto", dry_run: true }));

    expect(result.outcome).toBe("succeeded");
    // All read-only preconditions run (store freshness, graph commit-distance,
    // then graph reproducibility); dry_run still executes no refresh step.
    expect(argvCalls).toEqual([
      ["bun", "scripts/store-freshness-gate.mjs", "--json"],
      ["bun", "run", "gate:vi-freshness"],
      ["bun", "run", "gate:vi-reproducible"],
    ]);
    const payload = result as unknown as { dry_run: boolean; stores: Array<{ name: string; action: string }> };
    expect(payload.dry_run).toBe(true);
    expect(payload.stores.find((s) => s.name === "claim-ledger")?.action).toBe("would_refresh");
  });

  it("refuses a real (non dry_run) evidence.refresh under the read-only filesystem policy", async () => {
    const root = directory("arbor-native-tools-evidence-refresh-readonly-");
    const records: NativeToolAuditRecord[] = [];
    const tools = host(root, records, { filesystem: "read_only" });

    const result = await call(tools, "evidence.refresh", request(root, { scope: "auto" }));

    expect(result).toMatchObject({ outcome: "refused", stage: "sandbox", code: "filesystem_read_only" });
  });

  it("[ADR-105 O4] todo.write replaces the bounded ordered list, todo.read observes it, and neither consults high-risk governance scope", async () => {
    const root = directory("arbor-native-tools-root-");
    const records: NativeToolAuditRecord[] = [];
    let scopeCalls = 0;
    const descriptors = createNativeRepositoryToolHost({
      filesystem: "workspace_write",
      workspace_roots: [root],
      resolve_intent: () => ({ purpose: "test evidence", provenance: { tag: "claimed", claimant: "test" } }),
      resolve_high_risk_scope: () => { scopeCalls += 1; return null; },
      on_audit: (record) => records.push(record),
    });
    const tools = new Map(descriptors.map((descriptor) => [descriptor.tool, descriptor.port]));

    const empty = await call(tools, "todo.read", request(root, {}));
    const written = await call(tools, "todo.write", request(root, { items: [
      { id: "1", text: "first", status: "pending" },
      { id: "2", text: "second", status: "in_progress" },
    ] }));
    const read = await call(tools, "todo.read", request(root, {}));
    const duplicate = await call(tools, "todo.write", request(root, { items: [
      { id: "1", text: "a", status: "pending" }, { id: "1", text: "b", status: "pending" },
    ] }));
    const badStatus = await call(tools, "todo.write", request(root, { items: [{ id: "1", text: "a", status: "bogus" }] }));

    expect(empty).toMatchObject({ outcome: "succeeded", items: [] });
    expect(written).toMatchObject({ outcome: "succeeded", items: [{ id: "1", status: "pending" }, { id: "2", status: "in_progress" }] });
    expect(read).toMatchObject({ outcome: "succeeded", items: [{ id: "1" }, { id: "2" }] });
    expect(duplicate).toMatchObject({ outcome: "refused", stage: "semantic", code: "todo_id_duplicate" });
    expect(badStatus).toMatchObject({ outcome: "refused", stage: "semantic", code: "todo_status_invalid" });
    // No high-risk governance scope is ever consulted for todo.write/todo.read
    // (both are risk "low"), and their audit evidence carries no action-scope
    // binding — the concrete, evidenced shape of ADR-105 O4's claim that this
    // state is untouched by @arbor/governance's obligation/waiver/gate machinery.
    expect(scopeCalls).toBe(0);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.action_scope.status === "not_required")).toBe(true);
    expect(tools.get("todo.write")?.recovery_protection?.(request(root, { items: [] }))).toMatchObject({ effect_kind: "external", repeatable: true });
  });
});
