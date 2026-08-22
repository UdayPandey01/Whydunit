import { NOTIFY_MIN_LEAD_HOURS } from "../config.ts";
import { hash32, makeRng } from "../rng.ts";
import { HOUR_MS } from "../time.ts";
import { generateWorldFull } from "../world/generate.ts";
import { wasDeliveredByBank } from "../world/notification.ts";
import { attemptAt } from "../world/replay.ts";
import type { Notify } from "../world/replay.ts";
import type { Customer, Mandate, WorldRecord } from "../world/types.ts";
import { observe } from "../observe.ts";
import type { ObservedAttempt } from "../observe.ts";
import { FAILED, OK } from "./types.ts";
import type { PspClient, Result } from "./types.ts";

/**
 * The seeded world behind the PSP interface. Default implementation: needs no
 * credentials and no network, which is what makes the whole project runnable by
 * anyone who clones it.
 *
 * Notification state lives HERE rather than in the agent, because that is where
 * it lives in reality — the agent asks for a notice to be sent and never learns
 * whether the bank delivered it.
 */
export class SimulatedPsp implements PspClient {
  readonly name = "simulated";
  private readonly customers: Map<string, Customer>;
  private readonly mandates: Map<string, Mandate>;
  private readonly records: WorldRecord[];
  private readonly observations: ObservedAttempt[];
  private readonly notify = new Map<string, Notify>();
  private readonly pendingNotice = new Map<string, string>();
  private readonly cancelled = new Set<string>();

  constructor(opts: { seed?: number; mandates?: number; horizonDays?: number } = {}) {
    const world = generateWorldFull(opts);
    this.customers = world.customers;
    this.mandates = world.mandates;
    this.records = world.records;
    this.observations = observe(world.records);
    for (const rec of world.records) {
      this.notify.set(rec.mandate_id, {
        dispatchMs: Date.parse(rec.notification_dispatched_at),
        delivered: rec.world.notification_delivered_by_bank,
      });
    }
  }

  /** Exposed for the offline harness, which needs ground truth. Not on the interface. */
  world(): { records: WorldRecord[]; customers: Map<string, Customer>; mandates: Map<string, Mandate> } {
    return { records: this.records, customers: this.customers, mandates: this.mandates };
  }

  async fetchFailedDebits(since: Date): Promise<ObservedAttempt[]> {
    const from = since.getTime();
    return this.observations.filter((o) => !o.success && Date.parse(o.timestamp) >= from);
  }

  async scheduleDebit(mandateId: string, at: Date, idempotencyKey: string): Promise<Result> {
    const mandate = this.mandates.get(mandateId);
    if (mandate === undefined) return FAILED("mandate_not_found", `unknown mandate ${mandateId}`);
    if (this.cancelled.has(mandateId)) return FAILED("payment_cancelled", "mandate cancelled");

    const customer = this.customers.get(mandate.customer_id)!;
    // A notice requested since the last debit is resolved HERE, against the debit
    // it precedes. Dispatching it against wall-clock time would be meaningless in
    // a world that runs in simulated 2026 time.
    const pending = this.pendingNotice.get(mandateId);
    if (pending !== undefined) {
      const dispatchMs = at.getTime() - (NOTIFY_MIN_LEAD_HOURS + 2) * HOUR_MS;
      const bank = this.records.find((r) => r.mandate_id === mandateId)?.bank ?? "HDFC";
      this.notify.set(mandateId, {
        dispatchMs,
        delivered: wasDeliveredByBank(bank, dispatchMs, makeRng(hash32(pending))),
      });
      this.pendingNotice.delete(mandateId);
    }
    const notify = this.notify.get(mandateId) ?? { dispatchMs: at.getTime(), delivered: false };
    const outcome = attemptAt(customer, mandate, at.getTime(), notify);
    if (outcome.success) return OK(idempotencyKey);
    return FAILED(null, outcome.blockers.join("+"));
  }

  async sendPreDebitNotification(mandateId: string, idempotencyKey: string): Promise<Result> {
    if (!this.mandates.has(mandateId)) return FAILED("mandate_not_found", `unknown mandate ${mandateId}`);
    this.pendingNotice.set(mandateId, idempotencyKey);
    return OK(idempotencyKey);
  }

  async cancelMandate(mandateId: string, idempotencyKey: string): Promise<Result> {
    this.cancelled.add(mandateId);
    return OK(idempotencyKey);
  }

  /** Simulation-only: schedule relative to a world timestamp rather than wall clock. */
  setNotification(mandateId: string, dispatchMs: number, delivered: boolean): void {
    this.notify.set(mandateId, { dispatchMs, delivered });
  }
}
