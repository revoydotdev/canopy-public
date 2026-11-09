import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/widgets.js";
import { renderStatusDocument } from "../src/screens/status-document.js";
import type { ScreenProjection } from "../src/screens/screen.js";

const projection: ScreenProjection = {
  screen: "capabilities",
  variant: "catalog",
  caption: "canonical/capability.introspect · 2 capabilities",
  columns: [
    { key: "kind", title: "Capability", width: 30 },
    { key: "state", title: "State", width: 14 },
    { key: "detail", title: "Operator detail", width: 50 },
  ],
  rows: [
    { kind: "campaign.run", state: "supported", detail: "Direct native execution is ready." },
    { kind: "provider.call", state: "unavailable", detail: "Configure a credential before starting." },
  ],
  row_ids: [{ id: "campaign.run" }, { id: "provider.call" }],
};

describe("responsive status document", () => {
  it("orients an empty screen without inventing records or changing populated layout", () => {
    const options = { empty_title: "KNOWLEDGE BASE", empty_hint: "Ctrl+P: return to Console or inspect Campaigns." };
    const empty = { ...projection, rows: [], row_ids: [], caption: "No knowledge entries yet" };
    const lines = renderStatusDocument(empty, 30, 12, 0, options);
    expect(lines[0]).toBe("KNOWLEDGE BASE");
    expect(lines.join(" ")).toContain("No knowledge entries yet");
    expect(lines.join(" ")).toContain("Ctrl+P: return to Console");
    expect(lines.every((line) => displayWidth(line) <= 30)).toBe(true);
    expect(renderStatusDocument(empty, 30, 2, 0, options)).toHaveLength(2);
    expect(renderStatusDocument(projection, 120, 10, 0, options))
      .toEqual(renderStatusDocument(projection, 120, 10));
    expect(empty.row_ids).toEqual([]);
  });

  it("renders bounded labelled records at narrow widths without losing state semantics", () => {
    const lines = renderStatusDocument(projection, 44, 20, 0);
    expect(lines.join("\n")).toContain("Capability: campaign.run");
    expect(lines.join("\n")).toContain("State: supported");
    expect(lines.join("\n")).toContain("! Capability: provider.call");
    expect(lines.every((line) => displayWidth(line) <= 44)).toBe(true);
  });

  it("retains the domain table at wide widths and respects record offsets", () => {
    const wide = renderStatusDocument(projection, 120, 10, 1);
    expect(wide.join("\n")).toContain("provider.call");
    expect(wide.join("\n")).not.toContain("campaign.run");
    expect(wide.every((line) => displayWidth(line) <= 120)).toBe(true);
  });

  it("renders an authoritative empty caption without inventing rows", () => {
    const empty = { ...projection, rows: [], row_ids: [] };
    const lines = renderStatusDocument(empty, 40, 5);
    // The caption is the only content; it wraps rather than inventing rows or cutting itself (EC-058).
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join(" ")).toContain("canonical/capability");
    expect(lines.every((line) => displayWidth(line) <= 40)).toBe(true);
    expect(lines.every((line) => !/^\s*\S+\s+\S+\s+\S+/u.test(line) || line === lines[0] || !line.includes("│"))).toBe(true);
  });
});

describe("a caption that does not fit says so (EC-036)", () => {
  const long = "Config (26) · Native: direct (anthropic-messages → anthropic/claude-sonnet-5); revision unpinned · Native policy: no session budget/pricing configured";
  const withCaption = (caption: string, rows: ScreenProjection["rows"]): ScreenProjection => ({
    screen: "config", variant: "catalog", caption,
    columns: [{ key: "key", title: "Key", width: 20 }], rows, row_ids: rows.map(() => null),
  });

  it("marks the cut on a caption too wide for the pane", () => {
    const [header] = renderStatusDocument(withCaption(long, [{ key: "a" }]), 90, 10);
    expect(displayWidth(header!)).toBeLessThanOrEqual(90);
    expect(header!.endsWith("…")).toBe(true);
  });

  it("wraps the EMPTY-rows caption instead of cutting it — the remedy is usually the tail (EC-058)", () => {
    const lines = renderStatusDocument(withCaption(long, []), 90, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => displayWidth(line) <= 90)).toBe(true);
    expect(lines.join(" ")).toContain(long.slice(-20));
  });

  it("leaves a caption that fits completely alone", () => {
    const short = "Evidence records (4)";
    const [header] = renderStatusDocument(withCaption(short, [{ key: "a" }]), 90, 10);
    expect(header).toContain(short);
    expect(header).not.toContain("…");
  });
});
