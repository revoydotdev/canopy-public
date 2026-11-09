import { describe, expect, it } from "vitest";
import { reviewDocument } from "../src/console-review-document.js";
import { consoleScreen } from "../src/screens/console.js";
import { displayWidth } from "../src/widgets.js";

const review = JSON.stringify({ approved: true, rationale: "The reviewer approved this change.", checks: [{ name: "measurement_validation", passed: true, detail: "Reviewer-reported check detail." }] });
describe("Console reviewer document", () => {
  it("labels a model verdict without upgrading it to execution proof", () => {
    const text = reviewDocument(review, 100, false).join("\n");
    expect(text).toContain("REVIEW - APPROVED");
    expect(text).toContain("not independent execution proof");
    expect(text).toContain("1/1 reported passed");
    expect(text).not.toContain('{"approved"');
  });
  it("retains failed checks and exposes expanded detail", () => {
    const rejected = JSON.stringify({ approved: false, rationale: "Needs testing", root_cause: "No test run", checks: [{ name: "tests", passed: false, detail: "Missing evidence" }] });
    expect(reviewDocument(rejected, 80, false).join("\n")).toContain("FAIL: tests - Missing evidence");
    expect(reviewDocument(review, 80, true).join("\n")).toContain("Reviewer-reported check detail.");
  });
  it("keeps malformed review output readable without inventing a verdict", () => {
    expect(reviewDocument("not JSON", 80, false).join("\n")).toContain("unstructured reviewer output");
    expect(reviewDocument('{"approved":"yes"}', 80, false).join("\n")).not.toContain("REVIEW - APPROVED");
  });
  it("wraps review lines to narrow viewport width", () => {
    expect(reviewDocument(review, 30, true).every((line) => displayWidth(line) <= 30)).toBe(true);
  });
  it("uses canonical review identity, not JSON-looking answer text", () => {
    const render = (operation: string, history = false) => {
      const size = { width: 140, height: 40 };
      const projection = consoleScreen.project({ captured_at: "2026-09-05T12:00:00Z", sidebar_visibility: "hidden",
        session_attach: { live: false, session: { session_id: "s", operation, state: "completed" },
          events: [{ sequence: 1, occurred_at: "2026-09-05T12:00:00Z", kind: "model_text", payload: { text: review, phase: "final" } }] },
      }, size);
      return consoleScreen.render({ projection, ...size, color: false,
        ...(history ? { live_edge: { mode: "scrollback" as const, anchor_id: null, unseen_meaningful_events: 0 } } : {}),
      }).join("\n");
    };
    expect(render("review")).toContain("REVIEW - APPROVED");
    expect(render("review")).not.toContain("Reviewer-reported check detail.");
    expect(render("review", true)).toContain("Reviewer-reported check detail.");
    expect(render("review", true)).toContain("REVIEW DETAILS");
    expect(render("specialize")).toContain("ANSWER");
    expect(render("specialize")).toContain('{"approved"');
  });
});
