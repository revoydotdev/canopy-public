import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanopyDebugCaptureStore } from "../src/canopy-debug-capture.js";
import { createCanopyDebugJournal } from "../src/canopy-debug-journal.js";

const frame = { text: "hello\n", scene: { rows: ["hello"] } } as never;

describe("canopy-debug capture store", () => {
  it("persists timestamped screenshot and recording index rows beside artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-debug-"));
    const store = createCanopyDebugCaptureStore({ root, session_id: "test-session", clock: () => new Date("2026-09-20T12:00:00.000Z") });
    const shot = store.screenshot(frame, { trigger: "F8" });
    expect(shot.kind).toBe("screenshot");
    expect(store.toggleRecording(frame, { trigger: "F9" })).toBe(true);
    store.appendFrame({ text: "next\n", scene: {} } as never);
    expect(store.toggleRecording()).toBe(false);
    store.close();
    const index = await readFile(join(store.root, "capture-index.jsonl"), "utf8");
    const rows = index.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((row) => row.kind)).toEqual(["session_open", "screenshot", "recording_start", "recording_frame", "recording_frame", "recording_stop", "session_close"]);
    expect(rows.every((row) => typeof row.timestamp === "string")).toBe(true);
    expect(rows.filter((row) => row.artifact_path).every((row) => typeof row.sha256 === "string")).toBe(true);
    const journal = createCanopyDebugJournal({ path: join(store.root, "journal.sqlite"), session_id: store.session_id, clock: () => new Date("2026-09-20T12:01:00.000Z") });
    const indexed = journal.query({ session_id: store.session_id });
    expect(indexed.map((row) => row.kind)).toEqual(rows.map((row) => row.kind));
    expect(journal.artifacts().length).toBeGreaterThan(0);
    journal.close();
  });
});
