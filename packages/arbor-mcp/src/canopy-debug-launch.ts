/** Capture is enabled only by the dedicated source-bound canopy-debug launcher. */
export function isCanopyDebugEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.CANOPY_DEBUG_ENABLED === "1";
}
