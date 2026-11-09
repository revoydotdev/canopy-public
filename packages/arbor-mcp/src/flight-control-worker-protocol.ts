/** Parse the synthetic flight worker's bounded line-JSON protocol. */
export function parseFlightWorkerLine(line: string): unknown {
  return JSON.parse(line);
}
