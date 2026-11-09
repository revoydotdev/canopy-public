import { describe, expect, it } from "vitest";
import {
  clearRegisteredScreens,
  installScreens,
  availableScreens,
  interviewsScreen,
} from "../src/index.js";

function inputRecords() {
  return {
    records: [
      {
        id: "userinput_1",
        question: {
          operation_id: "ask:1",
          question: "Proceed with the self-build refactor?",
          authority: "lead",
          blocking: "blocking",
          requester_role: "taproot",
          origin_session_id: "native-session-1-with-full-correlation-identity",
        },
      },
      {
        id: "userinput_2",
        question: {
          operation_id: "ask:2",
          question: "Steer toward greenfield?",
          authority: "delegated_needs_input",
          blocking: "async",
          requester_role: "seed",
        },
      },
    ],
  };
}

describe("interviews screen", () => {
  it("projects userinput.list records into bounded rows with authority/blocking", () => {
    const projection = interviewsScreen.project(inputRecords(), { width: 80, height: 40 });
    expect(projection.screen).toBe("interviews");
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows[0].id).toBe("userinput_1");
    expect(projection.rows[0].question).toContain("Proceed");
    expect(projection.rows[0].requester).toBe("taproot");
    expect(projection.rows[0].session).toBe("native-session-1-with-full-correlation-identity");
    expect(projection.rows[0].authority).toContain("◎");
    // async / delegated row
    expect(projection.rows[1].blocking).toContain("☐");
  });

  it("returns an empty projection for null / non-list results", () => {
    const empty = interviewsScreen.project(null, { width: 80, height: 40 });
    expect(empty.rows).toHaveLength(0);
    const notList = interviewsScreen.project({ hello: 1 }, { width: 80, height: 40 });
    expect(notList.rows).toHaveLength(0);
  });

  it("renders a header + caption and a '(no pending interviews)' placeholder when empty", () => {
    const lines = interviewsScreen.render(
      { projection: { screen: "interviews", rows: [], columns: [{ key: "id", title: "Interview", width: 10 }], caption: "no interviews", variant: "interviews" }, width: 40, height: 10 },
    );
    expect(lines[0]).toContain("no pending interviews");
    const proj = interviewsScreen.project(inputRecords(), { width: 60, height: 20 });
    const rendered = interviewsScreen.render({ projection: proj, width: 60, height: 20 });
    expect(rendered[0]).toContain("Interviews");
  });

  it("handles records without a question object (id/question fallbacks)", () => {
    const projection = interviewsScreen.project(
      { records: [{ id: "x" }, { id: "y", question: { authority: "nobody", blocking: "maybe" } }] },
      { width: 80, height: 40 },
    );
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows[0].question).toBe("—");
    expect(projection.rows[0].requester).toBe("—");
    expect(projection.rows[1].authority).toContain("?");
    expect(projection.rows[1].blocking).toContain("☐");
  });

  it("carries row_ids keyed by the record id — the value userinput.answer needs", () => {
    const projection = interviewsScreen.project(inputRecords(), { width: 80, height: 40 });
    expect(projection.row_ids).toEqual([{ id: "userinput_1" }, { id: "userinput_2" }]);
  });

  it("removes durably answered records from the pending attention queue", () => {
    const input = inputRecords();
    const projection = interviewsScreen.project(
      { ...input, answered_record_ids: ["userinput_1"] },
      { width: 80, height: 40 },
    );
    expect(projection.caption).toBe("Interviews (1)");
    expect(projection.rows.map((row) => row.id)).toEqual(["userinput_2"]);
    expect(projection.row_ids).toEqual([{ id: "userinput_2" }]);

    const complete = interviewsScreen.project(
      { ...input, answered_record_ids: ["userinput_1", "userinput_2"] },
      { width: 80, height: 40 },
    );
    expect(complete.rows).toEqual([]);
    expect(interviewsScreen.render({ projection: complete, width: 80, height: 40 })[0]).toContain("no pending interviews");
  });

  it("row_ids is null when the record id cannot be resolved at all", () => {
    const projection = interviewsScreen.project({ records: [{ notAnId: true }] }, { width: 80, height: 40 });
    expect(projection.rows[0].id).toBe("?");
    expect(projection.row_ids).toEqual([null]);
  });

  it("no longer declares userinput.awaiting — its real shape (a single boolean flag) never matched this screen's records-list projection", () => {
    expect(interviewsScreen.surface.queries).toEqual(["userinput.list"]);
  });

  it("is registered and gated on userinput.read + userinput.write", () => {
    clearRegisteredScreens();
    installScreens();
    try {
      const granted = availableScreens(new Set(["userinput.read", "userinput.write"]));
      expect(granted.map((s) => s.id)).toContain("interviews");
      const without = availableScreens(new Set(["userinput.read"]));
      expect(without.map((s) => s.id)).not.toContain("interviews");
    } finally {
      clearRegisteredScreens();
    }
  });
});
