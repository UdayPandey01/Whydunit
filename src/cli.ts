import { mkdirSync, writeFileSync } from "node:fs";
import { HORIZON_DAYS, SEED } from "./config.ts";
import { observe } from "./observe.ts";
import { generateWorld } from "./world/generate.ts";
import type { WorldRecord } from "./world/types.ts";

const P = "[generate]";

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function pct(n: number, d: number): string {
  return d === 0 ? "0.0%" : `${((100 * n) / d).toFixed(1)}%`;
}

function summarise(world: WorldRecord[], observations: ReturnType<typeof observe>): void {
  const fails = world.filter((w) => !w.success);
  const mandates = new Set(world.map((w) => w.mandate_id)).size;

  console.log(`${P} mandates ${mandates}  attempts ${world.length}  horizon ${HORIZON_DAYS}d  seed ${SEED}`);
  console.log(`${P} failures ${fails.length} (${pct(fails.length, world.length)} of attempts)`);

  const byCause = new Map<string, number>();
  for (const f of fails) byCause.set(f.cause!, (byCause.get(f.cause!) ?? 0) + 1);
  console.log(`${P} class distribution (deliberately imbalanced):`);
  for (const [cause, n] of [...byCause].sort((a, b) => b[1] - a[1])) {
    console.log(`${P}   ${cause.padEnd(22)} ${String(n).padStart(5)}  ${pct(n, fails.length).padStart(6)} of failures  ${pct(n, world.length).padStart(6)} of attempts`);
  }

  const multi = fails.filter((f) => f.multi_cause);
  console.log(`${P} multi-cause ${multi.length} (${pct(multi.length, fails.length)} of failures)`);

  // Sanity check on the one place cause information reaches an observable: if any
  // decline code were ~100% pure the classifier would be a lookup table.
  const byCode = new Map<string, Map<string, number>>();
  for (const f of fails) {
    const m = byCode.get(f.error_code!) ?? new Map<string, number>();
    m.set(f.cause!, (m.get(f.cause!) ?? 0) + 1);
    byCode.set(f.error_code!, m);
  }
  console.log(`${P} decline-code ambiguity (max P(cause | code)):`);
  for (const [code, m] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [topCause, topN] = [...m].sort((a, b) => b[1] - a[1])[0]!;
    console.log(`${P}   ${code.padEnd(5)} n=${String(total).padStart(4)}  ${pct(topN, total).padStart(6)} ${topCause}`);
  }

  const withReceipt = observations.filter((o) => o.notification.receipt !== null).length;
  const withRevoke = observations.filter((o) => o.lifecycle_events.length > 0).length;
  const silentChurn = world.filter((w) => w.world.churned_at !== null && !w.world.churn_emits_event).length;
  console.log(`${P} observability: delivery receipt on ${pct(withReceipt, observations.length)} of attempts`);
  console.log(`${P} observability: mandate.revoked visible on ${withRevoke} attempts; ${silentChurn} attempts sit under SILENT churn`);
}

function main(): void {
  const command = process.argv[2];
  if (command !== "generate") {
    console.error("usage: node src/cli.ts generate");
    process.exit(1);
  }

  const world = generateWorld();
  if (world.length === 0) throw new Error("generator produced no attempts");
  const observations = observe(world);

  mkdirSync("data", { recursive: true });
  writeJsonl("data/world.jsonl", world);
  writeJsonl("data/observations.jsonl", observations);

  console.log(`${P} wrote data/world.jsonl (${world.length} records, ground truth included)`);
  console.log(`${P} wrote data/observations.jsonl (${observations.length} records, merchant-visible only)`);
  summarise(world, observations);
}

main();
