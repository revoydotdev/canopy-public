export const canaryState: { flag?: boolean } = {};

/** A branch that only a test ever turns on. */
export function seedBranch(): number {
  if (canaryState.flag) return 1;
  return 0;
}
