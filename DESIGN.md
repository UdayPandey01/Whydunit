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
| `src/decision.ts` | Cost-sensitive stop rule, amount-aware threshold, EV retry budget. Shared by the agent and the offline policy. |
| `src/psp/types.ts` | `PspClient` — the one port the agent talks to. |
| `src/psp/simulated.ts` | The seeded world behind that port. Default; no credentials. |
| `src/psp/razorpay.ts` | Razorpay test-mode adapter: auth, retry, payment→Observation. |
| `src/psp/razorpay-codes.ts` | Documented code map plus the `UNMAPPED` gap list. |
| `src/psp/webhook.ts` | Signature verification and event mapping. No framework. |
| `src/whydunit.ts` | Public API: `attribute` / `plan` / `execute`. |
| `src/index.ts` | The exported surface. Everything else is internal. |
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


## 6. Presentation and verification

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

## 7. The integration seam (Phase 5)

**One port.** `PspClient` has four methods; the agent knows nothing else about the
outside world. `SimulatedPsp` wraps the seeded world, `RazorpayPsp` wraps the real
test-mode API. `tests/seam.test.ts` runs the same agent cycle against the simulator
and against a scripted PSP sharing no code with it, asserting the audit trails match
row for row — and runs it against a PSP that accepts everything, asserting the
intervention budget still binds.

**Notification state moved into the PSP**, which is where it lives in reality: the
agent asks for a notice and never learns whether the bank delivered it. The
simulator resolves a requested notice against the debit it precedes rather than
wall-clock time, because the world runs in simulated 2026 time.

**The agent is now async**, because a real PSP call is. The crash-safety ordering is
unchanged — TX1 commits intent and the budget, the effect happens, TX2 commits the
outcome — but `fire()` now consults the ledger **before** the effect rather than
after. That reordering matters: re-running a pure simulated adjudication was
harmless, whereas a second real charge is not.

**One window remains and is inherent to talking to another system.** A crash between
the PSP call landing and the ledger row committing leaves the effect done but
unrecorded, and the replay calls again with the same key. The simulator is pure so
this is harmless; a real PSP must dedupe on the key, which is why `idempotencyKey` is
on the interface rather than an implementation detail.

**A real debit returns `pending`.** Razorpay accepts the instruction and the outcome
arrives by webhook, so the agent cannot learn the result within the cycle. The
interface models this rather than pretending outcomes are synchronous.

**Public API.** `attribute` / `plan` / `execute`, each standalone. The default scorer
is the expert rule, capped at 0.90 confidence so it can never reach the C4 stop
threshold on its own — a rule cannot express invariance, so it must never be the
thing that abandons a mandate. Model probabilities enable cost-sensitive stopping.

**What is not verified.** The Razorpay adapter has never run against live
credentials; none were available. Auth, retry, signature verification and event
mapping are unit-tested against fixtures, not against a live key. Only C3 is
inducible in test mode — README has the full gap table.

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

## 9. Reproducibility and packaging

`docker compose up` runs the whole pipeline in one image: Node 24.19.0 for the
TypeScript stages, Python 3.11 with an exact `requirements.txt` for training and
evaluation. The build fails if the committed source does not typecheck. Verified by
cloning into `/tmp` and running it there — ~50s cold build, ~20s pipeline.

`.github/workflows/verify.yml` runs typecheck, tests, the full pipeline and
`npm run verify` on every push. The badge is the reproducibility claim executed
rather than asserted.

Hygiene sweep at Phase 7 found and fixed two things. `src/world/window.ts` had been
dead since the schedule helpers were extracted in Phase 3; deleting it exposed that
`generate.ts` hardcoded the restricted window as `hour >= 10 && hour < 13` instead of
reading it through `isRestrictedTime`, so the generator and the counterfactual replay
would have disagreed about C1 the moment `RESTRICTED_START_HOUR` changed. Fixed;
`world.jsonl` is byte-identical after the change. No secrets, no `.env`, no
`Math.random` anywhere in `src/`, and no `Date.now()` in the world, agent or PSP —
simulated time and wall-clock time do not mix.

## 10. Expected-value recovery: what was tried and what was kept

The Phase 4A stop rule prices one trade — a wrongful stop forfeits a mandate, a
wrongful retry costs a retry — as a fleet-wide **ratio**, giving every mandate the
same threshold of 0.952. That is amount-blind: a ₹149 mandate and a ₹4,999 mandate
are charged the same reluctance to give up. Two amount-aware variants were built
and measured against it.

**EV threshold** (`stopThresholdFor`). The same inequality priced in absolute
rupees: stop iff `P(C4) > V / (V + R)`, where `V` is the mandate and `R` is a fixed
per-retry cost (`COST_RETRY_RUPEES`, default ₹33). Gives up sooner on small mandates
(₹149 → 0.819) and fights harder for large ones (₹4,999 → 0.993).

**EV budget** (`retryBudgetFor`). A different question: not *whether* to stop but
*how many* retries a mandate is worth. Spend retry k only while
`P(success) × V > R`, so a mandate worth n breakevens buys n retries. At R=₹33 and
P=0.33 the breakeven is ₹100: ₹149 buys one retry, ₹499 buys three.

### Measured, 270-day run, paired bootstrap against the flat policy

| Variant | Δ ₹ recovered | Δ retries / failure | Break-even retry cost |
|---|---:|---:|---:|
| EV threshold | −0.07pp `[−0.16, −0.02]` | −0.02 `[−0.04, −0.01]` | ₹20 |
| EV budget | −2.31pp `[−3.12, −1.71]` | −0.31 `[−0.36, −0.26]` | ₹49 |
| EV threshold on the *rule* | +0.00pp exactly | +0.00 exactly | — |

**Kept: the flat threshold, as the default.** Both variants trade money for retries,
and the trade only pays above a retry cost the merchant has to supply. The EV
threshold clears its ₹20 break-even at the assumed ₹33, but nets about ₹965 on
₹20.87L — statistically detectable, economically noise, and not worth a second code
path under the simplicity rules. The EV budget does **not** clear its ₹49 break-even
at ₹33; it becomes the right policy only if a retry genuinely costs more than that.
Both ship as measured, opt-in variants with the break-even printed on every policy
run, because the number that decides between them belongs to the merchant.

### Two findings worth more than the feature

**Amount-weighting is inert against a predictor with degenerate probabilities.** The
expert rule answers 0 or 1, so every threshold in (0,1) yields the same decision and
the delta is *exactly* zero — not small, zero. Amount-weighting only bites on
calibrated beliefs in the middle of the range, which makes it a reason to care about
calibration rather than a policy trick. `tests/decision.test.ts` pins this.

**The diagnosis that motivated this work was wrong, and the measurement corrected
it.** The ₹149–299 band consumes 49% of all retries while holding 17% of the money
at risk, returning ₹84 per retry against ₹1,174 in the ₹1,500+ band. That 14× spread
was read as waste. It is not: ₹84 still clears a ₹33 retry cost, so those retries are
individually profitable — merely lower-yield. Cutting them, which is exactly what the
EV budget does, destroys more value than it saves. Lower-yield is not unprofitable,
and the only thing that distinguishes them is the retry cost.

## 11. Portable, not merely deterministic

`verify` passed on the arm64 dev machine and would have failed on the x86 CI
runner. The pipeline was deterministic on each platform and disagreed between
them: 17 of 3,116 lines of `predictions.jsonl` differed, with a maximum
probability delta of **5.55e-17** — one ULP. Zero predicted classes changed, and
`report.json`, `policy.json` and `evaluation.json` all matched byte for byte,
because everything downstream either takes an argmax or compares against a
threshold three orders of magnitude coarser than the noise.

The cause is that float64 `repr` is not portable. numpy and scipy bind different
BLAS backends per architecture, so a deterministic HistGradientBoosting fit can
land on different last bits, and hashing that representation makes a
reproducibility gate architecture-dependent rather than reproducible.

Probabilities are now rounded to 6 dp **at the serialization boundary in
`eval/evaluate.py`, never in the computation** — roughly eleven orders above the
observed noise and three below the tightest threshold anything downstream uses
(`P(C4) ≥ 0.952`, ambiguity margin `0.15`). Rows are not renormalised afterwards
and nothing consumes them as a normalised distribution. All eleven headline
metrics are unchanged.

`verify` now checks portability directly rather than inferring it from a hash, so
a recurrence names the cause instead of reporting an opaque mismatch. Confirmed by
running the full pipeline under `--platform linux/amd64` and comparing all ten
artifacts against the manifest built on arm64.

The general rule this establishes: **an artifact that is hashed as a
reproducibility claim must be canonical, not merely deterministic.** Determinism
is a property of one machine; portability is the property the claim actually needs.
