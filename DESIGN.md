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
| `src/decision.ts` | Cost-sensitive stop rule. Shared by the agent and the offline policy. |
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
| `src/render.ts` | Terminal primitives: self-sizing tables, semantic colour, sparklines, progress. Computes nothing. 143 lines. |
| `src/copy.ts` | Human-readable labels. Mirrors the agent's action map, never leads it. |
| `src/cli.ts` | `generate` \| `features` \| `report` \| `policy` \| `agent` \| `digest` \| `explain` \| `verify` \| `demo`. |
| `eval/train.py` | Fits HistGradientBoosting per split → `model.pkl`, `support.json`. |
| `eval/evaluate.py` | P/R/F1, macro-F1, confusion, calibration, ECE, all with cluster-bootstrap CIs. |
| `tests/*.test.ts` | Boundary, determinism, base rates, feature causality, constraints, crash-resume, routing, LLM containment. 54 tests. |

## 3. Data flow

```
generateWorldFull() ─► world.jsonl          ground truth, never read downstream
   └─ observe() ─────► observations.jsonl   merchant-visible only
        └─ computeFeatures()  ← observations ONLY, strictly point-in-time
             + label joined in cli.ts + assignSplits() ─► features.jsonl
                  ├─ eval/train.py    ─► model.pkl, support.json
                  └─ eval/evaluate.py ─► evaluation.json, predictions.jsonl
                       ├─ report ─► report.json, exceptions.jsonl
                       ├─ policy ─► policy.json
                       └─ agent  ─► agent.db  ─► digest ─► digest.txt
```

Everything CHOOSES from observations and predictions; whether an action would have
worked is adjudicated by replaying the world. The agent's per-intervention ordering
is what makes a crash safe:

```
TX1  audit(pending) + budget++        commit   ← budget spent before the effect
fire INSERT OR IGNORE psp_ledger      commit   ← the effect itself, keyed
TX2  audit(completed) + cycle status  commit
```

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
- **Stopping is cost-sensitive, not argmax.** Argmax treats a wrongful stop and a
  wrongful retry as equally bad; one forfeits a mandate, the other costs a retry.
  The threshold comes from that ratio, and the sweep is printed on every run with a
  net-value column, because recovery rises monotonically across 0.50–0.95 and
  picking the maximum would be a corner rather than a choice.
- **No debit is generated after an explicit revoke.** A revoked mandate is dead at
  the PSP. Silent churn is deliberately untouched — those mandates keep failing.
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

Horizon is a swept parameter (`WHYDUNIT_HORIZON`); every figure below carries its
horizon. Two policy bugs were fixed first — see INCIDENTS #10 — so these supersede
all earlier numbers.

**Classification, macro-F1 out-of-fold, model minus hand-written expert rule
(paired, 95% cluster bootstrap).** The model's entire edge is silent churn, which a
single-attempt rule cannot express, so the edge only exists once mandates have
enough history for invariance to show.

| horizon | failures | ECE | model − rule | verdict |
|---|---|---|---|---|
| 90d | 975 | 0.064 | +0.001 [−0.007, +0.008] | ties |
| 180d | 2,114 | 0.080 | **+0.141 [+0.116, +0.163]** | wins |
| 270d | 3,116 | 0.093 | **+0.181 [+0.158, +0.198]** | wins |
| 360d | 4,264 | 0.061 | **+0.201 [+0.181, +0.218]** | wins |

ECE stays at or below 0.093 on every mandate split, so probabilities are
trustworthy enough to threshold on directly; no isotonic calibration was fitted.

**Recovery, rupees recovered / at risk, and retries per failure.** Stopping uses
P(C4) ≥ 0.952, derived from a cost matrix where a wrongful stop forfeits a whole
mandate and a wrongful retry costs 0.05 of one.

| horizon | naive | rule | model | oracle | Δ₹ vs rule | Δretries vs rule |
|---|---|---|---|---|---|---|
| 90d | 34.4% | 68.4% | 68.5% | 70.2% | +0.11pp [−0.46, +0.77] | −0.006 [−0.015, +0.001] |
| 180d | 30.9% | 64.4% | 64.1% | 66.0% | −0.24pp [−0.58, +0.04] | **−0.078 [−0.106, −0.052]** |
| 270d | 33.3% | 62.9% | 63.1% | 64.8% | +0.14pp [−0.56, +0.79] | **−0.153 [−0.191, −0.119]** |
| 360d | 30.5% | 61.4% | 61.8% | 62.8% | +0.38pp [−0.07, +0.76] | **−0.190 [−0.235, −0.151]** |

**The rule remains the production retry policy.** The agreed bar was to beat it on
rupees *and* retries with a CI clear of zero; on rupees the difference straddles
zero at all four horizons. The model is significantly cheaper from 180d and
significantly better at attribution, so it earns its place in the exception queue
and the merchant report — but not, on this evidence, in the retry decision.

Naive retry still recovers **0.0%** of execution-window failures: T+24/72/168h all
preserve the hour and land back inside the NPCI window.

## 6. Not built yet

- **P5** — hardening, README, video.
- The Claude layer is written and unit-tested against an adversarial stub but has
  **never been run against the live API** — no credentials in this environment.
- An intervention is budgeted to the cycle of the failure it answers but may be
  scheduled into the next calendar month; collision with that month's own debit is
  unhandled.

## 7. Presentation and verification

`render.ts` (143 lines) and `copy.ts` are display only. Tables size their own
columns, so the width arithmetic that used to tear box frames cannot occur.
Colour is semantic: green beats the baseline, red is worse, yellow means the
interval straddles zero. Every command fits 79 columns, checked by scanning
rendered output.

`explain <mandate_id>` walks one mandate: observations, what was *not* observable,
the invariance test, competing hypotheses, attribution, action and constraint
checks, outcome — ground truth **last**, labelled evaluation-only. Three reference
mandates are pinned in README.md.

`verify` regenerates the seeded world in-process, re-hashes every artifact against
`reference/manifest.json`, and compares eleven headline scalars so a failure names
the metric that moved. Exits non-zero on mismatch; `--full` re-runs the pipeline
to catch Python-side drift. Proven to fail: corrupting `policy.json` and running a
different horizon both exit 1.

`demo` and `explain` are views — they read finished artifacts and run no pipeline
stage. Python eval output is untouched: it is the methodology report.

## 8. How to run

```bash
npm install
python3.11 -m venv .venv && .venv/bin/pip install scikit-learn numpy
WHYDUNIT_HORIZON=180 npm run all   # any horizon; default 270
npm run policy -- --cost-ratio 10  # override the stop threshold

npm run demo                       # the dashboard
npm run explain mdt_00004          # one mandate, end to end
npm run verify                     # reproducibility proof, exits non-zero on drift

npm run all          # generate → features → train → eval → report → policy → agent → digest
npm test             # 54 tests
npm run typecheck    # enforces the observation boundary at compile time

npm run digest -- --explain   # adds Claude prose; needs ANTHROPIC_API_KEY.
                              # Without it the pipeline runs identically, minus prose.
```
