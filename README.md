# WhyDunit

Takes failed UPI AutoPay debits, works out **why** each one actually failed, and
executes a bounded recovery action matched to that cause — with hard constraints,
an audit trail, and an honest exception list.

Razorpay AI Buildathon, Track 03.

---

## Run it

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy

npm run all      # generate → features → train → eval → report → policy → agent → digest
npm run demo     # the dashboard
npm run verify   # reproducibility proof; exits non-zero on any mismatch
```

Every stage is seeded. `npm run verify` regenerates the world from the seed,
re-hashes every artifact against `reference/manifest.json`, and names the exact
metric that moved if one does. `npm run verify -- --full` re-runs the whole
pipeline first, which is the only way to catch a change on the Python side.

---

## The three reference cases

`npm run explain <mandate_id>` walks one mandate end to end: what was observable,
what was *not*, the invariance test, competing hypotheses, the attribution, the
action, every safety check, the outcome — and ground truth last, marked
evaluation-only.

| Command | What it shows |
|---|---|
| `npm run explain mdt_00004` | **C1 execution window — the hero case.** Debited at 11:00, inside the NPCI restricted window. Naive retry recovers **0%** of these, because T+24/72/168h all preserve the hour and land back in the window. WhyDunit moves it to a safe hour. |
| `npm run explain mdt_00012` | **C2 notification failure.** The pre-debit notice went out 18.3h before the debit, under the 24h NPCI minimum, and no delivery receipt came back. Caught from dispatch evidence alone. |
| `npm run explain mdt_00060` | **C4 silent churn — the hard case.** No revoke webhook ever fired. Identified only by invariance: 3 consecutive failures across 6 different hours, on a bank behaving normally, with the notice confirmed delivered. Nothing situational explains it. |

These IDs are stable for `seed 20260903` at `HORIZON_DAYS=270`. Change either and
they will point at different mandates.

---

## What it does

Four causes, each with a different invariance signature:

| Class | Varies with | Invariant to |
|---|---|---|
| C1 execution window | hour of day | customer, bank, amount |
| C2 notification failure | bank, burst window | customer, amount, hour |
| C3 balance shortfall | customer, day-of-month | bank, hour |
| C4 cancellation | nothing | everything |

C4 is identified by failure *invariance* — nothing fixes it — so it is always the
last conclusion, never the default.

The one rule: **generate world state, derive observations from it, hide the world,
classify from observations only.** The generator never takes a label as input.
Labels are emergent — whichever world process blocked the debit first.

---

## Honest results

At a 270-day horizon, against a hand-written four-line expert rule:

- **Attribution:** the model wins from 180 days on (+0.141 → +0.201 macro-F1),
  and ties at 90 days. Its entire edge is silent churn, which a single-attempt
  rule cannot express.
- **Recovery:** the model **ties** the rule on rupees at every horizon tested.
  It is significantly cheaper on retries from 180 days.
- **Therefore the rule remains the production retry policy.** The model earns its
  place in the exception queue and the merchant report, not in the retry decision.

`DESIGN.md` has the full tables. `INCIDENTS.md` has every real failure, including
the two policy bugs that had to be fixed before any of this was measurable.

---

## Commands

`generate` · `features` · `train` · `eval` · `report` · `policy` · `agent` ·
`digest` · `explain <mandate_id>` · `verify` · `demo`
