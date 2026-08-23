<div align="center">

# WhyDunit

**Diagnoses *why* each failed UPI AutoPay debit actually failed, then executes a bounded recovery action matched to that cause.**

Razorpay AI Buildathon · Track 03 — AI Revenue Recovery

[Quickstart](#quickstart) · [Results](#results) · [How it works](#how-it-works) · [Integration](#integration) · [Limitations](#honest-limitations) · [Reproducibility](#reproducibility)

</div>

---

> ### A third of what merchants write off as churn was never the customer.
>
> It was a debit presented inside a window NPCI blocks. A pre-debit notice that never
> landed. A salary that arrived three days late. Retrying those on a timer recovers a
> third of the money and burns the rest on people who already left.

Most recovery systems retry on a schedule. A schedule cannot tell the difference
between a customer who *can't* pay today and one who has *stopped* paying — so it
spends the same three retries on both. WhyDunit works out which, acts accordingly,
and stops when there is nothing left to recover.

---

## Results

One seeded run. 1,983 mandates · 16,661 debit attempts · **3,116 failures worth ₹20,87,484**.
Every policy gets the same budget of three retries over the same failures. Deltas are
paired bootstrap, 1,000 resamples clustered by mandate.

| Policy | Recovered | Retries / failure | Δ vs WhyDunit (95% CI) | |
|:---|---:|---:|---:|:---|
| Do nothing | 0.0% | 0.00 | −63.1pp | loses |
| Naive retry `T+24/72/168h` | 33.3% | 2.67 | −29.8pp `[24.8, 35.5]` | loses |
| Window-aware retry | 49.9% | 2.31 | −13.1pp `[8.8, 18.6]` | loses |
| Expert rule (4 if-statements) | 62.9% | 1.95 | −0.1pp `[−0.6, 0.8]` | **ties** |
| **WhyDunit** | **63.1%** | **1.79** | — | — |
| Oracle *(knows the true cause)* | 64.8% | 1.43 | +1.7pp `[0.9, 2.7]` | ceiling |

**Attribution:** 88.4% auto-classified at macro-F1 **0.881** `[0.857, 0.901]`.
The remaining 11.6% is routed to human review with competing hypotheses attached.

### The class a timer can never fix

NPCI blocks AutoPay execution between **10:00 and 13:00 IST**. `T+24h`, `T+72h` and
`T+168h` all preserve the *time of day* — so a fixed-interval retry lands right back
inside the blocked window, every single time.

| C1 · execution window | Naive retry | WhyDunit |
|:---|---:|---:|
| Recovered | **0.0%** | **88.6%** |

Not "fewer". None. 605 failures in this run, 19.4% of all failures — and roughly half
of WhyDunit's total lead over naive retry comes from knowing this one published rule.

### Where the rest comes from

| Cause | Share | Naive retry | WhyDunit |
|:---|---:|---:|---:|
| **C1** Execution window | 19.4% | 0.0% | **88.6%** |
| **C2** Notification failure | 10.7% | 42.0% | **83.8%** |
| **C3** Balance shortfall | 45.5% | 52.0% | **67.7%** |
| **C4** Cancellation | 12.8% | 0.0% | 0.0% |

C4 recovers nothing **by design** — the correct action is to stop, not to spend.

---

## Quickstart

Cold clone to full pipeline in under five minutes, either way. Both paths were tested
on a fresh clone into `/tmp`, not assumed.

```bash
git clone https://github.com/UdayPandey01/Whydunit.git && cd Whydunit
docker compose up          # ~50s build, ~25s run. Nothing else needed.
```

Or natively — Node 24+ and Python 3.11:

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt

npm run all                # generate → features → train → eval → report → policy → agent → digest
npm run demo               # the terminal dashboard
npm run verify             # reproducibility proof; exits non-zero if any number moved
```

### The web front end

```bash
npm run snapshot           # freezes real pipeline artifacts into the app
cd web && npm install && npm run dev
```

Two static routes — the story (`/`) and a live dashboard (`/dashboard`), both rendered
from a committed snapshot of the real artifacts. `npm run build` emits a fully static
`out/`; on Vercel, set the root directory to `web`.

---

## Look at one payment, end to end

```bash
npm run explain mdt_00004
```

Walks a single mandate through the whole system: what was observable, what was **not**
observable, the invariance test across hour / bank / day-of-month / recent run,
competing hypotheses with calibrated probabilities, the attribution, the action taken,
every constraint check, the outcome — and ground truth **last**, clearly marked
evaluation-only.

| Command | The case |
|:---|:---|
| `npm run explain mdt_00004` | **C1 — the hero case.** ₹499 debited at 11:07, inside the restricted window, decline code `ZM`. Rescheduled to 14:07 the same day and recovered on the first retry. |
| `npm run explain mdt_00012` | **C2.** Notice dispatched 18.3h before the debit, under the 24h NPCI minimum. Caught from dispatch evidence alone. |
| `npm run explain mdt_00060` | **C4 silent churn — the hard case.** No revoke webhook ever fired. Found only by invariance: 3 consecutive failures across 6 different hours, on a bank behaving normally, with the notice confirmed delivered. Its bank signal is a genuine false lead the model has to see past. |

These IDs are stable for `seed 20260903` at `HORIZON_DAYS=270`; `npm run verify` fails
if that drifts.

---

## How it works

### Four causes, four invariance signatures

The core idea: each cause **moves with something different and is invariant to the
rest**. That signature is what separates them — not the decline code, which in this
corpus is never a reliable proxy (the most predictive one still misclassifies about a
fifth of the time).

| Class | Varies with | Invariant to |
|:---|:---|:---|
| **C1** execution window | hour of day | customer, bank, amount |
| **C2** notification failure | bank, burst window | customer, amount, hour |
| **C3** balance shortfall | customer, day-of-month | bank, hour |
| **C4** cancellation | *nothing* | *everything* |

C4 is identified by failure **invariance** — nothing fixes it — which makes it always
the *last* conclusion, never the default. That single design choice is why WhyDunit
stops instead of burning a retry budget on customers who have already gone.

### The one rule

> **Generate world state. Derive observations from it. Hide the world. Classify from
> observations only.**

The generator never takes a label as input. Labels are **emergent** — whichever world
process blocked the debit first. A test walks the serialized observation records and
asserts their key set exactly matches the declared merchant-visible allowlist, with a
positive control proving the same walker *does* find ground truth in the world file.

### Stopping is cost-sensitive, not argmax

Argmax prices a wrongful stop and a wrongful retry the same. They are not the same: a
wrongful stop forfeits an **entire mandate**, a wrongful retry costs **one retry**. The
threshold falls out of that ratio:

```
stop  iff  P(C4) ≥ ratio / (ratio + 1)      default 20:1 → 0.952
```

The full sweep from 0.50 to 0.95 is printed on **every** policy run, with a net-value
column priced from the same cost matrix — so the operating point is visibly *chosen*
rather than tuned until it looked good. Override with `npm run policy -- --cost-ratio 40`.

### Four hard constraints, enforced in the type system

`checkConstraints` is the only function that can mint a `CheckedPlan`, and the executor
accepts nothing else — there is **no code path** that reaches a PSP unchecked.

1. Max 3 interventions per mandate per cycle
2. Never schedule inside the restricted window
3. Never schedule a debit within 24h of the notification
4. Never retry after a cancellation

Every decision writes an audit record naming which checks **passed**, **failed**, or
**did not apply** — never "passed" when a check simply wasn't relevant.

### Crash-safe by construction

`tests/crash.test.ts` sends `SIGKILL` to the agent at **30 distinct points**, resumes,
and asserts the PSP ledger and audit log are identical to an uninterrupted run.

The guarantee doesn't rest on the agent's bookkeeping surviving. The idempotency key is
`mandate:cycle:attempt_no`, so a replay recomputes it exactly; the ledger holds it as
PRIMARY KEY. Intent and budget consumption commit in **one transaction before** the
effect is attempted — which is what makes a fourth intervention impossible, since a
crash can only ever leave the budget already spent, never unspent.

Injecting a non-deterministic idempotency key makes the test fail immediately, so it is
known to bite.

---

## Integration

One interface. The agent cannot tell which implementation it holds.

```ts
interface PspClient {
  fetchFailedDebits(since: Date): Promise<Observation[]>;
  scheduleDebit(mandateId, at: Date, idempotencyKey): Promise<Result>;
  sendPreDebitNotification(mandateId, idempotencyKey): Promise<Result>;
  cancelMandate(mandateId, idempotencyKey): Promise<Result>;
}
```

- **`SimulatedPsp`** — the seeded world. Default; no credentials, no network.
- **`RazorpayPsp`** — the real test-mode API via the official SDK.

`tests/seam.test.ts` runs the same agent cycle against the simulator and against a
scripted PSP that shares **no code** with it, and asserts the audit trails match **row
for row**. A second test runs the agent against a PSP that accepts everything and
asserts the intervention budget still binds — the constraints live in the agent, not in
the implementation.

### Ten-line integration

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

Three methods, each usable standalone — a merchant who wants attribution only is never
forced through execution. `examples/ten-lines.ts` is exactly this, runnable against the
simulator with no credentials.

### What Razorpay test mode actually supports

Checked against the docs **before** designing the adapter, not after.

**Works:** subscription/plan/customer creation · auth payment with test cards and UPI
IDs · on-demand charges via *Charge this now* · choosing success or failure, up to 4
consecutive · webhooks with HMAC-SHA256 over the raw body.

**Does not, and what we did about it:**

| Gap | Consequence | Our response |
|:---|:---|:---|
| No time advancement | Multi-month attempt histories impossible | Invariance (C4) unreachable live; corpus stays simulated |
| Cannot choose *which* decline reason | C1/C2/C4 not inducible | Only C3 (`insufficient_funds`) is inducible |
| No control over charge timing | C1 is defined entirely by the hour | C1 derived from the attempt timestamp — no code needed |
| Pre-debit notice not merchant-triggerable | C2 not inducible or re-issuable | Adapter returns `unsupported` rather than pretending |
| UPI Collect deprecated (Feb 2026) | Mandates can't be registered by typing a VPA | Headless registration not possible |

Razorpay's published UPI error list has **no code** for *mandate revoked*, *notification
not delivered*, or *execution-window rejection*. `src/psp/razorpay-codes.ts` maps only
what is documented and records every gap in an `UNMAPPED` table with a workaround for
each. A test asserts at most two codes are ever treated as evidence for one of our
causes, so the table cannot quietly grow invented rows.

One structural difference worth flagging: a real debit returns **`pending`**. Razorpay
accepts the instruction and the outcome arrives later by webhook, so the agent cannot
learn the result inside the same cycle. The interface models that honestly.

---

## Honest limitations

Read this before believing anything above.

**The evaluation corpus is simulated.** A labelled corpus of UPI AutoPay failures with
known ground truth does not exist outside a PSP. The simulator generates world state;
labels are emergent, never assigned. This is the largest caveat and no amount of
engineering removes it.

**The model ties the expert rule on money.** Against a hand-written four-line rule the
difference on rupees recovered is `+0.1pp [−0.6, 0.8]` — it straddles zero at every
horizon tested. **The rule remains the production retry policy.** The model is
significantly cheaper on retries and significantly better at attribution (+0.181 macro-F1
out-of-fold), and those are the only claims it makes.

**The Razorpay adapter is real but unproven.** Auth, retry, webhook signature
verification and event mapping are written and unit-tested. It has **never run against
live credentials.**

**Notification failure is inferred, not observed.** C2 comes from the merchant's own
dispatch log plus bank-level burst statistics. Whether the bank delivered the notice is
never observable — by construction, because it isn't observable in reality either.

**Silent-churn recall is horizon-dependent:** 0.556 at 270 days, 0.718 at 360, and
**0.000 at 90**. Invariance needs repeated attempts before it can be seen at all. C4 F1
is 0.631 — the weakest class by a wide margin, and the one the project exists to solve.

**Five banks.** Bank-relative features generalise to the two held out of training, but
five is a small population to claim that from.

**Calibration is adequate, not tight.** ECE 0.093 on the mandate split — good enough to
threshold on directly, so no isotonic calibrator was fitted.

### The horizon sweep

The model's entire edge is silent churn, which is defined by invariance over repeated
attempts. Vary how much history exists and the edge appears exactly where the theory
says it should — **with no change to the model**:

| Horizon | Failures | model − rule (macro-F1) | Verdict |
|:---|---:|---:|:---|
| 90 days | 975 | `+0.001 [−0.007, 0.008]` | ties |
| 180 days | 2,114 | `+0.141 [0.116, 0.163]` | wins |
| 270 days | 3,116 | `+0.181 [0.158, 0.198]` | wins |
| 360 days | 4,264 | `+0.201 [0.181, 0.218]` | wins |

At 90 days a monthly mandate gets at most three attempts, so the signature has no room
to appear. The signal was absent, not missed.

---

## Reproducibility

```bash
npm run verify              # exits non-zero if any number moved
npm run verify -- --full    # re-runs the entire pipeline first
```

`verify` regenerates the world from the seed **in-process**, re-hashes ten artifacts
against `reference/manifest.json`, and compares eleven headline scalars — so a failure
names *which number moved*, not just which file. It runs in CI on every push.

Proven to fail: corrupting one field of `policy.json` exits 1 and prints
`model_rate 0.630597 → 0.631597`.

Artifacts are **portable**, not merely deterministic. An early version passed on arm64
and would have failed on the x86 CI runner: 17 of 3,116 prediction lines differed by
5.55e-17 — one ULP — with zero predicted classes changed, because float64 `repr` isn't
portable between BLAS backends. Probabilities are now rounded at the serialization
boundary, and `verify` checks that directly. Confirmed identical under
`--platform linux/amd64`.

---

## Repository layout

```
src/world/        the simulator: four independent blocking processes
src/observe.ts    THE BOUNDARY — merchant-visible fields only
src/features.ts   six invariance families, strictly point-in-time
src/exceptions.ts the routing rules for human review
src/agent/        constraints, durable loop, crash-resume, audit log
src/psp/          the seam: PspClient, SimulatedPsp, RazorpayPsp, webhooks
src/whydunit.ts   the public API: attribute / plan / execute
eval/             scikit-learn training and the evaluation battery
web/              static Next.js front end and live dashboard
```

**Commands:** `generate` · `features` · `train` · `eval` · `report` · `policy` ·
`agent` · `digest` · `explain <mandate_id>` · `verify` · `demo`

**Stack:** TypeScript on Node 24 (native type stripping, zero build step) ·
Python 3.11 + scikit-learn as a script, not a service · SQLite for agent runtime state ·
4 runtime dependencies.

---

## Further reading

- **[DESIGN.md](DESIGN.md)** — the live map: every module, every key decision and its
  reason, the full Razorpay gap table, and what is deliberately not built.
- **[INCIDENTS.md](INCIDENTS.md)** — thirteen real failures, written when they happened:
  symptom → first hypothesis → the diagnostic that disproved it → root cause → fix and
  what it traded. Including an abstention rule that made the exception queue *worse* than
  no queue, a digest that silently reported the previous cycle's numbers, and a regression
  that halved recovery and was caught only by the first clean-clone container run.

<div align="center">

**71 tests** · `npm test` — MIT licensed

</div>
