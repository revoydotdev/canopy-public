import { describe, expect, it } from "vitest";
import { redactCredentialShapes, redactNativeText } from "../src/index.js";

/** Planted values only; none is a real credential. */
const POSITIVE: readonly (readonly [string, string])[] = [
  ["OpenAI legacy", "sk-PLANTED0123456789abcdefghij"],
  ["OpenAI project", "sk-proj-PLANTEDa1b2c3d4e5f6g7h8i9j0"],
  ["Anthropic", "sk-ant-api03-PLANTED0123456789abcdef-GHIJ_klm"],
  ["Stripe secret", "sk_live_PLANTED0123456789abcdef"],
  ["Stripe publishable", "pk_test_PLANTED0123456789abcdef"],
  ["Stripe restricted", "rk_live_PLANTED0123456789abcdef"],
  ["AWS access key id", "AKIAPLANTED012345678"],
  ["AWS session key id", "ASIAPLANTED012345678"],
  ["GitHub classic PAT", "ghp_PLANTED0123456789abcdefghijklmnopqr"],
  ["GitHub OAuth", "gho_PLANTED0123456789abcdefghijklmnopqr"],
  ["GitHub app server", "ghs_PLANTED0123456789abcdefghijklmnopqr"],
  ["GitHub fine-grained", "github_pat_11PLANTED0123456789_abcdefghijklmnopqrstuv"],
  ["Slack bot", "xoxb-1234567890-PLANTED-abcdefghij"],
  ["Slack user", "xoxp-1234567890-PLANTED-abcdefghij"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.PLANTEDsignature0123456789"],
  ["Google API key", "AIzaSyPLANTED0123456789abcdefghijklmnop"],
];

describe("redactCredentialShapes", () => {
  for (const [name, secret] of POSITIVE) {
    it(`removes a ${name} key embedded in prose`, () => {
      const text = `quota exceeded for ${secret}; retry later`;
      const redacted = redactCredentialShapes(text);
      expect(redacted).not.toContain(secret);
      expect(redacted).toBe("quota exceeded for [REDACTED]; retry later");
    });
  }

  it("removes a key at the very start and end of the text and honours a custom replacement", () => {
    expect(redactCredentialShapes("sk-proj-PLANTEDa1b2c3d4e5f6g7h8i9j0", "<x>")).toBe("<x>");
    expect(redactCredentialShapes("(AKIAPLANTED012345678)")).toBe("([REDACTED])");
  });

  it("removes a generic opaque run only after a key-ish label, keeping the label", () => {
    const run = "Zq8PLANTEDx7Kp2Lm9Nb4Vc6Xz1Wq3Er5Ty0Ui";
    expect(redactCredentialShapes(`credential ${run} rejected`)).toBe("credential [REDACTED] rejected");
    expect(redactCredentialShapes(`x-api-key: "${run}"`)).toBe(`x-api-key: "[REDACTED]"`);
    expect(redactCredentialShapes(`Token=${run}`)).toBe("Token=[REDACTED]");
    // The same run with no key-ish label is not treated as a credential.
    expect(redactCredentialShapes(`blob ${run} attached`)).toBe(`blob ${run} attached`);
  });

  it("is idempotent", () => {
    const once = redactCredentialShapes(`key sk-proj-PLANTEDa1b2c3d4e5f6g7h8i9j0 and token ${"a1".repeat(20)}`);
    expect(redactCredentialShapes(once)).toBe(once);
  });

  describe("negatives: identifiers that must survive", () => {
    const sha1 = "3f2a9c1e8b7d6054a3f2e1d0c9b8a7f6e5d4c3b2";
    const sha256hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const base64 = "SGVsbG8sIHdvcmxkISBUaGlzIGlzIGJhc2U2NCBjb250ZW50IDEyMzQ1Njc4OTA=";
    const cases: readonly (readonly [string, string])[] = [
      ["a git SHA", `commit ${sha1} merged`],
      ["a git SHA after a key-ish label", `cache key ${sha1}`],
      ["a sha256: digest", `content sha256:${sha256hex}`],
      ["a sha256: digest after a key-ish label", `idempotency key sha256:${sha256hex}`],
      ["a bare 64-hex digest after a key-ish label", `token ${sha256hex}`],
      ["a UUID", `session ${uuid}`],
      ["a UUID after a key-ish label", `idempotency key ${uuid}`],
      ["base64 file content", `file content: ${base64}`],
      ["prose that mentions sk- and pk_ words", "the task-sk-learn and pk_customers_by_region_and_date index"],
      ["a short sk- word", "sk-learn and sk-12"],
      ["an all-letter identifier after a label", `secret ${"abcdefghij".repeat(4)}`],
      ["a word ending in a vendor prefix", "desk_0123456789abcdefghij and work-0123456789abcdefghij"],
    ];
    for (const [name, text] of cases) {
      it(`keeps ${name}`, () => expect(redactCredentialShapes(text)).toBe(text));
    }
  });
});

describe("redactNativeText includes key-shape scrubbing", () => {
  it("removes an unlabelled key shape in addition to labelled secrets and bearer values", () => {
    const text = "HTTP 402: quota for key sk-proj-PLANTEDa1b2c3d4e5f6g7h8i9j0; api_key=native-secret Authorization: Bearer PLANTEDbearer0123456789";
    const redacted = redactNativeText(text);
    expect(redacted).not.toContain("sk-proj-PLANTED");
    expect(redacted).not.toContain("native-secret");
    expect(redacted).not.toContain("PLANTEDbearer");
    expect(redacted).toContain("HTTP 402: quota for key [REDACTED]");
  });

  it("uses the policy replacement for key shapes too", () => {
    expect(redactNativeText("id AKIAPLANTED012345678", { replacement: "***" })).toBe("id ***");
  });

  it("leaves digests and UUIDs intact", () => {
    const text = "evidence sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 at 3f2a9c1e8b7d6054a3f2e1d0c9b8a7f6e5d4c3b2 for 123e4567-e89b-12d3-a456-426614174000";
    expect(redactNativeText(text)).toBe(text);
  });
});
