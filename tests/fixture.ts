import { computeFeatures } from '../src/features.ts';
import { observe } from '../src/observe.ts';
import { hash32 } from '../src/rng.ts';
import type { AgentOptions, WorkItem } from '../src/agent/agent.ts';
import { SimulatedPsp } from '../src/psp/simulated.ts';
import type { Cause } from '../src/world/types.ts';

function ruleCause(f: Record<string, number | null>): Cause {
  if (f.revoked_before_attempt === 1) return 'C4_CANCELLATION';
  if (f.receipt_delivered === 0 || f.notify_lead_under_24 === 1)
    return 'C2_NOTIFICATION_FAIL';
  if (f.in_restricted_window === 1) return 'C1_EXECUTION_WINDOW';
  return 'C3_BALANCE_SHORTFALL';
}

function probaFor(cause: Cause): Record<Cause, number> {
  return {
    C1_EXECUTION_WINDOW: cause === 'C1_EXECUTION_WINDOW' ? 0.97 : 0.01,
    C2_NOTIFICATION_FAIL: cause === 'C2_NOTIFICATION_FAIL' ? 0.97 : 0.01,
    C3_BALANCE_SHORTFALL: cause === 'C3_BALANCE_SHORTFALL' ? 0.97 : 0.01,
    C4_CANCELLATION: cause === 'C4_CANCELLATION' ? 0.97 : 0.01,
  };
}

export function buildFixture(
  seed = 31,
  mandates = 200,
): Omit<AgentOptions, 'dbPath' | 'crashAfter'> {
  const psp = new SimulatedPsp({ seed, mandates });
  const { records } = psp.world();
  const observations = observe(records, seed + 1);
  const obsById = new Map(observations.map((o) => [o.attempt_id, o]));
  const featById = new Map(
    computeFeatures(observations).map((r) => [r.attempt_id, r.features]),
  );

  const work: WorkItem[] = records
    .filter((r) => !r.success)
    .map((r) => {
      const o = obsById.get(r.attempt_id)!;
      const revoke = o.lifecycle_events[0];
      return {
        source_attempt: r.attempt_id,
        mandate_id: r.mandate_id,
        bank: r.bank,
        failed_at: r.timestamp_ms,
        notification_dispatch_at: Date.parse(o.notification.dispatched_at),
        revoked_at: revoke === undefined ? null : Date.parse(revoke.timestamp),
        cause: ruleCause(featById.get(r.attempt_id)!),
        proba: probaFor(ruleCause(featById.get(r.attempt_id)!)),

        confidence: hash32(r.attempt_id) % 100 < 12 ? 0.45 : 0.9,
        routed_to_exception_queue: hash32(r.attempt_id) % 100 < 12,
      };
    });

  return { work, psp };
}
