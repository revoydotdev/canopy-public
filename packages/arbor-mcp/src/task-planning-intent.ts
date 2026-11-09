/**
 * Positive requests that the single-action shortcut cannot satisfy.
 * This only requests planning; it never changes governance or grants scope.
 */
export function requestsDeliberatePlanning(task: string): boolean {
  const text = task.toLowerCase().replace(/\s+/gu, " ");
  return /\bplan (?:and|then) (?:implement|build|execute)\b/u.test(text)
    || /\b(?:ask|interview) (?:me|the operator|the user)\b/u.test(text)
    || /\b(?:produce|create|provide|write) (?:a |an )?(?:\w+ ){0,3}plan\b/u.test(text)
    || /\b(?:dependent|bounded) (?:work )?(?:units|phases|tasks)\b/u.test(text)
    || /\bunresolved (?:requirement|decision|prerequisite)\b/u.test(text);
}
