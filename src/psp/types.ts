import type { ObservedAttempt } from "../observe.ts";

export type { ObservedAttempt as Observation };

export type DebitStatus = "succeeded" | "failed" | "pending";

export type Result = {
  ok: boolean;
  /**
   * `pending` is the honest real-world case: a live PSP accepts the instruction
   * and the outcome arrives later by webhook. The agent treats it as "cannot
   * continue this cycle now" and leaves the cycle open for a later resume.
   */
  status: DebitStatus;
  reference: string | null;
  error_code: string | null;
  reason: string | null;
};

/**
 * The ONLY surface the agent talks to. Everything about how debits are actually
 * presented — a simulated world or a live PSP — sits behind this.
 *
 * `idempotencyKey` is not decoration. The agent records its intent before it
 * calls, so a crash between the call and the record leaves the effect done but
 * unlogged; on resume it calls again with the same key. A simulated PSP is pure
 * so a replay is harmless, but a real one MUST dedupe on this key or that replay
 * becomes a double charge.
 */
export interface PspClient {
  readonly name: string;
  fetchFailedDebits(since: Date): Promise<ObservedAttempt[]>;
  scheduleDebit(mandateId: string, at: Date, idempotencyKey: string): Promise<Result>;
  sendPreDebitNotification(mandateId: string, idempotencyKey: string): Promise<Result>;
  cancelMandate(mandateId: string, idempotencyKey: string): Promise<Result>;
}

export const OK = (reference: string | null, status: DebitStatus = "succeeded"): Result => ({
  ok: status === "succeeded",
  status,
  reference,
  error_code: null,
  reason: null,
});

export const FAILED = (error_code: string | null, reason: string): Result => ({
  ok: false,
  status: "failed",
  reference: null,
  error_code,
  reason,
});
