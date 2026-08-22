# WhyDunit

**Works out why each failed UPI AutoPay debit actually failed, then executes a bounded recovery action matched to that cause.**

> ### A third of what merchants write off as churn was never the customer.
>
> It was a debit presented inside a window NPCI blocks. A pre-debit notice that
> never landed. A salary that arrived three days late. Retrying those on a timer
> recovers a third of the money and burns the rest on customers who already left.

[![verify](https://github.com/udaypandey/whydunit/actions/workflows/verify.yml/badge.svg)](../../actions/workflows/verify.yml)
&nbsp;·&nbsp; **[Live results dashboard →](https://claude.ai/code/artifact/28ac0396-cf18-4502-b19c-cc449b8230e0)**
&nbsp;·&nbsp; 90-second walkthrough: _link pending_

The badge is the claim: every number below is regenerated from a seed in CI and
diffed against a committed manifest. It goes red if any of them moves.

---

## Results

One seeded run. 1,983 mandates, 16,661 attempts, 3,116 failures, ₹20,87,484 at risk,
270-day horizon. Rupees recovered as a share of rupees at risk; deltas are paired
bootstrap against WhyDunit, 1,000 resamples clustered by mandate. Every policy gets
the same budget of three retries.

| Policy | Recovered | Retries / failure | Δ vs WhyDunit (95% CI) | |
|---|---:|---:|---:|---|
| Do nothing | 0.0% | 0.00 | −63.1pp | loses |
| Naive retry `T+24/72/168h` | 33.3% | 2.67 | −29.8pp `[24.8, 35.5]` | loses |
| Window-aware retry | 49.9% | 2.31 | −13.1pp `[8.8, 18.6]` | loses |
| Expert rule (4 if-statements) | 62.9% | 1.95 | −0.1pp `[−0.6, 0.8]` | **ties** |
| **WhyDunit** | **63.1%** | **1.79** | — | — |
| Oracle (knows the true cause) | 64.8% | 1.43 | +1.7pp `[0.9, 2.7]` | ceiling |

Attribution: **88.4% auto-classified at macro-F1 0.881** `[0.857, 0.901]`, 11.6%
routed to human review with competing hypotheses attached.

**The tie is the honest headline.** WhyDunit matches a hand-written four-line rule
on rupees while spending 8% fewer retries (−0.15 per failure, CI `[−0.19, −0.12]`).
It beats that rule decisively on *attribution* — +0.181 macro-F1 out-of-fold — but
on recovered revenue the difference straddles zero, so **the rule remains the
production retry policy**. The model earns its place in the exception queue and the
merchant report, not yet in the retry decision.

### The class a timer can never fix

NPCI blocks AutoPay execution between 10:00 and 13:00 IST. T+24h, T+72h and T+168h
all preserve the hour of day, so a fixed-interval retry lands right back inside the
window — every time.

| C1 · execution window | Naive fixed-interval retry | WhyDunit |
|---|---:|---:|
| Recovered | **0.0%** | **88.6%** |

605 failures here, 19.4% of all failures. Holds across horizons: 91.1% at 90 days,
88.6% at 270, 90.7% at 360. Roughly half of WhyDunit's total lead over naive retry
comes from knowing this one published rule — no classifier required.

---

## How it decides

Four causes. Each moves with something different and is invariant to the rest.

| Class | Varies with | Invariant to | Share | Naive | WhyDunit |
|---|---|---|---:|---:|---:|
| **C1** execution window | hour of day | customer, bank, amount | 19.4% | 0.0% | 88.6% |
| **C2** notification failure | bank, burst window | customer, amount, hour | 10.7% | 42.0% | 83.8% |
| **C3** balance shortfall | customer, day-of-month | bank, hour | 45.5% | 52.0% | 67.7% |
| **C4** cancellation | nothing | everything | 12.8% | 0.0% | 0.0% |

C4 is identified by failure **invariance** — nothing fixes it — so it is always the
last conclusion, never the default. It recovers nothing by design: the point is to
*stop* rather than spend. Stopping requires `P(C4) ≥ 0.952`, derived from a cost
matrix where a wrongful stop forfeits an entire mandate and a wrongful retry costs
one retry. The full threshold sweep prints on every policy run, so the operating
point is visibly chosen rather than tuned.

---

## Quickstart

Cold clone to full pipeline in under five minutes, either way.

```bash
git clone <repo> whydunit && cd whydunit
docker compose up            # ~50s build, ~20s run. Nothing else needed.
```

Or without Docker (needs Node 24+ and Python 3.11):

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm run all                  # generate → features → train → eval → report → policy → agent → digest
npm run demo                 # the dashboard
npm run verify               # regenerates from seed, exits non-zero if any number moved
```

Both were tested on a fresh clone into `/tmp`, not assumed.

---

## Look at one payment end to end

```bash
npm run explain mdt_00004
```

Walks a single mandate: what was observable, what was **not**, the invariance test
across hour / bank / day-of-month / recent run, competing hypotheses with calibrated
probabilities, the attribution, the action, every constraint check, the outcome —
and ground truth **last**, marked evaluation-only.

| Command | Case |
|---|---|
| `npm run explain mdt_00004` | **C1, the hero case.** Debited at 11:00, inside the restricted window. Naive retry recovers 0% of these. |
| `npm run explain mdt_00012` | **C2.** Notice sent 18.3h before the debit, under the 24h NPCI minimum. Caught from dispatch evidence alone. |
| `npm run explain mdt_00060` | **C4 silent churn, the hard case.** No revoke webhook. Found only by invariance: 3 consecutive failures across 6 different hours, on a bank behaving normally, notice confirmed delivered. Its bank signal is a genuine false lead the model must see past. |

Stable for `seed 20260903` at `HORIZON_DAYS=270`; `verify` fails if that drifts.

---

## Architecture

```
                    ┌── the boundary ───────────────────────────────┐
  world processes   │                                               │
  ┌──────────────┐  │  observations          features               │
  │ window   C1  │  │  merchant-visible      6 invariance families   │
  │ notify   C2  ├──┼─► only                 strictly point-in-time  │
  │ balance  C3  │  │       │                      │                 │
  │ churn    C4  │  │       ▼                      ▼                 │
  └──────────────┘  │  exception router ◄──── classifier + rule      │
   ground truth ────┘       │                      │                 │
   never read downstream    ▼                      ▼                 │
                       human review        cost-sensitive stop       │
                                                   │                 │
                                    ┌──────────────▼──────────────┐  │
                                    │ agent: 4 hard constraints,  │  │
                                    │ audit log, crash-resume     │  │
                                    └──────────────┬──────────────┘  │
                                                   ▼                 │
                                       PspClient ──┴── SimulatedPsp  │
                                                   └── RazorpayPsp ──┘
```

One rule governs everything: **generate world state, derive observations from it,
hide the world, classify from observations only.** The generator never takes a label
as input — labels are emergent, whichever process blocked the debit first. A test
walks the serialized observation records and asserts their key set exactly matches
the declared merchant-visible allowlist, with a positive control proving the same
walker *does* find ground truth in the world file. Downstream, four hard constraints
are load-bearing in the type system: `checkConstraints` is the only function that can
mint a `CheckedPlan`, and the executor accepts nothing else, so no code path reaches
a PSP unchecked.

---

## Honest limitations

Read this before believing anything above.

- **The evaluation corpus is simulated.** A labelled corpus of UPI AutoPay failures
  with known ground truth does not exist outside a PSP. The simulator generates world
  state; labels are emergent, not assigned. This is the single biggest caveat and it
  is not going away with more engineering.
- **The Razorpay adapter is real but unproven.** It is written against test mode with
  auth, retry, webhook signature verification and event mapping unit-tested — and it
  has **never run against live credentials**. Only one of the four causes (balance
  shortfall) is inducible in Razorpay test mode at all; test mode has no time
  advancement, no control over which decline reason comes back, and no
  merchant-triggerable pre-debit notification. The full gap table is in `DESIGN.md`.
- **Notification failure is inferred, not observed.** C2 comes from the merchant's own
  dispatch log plus bank-level burst statistics. Whether the bank actually delivered
  the notice is never observable — by construction, because it is not observable in
  reality either.
- **Five banks.** Bank-relative features generalise to the two held out of training,
  but five is a small population to claim that from.
- **Silent-churn recall is horizon-dependent: 0.556 here, 0.718 at 360 days, and
  0.000 at 90 days.** Invariance needs repeated attempts before it can be seen at all.
  At a 90-day horizon a mandate gets at most three attempts and the signature has no
  room to appear — which is also why the model ties the expert rule there and only
  pulls ahead from 180 days on.
- **Calibration is adequate, not tight.** ECE 0.093 on the mandate split — good enough
  to threshold on directly, so no isotonic calibrator was fitted.
- **The time split is proportional (2/3), not a fixed date.** An earlier fixed day-60
  boundary trained on 745 rows at a 360-day horizon and made cross-horizon numbers
  incomparable; that is fixed, and the 360-day split now trains on 2,790 rows.

---

## Integrate it

```ts
import { Whydunit, RazorpayPsp } from "whydunit";

const w = new Whydunit({
  psp: new RazorpayPsp({ keyId, keySecret }),
  costRatio: 40,              // a wrongful stop costs 40× a wrongful retry
  maxInterventions: 3,
});

const attributions = await w.attribute(observations);     // no side effects
const plan         = await w.plan(attributions);          // still no side effects
const result       = await w.execute(plan, observations); // respects every constraint
```

Three methods, each usable standalone — attribution-only never forces you through
execution. `examples/ten-lines.ts` is this, runnable against the simulator with no
credentials. The agent talks to one `PspClient` interface and cannot tell which
implementation it holds: `tests/seam.test.ts` runs the same cycle against the
simulator and against a scripted PSP sharing no code with it, asserting the audit
trails match row for row.

---

## Further reading

- **[DESIGN.md](DESIGN.md)** — the live map: module by module, every key decision and
  its reason, the Razorpay test-mode gap table, and what is deliberately not built.
- **[INCIDENTS.md](INCIDENTS.md)** — thirteen real failures, written when they
  happened: symptom → first hypothesis → the diagnostic that disproved it → root
  cause → fix and what it traded. Including an abstention rule that made the exception
  queue worse than no queue, a digest that silently reported the previous cycle's
  numbers, and a regression that halved recovery and was caught only by the first
  clean-clone Docker run.

MIT licensed. 67 tests — `npm test`.
