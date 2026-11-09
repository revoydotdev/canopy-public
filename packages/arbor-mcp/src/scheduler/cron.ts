/** Bounded five-field cron subset: wildcard, stepped wildcard, or one integer per field. */
export function nextCronOccurrence(expression: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must contain minute hour day-of-month month day-of-week");
  const specs = [parse(fields[0]!, 0, 59), parse(fields[1]!, 0, 23), parse(fields[2]!, 1, 31), parse(fields[3]!, 1, 12), parse(fields[4]!, 0, 6)];
  const cursor = new Date(after.getTime()); cursor.setUTCSeconds(0, 0); cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const bound = 366 * 24 * 60;
  for (let attempt = 0; attempt < bound; attempt += 1) {
    const values = [cursor.getUTCMinutes(), cursor.getUTCHours(), cursor.getUTCDate(), cursor.getUTCMonth() + 1, cursor.getUTCDay()];
    if (specs.every((spec, index) => spec(values[index]!))) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error("cron expression has no occurrence within one year");
}
function parse(field: string, min: number, max: number): (value: number) => boolean {
  if (field === "*") return () => true;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new Error("cron step is out of range");
    return (value) => (value - min) % step === 0;
  }
  const exact = Number(field);
  if (!Number.isSafeInteger(exact) || exact < min || exact > max) throw new Error("cron field is out of range");
  return (value) => value === exact;
}
