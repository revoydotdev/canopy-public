import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * scripts/tests/reachability-graph.test.mjs — the general reference-graph
 * walk (as opposed to reachability-communication-proof.test.mjs, which
 * covers only the ADR-083 sub-proof). Twelve waivers rest on this gate's
 * verdict; a defect that under-counts references grants an unnecessary
 * waiver, and one that over-counts them hides real dead code from review.
 *
 * Each test builds a throwaway fixture repo (own tsconfig.json,
 * entry-points.json, allowlist.json) and drives the real script against it
 * via `--repo`, exactly like reachability-communication-proof.test.mjs does
 * with `runWithMutatedHost` — a synthetic fixture is the only way to prove a
 * false verdict without corrupting the real repo's graph.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repo, "scripts", "reachability.mjs");

function runFixture(files, allowlistContent = JSON.stringify({ version: 1, entries: [] })) {
  const dir = mkdtempSync(join(tmpdir(), "revoy-reachability-graph-"));
  try {
    mkdirSync(join(dir, "packages", "pkg", "src"), { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }),
    );
    writeFileSync(
      join(dir, "entry-points.json"),
      JSON.stringify({
        entryPoints: [{ id: "e", file: "packages/pkg/src/entry.ts", kind: "process-entry" }],
      }),
    );
    writeFileSync(join(dir, "allowlist.json"), allowlistContent);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, "packages", "pkg", "src", name), content);
    }
    const result = spawnSync(
      "bun",
      [script, "--json", "--repo", dir, "--entry-points", join(dir, "entry-points.json"), "--allowlist", join(dir, "allowlist.json")],
      { cwd: repo, encoding: "utf8" },
    );
    return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function reachableOf(report, name) {
  const entry = report.checklist.find((c) => c.name === name);
  if (!entry) throw new Error(`${name} not in checklist: ${JSON.stringify(report.checklist)}`);
  return entry.reachable;
}

describe("reachability.mjs — reference-graph fidelity", () => {
  it("TEETH: does not treat `implements Base` as constructing Base — an implements-only class was live", () => {
    // Before the fix: isTypeOnlyReference did not recognize
    // ExpressionWithTypeArguments inside a HeritageClause, so the checker's
    // merged value+type symbol for a class made `implements Base` look
    // exactly like `new Base()`. Real bun/tsc output never reads Base as a
    // value for `implements` — verified separately against `bun build`.
    const { report } = runFixture({
      "entry.ts": `
        export class Base {}
        export class Derived implements Base {}
        export function main() { new Derived(); }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "Base")).toBe(false);
    expect(reachableOf(report, "Derived")).toBe(true);
  });

  it("a real `class X extends Base` still counts Base as reachable (extends genuinely evaluates it)", () => {
    const { report } = runFixture({
      "entry.ts": `
        export class Base {}
        export class Derived extends Base {}
        export function main() { new Derived(); }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "Base")).toBe(true);
    expect(reachableOf(report, "Derived")).toBe(true);
  });

  it("`interface I extends Base` (a class used only as an interface shape) does not construct Base", () => {
    const { report } = runFixture({
      "entry.ts": `
        export class Base {}
        interface I extends Base {}
        export function main(x: I) { void x; }
        if (true) { void main({}); }
      `,
    });
    expect(reachableOf(report, "Base")).toBe(false);
  });

  it("TEETH: an import used only in type position does not falsely evaluate its target module", () => {
    // Before the fix: `import { Shape } from "./types-only"` added a
    // module-evaluation edge regardless of whether Shape was ever used as a
    // value. Real bun/tsc-family transpilers elide this import entirely
    // (verified against `bun build` output), so types-only.ts's own
    // top-level side effect — and whatever it calls — never actually runs.
    const { report } = runFixture({
      "types-only.ts": `
        export function sideEffectTarget(): void {}
        export type Shape = { x: number };
        if (true) { void sideEffectTarget(); }
      `,
      "entry.ts": `
        import { Shape } from "./types-only";
        export function useShape(x: Shape): string { return typeof x; }
        export function main() { void useShape({ x: 1 }); }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "sideEffectTarget")).toBe(false);
    expect(report.violations.map((v) => v.name)).toContain("sideEffectTarget");
  });

  it("an import used as a real value still evaluates its target module", () => {
    const { report } = runFixture({
      "helper.ts": `export function helperFn(): number { return 1; }`,
      "entry.ts": `
        import { helperFn } from "./helper";
        export function main() { void helperFn(); }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "helperFn")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("an `export * from` barrel still resolves through to the origin declaration", () => {
    const { report } = runFixture({
      "impl.ts": `export function barrelFn(): number { return 42; }`,
      "index.ts": `export * from "./impl";`,
      "entry.ts": `
        import { barrelFn } from "./index";
        export function main() { void barrelFn(); }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "barrelFn")).toBe(true);
  });

  it("a dynamic `import()` reached via property access (not destructuring) still resolves to the origin export", () => {
    const { report } = runFixture({
      "dyn-target.ts": `export function dynFn(): number { return 1; }`,
      "entry.ts": `
        export function main() {
          return import("./dyn-target").then((m) => m.dynFn());
        }
        if (true) { void main(); }
      `,
    });
    expect(reachableOf(report, "dynFn")).toBe(true);
  });

  it("a decorator reference counts as a real value use", () => {
    const { report } = runFixture({
      "decorators.ts": `export function myDecorator(target: any) { return target; }`,
      "entry.ts": `
        import { myDecorator } from "./decorators";
        @myDecorator
        class Widget {}
        new Widget();
      `,
    });
    expect(reachableOf(report, "myDecorator")).toBe(true);
  });

  it("suppression verdict: an allowlisted symbol's reachability is computed, not skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy-reachability-graph-suppress-"));
    try {
      mkdirSync(join(dir, "packages", "pkg", "src"), { recursive: true });
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true } }),
      );
      writeFileSync(
        join(dir, "entry-points.json"),
        JSON.stringify({ entryPoints: [{ id: "e", file: "packages/pkg/src/entry.ts", kind: "process-entry" }] }),
      );
      writeFileSync(
        join(dir, "packages", "pkg", "src", "entry.ts"),
        `
          export function actuallyReachable(): number { return 1; }
          export function main() { return actuallyReachable(); }
          if (true) { void main(); }
        `,
      );
      // Allowlisted, but the symbol is genuinely reachable. A gate that
      // skips computing reachability for allowlisted symbols could never
      // tell the operator the waiver is now unnecessary.
      writeFileSync(
        join(dir, "allowlist.json"),
        JSON.stringify({
          version: 1,
          entries: [{ symbol: "actuallyReachable", file: "packages/pkg/src/entry.ts", reason: "test", gap: "G-TEST", expires: "2099-01-01" }],
        }),
      );
      const result = spawnSync(
        "bun",
        [script, "--json", "--repo", dir, "--entry-points", join(dir, "entry-points.json"), "--allowlist", join(dir, "allowlist.json")],
        { cwd: repo, encoding: "utf8" },
      );
      const report = JSON.parse(result.stdout);
      expect(reachableOf(report, "actuallyReachable")).toBe(true);
      expect(report.allowlisted).toEqual([]);
      expect(report.staleAllowlistEntries.map((e) => e.symbol)).toContain("actuallyReachable");
      expect(report.ok).toBe(false);
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the waiver store is unparseable", () => {
    const { status, report } = runFixture(
      { "entry.ts": "export function main() {}\nif (true) { void main(); }\n" },
      "{ this is not valid JSON",
    );
    expect(report.allowlistFileError).toBeTruthy();
    expect(report.ok).toBe(false);
    expect(status).not.toBe(0);
  });
});
