import { describe, expect, it } from "vitest";
import { resolveColorPolicy } from "../src/tui.js";

describe("explicit interactive color preference", () => {
  const environment = { NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-ghostty" };
  it("allows an operator to override inherited NO_COLOR on a capable TTY", () => {
    expect(resolveColorPolicy(environment, true, { rgb: false, ansi256: false }, "always")).toEqual({ color: true, color_mode: "truecolor" });
  });
  it("never leaks terminal coloring into redirected output", () => {
    expect(resolveColorPolicy(environment, false, null, "always").color).toBe(false);
  });
  it("retains advertised terminal color when native probes return no positive capabilities", () => {
    const unavailable = { rgb: false, ansi256: false };
    expect(resolveColorPolicy({ COLORTERM: "truecolor", TERM: "tmux-256color" }, true, unavailable)).toEqual({ color: true, color_mode: "truecolor" });
    expect(resolveColorPolicy({ TERM: "tmux-256color" }, true, unavailable)).toEqual({ color: true, color_mode: "ansi256" });
    expect(resolveColorPolicy({ TERM: "dumb" }, true, unavailable).color).toBe(false);
  });
  it("preserves default NO_COLOR and explicit never", () => {
    expect(resolveColorPolicy(environment, true, null).color).toBe(false);
    expect(resolveColorPolicy({}, true, null, "never").color).toBe(false);
  });
});
