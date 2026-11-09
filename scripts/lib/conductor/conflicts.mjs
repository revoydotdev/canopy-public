const GENERATED_STORE_PREFIXES = [
  ".claim-ledger/",
  ".determinism-baseline/",
  ".completion-depth/",
  ".visual-intelligence/observed/",
  "decisions/registry.json",
];

export function isGeneratedStore(path) {
  return GENERATED_STORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function unionList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function structuredLineUnion(ours, theirs) {
  const importPattern = /^(\s*(?:import|export)\s*\{)([^}]*)(\}\s*(?:from\s+[^;]+)?;?\s*)$/;
  const left = ours.match(importPattern);
  const right = theirs.match(importPattern);
  if (!left || !right || left[1] !== right[1] || left[3] !== right[3]) return null;
  const members = [...new Set([...unionList(left[2]), ...unionList(right[2])])].sort();
  return `${left[1]} ${members.join(", ")} ${left[3]}`;
}

function uniqueLines(ours, theirs) {
  return [...new Set([...ours, ...theirs])];
}

/**
 * Resolve only syntax shapes whose composition is set union. Everything else
 * is a semantic conflict and remains for an operator.
 */
export function mechanicalConflictResolution({ base, ours, theirs }) {
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");
  if (oursLines.length === 1 && theirsLines.length === 1) {
    const line = structuredLineUnion(oursLines[0], theirsLines[0]);
    if (line !== null) return { kind: "import_export_union", text: line };
  }

  const nonblankOurs = oursLines.filter((line) => line.trim());
  const nonblankTheirs = theirsLines.filter((line) => line.trim());
  if (!base.trim() && nonblankOurs.length && nonblankTheirs.length) {
    const allCases = [...nonblankOurs, ...nonblankTheirs].every((line) => /^\s*(?:case\b|[|&]\s)/.test(line));
    if (allCases) return { kind: "additive_arms_union", text: uniqueLines(oursLines, theirsLines).join("\n") };
  }
  return null;
}

export function resolveDiff3Text(text) {
  const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)^\|{7}[^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let semantic = false;
  let mechanicalCount = 0;
  const merged = text.replace(pattern, (whole, ours, base, theirs) => {
    const resolution = mechanicalConflictResolution({ base: base.replace(/\n$/, ""), ours: ours.replace(/\n$/, ""), theirs: theirs.replace(/\n$/, "") });
    if (!resolution) {
      semantic = true;
      return whole;
    }
    mechanicalCount += 1;
    return `${resolution.text}\n`;
  });
  return { text: merged, semantic, mechanical_count: mechanicalCount };
}
