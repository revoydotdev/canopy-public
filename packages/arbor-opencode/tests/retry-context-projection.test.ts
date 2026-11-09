import { describe, expect, it } from "vitest";

import { appendRetryContextProjection } from "../src/loop.js";

describe("appendRetryContextProjection", () => {
  it("preserves the prompt byte-for-byte when no retry projection exists", () => {
    expect(appendRetryContextProjection("original prompt", null)).toBe("original prompt");
  });

  it("includes bounded context without a corrective section when nothing remains unresolved", () => {
    const projection = {
      attempt: 2,
      failure: { fingerprint: "sha256:resolved" },
      requirements: [{ status: "resolved", description: "tests now pass" }],
    } as never;

    const prompt = appendRetryContextProjection("original prompt", projection);

    expect(prompt).not.toContain("CORRECTIVE RETRY");
    expect(prompt).toContain("attempt 2");
    expect(prompt).toContain("sha256:resolved");
  });

  it("elevates every unresolved correction ahead of the bounded context", () => {
    const projection = {
      attempt: 3,
      failure: { fingerprint: "sha256:rejected" },
      requirements: [
        { status: "unresolved", description: "handle signed ranges" },
        { status: "resolved", description: "format output" },
      ],
    } as never;

    const prompt = appendRetryContextProjection("original prompt", projection);

    expect(prompt).toContain("CORRECTIVE RETRY");
    expect(prompt).toContain("- handle signed ranges");
    expect(prompt).not.toContain("- format output");
  });
});
