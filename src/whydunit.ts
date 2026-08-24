import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from './agent/agent.ts';
import type { AgentSummary, WorkItem } from './agent/agent.ts';
import { MAX_INTERVENTIONS_PER_CYCLE } from './agent/constraints.ts';
import { DEFAULT_COST_RATIO } from './config.ts';
import { decideCause, stopThreshold } from './decision.ts';
import { computeFeatures } from './features.ts';
import type { Observation, PspClient } from './psp/types.ts';
import type { Cause } from './world/types.ts';

export type Probabilities = Record<Cause, number>;

export type Scorer = (features: Record<string, number | null>) => Probabilities;

export const ruleScorer: Scorer = (f) => {
  const pick: Cause =
    f.revoked_before_attempt === 1
      ? 'C4_CANCELLATION'
      : f.receipt_delivered === 0 || f.notify_lead_under_24 === 1
        ? 'C2_NOTIFICATION_FAIL'
        : f.in_restricted_window === 1
          ? 'C1_EXECUTION_WINDOW'
          : 'C3_BALANCE_SHORTFALL';
  const out = {
    C1_EXECUTION_WINDOW: 0.0333,
    C2_NOTIFICATION_FAIL: 0.0333,
    C3_BALANCE_SHORTFALL: 0.0333,
    C4_CANCELLATION: 0.0333,
  } as Probabilities;
  out[pick] = 0.9;
  return out;
};

export type Attribution = {
  attempt_id: string;
  mandate_id: string;
  cause: Cause;
  confidence: number;
  probabilities: Probabilities;
  evidence: Record<string, number | null>;
};

export type PlannedAction = {
  attempt_id: string;
  mandate_id: string;
  cause: Cause;
  action: 'reschedule' | 'refire_notification_then_reschedule' | 'stop';
  stop: boolean;
};

export type WhydunitOptions = {
  psp: PspClient;

  costRatio?: number;
  maxInterventions?: number;
  scorer?: Scorer;
  dbPath?: string;
};

export class Whydunit {
  readonly psp: PspClient;
  private readonly scorer: Scorer;
  private readonly threshold: number;
  private readonly dbPath: string;
  readonly costRatio: number;
  readonly maxInterventions: number;

  constructor(opts: WhydunitOptions) {
    this.psp = opts.psp;
    this.scorer = opts.scorer ?? ruleScorer;
    this.costRatio = opts.costRatio ?? DEFAULT_COST_RATIO;
    this.threshold = stopThreshold(this.costRatio);
    this.maxInterventions =
      opts.maxInterventions ?? MAX_INTERVENTIONS_PER_CYCLE;
    this.dbPath =
      opts.dbPath ?? join(mkdtempSync(join(tmpdir(), 'whydunit-')), 'agent.db');
  }

  async attribute(observations: Observation[]): Promise<Attribution[]> {
    const failed = observations.filter((o) => !o.success);
    return computeFeatures(failed).map((row) => {
      const probabilities = this.scorer(row.features);
      const [cause, confidence] = (
        Object.entries(probabilities) as [Cause, number][]
      ).sort((a, b) => b[1] - a[1])[0]!;
      return {
        attempt_id: row.attempt_id,
        mandate_id: row.mandate_id,
        cause,
        confidence,
        probabilities,
        evidence: row.features,
      };
    });
  }

  async plan(attributions: Attribution[]): Promise<PlannedAction[]> {
    return attributions.map((a) => {
      const d = decideCause(a.probabilities, this.threshold);
      return {
        attempt_id: a.attempt_id,
        mandate_id: a.mandate_id,
        cause: d.cause,
        action: d.stop
          ? 'stop'
          : d.cause === 'C2_NOTIFICATION_FAIL'
            ? 'refire_notification_then_reschedule'
            : 'reschedule',
        stop: d.stop,
      };
    });
  }

  async execute(
    plan: PlannedAction[],
    observations: Observation[],
  ): Promise<AgentSummary> {
    const byId = new Map(observations.map((o) => [o.attempt_id, o]));
    const work: WorkItem[] = plan.map((p) => {
      const o = byId.get(p.attempt_id);
      if (o === undefined)
        throw new Error(`execute: no observation for ${p.attempt_id}`);
      const revoke = o.lifecycle_events[0];
      const proba = {
        C1_EXECUTION_WINDOW: 0,
        C2_NOTIFICATION_FAIL: 0,
        C3_BALANCE_SHORTFALL: 0,
        C4_CANCELLATION: 0,
      } as Probabilities;
      proba[p.cause] = p.stop ? 1 : 0.9;
      return {
        source_attempt: o.attempt_id,
        mandate_id: o.mandate_id,
        bank: o.bank,
        failed_at: Date.parse(o.timestamp),
        notification_dispatch_at: Date.parse(o.notification.dispatched_at),
        revoked_at: revoke === undefined ? null : Date.parse(revoke.timestamp),
        cause: p.cause,
        confidence: p.stop ? 1 : 0.9,
        proba,
        routed_to_exception_queue: false,
      };
    });
    return runAgent({
      dbPath: this.dbPath,
      work,
      psp: this.psp,
      stopThreshold: this.threshold,
    });
  }
}
