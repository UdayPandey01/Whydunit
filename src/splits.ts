import type { FeatureRow } from './features.ts';
import { HORIZON_DAYS } from './config.ts';
import { hash32 } from './rng.ts';

export const HOLDOUT_BANKS = ['SBI', 'AXIS'];
export const MANDATE_TRAIN_FRACTION = 0.7;

export const TIME_SPLIT_DAY = Math.floor((HORIZON_DAYS * 2) / 3);

export type Split = 'train' | 'test';
export type SplitScheme = 'mandate' | 'bank' | 'time';
export type SplitAssignment = Record<SplitScheme, Split>;

export function assignSplits(row: FeatureRow): SplitAssignment {
  return {
    mandate:
      hash32(row.mandate_id) / 2 ** 32 < MANDATE_TRAIN_FRACTION
        ? 'train'
        : 'test',
    bank: HOLDOUT_BANKS.includes(row.bank) ? 'test' : 'train',
    time: row.day_index < TIME_SPLIT_DAY ? 'train' : 'test',
  };
}
