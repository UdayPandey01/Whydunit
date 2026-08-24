import type { ObservedAttempt } from '../observe.ts';

export type { ObservedAttempt as Observation };

export type DebitStatus = 'succeeded' | 'failed' | 'pending';

export type Result = {
  ok: boolean;

  status: DebitStatus;
  reference: string | null;
  error_code: string | null;
  reason: string | null;
};

export interface PspClient {
  readonly name: string;
  fetchFailedDebits(since: Date): Promise<ObservedAttempt[]>;
  scheduleDebit(
    mandateId: string,
    at: Date,
    idempotencyKey: string,
  ): Promise<Result>;
  sendPreDebitNotification(
    mandateId: string,
    idempotencyKey: string,
  ): Promise<Result>;
  cancelMandate(mandateId: string, idempotencyKey: string): Promise<Result>;
}

export const OK = (
  reference: string | null,
  status: DebitStatus = 'succeeded',
): Result => ({
  ok: status === 'succeeded',
  status,
  reference,
  error_code: null,
  reason: null,
});

export const FAILED = (error_code: string | null, reason: string): Result => ({
  ok: false,
  status: 'failed',
  reference: null,
  error_code,
  reason,
});
