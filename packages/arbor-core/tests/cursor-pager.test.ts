import { describe, expect, it } from "vitest";
import { cursorPage, cursorOffset } from "../src/cursor-pager.js";

describe("cursorPage", () => {
  const items = [0, 1, 2, 3, 4];

  it("returns the first page with a next-cursor when more items remain", () => {
    const page = cursorPage<number>({ stream_id: "s", offset: 0, limit: 2, items });
    expect(page.items).toEqual([0, 1]);
    expect(page.next_cursor).toEqual({ stream_id: "s", sequence: 2 });
    expect(page.total).toBe(5);
  });

  it("returns a null next-cursor on the last page", () => {
    const page = cursorPage<number>({ stream_id: "s", offset: 3, limit: 2, items });
    expect(page.items).toEqual([3, 4]);
    expect(page.next_cursor).toBeNull();
  });

  it("clamps offset/limit past the end", () => {
    const page = cursorPage<number>({ stream_id: "s", offset: 4, limit: 5, items });
    expect(page.items).toEqual([4]);
    expect(page.next_cursor).toBeNull();
  });

  it("handles an empty set", () => {
    const page = cursorPage<number>({ stream_id: "s", offset: 0, limit: 2, items: [] });
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.total).toBe(0);
  });

  it("rejects a negative offset / bad limit", () => {
    expect(() => cursorPage({ stream_id: "s", offset: -1, limit: 2, items })).toThrow(/offset/);
    expect(() => cursorPage({ stream_id: "s", offset: 0, limit: 0, items })).toThrow(/limit/);
  });
});

describe("cursorOffset", () => {
  it("starts at 0 when no cursor", () => {
    expect(cursorOffset(undefined, "s")).toBe(0);
  });

  it("reads the sequence from a matching-stream cursor", () => {
    expect(cursorOffset({ stream_id: "s", sequence: 3 }, "s")).toBe(3);
  });

  it("throws on a mismatched stream", () => {
    expect(() => cursorOffset({ stream_id: "other", sequence: 0 }, "s")).toThrow(/does not match/);
  });
});
