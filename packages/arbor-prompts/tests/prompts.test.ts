import { describe, it, expect } from "vitest";
import { AGENT_PROMPTS, crownPrompt, cambiumPrompt, lenticelPrompt, seedPrompt, taprootPrompt, xylemPrompt, heartwoodPrompt } from "../src/index.js";

const AGENT_NAMES = Object.keys(AGENT_PROMPTS);

const OMO_NAMES = ["sisyphus", "hephaestus", "prometheus", "atlas", "oracle", "librarian", "explore", "metis", "momus"];

describe("agent prompt generation", () => {
  it("exports 11 prompt functions", () => {
    expect(AGENT_NAMES).toHaveLength(11);
  });

  it("each prompt returns a non-empty string", () => {
    for (const name of AGENT_NAMES) {
      const prompt = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS]();
      expect(prompt.length, `prompt for ${name} should be non-empty`).toBeGreaterThan(100);
    }
  });

  it("crown prompt mentions tree and orchestration", () => {
    const prompt = crownPrompt().toLowerCase();
    expect(prompt).toContain("tree");
    expect(prompt).toContain("orchestrat");
  });

  it("lenticel prompt mentions root-cause and measurement", () => {
    const prompt = lenticelPrompt().toLowerCase();
    expect(prompt).toContain("root-cause");
    expect(prompt).toContain("measurement");
  });

  it("seed prompt mentions self-validat and cannot delegate", () => {
    const prompt = seedPrompt().toLowerCase();
    expect(prompt).toContain("self-validat");
    expect(prompt).toContain("cannot delegate");
  });

  it("taproot prompt mentions interview and read-only", () => {
    const prompt = taprootPrompt().toLowerCase();
    expect(prompt).toContain("interview");
    expect(prompt).toContain("read-only");
  });

  it("no prompt references omo agent names as standalone words", () => {
    for (const name of AGENT_NAMES) {
      const prompt = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS]().toLowerCase();
      for (const omoName of OMO_NAMES) {
        const wordBoundary = new RegExp(`\\b${omoName}\\b`);
        expect(prompt, `prompt for ${name} should not reference omo agent "${omoName}" as a word`).not.toMatch(wordBoundary);
      }
    }
  });

  it("each prompt is between 200 and 3000 characters", () => {
    for (const name of AGENT_NAMES) {
      const prompt = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS]();
      expect(prompt.length, `prompt for ${name} is ${prompt.length} chars`).toBeGreaterThanOrEqual(200);
      expect(prompt.length, `prompt for ${name} is ${prompt.length} chars`).toBeLessThanOrEqual(3000);
    }
  });

  it("accepts optional context", () => {
    const prompt = crownPrompt({ campaignId: "camp_001", taskDescription: "refactor auth" });
    expect(prompt).toContain("camp_001");
    expect(prompt).toContain("refactor auth");
  });
});

describe("prompt context branches", () => {
  const ctx = { campaignId: "camp_001", taskDescription: "refactor auth" };

  describe("crownPrompt", () => {
    it("shows no campaign when ctx absent", () => {
      const p = crownPrompt();
      expect(p).toContain("No active campaign yet.");
      expect(p).not.toContain("Active campaign:");
    });

    it("shows campaign when campaignId present", () => {
      const p = crownPrompt({ campaignId: "camp_001" });
      expect(p).toContain("Active campaign: camp_001");
      expect(p).not.toContain("No active campaign yet.");
    });

    it("omits task when taskDescription absent", () => {
      const p = crownPrompt({ campaignId: "camp_001" });
      expect(p).not.toContain("Task:");
    });

    it("shows task when taskDescription present", () => {
      const p = crownPrompt({ taskDescription: "do the thing" });
      expect(p).toContain("Task: do the thing");
    });

    it("shows both when both present", () => {
      const p = crownPrompt(ctx);
      expect(p).toContain("Active campaign: camp_001");
      expect(p).toContain("Task: refactor auth");
    });
  });

  describe("cambiumPrompt", () => {
    it("omits campaign when absent", () => {
      const p = cambiumPrompt();
      expect(p).not.toContain("Active campaign:");
    });

    it("shows campaign when present", () => {
      const p = cambiumPrompt({ campaignId: "camp_001" });
      expect(p).toContain("Active campaign: camp_001");
    });

    it("omits task when absent", () => {
      const p = cambiumPrompt({ campaignId: "camp_001" });
      expect(p).not.toContain("Current task:");
    });

    it("shows task when present", () => {
      const p = cambiumPrompt({ taskDescription: "deploy service" });
      expect(p).toContain("Current task: deploy service");
    });

    it("shows both when both present", () => {
      const p = cambiumPrompt(ctx);
      expect(p).toContain("Active campaign: camp_001");
      expect(p).toContain("Current task: refactor auth");
    });
  });

  describe("lenticelPrompt", () => {
    it("omits campaign when absent", () => {
      const p = lenticelPrompt();
      expect(p).not.toContain("Campaign:");
    });

    it("shows campaign when present", () => {
      const p = lenticelPrompt({ campaignId: "camp_001" });
      expect(p).toContain("Campaign: camp_001");
    });

    it("does not reference task in output", () => {
      const p = lenticelPrompt(ctx);
      expect(p).not.toMatch(/\bTask:/);
    });
  });

  describe("taprootPrompt", () => {
    it("omits initial request when taskDescription absent", () => {
      const p = taprootPrompt();
      expect(p).not.toContain("User's initial request:");
    });

    it("shows initial request when taskDescription present", () => {
      const p = taprootPrompt({ taskDescription: "build a dashboard" });
      expect(p).toContain("User's initial request: build a dashboard");
    });

    it("does not reference campaign in output", () => {
      const p = taprootPrompt(ctx);
      expect(p).not.toMatch(/\bCampaign:/);
    });
  });

  describe("xylemPrompt", () => {
    it("omits plan under review when taskDescription absent", () => {
      const p = xylemPrompt();
      expect(p).not.toContain("Plan under review:");
    });

    it("shows plan under review when taskDescription present", () => {
      const p = xylemPrompt({ taskDescription: "migrate to ESM" });
      expect(p).toContain("Plan under review: migrate to ESM");
    });

    it("does not reference campaign in output", () => {
      const p = xylemPrompt(ctx);
      expect(p).not.toMatch(/\bCampaign:/);
    });
  });

  describe("seedPrompt", () => {
    it("omits task when taskDescription absent", () => {
      const p = seedPrompt();
      expect(p).not.toContain("Task:");
    });

    it("shows task when taskDescription present", () => {
      const p = seedPrompt({ taskDescription: "add validation" });
      expect(p).toContain("Task: add validation");
    });

    it("does not reference campaign in output", () => {
      const p = seedPrompt(ctx);
      expect(p).not.toMatch(/\bCampaign:/);
    });
  });

  describe("heartwoodPrompt", () => {
    it("omits goal when taskDescription absent", () => {
      const p = heartwoodPrompt();
      expect(p).not.toContain("Goal:");
    });

    it("shows goal when taskDescription present", () => {
      const p = heartwoodPrompt({ taskDescription: "rewrite the router" });
      expect(p).toContain("Goal: rewrite the router");
    });

    it("does not reference campaign in output", () => {
      const p = heartwoodPrompt(ctx);
      expect(p).not.toMatch(/\bCampaign:/);
    });
  });

  describe("non-ctx functions", () => {
    it("burlPrompt works without ctx", () => {
      expect(AGENT_PROMPTS.burl().length).toBeGreaterThan(100);
    });

    it("rhizomePrompt works without ctx", () => {
      expect(AGENT_PROMPTS.rhizome().length).toBeGreaterThan(50);
    });

    it("myceliumPrompt works without ctx", () => {
      expect(AGENT_PROMPTS.mycelium().length).toBeGreaterThan(50);
    });

    it("stomaPrompt works without ctx", () => {
      expect(AGENT_PROMPTS.stoma().length).toBeGreaterThan(50);
    });
  });
});

describe("G-02: PromptContext.foregroundFragment — per-model prompt derivation", () => {
  it("every one of the 11 prompt functions now accepts ctx (not just 7 of 11)", () => {
    for (const name of AGENT_NAMES) {
      const fn = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS];
      // Calling with an explicit ctx object must not throw for any agent —
      // before this fix, burl/rhizome/mycelium/stoma took no parameter at all.
      expect(() => fn({ foregroundFragment: '{"model_family":"anthropic/claude-haiku"}' })).not.toThrow();
    }
  });

  it("omits the Foreground block when absent — no behavior change for existing callers", () => {
    for (const name of AGENT_NAMES) {
      const fn = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS];
      expect(fn()).not.toContain("Foreground");
    }
  });

  it("renders the derived fragment verbatim when present, for every agent", () => {
    const fragment = '{"lead":"seed","model_family":"anthropic/claude-sonnet-4","tier":"specialist"}';
    for (const name of AGENT_NAMES) {
      const fn = AGENT_PROMPTS[name as keyof typeof AGENT_PROMPTS];
      const prompt = fn({ foregroundFragment: fragment });
      expect(prompt, `${name} must render its foreground fragment`).toContain(fragment);
    }
  });

  it("two calls with the same fragment produce byte-identical output — derived, not cached per-call state", () => {
    const fragment = '{"model_family":"anthropic/claude-opus-4"}';
    const a = crownPrompt({ foregroundFragment: fragment });
    const b = crownPrompt({ foregroundFragment: fragment });
    expect(a).toBe(b);
  });
});

describe("G-10 (ADR-022): PromptContext.repoInstructions — root/plan-level-only scope", () => {
  const repoInstructions = { source_paths: ["/repo/AGENTS.md"], content: "Always run the test suite before committing.", truncated: false };

  it("renders the repo-instructions block, labeled and distinct, for the three root/plan-level agents", () => {
    for (const fn of [crownPrompt, cambiumPrompt, taprootPrompt]) {
      const prompt = fn({ repoInstructions });
      expect(prompt).toContain("Always run the test suite before committing.");
      expect(prompt).toContain("Repo instructions");
      expect(prompt).toContain("not campaign evidence");
    }
  });

  it("omits the block entirely when repoInstructions is absent — no behavior change for existing callers", () => {
    for (const fn of [crownPrompt, cambiumPrompt, taprootPrompt]) {
      expect(fn()).not.toContain("Repo instructions");
    }
  });

  // The anti-pattern OMO was criticised for (Appendix E): a deep leaf must
  // never inherit the whole repo's instructions. Structural proof, not just
  // convention — these 8 prompt functions ignore the field even when a
  // caller sets it, so a future caller cannot accidentally leak it into a
  // leaf's dispatch by merely passing the context through.
  it("leaf/critic/research prompt functions never render repoInstructions even if the field is set", () => {
    const leafFns = [lenticelPrompt, seedPrompt, xylemPrompt, heartwoodPrompt, AGENT_PROMPTS.burl, AGENT_PROMPTS.rhizome, AGENT_PROMPTS.mycelium, AGENT_PROMPTS.stoma];
    for (const fn of leafFns) {
      const prompt = fn({ repoInstructions });
      expect(prompt).not.toContain("Always run the test suite before committing.");
      expect(prompt).not.toContain("Repo instructions");
    }
  });
});
