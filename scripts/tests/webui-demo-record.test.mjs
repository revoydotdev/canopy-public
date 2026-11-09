import { describe, expect, it } from "vitest";
import { assertWebUiDemoContract, choosePageTarget, contactSheetGrid, extractVerifiedCheck, frameConcat } from "../webui-demo-record.mjs";

const hash = (digit) => `sha256:${digit.repeat(64)}`;

function validPackage() {
  const chapterIds = ["workspace", "task-entry", "planning", "tree-search", "independent-review", "result-review", "evidence-seal"];
  return {
    artifact_kind: "real_time_governed_webui_campaign",
    duration_ms: 180_000,
    executor: { kind: "provider_backed", integration: "claude-code" },
    chapters: chapterIds.map((id, index) => ({ id, capture_ms: index * 20_000, rendered_ms: index * 20_000, timing: "real_time", evidence_hashes: [hash(String((index % 9) + 1))] })),
    empirical_checks: {
      task_typed_through_browser: true,
      task_submitted_through_browser: true,
      campaign_rendered: true,
      tree_rendered: true,
      specialist_dispatched: true,
      critic_dispatched: true,
      verified_result: true,
      result_review_rendered: true,
    },
    privacy: { page_pixels_only: true, ocr_all_frames_passed: true, findings: 0, visual_review_attested: true, visual_review_hashes: [hash("a")] },
    ledger_tip: hash("b"),
    verification: { provenance: "verified", exit_code: 0 },
  };
}

describe("governed WebUI demo publication contract", () => {
  it("accepts a minutes-long provider-backed browser campaign with linked evidence", () => {
    expect(() => assertWebUiDemoContract(validPackage())).not.toThrow();
  });

  it("fails closed on staged timing, missing browser interaction, or incomplete pixel review", () => {
    const pkg = validPackage();
    pkg.chapters[3].rendered_ms -= 1000;
    expect(() => assertWebUiDemoContract(pkg)).toThrow(/real timing/);
    pkg.chapters[3].rendered_ms = pkg.chapters[3].capture_ms;
    pkg.empirical_checks.task_typed_through_browser = false;
    expect(() => assertWebUiDemoContract(pkg)).toThrow(/proof is incomplete/);
    pkg.empirical_checks.task_typed_through_browser = true;
    pkg.privacy.visual_review_attested = false;
    expect(() => assertWebUiDemoContract(pkg)).toThrow(/privacy review/);
    pkg.privacy.visual_review_attested = true;
    pkg.chapters.at(-1).capture_ms = pkg.duration_ms + 1;
    pkg.chapters.at(-1).rendered_ms = pkg.duration_ms + 1;
    expect(() => assertWebUiDemoContract(pkg)).toThrow(/inside the captured duration/);
  });

  it("chooses an inspectable browser page target instead of DevTools or workers", () => {
    expect(choosePageTarget([
      { type: "service_worker", url: "https://example.test/worker.js" },
      { type: "page", url: "devtools://devtools/bundled/inspector.html" },
      { id: "shell", type: "page", url: "chrome-extension://vivaldi/welcome.html", webSocketDebuggerUrl: "ws://shell" },
      { id: "webui", type: "page", url: "http://127.0.0.1:4000/", webSocketDebuggerUrl: "ws://page" },
    ], "webui")).toMatchObject({ webSocketDebuggerUrl: "ws://page" });
  });

  it("writes timestamp-derived concat durations and duplicates the final frame", () => {
    const body = frameConcat([{ at_ms: 0, path: "/tmp/a.png" }, { at_ms: 1250, path: "/tmp/b.png" }, { at_ms: 2000, path: "/tmp/c.png" }]);
    expect(body).toContain("duration 1.250000");
    expect(body).toContain("duration 0.750000");
    expect(body.match(/file '\/tmp\/c.png'/g)).toHaveLength(2);
  });

  it("extracts command evidence from nested verified record shapes without accepting claimed output", () => {
    const record = extractVerifiedCheck({
      campaign_id: "campaign-a",
      confidence: "verified",
      checks: [{ command: ["bun", "vitest", "run", "focused.test.ts"], exit_status: 0 }],
    }, "campaign-a");
    expect(record).toMatchObject({ provenance: "verified", command: "bun vitest run focused.test.ts", exit_code: 0 });
    expect(extractVerifiedCheck({ campaign_id: "campaign-a", provenance: "claimed", command: "bun test", exit_code: 0 }, "campaign-a")).toBeNull();
  });

  it("chooses compact contact-sheet grids before aspect-ratio tie breaking", () => {
    expect(contactSheetGrid(6)).toEqual({ columns: 3, rows: 2 });
    expect(contactSheetGrid(7)).toEqual({ columns: 4, rows: 2 });
    expect(contactSheetGrid(1)).toEqual({ columns: 1, rows: 1 });
  });
});
