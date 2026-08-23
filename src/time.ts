export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const IST_OFFSET_MS = 5.5 * HOUR_MS;

export function istParts(ms: number) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

export function istMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MS;
}

export function istHour(ms: number): number {
  return istParts(ms).hour;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function toIso(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19) + "+05:30";
}

export function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

export function istWeekday(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay();
}
