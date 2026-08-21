import type { Db } from "./db.ts";

export type FireOutcome = { success: boolean; blockers: string[] };
export type FireResult = FireOutcome & { replayed: boolean };

/**
 * The simulated PSP boundary, and the only place an effect becomes real.
 *
 * `adjudicate` is a pure replay against the world, so running it twice is
 * harmless; the effect is the ledger INSERT, which is atomic and keyed. A crash
 * before the insert leaves no effect and the work is safely redone; a crash after
 * it leaves the key present, and the replay returns the stored result instead of
 * firing again. That is exactly-once, and it does not depend on the agent's own
 * bookkeeping being intact.
 */
export function fire(
  db: Db,
  key: string,
  mandateId: string,
  firedAt: string,
  adjudicate: () => FireOutcome,
): FireResult {
  const outcome = adjudicate();
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO psp_ledger(idempotency_key, mandate_id, fired_at, result, blockers) VALUES (?,?,?,?,?)",
    )
    .run(key, mandateId, firedAt, outcome.success ? "recovered" : "failed", JSON.stringify(outcome.blockers));

  const row = db
    .prepare("SELECT result, blockers FROM psp_ledger WHERE idempotency_key = ?")
    .get(key) as { result: string; blockers: string } | undefined;
  if (row === undefined) throw new Error(`psp ledger lost key ${key}`);

  return {
    success: row.result === "recovered",
    blockers: JSON.parse(row.blockers) as string[],
    replayed: info.changes === 0,
  };
}

export function ledgerCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) n FROM psp_ledger").get() as { n: number }).n;
}
