/**
 * scripts/tests/tui-pilot-keys.test.mjs — key names become exact bytes.
 *
 * The tmux recorder let tmux choose the bytes and three false "key X does
 * nothing" findings followed (EC-024/026/028). The encoder is asserted on the
 * exact keys those findings were about, on the ctrl+shift ambiguity EC-027
 * measured, and on the kitty form that resolves it.
 */
import { describe, expect, it } from "vitest";
import { describeBytes, encodeKey, parseKey } from "../tui-pilot/lib/keys.mjs";

const ESC = "\u001b";

describe("encodeKey — the keys tmux could not deliver", () => {
  it("sends a bare semicolon and a bare backslash as themselves", () => {
    expect(encodeKey(";").bytes).toBe(";");
    expect(encodeKey("\\").bytes).toBe("\\");
    expect(encodeKey("`").bytes).toBe("`");
  });

  it("shift on a letter is the uppercase letter, not a tmux S- prefix", () => {
    expect(encodeKey("S-r")).toEqual({ bytes: "R", lossy: false, encoding: "legacy" });
    expect(encodeKey("shift+d").bytes).toBe("D");
  });

  it("ctrl+letter is the control byte", () => {
    expect(encodeKey("C-p").bytes).toBe("\u0010");
    expect(encodeKey("ctrl+c").bytes).toBe("\u0003");
  });

  it("ctrl+shift+letter is the SAME byte as ctrl+letter on a legacy terminal, and says so", () => {
    const plain = encodeKey("C-a");
    const shifted = encodeKey("C-S-a");
    expect(shifted.bytes).toBe(plain.bytes);
    expect(plain.lossy).toBe(false);
    expect(shifted.lossy).toBe(true);
  });

  it("kitty encoding carries shift separately", () => {
    expect(encodeKey("ctrl+shift+a", { kitty: true })).toEqual({ bytes: `${ESC}[97;6u`, lossy: false, encoding: "kitty" });
    expect(encodeKey("ctrl+shift+x", { kitty: true }).bytes).toBe(`${ESC}[120;6u`);
  });

  it("named keys and aliases", () => {
    expect(encodeKey("Enter").bytes).toBe("\r");
    expect(encodeKey("ENTER").bytes).toBe("\r");
    expect(encodeKey("Escape").bytes).toBe(ESC);
    expect(encodeKey("BSpace").bytes).toBe("\u007f");
    expect(encodeKey("BS").bytes).toBe("\u007f");
    expect(encodeKey("Up").bytes).toBe(`${ESC}[A`);
    expect(encodeKey("PageDown").bytes).toBe(`${ESC}[6~`);
    expect(encodeKey("S-Tab").bytes).toBe(`${ESC}[Z`);
    expect(encodeKey("S-Enter").bytes).toBe(`${ESC}[13;2u`);
  });

  it("alt prefixes an escape", () => {
    expect(encodeKey("M-x").bytes).toBe(`${ESC}x`);
  });

  it("a lone dash or plus is a printable key", () => {
    expect(parseKey("-")).toEqual({ mods: { ctrl: false, alt: false, shift: false }, base: "-" });
    expect(encodeKey("+").bytes).toBe("+");
  });

  it("rejects an unknown modifier or key rather than guessing", () => {
    expect(() => encodeKey("Super-a")).toThrow(/unknown modifier/u);
    expect(() => encodeKey("Frobnicate")).toThrow(/unknown key/u);
  });
});

describe("describeBytes — receipts show what was sent", () => {
  it("names control bytes", () => {
    expect(describeBytes(`${ESC}[97;6u`)).toBe("ESC [ 9 7 ; 6 u");
    expect(describeBytes("\u0010")).toBe("^P");
    expect(describeBytes("\u007f")).toBe("DEL");
  });
});
