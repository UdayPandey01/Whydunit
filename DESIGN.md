# DESIGN

## 1. Current state

Phase 1 is done: a seeded world simulator generates ~5,800 UPI AutoPay debit
attempts across 2,000 mandates over 90 days, where the failure cause of each
attempt is emergent rather than assigned. An observation layer strips the world
down to what a merchant could actually see and writes it to a separate file.
`npm run generate` produces both files and reproduces byte-for-byte on rerun.

## 2. Module map

| File | What it does |
|---|---|
| `src/config.ts` | Every simulation knob as a named constant: run size, seed, restricted window, per-bank notification reliability and outages, salary/spend/buffer distributions, churn hazard, amount tiers, decline-code weights. |
| `src/time.ts` | IST wall-clock helpers over epoch-ms, plus `toIso` and `round`. Isolates all calendar maths from the host timezone. |
| `src/rng.ts` | mulberry32 seeded PRNG and draw helpers (`uniform`, `int`, `bernoulli`, `normal`, `lognormal`, `weighted`, `clamp`). |
| `src/world/types.ts` | `Cause`, `Customer`, `Mandate`, `WorldRecord` — the full-state shapes, ground truth included. |
| `src/world/window.ts` | C1. `isRestricted(ms)` — is this attempt inside the 10:00–13:00 IST NPCI window. |
| `src/world/notification.ts` | C2's hidden half. `isBankOutage`, `wasDeliveredByBank` — per-bank reliability plus injected outage intervals. |
| `src/world/balance.ts` | C3. `balanceAt(customer, ms)` — salary credit, front-loaded spend decay, shocks. Pure function of drawn parameters and the clock. |
| `src/world/churn.ts` | C4. `drawChurn(...)` — inverts a geometric hazard to pick a cancellation instant, and decides whether it emits a webhook. |
| `src/world/generate.ts` | Draws the population, steps the horizon, asks all four processes about every attempt, and records the emergent cause. |
| `src/observe.ts` | THE BOUNDARY. `ObservedAttempt` type + `observe()`. Merchant-visible fields only. |
| `src/cli.ts` | `generate` command: writes both JSONL files and prints the summary. |
| `tests/boundary.test.ts` | Ground truth cannot cross the boundary — asserts on serialized keys and values. |
| `tests/determinism.test.ts` | Same seed → byte-identical output; timezone-independent; observation seed cannot move the world. |
| `tests/baserates.test.ts` | Failure rate, class imbalance, multi-cause rate, and the anti-leakage check on decline codes. |

## 3. Data flow

```
config.ts (constants)
     │
     ▼
generateWorld({seed, mandates, horizonDays})
     │  drawCustomer  ─┐
     │  drawMandate   ─┤  two RNG streams:
     │                 │    rng      → population + world dynamics
     │  per attempt:   │    codeRng  → decline codes only
     │    drawAttemptHour
     │    churn?  ──► blockers.push("C4")   ┐ push order
     │    notification? ──► push("C2")      │ IS
     │    window? ──► push("C1")            │ precedence
     │    balance? ──► push("C3")           ┘
     │    cause = blockers[0]
     │    multi_cause = blockers.length > 1
     ▼
WorldRecord[]  ──────────────────────────────► data/world.jsonl
     │           {..., cause, blockers, multi_cause, world:{balance, churn, ...}}
     │
     ▼  observe(world, OBSERVATION_SEED)   ← third, independent stream
ObservedAttempt[]  ─────────────────────────► data/observations.jsonl
                 {attempt_id, mandate_id, timestamp, bank, amount, max_amount,
                  frequency, mandate_age_days, attempt_index, success, error_code,
                  notification:{dispatched_at, hours_before_debit, receipt},
                  prior_attempts[], lifecycle_events[]}
```

## 4. Key decisions

- **Precedence is churn → notification → window → balance.** It is real
  chronology, but the binding reason is the invariance spine: if churn were
  evaluated last, a cancelled customer's failures would sometimes be labelled C3
  and C4 would lose the "nothing fixes it" signature that identifies it.
- **All four processes are always evaluated, never short-circuited.** `multi_cause`
  needs to know who else would have blocked.
- **`ObservedAttempt` is defined positively, not as `Omit<WorldRecord, ...>`.**
  Subtraction would make the visible set a residue, so any new world field would
  become visible by default.
- **The hidden-key list is written by hand, not derived from `WorldRecord`.** A
  derived union is self-defeating — adding a ground-truth field to the observation
  type would remove it from the union and the guard would silently pass.
- **No spread operator anywhere in `observe.ts`.** Every field is copied
  explicitly; a spread is exactly how a new world field would leak unnoticed.
- **Decline codes are deliberately lossy.** This is the only place cause
  information reaches an observable, so every code appears under several causes;
  a test fails the build if any code exceeds 95% purity.
- **C4 splits its code table by whether it emitted a webhook.** Silent churn
  produces generic and funds-shaped declines, which is why it can only be told
  apart from C3 by invariance over repeated attempts.
- **Attempt hour is drawn per attempt, not per mandate.** A fixed per-mandate hour
  would make C1 repeat forever for that mandate and become indistinguishable from
  C4 under the invariance test.
- **`WINDOW_HIT_RATE` sets C1's base rate, not the window rule.** Uniform business-
  hour scheduling would put ~30% of attempts in the window and C1 would swamp
  everything.
- **Three separate RNG streams** (world, decline codes, observation). Retuning the
  code table or the observation layer must not move who churned. See INCIDENTS #1.
- **`balanceAt` is a pure function of drawn parameters and the clock**, not a
  mutable ledger — reproducibility for free, and no ordering hazards.
- **One customer per mandate in P1.** Keeps `balanceAt` pure by dodging the
  question of two debits depleting one balance in the same month.
- **Churn and balance are statistically independent.** A real churner probably also
  stops funding the account; modelling that correlation is P2 work at the earliest.
- **snake_case in the serialized types**, so Python reads the JSONL in P2 with no
  mapping layer.
- **Zero runtime dependencies.** Node 22.6+ strips TypeScript natively and
  `node:test` is built in; `typescript` is a devDependency purely so `tsc --noEmit`
  can enforce the boundary that type stripping does not check.

## 5. Measured output (seed 20260903)

```
attempts 5804   failures 1098 (18.9%)
  C3_BALANCE_SHORTFALL  579   52.7% of failures
  C1_EXECUTION_WINDOW   204   18.6%
  C2_NOTIFICATION_FAIL  170   15.5%
  C4_CANCELLATION       145   13.2%
multi-cause 76 (6.9% of failures)
max P(cause | decline code): Z9 90.6% → C3, ZA 70.5% → C4, rest ≤ 46%
delivery receipt visible on 69.3% of attempts; 115 attempts under silent churn
```

Multi-cause lands at 6.9% against a ~5% target. It is left where it falls: the
rate is emergent from four independent processes, and forcing it to 5% would mean
coupling them, which is a worse lie than the 2-point miss.

## 6. Not built yet

- **P2** — feature extraction from observations, scikit-learn classifier as a
  script, eval harness, baselines (majority class, decline-code lookup).
- **P3** — the agent: interventions, hard constraints, audit log, crash-resume,
  SQLite runtime state.
- **P4** — exception queue, merchant report, LLM explanation layer.
- **P5** — hardening, README, video.

Nothing in `src/` scaffolds for these.

## 7. How to run

```bash
npm install
npm run generate     # writes data/world.jsonl and data/observations.jsonl
npm test             # 16 tests
npm run typecheck    # enforces the observation boundary at compile time
```
