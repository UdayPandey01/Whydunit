import type { Db } from "./db.ts";

export type FireOutcome = { success: boolean; blockers: string[] };
export type FireResult = FireOutcome & { replayed: boolean };

/**
 * The simulated PSP boundary, and the only place an effect becomes real.
 *
 * The ledger is consulted before the effect and written after it, so a settled
 * key never causes a second call. One window remains and is inherent to talking
 * to another system: a crash between the call landing and the row committing
 * leaves the effect done but unrecorded, and the replay calls again with the same
 * key. The simulated PSP is pure so that is harmless; a real PSP must dedupe on
 * the key, which is why it is on the interface. See DESIGN.md §9.
 */
export async function fire(
  db: Db,
  key: string,
  mandateId: string,
  firedAt: string,
  effect: (idempotencyKey: string) => Promise<FireOutcome>,
): Promise<FireResult> {
  // Check the ledger FIRST. With a pure simulated world re-running the effect was
  // harmless, but a live PSP would take a second real charge, so the order matters
  // now: never call out for a key we have already settled.
  const seen = db
    .prepare("SELECT result, blockers FROM psp_ledger WHERE idempotency_key = ?")
    .get(key) as { result: string; blockers: string } | undefined;
  if (seen !== undefined) {
    return {
      success: seen.result === "recovered",
      blockers: JSON.parse(seen.blockers) as string[],
      replayed: true,
    };
  }

  const outcome = await effect(key);
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
