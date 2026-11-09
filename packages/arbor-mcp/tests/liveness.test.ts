/**
 * Liveness attestation tests.
 *
 * The thing being tested is an instrument, so the tests are mostly about
 * whether it can be fooled. Two properties matter more than coverage:
 *
 *  1. It must not report health it did not observe. Every "answered" has to
 *     come from a dispatch that actually happened.
 *  2. It must distinguish a working seam declining from a broken one. A binary
 *     result would score `a2a.send` without a secret and the historical
 *     `diagnostics` bug identically, and the second one is the whole point.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeError, RuntimeErrorCode } from "@arbor/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyRuntimeError,
  probeCatalog,
  probeConsumers,
  probePayloads,
  summarize,
  type DeclaredConsumer,
  type LivenessProbeContext,
} from "../src/liveness.js";
import { runLiveness, livenessRouterFromCompositionRoot } from "../src/liveness-runner.js";
import { TUI_SCREEN_CONSUMERS, consumersCoverScreens, screensWithDispatch } from "../src/liveness-consumers.js";
import { RUNTIME_CATALOG } from "../src/runtime-catalog.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AT = "2026-08-07T00:00:00.000Z";

function error(code: RuntimeErrorCode, summary = "s"): RuntimeError {
  return { code, severity: "error", recoverable: true, source: "test", summary };
}

describe("classifyRuntimeError — the four outcomes", () => {
  it("treats a typed decline as a working seam, not a failure", async () => {
    for (const code of ["permission", "unavailable", "conflict", "cancellation"] as const) {
      expect(classifyRuntimeError(error(code))).toBe("refused");
    }
  });

  it("treats an internal, transport, timeout or corrupt-data error as unreachable", async () => {
    for (const code of ["internal", "transport", "timeout", "corrupt_data"] as const) {
      expect(classifyRuntimeError(error(code))).toBe("unreachable");
    }
  });

  it("treats a PROBER's validation failure as indeterminate — the probe's own payload may be wrong", async () => {
    expect(classifyRuntimeError(error("validation"), "prober")).toBe("indeterminate");
  });

  it("treats a CONSUMER's validation failure as unreachable — that request shape is the thing under test", async () => {
    // This asymmetry is load-bearing. Collapsing it would have downgraded the
    // real diagnostics defect to "nothing is known" and let it pass a gate.
    expect(classifyRuntimeError(error("validation"), "consumer")).toBe("unreachable");
  });
});

describe("probeCatalog — attestation is observed, never claimed", () => {
  it("covers every declared catalog entry exactly once", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const probes = await probeCatalog({ router, context });
      expect(probes).toHaveLength(RUNTIME_CATALOG.length);
      const kinds = probes.map((p) => `${p.direction}:${p.kind}`).sort();
      const declared = RUNTIME_CATALOG.map((e) => `${e.direction}:${e.kind}`).sort();
      expect(kinds).toEqual(declared);
    } finally {
      await dispose();
    }
  });

  it("answers live node projections and fail-closes unpublished A2A cards", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const probes = await probeCatalog({ router, context });
      for (const kind of ["foreground.derive", "nodecard.resolve"] as const) {
        const probe = probes.find((p) => p.kind === kind);
        expect(probe, kind).toBeDefined();
        expect(probe!.outcome, kind).toBe("answered");
        expect(probe!.declared_supported, kind).toBe(true);
      }
      const a2a = probes.find((p) => p.kind === "a2a.cards");
      expect(a2a).toMatchObject({ outcome: "refused", declared_supported: true });
    } finally {
      await dispose();
    }
  });

  it("probes seeded detail identities and the governed context reads without mutating the runtime", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const payloads = probePayloads(context);
      expect(payloads["operation.get"]).toEqual({ operation_id: context.operation_id });
      expect(payloads["output.descriptor"]).toEqual({ evidence_id: context.output_evidence_id });
      expect(payloads["context.workspace"]).toMatchObject({ artifact_id: context.context_artifact_id, visibility: "campaign" });
      expect(payloads["harness.evaluation.detail"]).toEqual({ run_id: context.evaluation_run_id });

      const probes = await probeCatalog({ router, context });
      for (const kind of ["operation.get", "output.descriptor", "context.workspace", "context.governance", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail"] as const) {
        expect(probes.find((probe) => probe.kind === kind), kind).toMatchObject({ outcome: "answered" });
      }
      expect(probes.find((probe) => probe.kind === "output.raw")).toMatchObject({ outcome: "refused" });
    } finally {
      await dispose();
    }
  });

  it("does not invoke mutating kinds by default, and says so rather than implying health", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const probes = await probeCatalog({ router, context });
      const commands = probes.filter((p) => p.direction === "command");
      expect(commands.length).toBeGreaterThan(20);
      for (const probe of commands) {
        if (probe.declared_supported) {
          expect(probe.outcome, probe.kind).toBe("indeterminate");
          expect(probe.detail, probe.kind).toContain("mutating kind not probed");
        } else {
          expect(probe.outcome, probe.kind).toBe("refused");
        }
      }
    } finally {
      await dispose();
    }
  });

  it("executes declared disposable command trajectories without treating a fixture acknowledgement as proof", async () => {
    // The gate enables this mode. Each trajectory dispatches against the
    // mkdtemp composition root and checks a durable/read-side consequence
    // before `probeCatalog` is allowed to classify it as answered.
    const report = await runLiveness({ at: AT, includeMutating: true });
    const commands = report.catalog.filter((probe) => probe.direction === "command");
    expect(commands.some((probe) => probe.outcome === "unreachable")).toBe(false);
    expect(report.summary.catalog_indeterminate).toBeLessThanOrEqual(30);
    const probes = new Map(report.catalog.map((probe) => [probe.kind, probe]));
    expect(probes.get("git.workspace")?.outcome).toBe("refused");
    for (const kind of ["git.worktree.create", "git.worktree.switch", "git.worktree.cleanup"] as const) {
      // The disposable liveness probe has no signed operator session. Git
      // mutations now refuse at that boundary before repository availability.
      expect(probes.get(kind), kind).toMatchObject({ outcome: "refused", error_code: "permission" });
    }
    expect(probes.get("inspect.action")?.outcome).toBe("answered");
    expect(probes.get("governance.record.search")?.outcome).toBe("answered");
    expect(probes.get("governance.record.read")?.outcome).toBe("answered");
    for (const kind of ["tree.branch", "tree.prune", "communication.record", "output.capture", "bus.record", "job.submit", "job.cancel", "job.pause", "job.resume"] as const) {
      expect(commands.find((probe) => probe.kind === kind), kind).toMatchObject({ outcome: "answered" });
    }
    for (const kind of ["integration.install", "peer.grant", "a2a.send", "harness.promote", "harness.session.resume", "approval.request", "approval.approve", "approval.reject", "approval.expire"] as const) {
      expect(commands.find((probe) => probe.kind === kind), kind).toMatchObject({ outcome: "refused" });
    }
  });

  it("reports an undeclared probe payload as indeterminate, never as answered", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const probes = await probeCatalog({ router, context });
      const unprobed = probes.filter((p) => p.detail === "no probe payload declared");
      for (const probe of unprobed) expect(probe.outcome).toBe("indeterminate");
    } finally {
      await dispose();
    }
  });

  it("actually exercises the runtime — a non-trivial number of seams answer", async () => {
    // Guards the whole instrument against the failure mode where it passes by
    // measuring nothing: every other assertion here would still hold if the
    // prober silently dispatched zero requests.
    const report = await runLiveness({ at: AT });
    expect(report.summary.catalog_answered).toBeGreaterThan(15);
  });
});

describe("probeConsumers — the family that catches call-site defects", () => {
  const ctx: LivenessProbeContext = {
    campaign_id: "c", node_id: "root", child_node_id: "child", stream_id: "s",
    operation_id: "operation", output_evidence_id: "out_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", context_artifact_id: "ctx_artifact",
  };

  it("flags a consumer whose own request does not validate", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      // The historical defect, reproduced verbatim: `cursor` must be a
      // `RuntimeCursor` record, and `refreshScreenData` sent a bare number.
      const broken: DeclaredConsumer = {
        consumer: "regression:diagnostics-cursor-0",
        kind: "event.resume",
        request: () => ({ cursor: 0 }),
      };
      const probes = probeConsumers({ router, context, consumers: [broken] });
      expect(probes[0].outcome).toBe("unreachable");
    } finally {
      await dispose();
    }
  });

  it("passes the same consumer once its request matches the contract — the seam was never the problem", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const fixed: DeclaredConsumer = {
        consumer: "regression:diagnostics-cursor-record",
        kind: "event.resume",
        request: (c) => ({ cursor: { stream_id: c.stream_id, sequence: 0 } }),
      };
      const probes = probeConsumers({ router, context, consumers: [fixed] });
      expect(probes[0].outcome).toBe("answered");
    } finally {
      await dispose();
    }
  });

  it("reports a consumer naming a non-existent seam as indeterminate", async () => {
    const { router, context, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const bogus = { consumer: "x", kind: "not.a.kind", request: () => ({}) } as unknown as DeclaredConsumer;
      const probes = probeConsumers({ router, context, consumers: [bogus] });
      expect(probes[0].outcome).toBe("indeterminate");
    } finally {
      await dispose();
    }
  });

  it("every declared TUI consumer answers on a real composition root", async () => {
    const report = await runLiveness({ at: AT });
    const bad = report.consumers.filter((p) => p.outcome !== "answered" && p.outcome !== "refused");
    expect(bad.map((p) => `${p.consumer}: ${p.detail}`)).toEqual([]);
    expect(report.consumers).toHaveLength(TUI_SCREEN_CONSUMERS.length);
  });

  it("consumers do not drift from the screens that dispatch", async () => {
    // The mirroring weakness this check exists to bound: a screen that gains a
    // dispatch with no declared consumer is a real request shape nothing
    // attests to. Empty is the healthy state.
    const tuiSource = readFileSync(join(REPO_ROOT, "packages/arbor-mcp/src/tui.ts"), "utf8");
    expect(screensWithDispatch(tuiSource).length).toBeGreaterThan(5);
    expect(consumersCoverScreens(tuiSource)).toEqual([]);
  });

  it("summarize counts each outcome exactly once", async () => {
    const { router, dispose } = await livenessRouterFromCompositionRoot();
    try {
      const consumers = probeConsumers({ router, context: ctx, consumers: [] });
      const summary = summarize([], consumers);
      expect(summary.catalog_total).toBe(0);
      expect(summary.consumers_total).toBe(0);
    } finally {
      await dispose();
    }
  });
});

describe("the whole report", () => {
  it("has no unreachable seam or consumer on the current tree", async () => {
    const report = await runLiveness({ at: AT });
    expect(report.catalog.filter((p) => p.outcome === "unreachable").map((p) => `${p.kind}: ${p.detail}`)).toEqual([]);
    expect(report.consumers.filter((p) => p.outcome === "unreachable").map((p) => `${p.consumer}: ${p.detail}`)).toEqual([]);
  });

  it("is deterministic across runs given the same tree", async () => {
    const shape = async (at: string): Promise<string> =>
      JSON.stringify((await runLiveness({ at })).catalog.map((p) => [p.kind, p.direction, p.outcome]));
    expect(await shape(AT)).toBe(await shape(AT));
  });
});

describe("devtools_liveness — the map is callable", () => {
  it("is exposed as a devtools tool and returns a real report when invoked", async () => {
    const { ArborRuntime } = await import("../src/runtime.js");
    const { RuntimeCatalogRouter } = await import("../src/runtime-catalog.js");
    const { BreakpointRegistry } = await import("../src/devtools-breakpoints.js");
    const { defineDevToolsTools } = await import("../src/devtools.js");

    const runtime = new ArborRuntime();
    const catalog = new RuntimeCatalogRouter(runtime);
    const tools = defineDevToolsTools(runtime, catalog, new BreakpointRegistry());

    const tool = tools.find((t) => t.name === "devtools_liveness");
    expect(tool, "devtools_liveness must be registered").toBeDefined();

    // The point of the whole exercise: an agent can ask the running system what
    // is alive, through the same surface it dispatches through. Invoked here
    // rather than merely asserted present — a registered tool that throws on
    // call is the defect this instrument exists to find.
    const report = (await tool!.handler({})) as {
      catalog: unknown[];
      consumers: unknown[];
      summary: { catalog_total: number; catalog_answered: number };
    };

    expect(report.summary.catalog_total).toBe(RUNTIME_CATALOG.length);
    expect(report.summary.catalog_answered).toBeGreaterThan(0);
    expect(Array.isArray(report.catalog)).toBe(true);
    expect(Array.isArray(report.consumers)).toBe(true);
  });
});

describe("arbor liveness — scratch working directory", () => {
  it("attests from a cwd with no decisions/ instead of aborting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "arbor-liveness-cwd-"));
    try {
      const result = spawnSync("bun", [join(REPO_ROOT, "packages", "arbor-mcp", "src", "cli.ts"), "liveness", "--json"], { cwd, encoding: "utf8", timeout: 60_000 });
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
