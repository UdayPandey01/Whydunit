import { NOTIFY_MIN_LEAD_HOURS } from '../config.ts';
import { isRestrictedTime } from '../schedule.ts';
import { HOUR_MS } from '../time.ts';
import { balanceAt } from './balance.ts';
import type { Cause, Customer, Mandate } from './types.ts';

export type Notify = { dispatchMs: number; delivered: boolean };

export function attemptAt(
  customer: Customer,
  mandate: Mandate,
  at: number,
  notify: Notify,
): { success: boolean; blockers: Cause[] } {
  const blockers: Cause[] = [];
  if (mandate.churned_at !== null && at >= mandate.churned_at)
    blockers.push('C4_CANCELLATION');
  const leadHours = (at - notify.dispatchMs) / HOUR_MS;
  if (leadHours < NOTIFY_MIN_LEAD_HOURS || !notify.delivered)
    blockers.push('C2_NOTIFICATION_FAIL');
  if (isRestrictedTime(at)) blockers.push('C1_EXECUTION_WINDOW');
  if (mandate.amount > balanceAt(customer, at).balance)
    blockers.push('C3_BALANCE_SHORTFALL');
  return { success: blockers.length === 0, blockers };
}
