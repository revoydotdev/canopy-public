import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_INTEGRATION_SDK_VERSION, defineIntegration } from "../src/sdk.js";

describe("public SDK boundary", () => {
  it("exports only data-authoring helpers and validates public definitions", async () => {
    expect(Object.keys(await import("../src/sdk.js")).sort()).toEqual(["PUBLIC_INTEGRATION_SDK_VERSION", "defineIntegration"]);
    expect(defineIntegration({ schema_version: 1, sdk_version: PUBLIC_INTEGRATION_SDK_VERSION, integration_id: "review-helper", version: "1.0.0", display_name: "Review helper", capabilities: ["tools", "tools"] })).toEqual(expect.objectContaining({ capabilities: ["tools"] }));
    expect(() => defineIntegration({ schema_version: 1, sdk_version: PUBLIC_INTEGRATION_SDK_VERSION, integration_id: "x", version: "1.0.0", display_name: "x", capabilities: [] })).toThrow(/identifier/);
    expect(() => defineIntegration({ schema_version: 1, sdk_version: PUBLIC_INTEGRATION_SDK_VERSION, integration_id: "review-helper", version: "1.0.0", display_name: "Review helper", capabilities: "tools" } as unknown as Parameters<typeof defineIntegration>[0])).toThrow(/capability/);
  });

  it("has an explicit package export and never imports internal authority or credential material", () => {
    const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")); const source = readFileSync(new URL("../src/sdk.ts", import.meta.url), "utf8");
    expect(packageManifest.exports["./sdk"]).toEqual({ types: "./src/sdk.ts", import: "./src/sdk.ts" });
    expect(source).not.toMatch(/from\s+["'][^"']*(integration-sdk|credential|registry|sandbox|runtime)[^"']*["']/);
    expect(source).not.toMatch(/private[_ ]?key|secret|token/i);
  });
});
