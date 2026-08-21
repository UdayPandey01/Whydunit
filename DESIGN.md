# DESIGN

## 1. Current state

All four phases are done. A seeded world simulator produces ~5,800 UPI AutoPay
debit attempts whose failure causes are emergent, an observation layer exposes only
merchant-visible fields, and 43 strictly point-in-time features feed a classifier
evaluated on three splits with bootstrap CIs. A deterministic router sends
uncertain cases to an exception queue; a durable agent executes cause-matched
interventions on the rest under four code-enforced constraints, surviving `kill -9`
without double-firing. Claude writes prose about the results and touches nothing else.

**Classified 79.0% at macro-F1 0.931 [95% CI 0.906–0.951], routed 21.0% to human review.**

## 2. Module map

| File | What it does |
|---|---|
| `src/config.ts` | Every simulation knob as a named constant. |
| `src/time.ts` | IST wall-clock helpers over epoch-ms; isolates calendar maths from host timezone. |
| `src/rng.ts` | mulberry32 seeded PRNG, draw helpers, FNV-1a `hash32`. |
| `src/bootstrap.ts` | Cluster bootstrap by mandate. One implementation, so every CI agrees. |
| `src/schedule.ts` | NPCI-window avoidance, salary-date targeting, billing-cycle key. |
| `src/world/{window,notification,balance,churn}.ts` | The four processes. Each answers only "would I block this?" |
| `src/world/generate.ts` | Draws the population, steps the horizon, records the emergent cause. |
| `src/world/replay.ts` | Counterfactual adjudication: what the four would say at another time. |
| `src/observe.ts` | THE BOUNDARY. `ObservedAttempt` + `observe()`. Merchant-visible only. |
| `src/features.ts` | Six invariance families + raw decline code → 43 features. Observations only. |
| `src/splits.ts` | Mandate (hash), bank (SBI/AXIS holdout) and time (day <60) splits. |
| `src/exceptions.ts` | The routing rules. Deterministic, in code, observables only. |
| `src/report.ts` | Headline metric, cause breakdown, digest rendering. |
| `src/explain.ts` | Claude. Prose only — the sole file importing the Anthropic SDK. |
| `src/policy.ts` | Offline 5-policy comparison with paired bootstrap deltas. |
| `src/agent/db.ts` | SQLite schema: `audit_log`, `cycle_state`, `psp_ledger`. WAL + `synchronous=FULL`. |
| `src/agent/psp.ts` | The simulated PSP. The keyed ledger INSERT *is* the side effect. |
| `src/agent/constraints.ts` | The four hard constraints and the branded `CheckedPlan`. |
| `src/agent/agent.ts` | `decide` → `scheduleFor` → `checkConstraints` → `execute`, plus resume. |
| `src/cli.ts` | `generate` \| `features` \| `report` \| `policy` \| `agent` \| `digest`. |
| `eval/train.py` | Fits HistGradientBoosting per split → `model.pkl`, `support.json`. |
| `eval/evaluate.py` | P/R/F1, macro-F1, confusion, calibration, ECE, all with cluster-bootstrap CIs. |
| `tests/*.test.ts` | Boundary, determinism, base rates, feature causality, constraints, crash-resume, routing, LLM containment. 54 tests. |

## 3. Data flow

```
generateWorldFull() ─► world.jsonl        {cause, blockers, multi_cause, world:{...}}
   └─ observe() ─────► observations.jsonl  merchant-visible only
        └─ computeFeatures()  ← observations ONLY, strictly point-in-time
             + label joined in cli.ts + assignSplits() ─► features.jsonl
                  ├─ eval/train.py    ─► model.pkl, support.json
                  └─ eval/evaluate.py ─► evaluation.json, predictions.jsonl
                       ├─ src/report.ts ─► report.json, exceptions.jsonl
                       ├─ src/policy.ts ─► policy.json
                       └─ src/agent/agent.ts ─► agent.db   (needs exceptions.jsonl)
                            └─ digest ─► digest.txt        (needs report.json + agent.db)
                                 └─ src/explain.ts ─► explanations.jsonl, digest.md

agent, per failure, up to 3 times:
   decide ─► scheduleFor ─► checkConstraints ─┬─ vetoed ─► audit(blocked), terminal
                                              └─ CheckedPlan
        TX1  audit(pending) + budget++          commit
        fire INSERT OR IGNORE psp_ledger        commit  ← the effect
        TX2  audit(completed) + cycle status    commit
```

Everything CHOOSES from observations and predictions; whether an action would have
worked is adjudicated by replaying the world. Explanations are a leaf: nothing
reads `explanations.jsonl` or `digest.md` back.

## 4. Key decisions

- **Precedence is churn → notification → window → balance.** Real chronology, but
  the binding reason is that C4's signature is "nothing fixes it", which only holds
  if churn is first. All four always evaluated, so `multi_cause` sees co-blockers.
- **`ObservedAttempt` is defined positively, the hidden-key list is hand-written,
  and `observe.ts` contains no spread.** Each alone would let a new world field leak.
- **Decline codes are deliberately lossy**; a test fails the build above 95% purity.
- **Three RNG streams** (world / decline codes / observation) so retuning a
  reporting layer cannot move who churned. See INCIDENTS #1.
- **Features are strictly point-in-time.** `tests/features.test.ts` proves it by
  deleting the future and asserting the past does not move. A retrospective model
  would score better and be useless to the agent, which decides at failure time.
- **No raw bank identity in the matrix**, only bank-*relative* statistics —
  otherwise the bank-holdout split measures nothing.
- **Bootstrap resamples mandates, not rows**, and comparisons use a **paired
  difference** rather than overlapping CIs — the weaker test would have called the
  Phase 2 null result a win.
- **Hyperparameters set once from defaults, never tuned against test scores.**
- **The constraints are load-bearing in the type system.** `checkConstraints` is
  the only function that can mint a `CheckedPlan`; `execute` accepts nothing else.
  Checks are recorded passed / failed / **skipped** — never "passed" when they did
  not apply.
- **Crash safety does not depend on the agent's bookkeeping.** Idempotency key is
  `mandate:cycle:attempt_no`; the PSP ledger holds it as PRIMARY KEY. Intent and
  budget consumption commit *before* the effect is attempted, so a crash can never
  yield a fourth intervention. Resume re-runs `fire` and lets idempotency decide.
- **Multi-cause conflict is inferred from observables**, never from the hidden
  `multi_cause` flag — two or more independent indicators firing at once. A much
  weaker detector (17% recall, 45% precision against the hidden flag), and the only
  one that respects the boundary.
- **The exception router is the single authority on escalation.** Phase 3's bare
  confidence threshold is gone, so two thresholds can never disagree.
- **`report` and `digest` are separate stages.** The agent needs the exception
  queue, and the digest needs the agent's outcomes, so one command could not do
  both without reporting a stale cycle. The agent tally is a required argument, not
  a nullable one. See INCIDENTS #6.
- **The LLM is kept out of scoring structurally, not by prompting.** `explain.ts`
  returns strings, writes to its own files, and is imported by nothing in the
  scoring path. `tests/explain.test.ts` runs an adversarial explainer that insists
  on a different cause and asserts every number is byte-identical.

## 5. Results

**Classification (macro-F1, 95% cluster-bootstrap CI, n=1000).** The model is not
distinguishable from a four-line expert rule, and is significantly *worse* on
unseen banks. Nothing was tuned in response.

| split | model | expert rule | paired model − rule |
|---|---|---|---|
| mandate | 0.935 | 0.930 | **+0.004 [−0.014, +0.023]** |
| bank | 0.808 | 0.866 | **−0.058 [−0.087, −0.030]** |
| time | 0.878 | 0.872 | **+0.006 [−0.007, +0.021]** |
| out-of-fold n=1098 | 0.901 | 0.895 | **+0.006 [−0.006, +0.018]** |

40% of failures are settled by one directly-observed boolean: revoke webhook (n=88,
C4 100%), receipt FAILED (n=66, C2 100%), dispatch <24h (n=75, C2 99%), inside the
NPCI window (n=208, C1 98%). Aggregate macro-F1 is dominated by that trivial 40%.
On the hard 60% the model does add signal (0.390 vs the rule's 0.233) but it never
converts, because there the right action is "retry later" either way.

**Silent churn recall is 0.000** (explicit-webhook C4 is 1.000). C4 is defined by
invariance, but monthly mandates over 90 days give at most 3 attempts, so a failure
has at most 2 priors and 19 of 145 C4 attempts have none. The fix is a Phase-1
change — weekly mandates, and a lower `RECEIPT_VISIBLE_RATE` so C2 is genuinely
inferential — deliberately *not* made in response to these numbers.

**Recovery (rupees recovered / at risk, paired Δ vs `model_policy`).**

| policy | recovery | retries/failure | paired Δ |
|---|---|---|---|
| do_nothing | 0.0% | 0.00 | — |
| naive_retry T+24/72/168h | 31.6% | 2.54 | −27.0pp [−32.3, −22.1] |
| window_aware_retry | 46.3% | 2.22 | −12.4pp [−17.6, −7.6] |
| **rule_policy** | 57.9% | 1.55 | **−0.8pp [−2.6, +0.1]** |
| model_policy | 58.7% | 1.51 | — |
| oracle_policy | 60.4% | 1.39 | +1.7pp |

Naive retry recovers **0.0%** of C1: every one of T+24/72/168h preserves the hour and
lands back in the NPCI window. Half the gain over naive comes from knowing that
rule, not from the classifier.

**Exception queue.** 231 routed (21.0%): 211 insufficient history, 29 multi-cause
conflict, 16 ambiguous top-two. `outside_training_support` fires **0 times** on the
deployed model because all five banks are well represented; under the bank-holdout
model it fires on 43.1%, which is how the rule was verified rather than assumed.

The "<2 prior attempts" rule was **narrowed to fire only when no single observable
settles the call**. As literally specified it routed 65.7% and left macro-F1 on the
retained set at 0.888 — *below* the 0.901 of no routing at all, because it swept
away easy in-window and revoke-webhook cases and kept the residue. Narrowed, it
retains 79.0% at 0.931. Both figures are printed on every run so the queue can
never quietly cost quality.

The queue costs recovery: the agent recovers ₹292,888 with it against ₹385,691
without, because 231 attempts go to humans instead of being retried. That is a
merchant's call to make, so both numbers are reported.

## 6. Not built yet

- **P5** — hardening, README, video.
- The Claude layer is written and unit-tested against an adversarial stub but has
  **never been run against the live API** — no credentials in this environment.
- An intervention is budgeted to the cycle of the failure it answers but may be
  scheduled into the next calendar month; collision with that month's own debit is
  unhandled.

## 7. How to run

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy
npm run all          # generate → features → train → eval → report → policy → agent → digest
npm test             # 54 tests
npm run typecheck    # enforces the observation boundary at compile time

npm run digest -- --explain   # adds Claude prose; needs ANTHROPIC_API_KEY.
                              # Without it the pipeline runs identically, minus prose.
```
