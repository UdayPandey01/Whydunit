import { SPEND_TAU_DAYS, START_MS } from "../config.ts";
import { DAY_MS, daysInMonth, istMs, istParts } from "../time.ts";
import type { Customer } from "./types.ts";

function monthIndex(year: number, month: number): number {
  const s = istParts(START_MS);
  return (year - s.year) * 12 + (month - s.month);
}

function lastSalaryCredit(c: Customer, ms: number): number {
  const p = istParts(ms);
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(p.year, p.month - back, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const day = Math.min(c.salary_day, daysInMonth(year, month));
    const idx = monthIndex(year, month);
    const delay = c.salary_delays[Math.min(Math.max(idx, 0), c.salary_delays.length - 1)] ?? 0;
    const credit = istMs(year, month, day, 10, 30) + delay * DAY_MS;
    if (credit <= ms) return credit;
  }
  return ms - 30 * DAY_MS;
}

export function balanceAt(c: Customer, ms: number): { balance: number; days_since_salary: number } {
  const credit = lastSalaryCredit(c, ms);
  const d = (ms - credit) / DAY_MS;
  const spent = c.income * c.spend_ratio * (1 - Math.exp(-d / SPEND_TAU_DAYS));
  let shocks = 0;
  for (const s of c.shocks) if (s.ms > credit && s.ms <= ms) shocks += s.amount;
  return {
    balance: Math.max(0, c.buffer + c.income - spent - shocks),
    days_since_salary: d,
  };
}
