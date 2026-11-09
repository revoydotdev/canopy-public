/**
 * Table-driven screen projection pipeline (roadmap 4F.8).
 *
 * Several screens own more than one query kind, so `project()` cannot know
 * which query kind produced the raw `result` it received — it must duck-type
 * the VALUE shape. Previously this was an ad hoc if/else cascade of
 * `isXShape` predicates in `project()`, followed by `render()` re-inspecting
 * the already-built `ScreenProjection`'s `columns` array to guess which
 * render function to use. `buildScreenPipeline` replaces both with one
 * generic, shared, table-driven dispatcher: each variant pairs a `match`
 * predicate + `project` closure with the `render` function it feeds, tagged
 * by `variant`. `render()` then looks up the render function by the tag
 * `project()` already resolved — no re-inspection of shape.
 */

import { wrapDisplay } from "../widgets.js";
import type { ScreenModule, ScreenProjection, ScreenProjectContext } from "./screen.js";
/** Keep variant presentation options identical to the public screen contract. */
export type RenderContext = Omit<Parameters<ScreenModule["render"]>[0], "projection">;

export interface ScreenVariant<TShape = unknown> {
  readonly tag: string;
  readonly match: (result: unknown) => result is TShape;
  readonly project: (
    shape: TShape,
    input: ScreenProjectContext,
  ) => Omit<ScreenProjection, "variant">;
  readonly render: (projection: ScreenProjection, ctx: RenderContext) => readonly string[];
}

/**
 * A variant whose shape parameter has been erased for storage in a table.
 *
 * `ScreenVariant<T>` is contravariant in `T` (`project` takes it), so a table of
 * concrete variants cannot be typed `ScreenVariant<unknown>[]` — annotating it
 * that way silently widens every `project` parameter to `unknown`, which is what
 * broke the declaration build. Variants are defined one at a time with
 * `defineVariant` (which keeps each shape) and erased only here, where `match`
 * is the runtime proof that `project` receives the shape it expects.
 */
export type ErasedScreenVariant = ScreenVariant<any>;

/**
 * Identity helper that infers `TShape` from the `match` type predicate, so a
 * variant's `project` callback receives its narrowed shape instead of `unknown`.
 * Define variants with this rather than annotating the surrounding array.
 */
export function defineVariant<TShape>(variant: ScreenVariant<TShape>): ScreenVariant<TShape> {
  return variant;
}

export type ScreenPipeline = Pick<ScreenModule, "project" | "render">;

export interface ScreenPipelineOptions {
  /**
   * Builds the zero-rows fallback projection. Called with `"empty"` when
   * `result` was `null` (no query issued yet / nothing to show), and with
   * `"unrecognised"` when `result` was non-null but matched none of this
   * screen's own variant shapes (WA-59: these are genuinely different
   * conditions — a screen that only ever showed "No data" for both hid
   * which one happened). A screen that doesn't yet distinguish the two may
   * still supply a single-argument `() => ...` here; TypeScript allows the
   * narrower callback.
   */
  readonly emptyProjection: (reason: "empty" | "unrecognised") => Omit<ScreenProjection, "variant">;
  /**
   * Default true: replicates the shared guard every multi/single-variant
   * table screen already had — `rows.length === 0` short-circuits to a
   * generic `[clipDisplay(projection.caption ?? "(no data)", width)]` line
   * BEFORE variant-specific rendering, regardless of which variant matched.
   * Set false for screens whose OWN render function already fully owns the
   * empty-rows case with different, specific output (diagnostics,
   * interviews, devtools) — for those, dispatch goes straight to the
   * variant's render function always.
   */
  readonly shortCircuitEmptyRows?: boolean;
}

export function buildScreenPipeline(
  variants: readonly ErasedScreenVariant[],
  options: ScreenPipelineOptions,
): ScreenPipeline {
  if (variants.length === 0) throw new Error("screen pipeline requires at least one variant");
  const shortCircuit = options.shortCircuitEmptyRows ?? true;
  const renderByTag = new Map(variants.map((v) => [v.tag, v.render] as const));
  // Screens that opt out of the shared shortCircuitEmptyRows guard (diagnostics,
  // interviews, devtools) pre-refactor always called ONE render function
  // unconditionally, regardless of whether a variant matched — that render
  // function fully owns the zero-rows/unmatched-shape case with its own fixed
  // string (e.g. diagnostics's "(no events)"), which is NOT the same string as
  // the generic `caption ?? "(no data)"` fallback below. Route the "empty" tag
  // to the (sole, by construction of every current caller) variant's render so
  // that unconditional-dispatch behavior survives byte-for-byte.
  if (!shortCircuit) renderByTag.set("empty", variants[0].render);

  function emptyTagged(reason: "empty" | "unrecognised"): ScreenProjection {
    return { ...options.emptyProjection(reason), variant: "empty" };
  }

  return {
    project(result: unknown, input: ScreenProjectContext): ScreenProjection {
      if (result == null) return emptyTagged("empty");
      for (const variant of variants) {
        if (variant.match(result)) {
          return { ...variant.project(result, input), variant: variant.tag };
        }
      }
      return emptyTagged("unrecognised");
    },
    render(input: { projection: ScreenProjection } & RenderContext): readonly string[] {
      const { projection, ...ctx } = input;
      if (shortCircuit && projection.rows.length === 0) {
        return wrapDisplay(projection.caption ?? "(no data)", ctx.width).slice(0, Math.max(1, ctx.height));
      }
      const renderer = renderByTag.get(projection.variant);
      if (renderer !== undefined) return renderer(projection, ctx);
      // "empty" tag (or any unrecognized tag, e.g. a hand-built test
      // fixture bypassing project()) falls back to the same generic line —
      // total, never throws, never re-inspects shape.
      return wrapDisplay(projection.caption ?? "(no data)", ctx.width).slice(0, Math.max(1, ctx.height));
    },
  };
}
