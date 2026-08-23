import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MAX_INTERVENTIONS_PER_CYCLE } from "../src/agent/constraints.ts";

const CHILD = new URL("./crash-child.ts", import.meta.url).pathname;
const CRASH_POINTS = 30;

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "whydunit-crash-")), "agent.db");
}

function run(dbPath: string, crashAfter: number) {
  return spawnSync(process.execPath, [CHILD, dbPath, String(crashAfter)], { encoding: "utf8" });
}

type Ledger = { idempotency_key: string; mandate_id: string; result: string }[];

function readDb(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  const ledger = db
    .prepare("SELECT idempotency_key, mandate_id, result FROM psp_ledger ORDER BY idempotency_key")
    .all() as Ledger;
  const audit = db
    .prepare("SELECT idempotency_key, action, status, outcome FROM audit_log ORDER BY idempotency_key")
    .all() as { idempotency_key: string; action: string; status: string; outcome: string | null }[];
  const perCycle = db
    .prepare("SELECT mandate_id, cycle, interventions_used FROM cycle_state")
    .all() as { mandate_id: string; cycle: string; interventions_used: number }[];
  db.close();
  return { ledger, audit, perCycle };
}

const cleanPath = tmpDb();
const cleanRun = run(cleanPath, 0);
const clean = readDb(cleanPath);

test("the uninterrupted baseline is non-trivial", () => {
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  assert.ok(clean.ledger.length > 60, `only ${clean.ledger.length} PSP effects -- fixture too small to prove anything`);
  assert.ok(clean.audit.length > clean.ledger.length, "expected non-effectful decisions too");
});

test("kill -9 at any point never double-fires, and resume reaches the same state", () => {
  let actuallyKilled = 0;

  for (let k = 1; k <= CRASH_POINTS; k++) {
    const dbPath = tmpDb();
    const crashed = run(dbPath, k);

    if (crashed.signal === "SIGKILL") actuallyKilled++;

    const resumed = run(dbPath, 0);
    assert.equal(resumed.status, 0, `resume failed at crash point ${k}: ${resumed.stderr}`);

    const after = readDb(dbPath);

    assert.deepEqual(after.ledger, clean.ledger, `ledger diverged after crash at point ${k}`);
    assert.equal(
      new Set(after.ledger.map((r) => r.idempotency_key)).size,
      after.ledger.length,
      `duplicate idempotency key after crash at point ${k}`,
    );

    const pending = after.audit.filter((a) => a.status !== "completed");
    assert.equal(pending.length, 0, `${pending.length} rows still pending after crash at point ${k}`);

    for (const c of after.perCycle) {
      assert.ok(
        c.interventions_used <= MAX_INTERVENTIONS_PER_CYCLE,
        `${c.mandate_id} used ${c.interventions_used} in ${c.cycle} after crash at point ${k}`,
      );
    }

    assert.deepEqual(after.audit, clean.audit, `audit diverged after crash at point ${k}`);

    rmSync(dbPath, { recursive: true, force: true });
  }

  assert.ok(
    actuallyKilled >= CRASH_POINTS - 2,
    `only ${actuallyKilled}/${CRASH_POINTS} children were actually SIGKILLed -- the test is not exercising crashes`,
  );
});

test("a crash mid-run really does leave work unfinished", () => {

  const dbPath = tmpDb();
  const crashed = run(dbPath, 5);
  assert.equal(crashed.signal, "SIGKILL");
  const mid = readDb(dbPath);
  assert.ok(mid.ledger.length < clean.ledger.length, "child completed everything before being killed");
  assert.ok(
    mid.audit.some((a) => a.status === "pending"),
    "expected at least one intent recorded but not completed",
  );
  rmSync(dbPath, { recursive: true, force: true });
});
