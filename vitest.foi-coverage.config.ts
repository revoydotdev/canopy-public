import { defineConfig } from "vitest/config";

/**
 * FOI acceptance measurement, intentionally separate from the repository-wide
 * coverage gate. It measures the complete TUI package against TUI tests only;
 * it does not let unrelated packages make this report red or inflate it.
 *
 * The 85% program threshold applies to statements, functions, and lines.
 * Branches retain an explicit 75% floor until the measured package reaches
 * 85%; the generated report must disclose that gap rather than call the whole
 * acceptance requirement complete.
 */
export default defineConfig({
  test: {
    setupFiles: ["./scripts/tests/setup-sanitize-git-env.mjs"],
    include: ["packages/arbor-tui/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/arbor-tui/tests/opentui-*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/frontier-operator-interface",
      reporter: ["json-summary", "json", "text"],
      include: ["packages/arbor-tui/src/**/*.ts"],
      exclude: ["packages/arbor-tui/src/opentui-renderer.ts"],
      thresholds: {
        statements: 85,
        functions: 85,
        lines: 85,
        branches: 75,
      },
    },
  },
});
