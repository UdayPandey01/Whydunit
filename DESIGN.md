# DESIGN

## 1. Current state

Phases 1–3 are done. A seeded world simulator produces ~5,800 UPI AutoPay debit
attempts whose failure causes are emergent, an observation layer exposes only
merchant-visible fields, and 43 strictly point-in-time features feed a classifier
evaluated on three splits with bootstrap CIs. A durable agent then executes
cause-matched interventions under four code-enforced constraints, writing an audit
record for every decision and surviving `kill -9` at any point without double-firing.
**The classifier is not distinguishable from a four-line expert rule** — see §5.

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
| `src/schedule.ts` | NPCI-window avoidance, salary-date targeting, billing-cycle key. Shared by policy and agent. |
| `src/world/replay.ts` | Counterfactual adjudication: what the four processes would have said at another time. |
| `src/agent/db.ts` | SQLite schema: `audit_log`, `cycle_state`, `psp_ledger`. WAL + `synchronous=FULL`. |
| `src/agent/psp.ts` | The simulated PSP. The keyed ledger INSERT *is* the side effect. |
| `src/agent/constraints.ts` | The four hard constraints and the branded `CheckedPlan`. |
| `src/agent/agent.ts` | `decide` → `scheduleFor` → `checkConstraints` → `execute`, plus resume. |
| `src/cli.ts` | `generate` \| `features` \| `policy` \| `agent`. |
| `eval/train.py` | Fits one HistGradientBoosting per split → `model.pkl`, `metrics.json`. |
| `eval/evaluate.py` | P/R/F1, macro-F1, confusion, calibration, ECE, all with cluster-bootstrap CIs; baselines; out-of-fold predictions. |
| `tests/*.test.ts` | Boundary, determinism, base rates, feature causality, constraints, crash-resume. 40 tests. |

## 3. Data flow

```
generateWorldFull() ─► world.jsonl        {cause, blockers, multi_cause, world:{...}}
   └─ observe() ─────► observations.jsonl  merchant-visible only
        └─ computeFeatures()  ← observations ONLY, strictly point-in-time
             + label joined in cli.ts + assignSplits() ─► features.jsonl
                  ├─ eval/train.py    ─► model.pkl, metrics.json
                  └─ eval/evaluate.py ─► evaluation.json
                       └─ out-of-fold preds (GroupKFold by mandate) ─► predictions.jsonl
                            ├─ src/policy.ts  5 policies ─► policy.json
                            └─ src/agent/agent.ts ─► agent.db

agent, per failure, up to 3 times:
   decide ─► scheduleFor ─► checkConstraints ─┬─ vetoed ─► audit(blocked), terminal
                                              └─ CheckedPlan
        TX1  audit(pending) + budget++          commit
        fire INSERT OR IGNORE psp_ledger        commit  ← the effect
        TX2  audit(completed) + cycle status    commit
```

Policies and the agent CHOOSE from observations and predictions; whether an action
would have worked is adjudicated by replaying the world.

## 4. Key decisions

**Phase 1**

- Precedence is churn → notification → window → balance: real chronology, but the
  binding reason is that C4's signature is "nothing fixes it", which only holds if
  churn is evaluated first. All four are always evaluated, never short-circuited,
  so `multi_cause` can see who else would have blocked.
- `ObservedAttempt` defined positively, hidden-key list hand-written, no spread in
  `observe.ts`. Each of the three alone would let a new world field leak.
- Decline codes deliberately lossy; a test fails the build above 95% purity.
- Three RNG streams (world / decline codes / observation) so retuning a reporting
  layer cannot move who churned. See INCIDENTS #1.

**Phase 2**

- **Features are strictly point-in-time.** Trailing windows are half-open on the
  attempt's own timestamp, mandate history comes from `prior_attempts`, and a revoke
  webhook arriving *after* the attempt is filtered out. A retrospective model would
  score better and be useless to the agent, which decides at failure time.
  `tests/features.test.ts` proves it by deleting the future and asserting the past
  does not move.
- **No raw bank identity in the matrix**, only bank-*relative* statistics —
  otherwise the bank-holdout split measures nothing.
- **Rows are failed attempts only** (1,098); successes still feed trailing statistics.
- **No `class_weight="balanced"`** — it would lift macro-F1 on small classes while
  wrecking the calibration ECE measures. Hyperparameters set once from defaults and
  never tuned against test scores.
- **Bootstrap resamples mandates, not rows.** Attempts on one mandate share a
  customer, balance trajectory and churn state; a row bootstrap would be too narrow.
- **Paired difference, not overlapping CIs**, when comparing two predictors on the
  same batch — the weaker test would have called the null result a win.
- **Outcomes are adjudicated by the world, not the model**, for both the offline
  policy and the live agent. Equal retry budget of 3 everywhere, so the comparison
  is about *where* retries go, not how many.

## 5. Results, including the null result

Classification, macro-F1 with 95% cluster-bootstrap CI (n=1000):

| split | model | expert rule | code lookup | majority | paired model − rule |
|---|---|---|---|---|---|
| mandate | 0.935 | 0.930 | 0.373 | 0.168 | **+0.004 [−0.014, +0.023]** |
| bank | 0.808 | 0.866 | 0.250 | 0.165 | **−0.058 [−0.087, −0.030]** |
| time | 0.878 | 0.872 | 0.418 | 0.163 | **+0.006 [−0.007, +0.021]** |
| out-of-fold n=1098 | 0.901 | 0.895 | — | — | **+0.006 [−0.006, +0.018]** |

Recovery, rupees recovered / rupees at risk, paired CI against `model_policy`:

| policy | recovery | retries/failure | paired Δ vs model |
|---|---|---|---|
| do_nothing | 0.0% | 0.00 | — |
| naive_retry T+24/72/168h | 31.6% | 2.54 | −27.0pp [−32.3, −22.1] |
| window_aware_retry | 46.3% | 2.22 | −12.4pp [−17.6, −7.6] |
| **rule_policy** | 57.9% | 1.55 | **−0.8pp [−2.6, +0.1]** |
| model_policy | 58.7% | 1.51 | — |
| oracle_policy (ground truth) | 60.4% | 1.39 | +1.7pp |

**The null result, stated plainly.** The gradient-boosted classifier is not
distinguishable from four if-statements on macro-F1 (mandate, time, out-of-fold),
is significantly *worse* on unseen banks, and the recovery policy it drives is not
distinguishable from the same rule (0.8pp, CI straddles zero). Nothing was tuned
in response to this.

**Diagnosis.** 40% of failures are settled by one directly-observed boolean, each
near-pure: a revoke webhook (n=88, C4 100%), a receipt saying FAILED (n=66, C2
100%), dispatch under 24h (n=75, C2 99%), inside the NPCI window (n=208, C1 98%).
The remaining 661 are the hard ones — nothing observable explains them, and they
are 88% C3, 54 silent-C4, 28 hidden-C2.

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

## 6. The agent (Phase 3)

**Actions.** `reschedule` (C1, C3), `refire_notification_then_reschedule` (C2),
`stop` (C4 or an explicit revoke), `escalate_to_human` (confidence < 0.6, budget
spent, no legal slot inside the horizon, or a constraint veto).

**The four hard constraints are code, and load-bearing in the type system.**
`checkConstraints` is the only function that can mint a `CheckedPlan`, and
`execute` accepts nothing else, so no code path reaches the PSP unchecked. They are
`max_interventions_per_cycle`, `never_schedule_in_restricted_window`,
`never_schedule_debit_within_24h_of_notification`, `never_retry_after_cancellation`.
Each is recorded per decision as passed / failed / **skipped** — never "passed" when
it merely did not apply.

**Crash safety does not depend on the agent's bookkeeping being intact.** The
idempotency key is `mandate:cycle:attempt_no`, so a replay recomputes it exactly;
the PSP ledger has it as PRIMARY KEY, so the second insert is a no-op. Intent and
budget consumption commit in one transaction *before* the effect is attempted,
which is why a crash can never hand a mandate a fourth intervention. Resume simply
re-runs `fire` for every pending row: if the effect happened the ledger returns the
stored result, and if it did not, it happens now. Nothing needs to know where the
crash landed.

`tests/crash.test.ts` SIGKILLs the agent from the inside at 30 distinct points,
resumes, and asserts the PSP ledger and the audit log are identical to an
uninterrupted run. It carries two positive controls: that the children were really
killed, and that a crash really does leave work unfinished. Injecting a
non-deterministic idempotency key makes it fail immediately.

Result on the full batch: 659 recovered, 183 escalated, 152 exhausted, 104 stopped;
₹385,691 of ₹658,952 recovered (58.5%), independently reproducing Phase 2's offline
58.7% from a separate code path. That agreement is what caught INCIDENTS #4.

**Known simplification.** An intervention is budgeted to the cycle of the failure it
answers, but may be scheduled into the next calendar month; collision with that
month's own debit is a Phase 4 concern.

## 7. Not built yet

- **P4** — exception queue, merchant report, LLM explanation layer.
- **P5** — hardening, README, video.

## 8. How to run

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy
npm run all        # generate → features → train → eval → policy → agent
npm test           # 40 tests
npm run typecheck  # enforces the observation boundary at compile time
```
