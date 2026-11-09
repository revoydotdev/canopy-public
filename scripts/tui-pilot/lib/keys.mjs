/**
 * Key names -> the exact bytes a terminal would send.
 *
 * The tmux recorder let tmux decide what bytes a key name became, and tmux
 * silently ate `;` (its own command separator), ignored `S-` on letters, and
 * could not express ctrl+shift at all (EC-024/026/027/028). Encoding here
 * makes every keystroke a byte string the pilot chose and the receipt can
 * show, so "key X did nothing" can never again be a transport artifact.
 *
 * Two encodings exist because two kinds of terminal exist:
 * - legacy: ctrl+a and ctrl+shift+a are the SAME byte (0x01); shift on a
 *   letter is just the uppercase letter. This is what most terminals send.
 * - kitty (`{ kitty: true }`): CSI-u, `ESC [ <codepoint> ; <mods> u`, which
 *   carries shift separately. Only meaningful when the app negotiated it.
 * A legacy encoding that lost a modifier reports `lossy: true` so the receipt
 * records that the chord could not be expressed, rather than pretending.
 */
const ESC = "\u001b";

const ALIASES = Object.freeze({
  ESC: "Escape", ENTER: "Enter", BS: "BSpace", BACKSPACE: "BSpace", TAB: "Tab", UP: "Up", DOWN: "Down",
  LEFT: "Left", RIGHT: "Right", HOME: "Home", END: "End", SPACE: "Space", PGUP: "PageUp", PGDN: "PageDown",
  DEL: "Delete", RET: "Enter", RETURN: "Enter",
});

const NAMED = Object.freeze({
  Enter: "\r", Escape: ESC, BSpace: "\u007f", Tab: "\t", BTab: `${ESC}[Z`, Space: " ",
  Up: `${ESC}[A`, Down: `${ESC}[B`, Right: `${ESC}[C`, Left: `${ESC}[D`, Home: `${ESC}[H`, End: `${ESC}[F`,
  PageUp: `${ESC}[5~`, PageDown: `${ESC}[6~`, Delete: `${ESC}[3~`, Insert: `${ESC}[2~`,
  F1: `${ESC}OP`, F2: `${ESC}OQ`, F3: `${ESC}OR`, F4: `${ESC}OS`, F5: `${ESC}[15~`, F6: `${ESC}[17~`,
  F7: `${ESC}[18~`, F8: `${ESC}[19~`, F9: `${ESC}[20~`, F10: `${ESC}[21~`, F11: `${ESC}[23~`, F12: `${ESC}[24~`,
});

// Legacy modifier parameter used by `ESC [ 1 ; <mods> A`-style sequences and by CSI-u.
const modsParam = (m) => 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);

/** Parse `C-S-a`, `ctrl+shift+a`, `M-x`, `Escape`, `a` into { mods, base }. */
export function parseKey(name) {
  const parts = name.includes("+") && name.length > 1 ? name.split("+") : name.split("-");
  // A lone `-` or `+` is a printable key, not a separator.
  if (parts.length > 1 && parts.some((p) => p === "")) return { mods: { ctrl: false, alt: false, shift: false }, base: name };
  const mods = { ctrl: false, alt: false, shift: false };
  let base = parts.at(-1);
  for (const raw of parts.slice(0, -1)) {
    const p = raw.toLowerCase();
    if (p === "c" || p === "ctrl" || p === "control") mods.ctrl = true;
    else if (p === "m" || p === "alt" || p === "meta") mods.alt = true;
    else if (p === "s" || p === "shift") mods.shift = true;
    else throw new Error(`unknown modifier "${raw}" in key "${name}"`);
  }
  base = ALIASES[base.toUpperCase()] ?? base;
  return { mods, base };
}

/** @returns {{ bytes: string, lossy: boolean, encoding: "legacy" | "kitty" }} */
export function encodeKey(name, { kitty = false } = {}) {
  const { mods, base } = parseKey(name);
  const anyMod = mods.ctrl || mods.alt || mods.shift;
  const named = NAMED[base];

  if (kitty && (anyMod || named === undefined) && base.length === 1) {
    const cp = base.toLowerCase().codePointAt(0);
    return { bytes: `${ESC}[${cp};${modsParam(mods)}u`, lossy: false, encoding: "kitty" };
  }

  if (named !== undefined) {
    if (!anyMod) return { bytes: named, lossy: false, encoding: "legacy" };
    // Modified navigation keys carry the modifier in a CSI parameter; other
    // named keys (Enter, Tab, Escape, BSpace) mostly cannot, so those are lossy.
    const csiFinal = { Up: "A", Down: "B", Right: "C", Left: "D", Home: "H", End: "F" }[base];
    if (csiFinal) return { bytes: `${ESC}[1;${modsParam(mods)}${csiFinal}`, lossy: false, encoding: "legacy" };
    if (base === "Tab" && mods.shift && !mods.ctrl && !mods.alt) return { bytes: NAMED.BTab, lossy: false, encoding: "legacy" };
    if (base === "Enter" && mods.shift) return { bytes: `${ESC}[13;2u`, lossy: false, encoding: "legacy" };
    if (base === "Space" && mods.ctrl) return { bytes: "\u0000", lossy: mods.shift || mods.alt, encoding: "legacy" };
    return { bytes: (mods.alt ? ESC : "") + named, lossy: mods.ctrl || mods.shift, encoding: "legacy" };
  }

  if (base.length !== 1) throw new Error(`unknown key "${name}"`);
  let bytes = base;
  let lossy = false;
  if (mods.ctrl) {
    const lower = base.toLowerCase();
    const code = lower.codePointAt(0);
    if (code >= 97 && code <= 122) bytes = String.fromCharCode(code - 96);
    else if (lower === "[" || lower === "3") bytes = ESC;
    else if (lower === "\\" || lower === "4") bytes = "\u001c";
    else if (lower === "]" || lower === "5") bytes = "\u001d";
    else if (lower === "^" || lower === "6") bytes = "\u001e";
    else if (lower === "_" || lower === "7" || lower === "/") bytes = "\u001f";
    else if (lower === "@" || lower === "2") bytes = "\u0000";
    else if (lower === "?") bytes = "\u007f";
    else lossy = true;
    // Legacy terminals cannot carry shift alongside ctrl (EC-027).
    if (mods.shift) lossy = true;
  } else if (mods.shift) {
    bytes = base.toUpperCase();
    if (bytes === base) lossy = true; // shift on a non-letter has no legacy form
  }
  if (mods.alt) bytes = ESC + bytes;
  return { bytes, lossy, encoding: "legacy" };
}

/** Human-readable form of a byte string for receipts and logs. */
export function describeBytes(bytes) {
  let out = "";
  for (const ch of bytes) {
    const code = ch.codePointAt(0);
    if (code === 0x1b) out += "ESC";
    else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
    else if (code === 0x7f) out += "DEL";
    else out += ch;
    out += " ";
  }
  return out.trimEnd();
}
