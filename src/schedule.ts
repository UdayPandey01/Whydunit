import { RESTRICTED_END_HOUR, RESTRICTED_START_HOUR } from "./config.ts";
import { daysInMonth, istMs, istParts } from "./time.ts";

export const SAFE_HOUR = 14;

// Shared by the offline policy comparison and the agent's action planner. Both
// must avoid the NPCI window in exactly the same way; two copies would drift.
export function isRestrictedTime(ms: number): boolean {
  const h = istParts(ms).hour;
  return h >= RESTRICTED_START_HOUR && h < RESTRICTED_END_HOUR;
}

export function toSafeHour(ms: number): number {
  const p = istParts(ms);
  if (!isRestrictedTime(ms)) return ms;
  return istMs(p.year, p.month, p.day, SAFE_HOUR, p.minute);
}

export function nextMonthDay(ms: number, day: number): number {
  const p = istParts(ms);
  const d = new Date(Date.UTC(p.year, p.month + 1, 1));
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  return istMs(y, mo, Math.min(day, daysInMonth(y, mo)), SAFE_HOUR, 0);
}

// A mandate's billing cycle. The "max 3 interventions per mandate per cycle"
// constraint is scoped to this key.
export function cycleOf(ms: number): string {
  const p = istParts(ms);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}`;
}
