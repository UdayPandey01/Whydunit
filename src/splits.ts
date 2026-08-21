import type { FeatureRow } from "./features.ts";
import { HORIZON_DAYS } from "./config.ts";
import { hash32 } from "./rng.ts";

// Banks held out entirely from training. Both carry injected outages, so C2 is
// still testable in the holdout, and the remaining three carry outages too, so it
// is still learnable in training.
export const HOLDOUT_BANKS = ["SBI", "AXIS"];
export const MANDATE_TRAIN_FRACTION = 0.7;
// Two thirds of the horizon, not a fixed day. A hard day-60 boundary meant the
// train/test proportion swung from 67/33 at a 90-day horizon to 17/83 at 360,
// so time-split numbers were not comparable across the horizon sweep. At 90 days
// this still evaluates to 60, so the original behaviour is preserved there.
export const TIME_SPLIT_DAY = Math.floor((HORIZON_DAYS * 2) / 3);

export type Split = "train" | "test";
export type SplitScheme = "mandate" | "bank" | "time";
export type SplitAssignment = Record<SplitScheme, Split>;

/**
 * Three independent views of the same rows, each answering a different question:
 *  - mandate: can it generalise to an unseen customer?          (mandatory)
 *  - bank:    are the bank features relative, or memorised?
 *  - time:    does it still work on a period it was not fit on?
 */
export function assignSplits(row: FeatureRow): SplitAssignment {
  return {
    mandate: hash32(row.mandate_id) / 2 ** 32 < MANDATE_TRAIN_FRACTION ? "train" : "test",
    bank: HOLDOUT_BANKS.includes(row.bank) ? "test" : "train",
    time: row.day_index < TIME_SPLIT_DAY ? "train" : "test",
  };
}
