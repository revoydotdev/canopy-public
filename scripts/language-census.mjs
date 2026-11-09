#!/usr/bin/env bun
/**
 * language-census — ADR-143 O2: an undeclared language in the source roots is
 * surfaced, not silently ungoverned.
 *
 * WHY THIS GATE EXISTS. revoy2 writes code. A campaign can introduce a language
 * `arbor.profile.jsonc` does not name — a Rust helper, a Python script, a Go
 * tool — and until this gate, nothing noticed. The battery would keep reporting
 * green over source it cannot read, because 10 of its 51 gates parse
 * TypeScript and the rest read artifacts that happen to be language-neutral.
 *
 * An autonomous harness that can add a language it cannot govern is a harness
 * whose governance is optional in practice. This makes that condition loud.
 *
 * WHAT IT DOES NOT DO. It does not install anything. Detection reports; a
 * scaffolded pack is advisory by construction and its promotion to blocking is
 * an operator decision (ADR-143 Decision 6, `scaffoldLanguagePack`). A gate
 * that silently granted the harness new governance coverage would be the
 * self-certification this repository already refuses elsewhere.
 *
 * The materiality floor is why a single vendored fixture or one example file
 * does not propose a pack: a finding that fires on every stray file teaches its
 * reader to skim past it.
 */
import { declaredLanguages, censusLanguages, undeclaredLanguages, scaffoldLanguagePack } from "./lib/language-support.mjs";

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const JSON_MODE = process.argv.includes("--json");
const floorArg = process.argv.indexOf("--floor");
const FLOOR = floorArg >= 0 ? Number.parseInt(process.argv[floorArg + 1] ?? "", 10) || 3 : 3;

const declared = declaredLanguages(REPO_ROOT);
const census = censusLanguages(REPO_ROOT);
const undeclared = undeclaredLanguages(REPO_ROOT, { floor: FLOOR });
const proposals = undeclared.map((entry) => scaffoldLanguagePack(entry));

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: undeclared.length === 0, declared, census, undeclared, proposals, floor: FLOOR }, null, 2));
  process.exit(undeclared.length === 0 ? 0 : 1);
}

console.log(`language-census — ${Object.keys(census).length} language(s) observed under the declared source roots`);
console.log(`  declared: ${declared.length > 0 ? declared.join(", ") : "(none — arbor.profile.jsonc names no languages)"}`);
for (const [language, files] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  const mark = declared.includes(language) ? "  " : "??";
  console.log(`  ${mark} ${language.padEnd(12)} ${files} file(s)`);
}
console.log(`  materiality floor: ${FLOOR} file(s) — below this, a language is not proposed`);

if (undeclared.length === 0) {
  console.log("\nPASS — every material language in the source roots is declared.");
  process.exit(0);
}

console.log(`\n${undeclared.length} undeclared language(s) — the battery does not govern these files:`);
for (const pack of proposals) {
  console.log(`\n  ${pack.id}  (${pack.detected_files} file(s))`);
  console.log(`    lsp server : ${pack.lsp_server ?? "none known — a pack must name one"}`);
  console.log(`    globs      : ${pack.globs.join(" ")}`);
  console.log(`    mode       : ${pack.mode}  (${pack.advisory_reason})`);
  const missing = Object.entries(pack.capabilities).filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length > 0) console.log(`    cannot answer: ${missing.join(", ")} — gates needing these report unsupported, not pass`);
}
console.log(`\nRemedy: add the language to arbor.profile.jsonc's \`languages\`, or delete the files if they`);
console.log(`were not meant to land. Promotion of a scaffolded pack to blocking is an operator`);
console.log(`decision recorded in decisions/interviews.jsonl — this gate never promotes one itself.`);
console.log("\nFAIL — a language is present that this repository has not declared.");
process.exit(1);
