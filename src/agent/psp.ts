import type { Db } from './db.ts';

export type FireOutcome = { success: boolean; blockers: string[] };
export type FireResult = FireOutcome & { replayed: boolean };

export async function fire(
  db: Db,
  key: string,
  mandateId: string,
  firedAt: string,
  effect: (idempotencyKey: string) => Promise<FireOutcome>,
): Promise<FireResult> {
  const seen = db
    .prepare(
      'SELECT result, blockers FROM psp_ledger WHERE idempotency_key = ?',
    )
    .get(key) as { result: string; blockers: string } | undefined;
  if (seen !== undefined) {
    return {
      success: seen.result === 'recovered',
      blockers: JSON.parse(seen.blockers) as string[],
      replayed: true,
    };
  }

  const outcome = await effect(key);
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO psp_ledger(idempotency_key, mandate_id, fired_at, result, blockers) VALUES (?,?,?,?,?)',
    )
    .run(
      key,
      mandateId,
      firedAt,
      outcome.success ? 'recovered' : 'failed',
      JSON.stringify(outcome.blockers),
    );

  const row = db
    .prepare(
      'SELECT result, blockers FROM psp_ledger WHERE idempotency_key = ?',
    )
    .get(key) as { result: string; blockers: string } | undefined;
  if (row === undefined) throw new Error(`psp ledger lost key ${key}`);

  return {
    success: row.result === 'recovered',
    blockers: JSON.parse(row.blockers) as string[],
    replayed: info.changes === 0,
  };
}

export function ledgerCount(db: Db): number {
  return (
    db.prepare('SELECT COUNT(*) n FROM psp_ledger').get() as { n: number }
  ).n;
}
