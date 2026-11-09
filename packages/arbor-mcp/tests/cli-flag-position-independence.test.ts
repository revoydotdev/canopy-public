// ADR-116: an operator flag on `arbor task` must work wherever it reads
// naturally. Before this ADR, `taskComposerCommand` refused any `args[0]`
// starting with "-" as an "unknown" option before the parser ever looked at
// it — so `arbor task --tier direct "text"` was refused even though `--tier`
// is a genuinely recognized, position-independently-parsed flag (proven by
// `arbor task "text" --tier direct` already working). These tests drive the
// real CLI entrypoint (`main`), not `taskComposerCommand` or its internal
// flag-parsing helpers, per this repo's "test through the real surface"
// convention — see cli.test.ts's own U1/D12 tests for the established
// pattern this file follows.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resolvePersistenceDir } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { ArborRuntime } from "../src/runtime.js";
import { TaskComposer } from "../src/task-composer.js";
import { CampaignManager } from "../src/manager.js";

/** Environment builder matching main()'s expected shape, with fresh streams per call. */
function makeEnv(cwd: string, overrides: Partial<{ persistence_dir: string; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; runtime_factory: (cwd: string, persistenceDir?: string) => ArborRuntime }> = {}) {
  return {
    cwd,
    persistence_dir: overrides.persistence_dir,
    stdin: overrides.stdin ?? new PassThrough(),
    stdout: overrides.stdout ?? new PassThrough(),
    stderr: overrides.stderr ?? new PassThrough(),
    runtime_factory: overrides.runtime_factory,
  };
}

function collect(stream: PassThrough): { text(): string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { text: () => buf };
}

/** Same deterministic, instantly-admittable stub runtime cli.test.ts uses for
 * `task confirm`/submit assertions — no planner or campaign runner round
 * trip, so a bare `task --plan` submit settles synchronously and repeatably. */
function confirmableStubRuntime(cwd: string, persistenceDir?: string): ArborRuntime {
  const dir = resolvePersistenceDir(cwd, persistenceDir);
  const proposal = JSON.stringify({
    summary: "implement the requested change", assumptions: [], questions: [],
    root_action: { description: "deliver the task", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
    actions: [{ description: "implement and verify", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
    acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["implement and verify"] }], risk_notes: [],
  });
  const manager = new CampaignManager({ persistence_dir: dir });
  const taskComposer = new TaskComposer({
    manager, persistence_dir: dir,
    planner: { plan: async () => ({ raw_proposal: proposal, session_id: "plan-session", model_identity: "native-test", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" } }) },
    admission: { admit: async ({ campaign_id }) => ({ campaign_id, job_id: `job-${campaign_id}` }) },
  });
  return new ArborRuntime({ persistence_dir: dir, workspace_root: cwd, manager, task_composer: taskComposer });
}

describe("ADR-116: task flags are position-independent", () => {
  it("(ADR-116 O1/decision 1) a leading '--tier' reaches the same planner-submission path as the identical trailing-'--tier' call", async () => {
    const leadingRoot = mkdtempSync(join(tmpdir(), "arbor-cli-flag-leading-"));
    const trailingRoot = mkdtempSync(join(tmpdir(), "arbor-cli-flag-trailing-"));
    try {
      const leadingOut = new PassThrough();
      const leading = collect(leadingOut);
      const leadingCode = await main(
        ["task", "--tier", "direct", "inspect the widget and report findings", "--plan", "--json"],
        makeEnv(leadingRoot, { stdout: leadingOut, runtime_factory: confirmableStubRuntime }),
      );

      const trailingOut = new PassThrough();
      const trailing = collect(trailingOut);
      const trailingCode = await main(
        ["task", "inspect the widget and report findings", "--tier", "direct", "--plan", "--json"],
        makeEnv(trailingRoot, { stdout: trailingOut, runtime_factory: confirmableStubRuntime }),
      );

      // Neither call is a usage error (the pre-ADR-116 defect), and both
      // reach the identical accepted-draft shape the planner-submission path
      // produces.
      expect(leadingCode).not.toBe(EXIT_CODES.USAGE);
      expect(trailingCode).not.toBe(EXIT_CODES.USAGE);
      expect(leadingCode).toBe(EXIT_CODES.SUCCESS);
      expect(trailingCode).toBe(EXIT_CODES.SUCCESS);

      const leadingResult = JSON.parse(leading.text());
      const trailingResult = JSON.parse(trailing.text());
      expect(leadingResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "proposed" } } });
      expect(trailingResult).toMatchObject({ ok: true, value: { accepted: true, draft: { status: "proposed" } } });
      // Only non-deterministic identifiers (draft/campaign ids, timestamps,
      // operation ids) may differ between the two independent invocations.
      expect(Object.keys(leadingResult)).toEqual(Object.keys(trailingResult));
      expect(Object.keys(leadingResult.value.draft)).toEqual(Object.keys(trailingResult.value.draft));
    } finally {
      rmSync(leadingRoot, { recursive: true, force: true });
      rmSync(trailingRoot, { recursive: true, force: true });
    }
  });

  it("(ADR-116 disambiguation) '--tier''s own value is never misread as a subcommand, even when it names a real one", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-flag-value-ambiguity-"));
    try {
      // "confirm" is a real TASK_SUBCOMMANDS entry — a plausible value for an
      // operator to type by mistake — but subcommand classification looks
      // only at args[0] ("--tier"), never at a flag's own value, so this must
      // fail --tier's own enum validation, not get dispatched as `task
      // confirm confirm-shaped-args...`.
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(
        ["task", "--tier", "confirm", "inspect the widget and report findings", "--json"],
        makeEnv(root, { stderr: err, runtime_factory: confirmableStubRuntime }),
      );
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(errText.text()).toContain("--tier requires one of: direct, reviewed, governed");
      expect(errText.text()).not.toContain("Unknown task option");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(ADR-116) a genuinely unknown leading flag is still refused, and the refusal still names it", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-flag-unknown-"));
    try {
      const err = new PassThrough();
      const errText = collect(err);
      const code = await main(["task", "--nonexistent-flag", "some task text"], makeEnv(root, { stderr: err }));
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(errText.text()).toContain("Unknown task option: --nonexistent-flag");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(ADR-116, --json safety) the leading-'--tier' path writes nothing to stdout but the single JSON document", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-flag-json-safety-"));
    try {
      const out = new PassThrough();
      const outText = collect(out);
      const code = await main(
        ["task", "--tier", "direct", "inspect the widget and report findings", "--plan", "--json"],
        makeEnv(root, { stdout: out, runtime_factory: confirmableStubRuntime }),
      );
      expect(code).toBe(EXIT_CODES.SUCCESS);
      // A stray human-facing write on the --json path (a demotion notice, a
      // progress line, anything) would make stdout contain more than the
      // single `JSON.stringify(result, null, 2)` document `main` writes —
      // round-tripping the exact text catches any such extra bytes, before
      // or after the JSON, that a naive JSON.parse() alone would tolerate.
      const text = outText.text();
      const parsed = JSON.parse(text);
      expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(ADR-116 decision 2) 'task --help' and the usage error both advertise exactly the same flag set", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-cli-flag-usage-parity-"));
    try {
      const helpOut = new PassThrough();
      const help = collect(helpOut);
      expect(await main(["task", "--help"], makeEnv(root, { stdout: helpOut }))).toBe(EXIT_CODES.SUCCESS);

      const usageErr = new PassThrough();
      const usage = collect(usageErr);
      // Any leading unrecognized flag reaches `taskUsage` via the same
      // refusal path exercised above.
      expect(await main(["task", "--nonexistent-flag"], makeEnv(root, { stderr: usageErr }))).toBe(EXIT_CODES.USAGE);

      const helpFlags = new Set<string>();
      const optionsSection = help.text().split("Options:\n")[1]?.split("\n\nExit codes:")[0] ?? "";
      for (const line of optionsSection.split("\n")) {
        const match = line.match(/^ {2}(--[a-zA-Z-]+)/);
        if (match) helpFlags.add(match[1]!);
      }

      const usageFlags = new Set<string>();
      const flagsLine = usage.text().split("\n").find((line) => line.startsWith("Flags: ")) ?? "";
      for (const match of flagsLine.matchAll(/(--[a-zA-Z-]+)/g)) usageFlags.add(match[1]!);

      expect(helpFlags.size).toBeGreaterThan(3);
      expect([...helpFlags].sort()).toEqual([...usageFlags].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
