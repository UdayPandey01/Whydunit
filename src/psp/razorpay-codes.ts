import type { Cause } from '../world/types.ts';

export const CODE_MAP: Record<
  string,
  { evidence_for: Cause | null; note: string }
> = {
  insufficient_funds: {
    evidence_for: 'C3_BALANCE_SHORTFALL',
    note: 'the one cause Razorpay test mode can actually produce on demand',
  },
  payment_cancelled: {
    evidence_for: 'C4_CANCELLATION',
    note: 'customer cancelled this transaction; weaker than a mandate revoke',
  },
  payment_declined: {
    evidence_for: null,
    note: 'generic bank decline; ambiguous by design',
  },
  payment_timed_out: {
    evidence_for: null,
    note: 'processing window exceeded; ambiguous',
  },
  payment_collect_request_expired: {
    evidence_for: null,
    note: 'collect request expired; ambiguous',
  },
  invalid_vpa: {
    evidence_for: null,
    note: 'not one of our four causes; routed to exceptions',
  },
};

export const UNMAPPED: { need: string; why: string; workaround: string }[] = [
  {
    need: 'mandate revoked / cancelled at the PSP (our C4 signal)',
    why: 'no decline code exists for it in the published UPI error list',
    workaround:
      'read the subscription.cancelled / subscription.halted webhook instead of a code',
  },
  {
    need: 'pre-debit notification not delivered ≥24h before debit (our C2 signal)',
    why: 'NPCI pre-debit notification is handled by the PSP; no code and no webhook exposes delivery',
    workaround:
      "use the merchant's own dispatch log for lead time; bank-side delivery stays unobservable, exactly as the simulator models it",
  },
  {
    need: 'debit rejected for landing in the NPCI restricted window (our C1 signal)',
    why: 'no code is published for it',
    workaround:
      'derive it from the attempt timestamp, which the adapter already holds — no code needed',
  },
  {
    need: 'distinguishing bank-side decline from customer-side decline',
    why: 'payment_declined covers both',
    workaround:
      'none; these land in the generic bucket and rely on invariance across attempts',
  },
];

export function evidenceFor(code: string | null): Cause | null {
  return code === null ? null : (CODE_MAP[code]?.evidence_for ?? null);
}
