# DESIGN

## 1. Current state

Phases 1 and 2 are done. A seeded world simulator produces ~5,800 UPI AutoPay
debit attempts whose failure causes are emergent, an observation layer exposes
only merchant-visible fields, and 43 strictly point-in-time features feed a
HistGradientBoosting classifier evaluated on three split schemes with bootstrap
CIs. **The classifier is not distinguishable from a four-line expert rule, and the
recovery policy it drives is not distinguishable from the same rule** — see §5.

## 2. Module map

| File | What it does |
|---|---|
| `src/config.ts` | Every simulation knob as a named constant. |
| `src/time.ts` | IST wall-clock helpers over epoch-ms; isolates calendar maths from host timezone. |
| `src/rng.ts` | mulberry32 seeded PRNG and draw helpers. |
| `src/world/types.ts` | `Cause`, `Customer`, `Mandate`, `WorldRecord` — full state, ground truth included. |
| `src/world/window.ts` | C1. `isRestricted(ms)` — inside the 10:00–13:00 IST NPCI window. |
| `src/world/notification.ts` | C2's hidden half: per-bank reliability plus injected outage intervals. |
| `src/world/balance.ts` | C3. `balanceAt` — salary credit, front-loaded spend decay, shocks. Pure. |
| `src/world/churn.ts` | C4. Inverts a geometric hazard; decides whether a revoke webhook fires. |
| `src/world/generate.ts` | Draws the population, steps the horizon, records the emergent cause. |
| `src/observe.ts` | THE BOUNDARY. `ObservedAttempt` + `observe()`. Merchant-visible only. |
| `src/features.ts` | Six invariance families + raw decline code → 43 numeric features. Reads observations only. |
| `src/splits.ts` | Mandate (hash), bank (SBI/AXIS holdout) and time (day <60) splits. |
| `src/policy.ts` | Counterfactual retry replay against the four world processes; cluster + paired bootstrap. |
| `src/cli.ts` | `generate` \| `features` \| `policy`. |
| `eval/train.py` | Fits one HistGradientBoosting per split → `model.pkl`, `metrics.json`. |
| `eval/evaluate.py` | P/R/F1, macro-F1, confusion, calibration, ECE, all with cluster-bootstrap CIs; baselines; out-of-fold predictions. |
| `tests/*.test.ts` | Boundary, determinism, base rates, feature causality. 22 tests. |

## 3. Data flow

```
config.ts
   │
   ▼  generateWorldFull()          rng → world dynamics
WorldRecord[] ─────────────────────────────────────► data/world.jsonl
   │           {cause, blockers, multi_cause, world:{balance, churn, ...}}
   │
   ▼  observe()                    obsRng → receipt visibility
ObservedAttempt[] ─────────────────────────────────► data/observations.jsonl
   │
   ▼  computeFeatures()   ← observations ONLY, strictly point-in-time
FeatureRow[] ── + label joined in cli.ts ── + assignSplits() ─► data/features.jsonl
   │
   ▼  eval/train.py                                   data/model.pkl, metrics.json
   ▼  eval/evaluate.py   ← cluster bootstrap by mandate
        ├─────────────────────────────────────────►  data/evaluation.json
        └─ out-of-fold preds (GroupKFold by mandate) ► data/predictions.jsonl
   │
   ▼  src/policy.ts      ← policy chosen from predictions, outcome adjudicated by the WORLD
5 policies × counterfactual replay ────────────────►  data/policy.json
```

## 4. Key decisions

**Phase 1**

- Precedence is churn → notification → window → balance: real chronology, but the
  binding reason is that C4's signature is "nothing fixes it", which only holds if
  churn is evaluated first.
- All four processes always evaluated, never short-circuited, so `multi_cause` can
  see who else would have blocked.
- `ObservedAttempt` defined positively, hidden-key list hand-written, no spread in
  `observe.ts`. Each of the three alone would let a new world field leak.
- Decline codes deliberately lossy; a test fails the build above 95% purity.
- Three RNG streams (world / decline codes / observation) so retuning a reporting
  layer cannot move who churned. See INCIDENTS #1.
- `generateWorldFull` added in P2 to expose the population for counterfactual
  replay, without touching the RNG stream — P1 output is still byte-identical.

**Phase 2**

- **Features are strictly point-in-time.** Trailing windows are half-open on the
  attempt's own timestamp; mandate history comes from `prior_attempts`; a revoke
  webhook arriving *after* the attempt is filtered out. A retrospective model would
  score better and be useless to the Phase 3 agent, which must decide at failure
  time. `tests/features.test.ts` proves it by deleting the future and asserting the
  past does not move.
- **No raw bank identity in the matrix**, only bank-*relative* statistics —
  otherwise the bank-holdout split measures nothing.
- **Rows are failed attempts only** (1,098). Successes still feed trailing
  statistics and mandate history.
- **No `class_weight="balanced"`.** It would lift macro-F1 on small classes while
  wrecking the calibration that ECE measures. The imbalance is real; report through it.
- **Hyperparameters set once from defaults and never tuned against test scores.**
- **Bootstrap resamples mandates, not rows.** Attempts on one mandate share a
  customer, balance trajectory and churn state; a row bootstrap would report
  intervals that are too narrow.
- **Paired difference, not overlapping CIs**, when comparing two predictors on the
  same batch — the weaker test would have called the null result a win.
- **Policy outcomes are adjudicated by the world, not the model.** The policy is
  chosen from observations and predictions; whether the retry would have succeeded
  is answered by replaying the same four processes.
- **Equal retry budget (3) for every policy**, so the comparison is about *where*
  retries go, not how many.

## 5. Results, including the null result

Classification, macro-F1 with 95% cluster-bootstrap CI (n=1000):

| split | model | expert rule | decline-code lookup | majority | paired model − rule |
|---|---|---|---|---|---|
| mandate | 0.935 [0.883, 0.974] | 0.930 [0.880, 0.968] | 0.373 | 0.168 | **+0.004 [−0.014, +0.023]** |
| bank | 0.808 [0.748, 0.856] | 0.866 [0.809, 0.913] | 0.250 | 0.165 | **−0.058 [−0.087, −0.030]** |
| time | 0.878 [0.842, 0.910] | 0.872 [0.833, 0.903] | 0.418 | 0.163 | **+0.006 [−0.007, +0.021]** |
| out-of-fold (n=1098) | 0.901 [0.873, 0.926] | — | — | — | **+0.006 [−0.006, +0.018]** |

Recovery, rupees recovered / rupees at risk, paired CI against `model_policy`:

| policy | recovery | retries/failure | paired Δ vs model |
|---|---|---|---|
| do_nothing | 0.0% | 0.00 | — |
| naive_retry T+24/72/168h | 31.6% [25.9, 37.5] | 2.54 | −27.0pp [−32.3, −22.1] |
| window_aware_retry | 46.3% [40.2, 52.5] | 2.22 | −12.4pp [−17.6, −7.6] |
| **rule_policy** | 57.9% [52.2, 63.5] | 1.55 | **−0.8pp [−2.6, +0.1]** |
| model_policy | 58.7% [52.9, 64.6] | 1.51 | — |
| oracle_policy (ground truth) | 60.4% [54.4, 66.3] | 1.39 | +1.7pp |

**The null result, stated plainly.** The gradient-boosted classifier is not
distinguishable from four if-statements on macro-F1 (mandate, time, out-of-fold),
is significantly *worse* on unseen banks, and the recovery policy it drives is not
distinguishable from the same rule (0.8pp, CI straddles zero). Nothing was tuned
in response to this.

**Diagnosis.** 40% of failures are settled by one directly-observed boolean:

| observable condition | n | dominant label |
|---|---|---|
| revoke webhook before attempt | 88 | C4 100% |
| receipt says FAILED | 66 | C2 100% |
| dispatch < 24h before debit | 75 | C2 99% |
| inside the NPCI window | 208 | C1 98% |
| **nothing observable explains it** | **661** | C3 88%, C4-silent 54, C2-hidden 28 |

Aggregate macro-F1 is dominated by that trivial 40%, which is why model ≈ rule. On
the hard 60% the model *does* add signal — macro-F1 0.390 vs the rule's 0.233, and
30% recall on C2 failures where the bank silently dropped the notification and no
receipt came back — but it never converts into recovery, because on that subset the
correct action is "retry later" for both C3 and hidden-C2 anyway. The one place the
distinction pays is **silent churn**, where the payoff is avoided cost rather than
revenue: 123 retries are burned on unrecoverable mandates, and the model's recall on
silent churn is **0.000** (explicit-webhook C4 recall is 1.000).

**Why silent churn is unlearnable here, and what would change it.** C4 is defined by
invariance — nothing fixes it — but monthly frequency over a 90-day horizon gives at
most 3 attempts per mandate, so a failure has at most 2 priors, and 19 of 145 C4
attempts have none. The invariance signature has no room to express itself. The
fixes are Phase-1 changes, deliberately *not* made in response to these numbers:
add weekly/daily mandates so invariance has 12+ attempts to show up in, and lower
`RECEIPT_VISIBLE_RATE` so C2 is genuinely inferential rather than 70% observed.

## 6. Not built yet

- **P3** — the agent: interventions, hard constraints, audit log, crash-resume,
  SQLite runtime state. `src/policy.ts` is an offline evaluator, not an agent: no
  state, no logging, no constraints.
- **P4** — exception queue, merchant report, LLM explanation layer.
- **P5** — hardening, README, video.

## 7. How to run

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy
npm run all        # generate → features → train → eval → policy
npm test           # 22 tests
npm run typecheck  # enforces the observation boundary at compile time
```
