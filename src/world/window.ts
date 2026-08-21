import { RESTRICTED_END_HOUR, RESTRICTED_START_HOUR } from "../config.ts";
import { istHour } from "../time.ts";

// C1. Applies uniformly to every customer, bank and amount -- the invariance
// that makes it separable from everything else.
export function isRestricted(ms: number): boolean {
  const h = istHour(ms);
  return h >= RESTRICTED_START_HOUR && h < RESTRICTED_END_HOUR;
}
