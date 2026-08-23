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

export class SimulatedPsp implements PspClient {
  readonly name = "simulated";
  private readonly customers: Map<string, Customer>;
  private readonly mandates: Map<string, Mandate>;
  private readonly records: WorldRecord[];
  private readonly observations: ObservedAttempt[];

  private readonly notices = new Map<string, Notify[]>();
  private readonly pendingNotice = new Map<string, string>();
  private readonly cancelled = new Set<string>();

  constructor(opts: { seed?: number; mandates?: number; horizonDays?: number } = {}) {
    const world = generateWorldFull(opts);
    this.customers = world.customers;
    this.mandates = world.mandates;
    this.records = world.records;
    this.observations = observe(world.records);
    for (const rec of world.records) {
      const list = this.notices.get(rec.mandate_id) ?? [];
      list.push({
        dispatchMs: Date.parse(rec.notification_dispatched_at),
        delivered: rec.world.notification_delivered_by_bank,
      });
      this.notices.set(rec.mandate_id, list);
    }
    for (const list of this.notices.values()) list.sort((a, b) => a.dispatchMs - b.dispatchMs);
  }

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

    const pending = this.pendingNotice.get(mandateId);
    if (pending !== undefined) {
      const dispatchMs = at.getTime() - (NOTIFY_MIN_LEAD_HOURS + 2) * HOUR_MS;
      const bank = this.records.find((r) => r.mandate_id === mandateId)?.bank ?? "HDFC";
      const fresh = { dispatchMs, delivered: wasDeliveredByBank(bank, dispatchMs, makeRng(hash32(pending))) };
      const list = this.notices.get(mandateId) ?? [];
      list.push(fresh);
      list.sort((a, b) => a.dispatchMs - b.dispatchMs);
      this.notices.set(mandateId, list);
      this.pendingNotice.delete(mandateId);
    }
    const notify = this.noticeGoverning(mandateId, at.getTime());
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

  private noticeGoverning(mandateId: string, atMs: number): Notify {
    const list = this.notices.get(mandateId) ?? [];
    let best: Notify | null = null;
    for (const n of list) {
      if (n.dispatchMs <= atMs && (best === null || n.dispatchMs > best.dispatchMs)) best = n;
    }

    return best ?? { dispatchMs: atMs, delivered: false };
  }
}
