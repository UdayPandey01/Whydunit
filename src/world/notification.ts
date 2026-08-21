import { BANKS, NOTIFICATION_OUTAGES, OUTAGE_DELIVERY_RATE, START_MS } from "../config.ts";
import { DAY_MS, HOUR_MS } from "../time.ts";
import type { Rng } from "../rng.ts";

const OUTAGES = NOTIFICATION_OUTAGES.map((o) => ({
  bank: o.bank,
  start: START_MS + o.start_day * DAY_MS + o.start_hour * HOUR_MS,
  end: START_MS + o.end_day * DAY_MS + o.end_hour * HOUR_MS,
}));

export function isBankOutage(bank: string, ms: number): boolean {
  return OUTAGES.some((o) => o.bank === bank && ms >= o.start && ms < o.end);
}

// C2's hidden half. The merchant knows it dispatched; whether the bank actually
// put the notification in front of the customer is not visible to it.
export function wasDeliveredByBank(bank: string, dispatchMs: number, rng: Rng): boolean {
  const p = isBankOutage(bank, dispatchMs)
    ? OUTAGE_DELIVERY_RATE
    : (BANKS[bank]?.notify_reliability ?? 0.99);
  return rng() < p;
}
