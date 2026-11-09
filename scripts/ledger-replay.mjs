#!/usr/bin/env node
/**
 * scripts/ledger-replay.mjs — grow a campaign back out of its own event log.
 *
 *   bun scripts/ledger-replay.mjs [<campaign-id>] [--speed 1.0] [--no-color]
 *
 * This is a REPLAYER, not an animation. Every glyph, state and tick comes from
 * `.arbor/devtools/devtools.log` — the same stream the DevTools screen reads.
 * Nothing is keyframed, nothing is invented, and a campaign that did badly
 * looks bad. If it renders something the ledger does not contain, that is a
 * bug in this file, not artistic licence.
 *
 * WHY IT EXISTS. Two reasons, and the second is the load-bearing one:
 *   1. It is a debugging tool — scrub a campaign's growth and see exactly
 *      where a branch died.
 *   2. It is the honest source for any promotional rendering. A hand-drawn
 *      "AI growing a solution tree" is an unwitnessed claim in video form,
 *      which is precisely the defect class this repository's gates exist to
 *      catch. Rendering from the ledger makes the pretty version and the true
 *      version the same artifact, so the first cannot drift from the second.
 *
 * THE VISUAL GRAMMAR — one idea, applied literally:
 *
 *   Provenance is material density. Cool + faint = provisional. Warm + solid =
 *   earned. A node's weight on screen is its weight in the evidence model, so
 *   an unverified branch visibly cannot bear load.
 *
 *   Failure composts. A failed or pruned node dims and its loss feeds the KB
 *   band at the foot of the frame, which brightens on `kb.entry_added` —
 *   because that is literally what happens: a failed node yields a
 *   failure-mode entry injected into the next specialist's prompt.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const LOG = join(REPO, ".arbor/devtools/devtools.log");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const COLOR = !args.includes("--no-color") && process.stdout.isTTY !== false;
const SPEED = Number.parseFloat(flag("--speed", "1.0")) || 1.0;
const WANT = args.find((a) => !a.startsWith("--") && !/^[\d.]+$/.test(a)) ?? null;

// ── palette ────────────────────────────────────────────────────────────────
// One axis: warm = earned, cool = provisional. Failure is rust, never
// alarm-red — in this system failure is normal and productive, and the
// palette should not shout about it.
const c = (code, s) => (COLOR ? `[${code}m${s}[0m` : s);
const STEEL = "38;5;66", CYAN = "38;5;80", GOLD = "1;38;5;178", RUST = "38;5;131";
const DIM = "2;38;5;242", SOIL = "38;5;101";

/** state -> [glyph, colour, weight] — glyphs are the cockpit's own (screens/tree.ts). */
const STATE = {
  pending: ["○", DIM, 0],
  expanding: ["◌", CYAN, 1],
  claimed: ["⬡", CYAN, 2],
  verified: ["✓", GOLD, 3],
  failed: ["✗", RUST, 1],
  pruned: ["⊘", DIM, 0],
  interrupted: ["‖", STEEL, 1],
  abandoned: ["·", DIM, 0],
};
const glyphFor = (state) => STATE[state] ?? ["?", STEEL, 0];

// ── load ───────────────────────────────────────────────────────────────────
if (!existsSync(LOG)) {
  process.stderr.write(`no devtools log at ${LOG} — run a campaign first (arbor run --once)\n`);
  process.exit(1);
}
const all = [];
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  if (!line.startsWith("{")) continue;
  try { all.push(JSON.parse(line)); } catch { /* a torn tail line is not an event */ }
}
const campaigns = [...new Set(all.map((e) => e.campaign_id).filter(Boolean))];
const campaign = WANT ?? campaigns[campaigns.length - 1];
const events = all.filter((e) => e.campaign_id === campaign).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

if (events.length === 0) {
  process.stderr.write(`no events for ${campaign}. known: ${campaigns.join(", ") || "(none)"}\n`);
  process.exit(1);
}

// ── replay state ───────────────────────────────────────────────────────────
const nodes = new Map();          // node_id -> state
const order = [];                 // first-seen order, so growth reads as growth
let kb = 0, gatesPass = 0, gatesFail = 0, evidence = 0, halted = null;

const t0 = Date.parse(events[0].ts);
const span = Math.max(1, Date.parse(events[events.length - 1].ts) - t0);

function frame(e, idx) {
  const lines = [];
  const elapsed = ((Date.parse(e.ts) - t0) / 1000).toFixed(2);
  lines.push("");
  lines.push(`  ${c(GOLD, "revoy2")} ${c(DIM, "·")} ${c(STEEL, campaign)}   ${c(DIM, `t+${elapsed}s`)}  ${c(DIM, `${idx + 1}/${events.length}`)}`);
  lines.push("");

  // canopy — every node the ledger has mentioned, in the order it appeared
  for (const id of order) {
    const [g, colour, weight] = glyphFor(nodes.get(id));
    const isRoot = id === "root";
    const stem = isRoot ? "  " : "    ";
    // weight renders as literal density: heavier nodes get a fuller stem
    const bar = ["", "─", "──", "───"][weight] ?? "";
    const label = `${g} ${id}`;
    lines.push(`  ${stem}${c(colour, bar ? `${bar} ` : "")}${c(colour, label)}  ${c(DIM, nodes.get(id))}`);
  }

  // soil — the KB. Failure composts into it and feeds the next specialist.
  lines.push("");
  const soilW = Math.min(48, 6 + kb * 12);
  lines.push(`  ${c(SOIL, "▁".repeat(soilW))}`);
  lines.push(`  ${c(DIM, "kb")} ${c(SOIL, String(kb))}   ${c(DIM, "gates")} ${c(GOLD, String(gatesPass))}${c(DIM, "/")}${c(RUST, String(gatesFail))}   ${c(DIM, "evidence")} ${c(STEEL, String(evidence))}${halted ? `   ${c(RUST, `\u23f9 ${halted}`)}` : ""}`);
  lines.push("");
  lines.push(`  ${c(DIM, e.event_kind)} ${c(DIM, e.node_id ?? "")}`);
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ────────────────────────────────────────────────────────────────────
process.stdout.write("[?25l"); // hide cursor
try {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const payload = e.event ?? {};
    // Any event naming a node is proof that node exists, even when no
    // tree.node_changed has fired for it yet — `root` is only ever announced
    // by its admission gate, so a growth view keyed solely on node_changed
    // renders a canopy with no trunk.
    const named = e.node_id ?? payload.node_id;
    if (named && !nodes.has(named)) { order.push(named); nodes.set(named, "pending"); }
    switch (e.event_kind) {
      case "tree.node_changed": {
        const id = e.node_id ?? payload.node_id;
        if (id) {
          if (!nodes.has(id)) order.push(id);
          nodes.set(id, payload.state ?? "pending");
        }
        break;
      }
      case "kb.entry_added": kb += 1; break;
      case "gate.recorded": (payload.result === "pass" ? gatesPass++ : gatesFail++); break;
      case "audit.evidence_recorded": evidence += 1; break;
      case "campaign.changed": if (payload.change === "halted") halted = payload.halt_reason ?? "below threshold"; break;
      default: break;
    }
    process.stdout.write("[2J[H" + frame(e, i) + "\n");
    // Pace by the campaign's own clock, compressed into ~12s and floored so a
    // burst of same-millisecond events is still legible.
    const next = events[i + 1];
    const realGap = next ? Date.parse(next.ts) - Date.parse(e.ts) : 0;
    await sleep(Math.max(90, Math.min(900, (realGap / span) * 12000)) / SPEED);
  }
} finally {
  process.stdout.write("[?25h"); // show cursor
}
