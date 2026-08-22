import type { Cause } from "../world/types.ts";

/**
 * Razorpay/UPI error_reason -> what it tells us about an observable field.
 *
 * Verified against razorpay.com/docs/errors/payments/upi/ on 2026-08-22. Only
 * codes that appear in the published UPI error list are here; nothing is invented
 * to make the table look finished.
 *
 * `evidence_for` is the cause a code is EVIDENCE for, not a label. Attribution
 * still runs on the full observation, because Phase 1 established that no decline
 * code is a reliable proxy for a cause.
 */
export const CODE_MAP: Record<string, { evidence_for: Cause | null; note: string }> = {
  insufficient_funds: {
    evidence_for: "C3_BALANCE_SHORTFALL",
    note: "the one cause Razorpay test mode can actually produce on demand",
  },
  payment_cancelled: {
    evidence_for: "C4_CANCELLATION",
    note: "customer cancelled this transaction; weaker than a mandate revoke",
  },
  payment_declined: { evidence_for: null, note: "generic bank decline; ambiguous by design" },
  payment_timed_out: { evidence_for: null, note: "processing window exceeded; ambiguous" },
  payment_collect_request_expired: { evidence_for: null, note: "collect request expired; ambiguous" },
  invalid_vpa: { evidence_for: null, note: "not one of our four causes; routed to exceptions" },
};

/**
 * THE GAP LIST. Codes and signals our model needs that Razorpay does not expose.
 * Documented rather than faked — an honest gap is worth more than a full-looking
 * table with invented rows.
 */
export const UNMAPPED: { need: string; why: string; workaround: string }[] = [
  {
    need: "mandate revoked / cancelled at the PSP (our C4 signal)",
    why: "no decline code exists for it in the published UPI error list",
    workaround: "read the subscription.cancelled / subscription.halted webhook instead of a code",
  },
  {
    need: "pre-debit notification not delivered ≥24h before debit (our C2 signal)",
    why: "NPCI pre-debit notification is handled by the PSP; no code and no webhook exposes delivery",
    workaround:
      "use the merchant's own dispatch log for lead time; bank-side delivery stays unobservable, exactly as the simulator models it",
  },
  {
    need: "debit rejected for landing in the NPCI restricted window (our C1 signal)",
    why: "no code is published for it",
    workaround: "derive it from the attempt timestamp, which the adapter already holds — no code needed",
  },
  {
    need: "distinguishing bank-side decline from customer-side decline",
    why: "payment_declined covers both",
    workaround: "none; these land in the generic bucket and rely on invariance across attempts",
  },
];

export function evidenceFor(code: string | null): Cause | null {
  return code === null ? null : (CODE_MAP[code]?.evidence_for ?? null);
}
