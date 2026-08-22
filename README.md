# WhyDunit

**Most failed UPI AutoPay debits get retried on a timer. That is the wrong loop.**

A debit that failed because it landed inside the NPCI 10:00–13:00 restricted window
will fail again at T+24h, T+72h and T+168h — every one of those intervals preserves
the hour. In our simulation, naive fixed-interval retry recovers **0.0%** of that
class. A debit that failed because the customer quietly stopped paying will fail
forever, and every retry spent on it is money burned on someone who has already left.

WhyDunit works out **why** each debit failed, then executes a bounded action matched
to that cause — under hard constraints, with an audit trail, and with an honest
exception queue for the cases it cannot call.

Razorpay AI Buildathon, Track 03.

---

## The boundary, stated up front

> **The adapter is real and is built against Razorpay test mode. The evaluation
> corpus is simulated, because a labelled corpus of UPI AutoPay failures with known
> ground truth does not exist outside a PSP. The simulator generates world state;
> labels are emergent, not assigned.**

Two further things we would rather say than be asked:

- **The Razorpay adapter has never been run against live credentials.** There were
  none in the build environment. Auth, retry, the SDK calls, webhook signature
  verification and the event mapping are written and unit-tested; the 10–20 live
  test-mode subscriptions were not run. Everything below marked *verified* was
  verified against the docs, not against a live key.
- **Only one of our four causes is inducible in Razorpay test mode.** See
  [What test mode actually supports](#what-razorpay-test-mode-actually-supports).
  We designed around that gap rather than hiding it.

---

## Results

Seeded, reproducible, 270-day horizon, 1,983 mandates, 16,661 attempts, 3,116 failures.

| | |
|---|---|
| **Classified** | 88.4% automatically, at macro-F1 **0.881** [0.857–0.901] |
| **Routed to human review** | 11.6%, each with competing hypotheses and what would resolve them |
| **Recovered** | **63.1%** of at-risk rupees, against 33.3% for naive retry |
| **Retries spent** | **1.79** per failure, against 2.67 for naive retry |
| **Ceiling** | 64.8% — what a policy with perfect knowledge of the true cause achieves |

Against naive retry: **+29.8pp** recovered [24.8, 35.5], paired bootstrap, 95% CI.

### Where the recovery actually comes from

| Cause | Naive retry | WhyDunit |
|---|---|---|
| C1 execution window | **0.0%** | 88.6% |
| C2 notification failure | 42.0% | 83.8% |
| C3 balance shortfall | 52.0% | 67.7% |
| C4 cancellation | 0.0% | 0.0% — correctly, it stops instead of spending |

### And the part we do not claim

Against a hand-written four-line expert rule, the gradient-boosted model **ties on
rupees recovered at every horizon we tested** (90/180/270/360 days). It is
significantly cheaper on retries from 180 days on, and significantly better at
attribution (+0.141 → +0.201 macro-F1). So:

> **The rule remains the production retry policy.** The model earns its place in the
> exception queue and the merchant report, not yet in the retry decision.

The model's entire edge is silent churn — cancellation with no webhook — which is
identified by failure *invariance* across repeated attempts, something a rule
evaluating one attempt in isolation cannot express. That edge does not exist at a
90-day horizon because there are not enough attempts per mandate for invariance to
show. `INCIDENTS.md` #8 has the horizon sweep that settled it.

---

## Integrate it in ten lines

```ts
import { Whydunit, RazorpayPsp } from "whydunit";

const w = new Whydunit({
  psp: new RazorpayPsp({ keyId, keySecret }),
  costRatio: 40,              // a wrongful stop costs 40× a wrongful retry
  maxInterventions: 3,
});

const attributions = await w.attribute(observations);   // no side effects
const plan         = await w.plan(attributions);        // still no side effects
const result       = await w.execute(plan, observations); // respects every constraint
```

Three methods, each usable standalone. A merchant who wants attribution only is
never forced through execution. `examples/ten-lines.ts` is this, runnable against
the simulator with no credentials.

---

## The seam

One interface. The agent cannot tell which implementation it holds.

```ts
interface PspClient {
  fetchFailedDebits(since: Date): Promise<Observation[]>;
  scheduleDebit(mandateId, at: Date, idempotencyKey): Promise<Result>;
  sendPreDebitNotification(mandateId, idempotencyKey): Promise<Result>;
  cancelMandate(mandateId, idempotencyKey): Promise<Result>;
}
```

- **`SimulatedPsp`** — the seeded world. Default, no credentials, no network.
- **`RazorpayPsp`** — the real test-mode API via the official SDK.

`tests/seam.test.ts` runs the same agent cycle against the simulator and against a
scripted PSP that shares no code with it, and asserts the audit trails are
**identical row for row**. It also runs the agent against a PSP that says yes to
everything and asserts the intervention budget still holds — the constraints live
in the agent, not in the implementation.

---

## What Razorpay test mode actually supports

Checked against the docs on 2026-08-22, before designing the adapter.

**Works:**

- Subscription, plan and customer creation
- Auth payment with test cards and test UPI IDs
- On-demand charges via the dashboard's *Charge this now*
- Choosing charge outcome — success or failure — up to 4 consecutive failures
- Webhooks: HMAC-SHA256 over the raw body, `X-Razorpay-Signature`

**Does not work, and what we did about it:**

| Gap | Consequence | What we did |
|---|---|---|
| No time advancement | Cannot build multi-month attempt histories | Invariance (C4) is unreachable in test mode; the corpus stays simulated |
| Cannot choose *which* decline reason | C1/C2/C4 cannot be induced | Only C3 (`insufficient_funds`) is inducible live |
| Cannot control the hour of a charge | C1 is defined entirely by the debit landing in 10:00–13:00 IST | C1 is derived from the attempt timestamp, which the adapter already holds — no code needed |
| Pre-debit notification is not merchant-triggerable | C2 cannot be induced or re-issued | `sendPreDebitNotification` returns `unsupported` on the Razorpay path rather than pretending |
| Subsequent token debit only within 3 days of token creation | Long histories impossible | Simulated corpus |
| UPI Collect deprecated 28 Feb 2026 | Mandates cannot be registered by typing a VPA; intent flow needs a real UPI app | Headless registration is not possible |

**The decline-code gap list.** Razorpay's published UPI error list has no code for
*mandate revoked*, *pre-debit notification not delivered*, or *debit rejected for
the execution window*. `src/psp/razorpay-codes.ts` maps only what is documented and
records every gap in an `UNMAPPED` table with the workaround for each. A test
asserts at most two Razorpay codes are ever treated as evidence for one of our
causes, so the table cannot quietly grow invented rows.

One structural difference is worth flagging: a real debit returns **`pending`**.
Razorpay accepts the instruction and the outcome arrives later by webhook, so the
agent cannot learn the result inside the same cycle. The interface models this
honestly and the agent leaves the cycle open for a later resume.

---

## Run it

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy

npm run all      # generate → features → train → eval → report → policy → agent → digest
npm run demo     # the dashboard
npm run verify   # reproducibility proof; exits non-zero on any mismatch
```

`npm run verify` regenerates the world from the seed, re-hashes ten artifacts against
`reference/manifest.json`, and names the exact metric that moved if one does. Proven
to fail: corrupting one field of `policy.json` exits 1. `--full` re-runs the whole
pipeline, which is the only way to catch a change on the Python side.

### The three reference cases

`npm run explain <mandate_id>` walks one mandate end to end: what was observable,
what was **not** observable, the invariance test, competing hypotheses with
calibrated probabilities, the attribution, the action, every constraint check, the
outcome — and ground truth **last**, marked evaluation-only.

| Command | What it shows |
|---|---|
| `npm run explain mdt_00004` | **C1 — the hero case.** Debited at 11:00, inside the restricted window. Naive retry recovers 0% of these. |
| `npm run explain mdt_00012` | **C2.** Notice sent 18.3h before the debit, under the 24h NPCI minimum. Caught from dispatch evidence alone. |
| `npm run explain mdt_00060` | **C4 silent churn — the hard case.** No revoke webhook. Identified only by invariance: 3 consecutive failures across 6 different hours, on a bank behaving normally, notice confirmed delivered. Its bank signal is a genuine false lead the model has to see past. |

Stable for `seed 20260903` at `HORIZON_DAYS=270`. `verify` fails if that drifts.

---

## How it decides

Four causes, each with a different **invariance signature**:

| Class | Varies with | Invariant to |
|---|---|---|
| C1 execution window | hour of day | customer, bank, amount |
| C2 notification failure | bank, burst window | customer, amount, hour |
| C3 balance shortfall | customer, day-of-month | bank, hour |
| C4 cancellation | nothing | everything |

C4 is identified by failure invariance — nothing fixes it — so it is always the last
conclusion, never the default.

**Stopping is cost-sensitive, not argmax.** Argmax prices a wrongful stop and a
wrongful retry the same. They are not the same: a wrongful stop forfeits an entire
mandate, a wrongful retry costs one retry. The threshold comes from that ratio
(`P(C4) ≥ ratio/(ratio+1)`), and the full sweep from 0.50 to 0.95 is printed on
every policy run so the operating point is visibly chosen rather than tuned.

**Four hard constraints, enforced in code and load-bearing in the type system.**
`checkConstraints` is the only function that can mint a `CheckedPlan`, and the
executor accepts nothing else — there is no path to the PSP that skips them.

1. Max 3 interventions per mandate per cycle
2. Never schedule inside the restricted window
3. Never schedule a debit within 24h of the notification
4. Never retry after a cancellation

Every decision writes an audit record with which checks passed, failed, or did not
apply — never "passed" when a check simply did not apply.

**Crash-safe.** `tests/crash.test.ts` SIGKILLs the agent at 30 distinct points,
resumes, and asserts the PSP ledger and audit log match an uninterrupted run exactly.
Injecting a non-deterministic idempotency key makes it fail, so the test is known to
bite.

---

## The one rule

**Generate world state. Derive observations from it. Hide the world. Classify from
observations only.** The generator never takes a label as input — labels are
emergent, whichever world process blocked the debit first. A test walks the
serialized observation records and asserts the key set exactly matches the declared
merchant-visible allowlist, with a positive control proving the same walker *does*
find ground truth in the world file.

---

## Honesty ledger

`INCIDENTS.md` has ten real failures, written when they happened, each with symptom →
first hypothesis → the diagnostic that disproved it → root cause → fix and what it
traded. Including the ones that are embarrassing:

- An abstention rule that made the exception queue *worse* than no queue
- Silent-churn recall of 0.000, misdiagnosed as a model failure when it was a data
  limitation — a horizon sweep settled it
- Two policy bugs, where the smaller one was hiding behind the larger
- A merchant digest that reported the previous cycle's recovery figures, invisible
  because determinism made stale data look identical to fresh

Three entries are marked as backfilled, because they were written after the fact —
which is exactly what that file exists to prevent.

---

## Layout

```
src/psp/          the seam: PspClient, SimulatedPsp, RazorpayPsp, webhook receiver
src/world/        the simulator: four independent blocking processes
src/observe.ts    THE BOUNDARY — merchant-visible fields only
src/features.ts   six invariance families, strictly point-in-time
src/agent/        constraints, durable loop, crash-resume, audit log
src/whydunit.ts   the public API: attribute / plan / execute
eval/             scikit-learn training and the evaluation battery
```

`DESIGN.md` is the live map. 65 tests, `npm test`.
