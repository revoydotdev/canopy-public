/**
 * Keymap-as-config grammar (ADR-020 / frontier Appendix B).
 *
 * Key bindings are a bounded, normalized grammar rather than freeform strings:
 * a canonical key-spec ("ctrl-a", "alt-x ctrl-s"), two-stroke chord support,
 * a max-events-per-binding bound, alternative-binding lists (`[...]` = an
 * alternative list, never a chord), and EARLY REJECTION of malformed bindings
 * with user-facing diagnostics (Commandment IX: bounds are part of the type).
 *
 * Pure, dependency-free — the TUI renders bindings already normalized by this
 * module, so an unparseable or unbounded keymap is rejected at config load, not
 * at keypress.
 */

export type KeyModifier = "ctrl" | "alt" | "shift";
export const KEY_MODIFIERS: readonly KeyModifier[] = ["ctrl", "alt", "shift"];
export const KEYMAP_MAX_EVENTS_PER_BINDING = 8;
export const KEYMAP_MAX_BINDINGS = 64;
export const KEYMAP_MAX_KEY_BYTES = 32;

export interface NormalizedKey {
  mods: KeyModifier[];
  key: string;
}

/** A single normalized key-spec, e.g. "ctrl" + "a". */
export interface NormalizedBinding {
  keys: readonly NormalizedKey[];
  description: string;
}

export const KEYMAP_SPEC_PREFIX = "[tui.keymap]";

export type KeymapParseResult =
  | { ok: true; bindings: NormalizedBinding[] }
  | { ok: false; diagnostics: string[] };

function isModifierToken(token: string): token is KeyModifier {
  return (KEY_MODIFIERS as readonly string[]).includes(token.toLowerCase());
}

/**
 * Parse one unicode-free token like "ctrl-a", "alt-x", "shift-F5", or a bare
 * single key ("a", "F5"). Returns the normalized key or a diagnostic.
 */
function parseKeyToken(token: string): { key?: NormalizedKey; error?: string } {
  const trimmed = token.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > KEYMAP_MAX_KEY_BYTES) {
    return { error: `invalid/oversized key token ${JSON.stringify(trimmed)}` };
  }
  const parts = trimmed.split("-");
  const mods: KeyModifier[] = [];
  for (const part of parts.slice(0, -1)) {
    if (!isModifierToken(part)) return { error: `unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(trimmed)}` };
    if (!mods.includes(part as KeyModifier)) mods.push(part as KeyModifier);
  }
  const key = parts[parts.length - 1];
  if (key.length === 0) return { error: `missing key in ${JSON.stringify(trimmed)}` };
  mods.sort((a, b) => KEY_MODIFIERS.indexOf(a) - KEY_MODIFIERS.indexOf(b));
  return { key: { mods, key: key.toLowerCase() } };
}

/**
 * Parse a single keymap entry line's binding expression into a list of
 * normalized bindings (each `[...]` alternative expands separately). Two
 * space-separated key-specs form a two-stroke chord; more than
 * KEYMAP_MAX_EVENTS_PER_BINDING rejects.
 */
function parseBindingExpression(expression: string, description: string, diagnostics: string[]): NormalizedBinding[] {
  const out: NormalizedBinding[] = [];
  // `[...]` = an ALTERNATIVE binding list (`a` OR `b`), not a chord. Split the
  // bracket content on commas into separate bindings.
  if (expression.startsWith("[") && expression.endsWith("]")) {
    const inner = expression.slice(1, -1);
    const alternatives = inner.split(",").map((s) => s.trim()).filter(Boolean);
    if (alternatives.length === 0) {
      diagnostics.push(`empty binding alternative ${JSON.stringify(expression)}`);
      return out;
    }
    for (const alt of alternatives) {
      const parsed = buildChord(alt, description, diagnostics);
      out.push(...parsed);
    }
    return out;
  }
  return buildChord(expression, description, diagnostics);
}

function buildChord(expression: string, description: string, diagnostics: string[]): NormalizedBinding[] {
  const tokens = expression.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) { diagnostics.push(`empty binding alternative ${JSON.stringify(expression)}`); return []; }
  if (tokens.length > KEYMAP_MAX_EVENTS_PER_BINDING) {
    diagnostics.push(`binding ${JSON.stringify(expression)} exceeds ${KEYMAP_MAX_EVENTS_PER_BINDING} events`);
    return [];
  }
  const keys: NormalizedKey[] = [];
  for (const token of tokens) {
    const parsed = parseKeyToken(token);
    if (parsed.error) { diagnostics.push(parsed.error); return []; }
    keys.push(parsed.key!);
  }
  if (keys.length === tokens.length) return [{ keys, description }];
  return [];
}

/**
 * Parse a full keymap-as-config body (the text after `[tui.keymap]`), one
 * "binding = description" assignment per line. Returns normalized bindings or
 * early-rejection diagnostics. Example:
 *
 *   [tui.keymap]
 *   ctrl-a = "focus palette"
 *   ctrl-x ctrl-s = "save"
 *   [alt-p, alt-shift-p] = "toggle preview"
 */
export function parseKeymap(configText: string): KeymapParseResult {
  const diagnostics: string[] = [];
  let body = configText;
  const prefixIndex = configText.indexOf(KEYMAP_SPEC_PREFIX);
  if (prefixIndex !== -1) {
    body = configText.slice(prefixIndex + KEYMAP_SPEC_PREFIX.length);
  }
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
  const bindings: NormalizedBinding[] = [];
  for (const line of lines) {
    // "binding-expr = "description""
    const eq = findUnquotedEquals(line);
    if (eq === -1) { diagnostics.push(`keymap line has no '=' assignment: ${JSON.stringify(line)}`); continue; }
    const expression = line.slice(0, eq).trim();
    const rawDesc = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (rawDesc.length === 0) { diagnostics.push(`keymap binding ${JSON.stringify(expression)} has empty description`); continue; }
    bindings.push(...parseBindingExpression(expression, rawDesc, diagnostics));
  }
  if (bindings.length > KEYMAP_MAX_BINDINGS) {
    diagnostics.push(`keymap exceeds ${KEYMAP_MAX_BINDINGS} bindings`);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, bindings };
}

function findUnquotedEquals(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "=") return i;
    if (line[i] === '"') i = line.indexOf('"', i + 1); // skip a quoted description
  }
  return -1;
}

/** Normalize a binding into the renderable string the palette/help surface shows. */
export function formatBinding(binding: NormalizedBinding): string {
  return binding.keys.map((k) => [...k.mods, k.key].join("+")).join(" ");
}
