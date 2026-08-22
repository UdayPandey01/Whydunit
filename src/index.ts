/** Public surface. Everything else is an implementation detail. */
export { Whydunit, ruleScorer } from "./whydunit.ts";
export type {
  Attribution, PlannedAction, Probabilities, Scorer, WhydunitOptions,
} from "./whydunit.ts";

export { SimulatedPsp } from "./psp/simulated.ts";
export { RazorpayPsp } from "./psp/razorpay.ts";
export { createWebhookReceiver, mapEvent, verifySignature } from "./psp/webhook.ts";
export type { WebhookEvent } from "./psp/webhook.ts";
export { CODE_MAP, UNMAPPED, evidenceFor } from "./psp/razorpay-codes.ts";

export type { Observation, PspClient, Result, DebitStatus } from "./psp/types.ts";
export type { Cause } from "./world/types.ts";
export type { AgentSummary } from "./agent/agent.ts";
export { stopThreshold, decideCause } from "./decision.ts";
