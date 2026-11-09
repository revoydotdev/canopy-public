# M7 semantic theme/token specification

Semantic meaning is carried by a label and glyph before color is applied.
`M7_THEME_TOKENS` is the source for the M7 policy surface; the existing
`RunTheme` palette provides optional dark/light color treatment.

| token | carrier | meaning |
|---|---|---|
| neutral | `· neutral` | observed, non-urgent information |
| active | `▶ active` | work is currently in flight |
| success | `✓ success` | authoritative completion |
| waiting | `… waiting` | waiting for an external/user condition |
| failure | `! failure` | failed or rejected; never hidden by compaction |
| selected | `› selected` | row/document selection |
| focused | `▸ focused` | input focus; distinct from selection |

The glyph/label distinction survives monochrome output and ASCII fallback
(`theme.ts` already supplies `SEMANTIC_GLYPHS` and contrast checks). Borders and
spacing remain renderer geometry, with one-cell gutters and bounded rows.
