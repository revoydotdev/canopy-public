/** Select either every cited seam or only seams absent from the baseline. */
export function selectSeamsToMeasure(seams, current, refreshAll) {
  return refreshAll ? [...seams] : seams.filter((seam) => !current.has(seam));
}

/** Preserve prior measurements, replace newly measured rows, and drop retired citations. */
export function mergeMeasuredBaselines(seams, current, measured) {
  const merged = new Map(current);
  for (const baseline of measured) merged.set(baseline.roundtrip_path, baseline);
  return seams.map((seam) => merged.get(seam)).filter((baseline) => baseline !== undefined);
}
