import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRoundtripShape, evaluateRoundtripFile } from "../roundtrip-shape.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("6.3 roundtrip semantic shape (scripts/roundtrip-shape.mjs)", () => {
  it("fails a unit test that never leaves the module — one operation, no boundary crossing", () => {
    // The exact shape 6.3's own mechanism description warns about: "a
    // roundtrip that never leaves the module is not a roundtrip." This
    // synthetic test calls exactly one src-exported operation and asserts
    // on its direct return value — no write-then-read-back through a
    // second call.
    const src = `
      import { describe, it, expect } from "vitest";
      import { formatLabel } from "../src/format.js";
      describe("formatLabel", () => {
        it("uppercases", () => {
          expect(formatLabel("x")).toBe("X");
        });
      });
    `;
    const result = evaluateRoundtripShape(src, "fake-unit.test.ts");
    expect(result.ok).toBe(false);
    expect(result.distinctOperationCount).toBeLessThan(2);
  });

  it("fails a file whose only assertions are tautological (reuses anti-stub Rule 5)", () => {
    const src = `
      import { describe, it, expect } from "vitest";
      import { start, record } from "../src/thing.js";
      describe("thing", () => {
        it("does something", () => {
          start();
          const items = record();
          expect(items.length).toBeGreaterThanOrEqual(0);
        });
      });
    `;
    const result = evaluateRoundtripShape(src, "fake-taut.test.ts");
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("tautological"))).toBe(true);
  });

  it("passes a real write-then-read-back shape with a substantive assertion", () => {
    const src = `
      import { describe, it, expect } from "vitest";
      import { CampaignManager } from "../src/manager.js";
      describe("roundtrip", () => {
        it("starts a campaign and projects it back", () => {
          const mgr = new CampaignManager();
          mgr.startCampaign("c1", "/tmp/plan.md", { id: "root" });
          const snapshot = mgr.getSnapshot("c1");
          expect(snapshot.campaign_id).toBe("c1");
          expect(snapshot.tree.size).toBeGreaterThan(0);
        });
      });
    `;
    const result = evaluateRoundtripShape(src, "fake-real.test.ts");
    expect(result.ok).toBe(true);
  });

  describe("calibration against every roundtrip= file currently cited in ROADMAP.md", () => {
    // Extract every unique `roundtrip=path/to.test.ts` citation directly
    // from ROADMAP.md (the same proof-comment syntax docs-truth.mjs parses)
    // and prove the semantic check passes cleanly against the real,
    // already-earned files it names — the check must have zero false
    // positives against the current, presumably-honest repo state before
    // it can be trusted as a real gate. This also transitively covers every
    // 6.3-manifest RUNTIME_CATALOG file (runtime-catalog.test.ts,
    // output-runtime.test.ts, etc.), since those are cited via the same
    // proof-comment mechanism at ROADMAP.md:1646 and friends.
    // Strip fenced code blocks first — 6.7's own "Mechanism" section
    // illustrates the proof-comment syntax inside a ``` fence with a
    // deliberately example-only path (tests/roundtrip/routing.test.ts) that
    // was never meant to resolve to a real file; docs-truth.mjs never sees
    // it either, since it only scans CLAIMED headings' bodies, and this
    // section is a mechanism description, not a claimed tranche.
    const roadmap = readFileSync(resolve(REPO_ROOT, "ROADMAP.md"), "utf-8").replace(/```[\s\S]*?```/g, "");
    const cited = new Set();
    for (const m of roadmap.matchAll(/<!--\s*proof:.*?roundtrip=(\S+?)\s*-->/g)) cited.add(m[1]);
    // Also fold in the 6.3 manifest's own landed files, so a future
    // manifest-only capability without its own ROADMAP proof comment is
    // still calibration-covered.
    const manifestPath = resolve(REPO_ROOT, "packages/arbor-mcp/tests/roundtrip/manifest.js");
    let manifestFiles = [];
    try {
      const manifestSrc = readFileSync(resolve(REPO_ROOT, "packages/arbor-mcp/tests/roundtrip/manifest.ts"), "utf-8");
      for (const m of manifestSrc.matchAll(/file:\s*"([^"]+)"/g)) manifestFiles.push(m[1]);
    } catch {
      // manifest.ts not present in some other repo layout — calibration
      // still covers the ROADMAP-cited set above.
    }
    for (const f of manifestFiles) cited.add(f);

    it("found at least 20 distinct roundtrip files to calibrate against (sanity floor)", () => {
      expect(cited.size).toBeGreaterThanOrEqual(20);
    });

    for (const relPath of [...cited].sort()) {
      it(`passes: ${relPath}`, () => {
        const abs = resolve(REPO_ROOT, relPath);
        expect(statSync(abs).isFile(), `${relPath} does not exist`).toBe(true);
        const result = evaluateRoundtripFile(abs);
        expect(result.ok, `${relPath} failed semantic roundtrip check: ${result.reasons.join("; ")}`).toBe(true);
      });
    }
  });
});
