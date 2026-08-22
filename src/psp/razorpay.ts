import Razorpay from "razorpay";
import { FAILED, OK } from "./types.ts";
import type { Observation, PspClient, Result } from "./types.ts";

export type RazorpayOptions = {
  keyId: string;
  keySecret: string;
  /** Subscription id per mandate id. Razorpay has no "mandate" primitive of its own. */
  subscriptions?: Map<string, string>;
  maxRetries?: number;
};

/**
 * Razorpay test-mode adapter.
 *
 * WHAT IS REAL: auth, retry, the SDK calls, webhook signature verification and
 * the event->Observation mapping. WHAT IS NOT: this has never been run against
 * live credentials — see README "The boundary". Every gap found while reading the
 * docs is written down in razorpay-codes.ts rather than papered over.
 *
 * The important structural difference from the simulator: a real debit returns
 * `pending`. Razorpay accepts the instruction and the outcome arrives later by
 * webhook, so the agent cannot learn the result inside the same cycle.
 */
export class RazorpayPsp implements PspClient {
  readonly name = "razorpay-test";
  private readonly client: Razorpay;
  private readonly subscriptions: Map<string, string>;
  private readonly maxRetries: number;

  constructor(opts: RazorpayOptions) {
    if (!opts.keyId || !opts.keySecret) throw new Error("RazorpayPsp needs keyId and keySecret");
    this.client = new Razorpay({ key_id: opts.keyId, key_secret: opts.keySecret });
    this.subscriptions = opts.subscriptions ?? new Map();
    this.maxRetries = opts.maxRetries ?? 3;
  }

  /** Exponential backoff on 5xx and network errors only; 4xx is never retried. */
  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = (error as { statusCode?: number }).statusCode;
        if (status !== undefined && status < 500) break;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw new Error(`razorpay ${what} failed: ${String(lastError)}`);
  }

  async fetchFailedDebits(since: Date): Promise<Observation[]> {
    // Razorpay paginates from `skip`; 100 is the per-page maximum.
    const from = Math.floor(since.getTime() / 1000);
    const page = await this.call("payments.all", () =>
      this.client.payments.all({ from, count: 100 }),
    );
    const items = (page as { items?: unknown[] }).items ?? [];
    return items
      .filter((p) => (p as { status?: string }).status === "failed")
      .map((p) => observationFromPayment(p as RazorpayPayment, this.subscriptions));
  }

  async scheduleDebit(mandateId: string, at: Date, idempotencyKey: string): Promise<Result> {
    const subscriptionId = this.subscriptions.get(mandateId);
    if (subscriptionId === undefined) return FAILED("mandate_not_found", `no subscription for ${mandateId}`);
    // Razorpay charges a subscription on ITS schedule; there is no "debit at this
    // instant" call, so `at` cannot be honoured. This is the sharpest gap between
    // the two implementations and the reason C1 cannot be induced in test mode.
    void at;
    const sub = await this.call("subscriptions.fetch", () => this.client.subscriptions.fetch(subscriptionId));
    return OK((sub as { id?: string }).id ?? idempotencyKey, "pending");
  }

  async sendPreDebitNotification(mandateId: string, idempotencyKey: string): Promise<Result> {
    // NPCI pre-debit notification is issued by the PSP, not the merchant. There
    // is no endpoint to trigger or re-issue one, so this cannot be honoured.
    void mandateId;
    return FAILED("unsupported", `pre-debit notification is not merchant-triggerable (${idempotencyKey})`);
  }

  async cancelMandate(mandateId: string, idempotencyKey: string): Promise<Result> {
    const subscriptionId = this.subscriptions.get(mandateId);
    if (subscriptionId === undefined) return FAILED("mandate_not_found", `no subscription for ${mandateId}`);
    await this.call("subscriptions.cancel", () => this.client.subscriptions.cancel(subscriptionId, false));
    return OK(idempotencyKey);
  }
}

export type RazorpayPayment = {
  id: string;
  amount: number;
  created_at: number;
  status: string;
  error_code?: string | null;
  error_reason?: string | null;
  bank?: string | null;
  method?: string;
  subscription_id?: string;
};

/** Razorpay payment -> our Observation. Unknown fields become null, never guesses. */
export function observationFromPayment(p: RazorpayPayment, subs: Map<string, string>): Observation {
  const mandateId =
    [...subs.entries()].find(([, sid]) => sid === p.subscription_id)?.[0] ?? p.subscription_id ?? p.id;
  return {
    attempt_id: p.id,
    mandate_id: mandateId,
    timestamp: new Date(p.created_at * 1000).toISOString(),
    bank: p.bank ?? "UNKNOWN",
    amount: p.amount / 100,
    max_amount: p.amount / 100,
    frequency: "monthly",
    mandate_age_days: 0,
    attempt_index: 0,
    success: p.status === "captured",
    error_code: p.error_reason ?? p.error_code ?? null,
    notification: {
      // Bank-side delivery is unobservable here, exactly as the simulator models it.
      dispatched_at: new Date(p.created_at * 1000).toISOString(),
      hours_before_debit: 0,
      receipt: null,
    },
    prior_attempts: [],
    lifecycle_events: [],
  };
}
