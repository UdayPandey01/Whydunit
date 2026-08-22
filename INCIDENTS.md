# INCIDENTS

Real failures only, written when they happen. Not reconstructed, not invented.

---

## #1 — 2026-08-21 — Retuning the decline-code table changed who churned

**Symptom.** I changed two balance knobs and the decline-code weights table, both
of which should be downstream of churn. C4 went from 14.9% to 22.6% of failures,
and the count of mandates with a churn date drawn moved from 139 to 167.

**First hypothesis.** The balance change altered which attempts failed, so
already-churned mandates simply became more visible in the mix.

**The diagnostic that disproved it.** I printed the number of distinct mandates
with a non-null `churned_at` directly, rather than counting C4 failures. That
number is fixed during population construction, before any attempt is evaluated,
so it cannot depend on balance outcomes. It moved anyway. Something was shifting
the draw itself.

**Root cause.** `errorCodeFor` drew from the same RNG as the world processes, and
it only draws on a *failed* attempt. The attempt loop is nested inside the
per-mandate loop, so changing the number of failures changed how many numbers were
consumed before the next mandate's `drawChurn` call. Every mandate after the first
behaviour change got a different position in the stream. A conditional draw was
sharing a stream with the process whose outcome the condition depended on.

**Fix and what it traded away.** Decline codes now draw from `makeRng(seed ^
0x9e3779b9)`, a separate stream. Cost: three streams instead of one, and the
seed→output mapping changed once, so any data generated before this is void.

**What it changed about the design.** RNG streams are now scoped by role — world
dynamics, reporting artifacts, observation layer — and that scoping is a stated
decision in DESIGN.md rather than an accident. `tests/determinism.test.ts` now
asserts that reseeding the observation layer leaves the world byte-identical, which
would have caught this class of bug directly.

---

## #2 — 2026-08-21 — `ZA` was a 100% pure predictor of C4

**Symptom.** The first decline-code purity audit read
`ZA n=49 C4_CANCELLATION 100%`. Every attempt carrying that code was a
cancellation, with no exceptions.

**First hypothesis.** Acceptable. `ZA` means "transaction declined by customer",
so a strong association with cancellation is realistic, and base rates would dilute
it once the run got bigger.

**The diagnostic that disproved it.** The cross-tab of code against cause showed
`ZA` occupying exactly one row. Base rates cannot dilute a code that no other cause
is capable of emitting — the purity was structural, not sampling noise. That makes
`ZA` the label under a different name, and CLAUDE.md's rule is that no feature may
encode the generating mechanism. A classifier would have scored those 49 cases
perfectly by lookup while learning nothing.

**Root cause.** `ERROR_CODE_WEIGHTS` assigned `ZA` weight only under
`C4_EXPLICIT` and `C4_SILENT`. I had written the table intending overlap
everywhere and left one column exclusive.

**Fix and what it traded away.** `ZA` now carries small weight under C1 (0.02),
C2 (0.05) and C3 (0.02); purity fell to 70.5%. The trade is a little realism — a
funds shortfall surfacing as "declined by customer" is an odd mapping, though banks
do produce worse — in exchange for the guarantee that no code is a label alias.

**What it changed about the design.** Purity is now enforced rather than
remembered. `tests/baserates.test.ts` fails the build if any decline code exceeds
95% purity or ever appears under only one cause, and `npm run generate` prints the
purity table on every run so the number is never out of sight.

---

## #3 — 2026-08-21 — A diagnostic counted more retries than existed

**Symptom.** The policy report printed, on adjacent lines, that `model_policy` spent
123 retries on C4 attempts in total and 148 retries on silent-churn attempts. Silent
churn is a subset of C4, so the subset was larger than the set containing it.

**First hypothesis.** A double-count in the retry accumulator — the same outcome
being summed twice across policy variants sharing an array.

**The diagnostic that disproved it.** The C4 total and the silent total were summed
from the same `outcomes.model_policy` array in the same loop, so a double-count
would have inflated both equally and preserved the ordering. It did not. The two
sums differed in their *filter*, not their arithmetic.

**Root cause.** `churned_at` is a property of the **mandate**, not of the attempt. It
is set on every attempt of a mandate that cancels at any point, including attempts
that happened *before* the cancellation and failed for an entirely different reason.
The silent-churn filter tested `churned_at !== null && !churn_emits_event`, which
selects "attempts belonging to a mandate that silently churns eventually" — a
strictly larger set than "attempts whose cause is silent churn". The C4 filter tested
`cause === "C4_CANCELLATION"`, which is attempt-scoped and correct.

**Fix and what it traded away.** The filter now tests
`cause === "C4_CANCELLATION" && !churn_emits_event`. Nothing was traded; the previous
number was simply wrong. It never reached a committed result, and it never touched
training, features or the observation boundary — only a printed diagnostic.

**What it changed about the design.** Mandate-scoped and attempt-scoped state read
identically at the call site (`f.world.churned_at` vs `f.cause`) while meaning
different things, and nothing in the types distinguishes them. The lesson recorded
here is that any filter reading `world.churned_at` on an attempt row is suspect and
should be scoped by `cause` instead. That is worth remembering into Phase 3, where
the agent will hold per-mandate state and ask per-attempt questions of it.

---

## #4 — 2026-08-21 — The agent recovered money in a month that was never simulated

**Symptom.** The first full agent run reported 66.7% of at-risk rupees recovered.
Phase 2's offline policy comparison, running the same cause-matched actions over
the same 1,098 failures, reported 58.7%. Two implementations of one policy should
not disagree by eight points.

**First hypothesis.** The agent gets a fresh decision each pass around its loop
while the offline simulator committed to one schedule up front, so the agent was
simply getting more out of its three retries.

**The diagnostic that disproved it.** Both give every failure the same budget of
three, and the agent's own audit log showed 1,838 interventions against the offline
run's comparable count — the budgets matched. So I stopped comparing totals and
asked the audit log *when* the interventions were scheduled:
`SELECT scheduled_at ... WHERE scheduled_at >= horizon_end`. 215 of them landed
after day 90, and 93 of those were booked as recoveries.

**Root cause.** The offline simulator had an explicit guard — a retry falling
outside the observation horizon is neither spent nor credited — and I did not carry
it into the agent. The world model happily answers questions about any timestamp,
because `balanceAt` and the churn hazard are defined for all time. So the agent
scheduled into April, the world adjudicated April, and 12% of its recoveries came
from a month for which no data was ever generated. The C3 third action,
"retry just after the next likely salary date", was 209 of the 215.

**Fix and what it traded away.** `scheduleFor` now returns `null` when no legal
slot exists inside the horizon, and the planner turns that into
`escalate_to_human` rather than a silent no-op. Recovery fell to 58.5%, which
matches the offline number. The trade is 183 escalations that a longer horizon
would have let the agent handle itself, and it is the honest trade: the agent now
refuses to act where it cannot account for the outcome.

**What it changed about the design.** A world that answers every question will
happily answer questions outside the data you generated, and nothing in the types
marks the boundary. The horizon is now a named constant the planner consults
(`HORIZON_END_MS`), a test asserts the planner proposes nothing beyond it, and the
rule for Phase 4 is that any new component touching simulated time states its
valid range explicitly. The bug was caught only because Phase 2 had produced an
independent number for the same quantity; without that cross-check it would have
shipped as a headline.

---

## #5 — 2026-08-21 — The LLM-containment test was matching prose, not imports

**Symptom.** `tests/explain.test.ts` failed with
`../src/exceptions.ts references the explanation layer`. That file has no LLM
code in it at all, and the pipeline it guards was demonstrably working.

**First hypothesis.** A stale build artifact, or the test resolving the wrong file
through `import.meta.url`.

**The diagnostic that disproved it.** Printing the matched region showed the hit
was inside an ordinary English sentence I had written minutes earlier — the
evidence line *"outside the 10:00-13:00 window, so the window does not explain
it"*. The test was doing `src.includes("explain")` against the whole file, so any
use of the word in a comment or a user-facing string counted as an import.

**Root cause.** The central claim of Phase 4 is that Claude cannot reach the
scoring path. I had written the test that proves it as a substring search over
source text rather than a check on the module graph. It happened to fail loudly
here, but the same construction fails the other way just as easily: rename the
module to `narrate.ts` and the test goes green while the import is still there. A
guarantee checked by grepping for a word is not a guarantee.

**Fix and what it traded away.** The test now extracts import specifiers with a
regex over `from "..."` and asserts none of them names the explanation layer or
the SDK, plus a second test asserting the Anthropic SDK is imported in exactly one
file in the whole project. Nothing was traded — the previous check was strictly
weaker.

**What it changed about the design.** Every structural guarantee in this project
is now checked against structure rather than text: the observation boundary
asserts on serialized keys, the constraint layer is enforced by a branded type the
checker alone can mint, and LLM containment is checked on the import graph. The
one remaining text-based check — `observe.ts` contains no spread operator — is
backed by the key-allowlist test, so it is a convenience rather than the guarantee
itself. Where a property can be made unrepresentable, a test that greps for it is
the wrong tool.

---

## #6 — 2026-08-21 — The merchant digest reported the previous cycle's recovery

**Symptom.** None visible. A full `npm run all` printed a digest whose "Recovery
this cycle" figures were correct, and the pipeline was green end to end. The bug
was spotted only by reading the run order in the output rather than the numbers.

**First hypothesis.** Nothing was wrong — the figures matched the agent run in the
same output, line for line.

**The diagnostic that disproved it.** `npm run all` orders the steps
`... report && policy && agent`, so `report` — which rendered the digest — ran
*before* the agent that produced the outcomes it was reporting. Moving
`data/agent.db` aside and re-running `report` made the entire "Recovery this
cycle" section disappear rather than error. The figures had matched only because
the whole pipeline is deterministic and the previous run had produced identical
numbers.

**Root cause.** Two things collided. The agent needs `exceptions.jsonl`, which
`report` produces, so `report` must run first — but the digest summarises the
agent's results, so it must run last. One command could not honestly do both.
Compounding it, `renderDigest` took `agent: Record<string, number> | null` and
silently omitted the section when null, so the absent case looked like a design
choice instead of a missing dependency. On a fresh clone the section would simply
be missing; on any second run it would print the prior cycle's numbers under a
heading claiming they were current.

**Fix and what it traded away.** Split into `report` (attribution + exception
queue) and `digest` (merchant summary), with the agent between them, and made the
agent tally a **required** argument so the null path cannot exist. `digest` throws
if `report.json` or `agent.db` is missing. The type checker immediately found a
test still passing `null`, which is the change working. Cost: one more pipeline
step, and `--explain` moved to `digest` — where it belongs, since it can now
report each attribution's real action and outcome instead of the placeholder
string "see audit log" it had been emitting.

**What it changed about the design.** A nullable argument that makes a section
vanish is a silent failure mode wearing the costume of a feature. Where a stage
genuinely depends on an earlier one, the dependency is now a required parameter
and a hard error, not an `if (x !== null)`. This is the second defect in this
project found by reading execution order rather than output — INCIDENTS #4 was
the first — and both were invisible precisely because determinism made stale data
look identical to fresh data.

---

## Backfill note

Entries #7–#9 are backfilled. They are real, and every number in them was measured,
but they were written after the fact rather than as they happened — which is
exactly what this file is supposed to prevent. #7 and #9 were reconstructed from
measurements already recorded in DESIGN.md; #8's decisive diagnostic (the horizon
sweep) did not exist when the finding was made and was run on 2026-08-22 to test a
claim that until then had only been an argument.

---

## #7 — 2026-08-21 (backfilled) — The abstention rule made the queue worse than no queue

**Symptom.** The exception router, built to the specified rule "route when fewer
than 2 prior attempts", sent 65.7% of failures to human review and left macro-F1
on the retained set at 0.888 — *below* the 0.901 achieved by classifying
everything and routing nothing.

**First hypothesis.** The threshold was simply too aggressive; a smaller prior-count
cutoff would trade volume for quality along a normal curve.

**The diagnostic that disproved it.** Splitting the routed set by what else was
observable. Of the 721 failures the rule caught, a large share were attempts sitting
plainly inside the NPCI window, or carrying a revoke webhook — cases with 98-100%
label purity that need no history at all. The rule was not on a volume/quality
curve; it was removing the *easiest* cases. That is why retained quality fell
rather than rose.

**Root cause.** The rule conflated "no history" with "no signal". History is only
decisive when nothing else is. Written as a blanket condition it fires hardest on
early attempts, which are disproportionately the trivially-attributable ones.

**Fix and what it traded away.** The rule now fires only when no single observable
already settles the call. Retention rose to 79.0% at macro-F1 0.931. The trade is
that a payment with thin history *and* one decisive observable is now auto-handled
where a human would previously have seen it — deliberate, since the observable is
98-100% pure.

**What it changed about the design.** Both figures — retained macro-F1 and
all-failures macro-F1 — are printed on every run, side by side. A queue that costs
quality can no longer hide behind the fact that its own retained number looks good.

---

## #8 — 2026-08-21 (backfilled) — Silent-churn recall was 0.000 and the model was blamed

**Symptom.** At a 90-day horizon the classifier recalled 100% of explicit-webhook
cancellations and **0.000** of silent ones. Silent churn is the case the project
exists to solve.

**First hypothesis.** A modelling failure. C4 is the smallest class, so the obvious
reading was that the gradient booster had collapsed it into C3 and needed class
weighting or a threshold adjustment.

**The diagnostic that disproved it.** Not a model change — a horizon sweep. C4 is
defined by *invariance*: nothing fixes it. Invariance is a statement about repeated
attempts under varied conditions, so it cannot be observed at all unless a mandate
has several. At 90 days a monthly mandate gets at most 3 attempts, so a failure has
at most 2 priors and 19 of 145 C4 attempts had none. Re-running at 90/180/270/360
days settled it: the model's advantage over a hand-written rule goes
+0.001 → +0.141 → +0.181 → +0.201 macro-F1 as attempts per mandate grow. Nothing
about the model changed across those runs. The signal was absent, not missed.

**Root cause.** A data limitation misread as a model limitation. The generator's
monthly frequency over a short horizon gave the identifying signature no room to
appear.

**Fix and what it traded away.** No model change was made, which is the point. The
horizon became a swept parameter (`WHYDUNIT_HORIZON`) so the question is answerable
rather than arguable. Cost: every headline number is now horizon-dependent and has
to be reported with its horizon attached.

**What it changed about the design.** Before concluding that a model cannot learn
something, vary the amount of evidence and watch the curve. A flat curve indicts the
model; a rising one indicts the dataset. This is now the first check for any
"the model can't do X" claim here.

---

## #9 — 2026-08-21 (backfilled) — The model tied four if-statements, and the tie was the finding

**Symptom.** At 90 days the gradient booster was statistically indistinguishable
from a four-line expert rule: paired macro-F1 +0.006 [−0.006, +0.018] out-of-fold,
and significantly *worse* on unseen banks at −0.058 [−0.087, −0.030].

**First hypothesis.** Under-fitting or bad features — the usual reading of a model
that cannot beat a rule.

**The diagnostic that disproved it.** Bucketing failures by which single observable
settled them. 40% were decided by one boolean at 98-100% purity: a revoke webhook,
a failed delivery receipt, a sub-24h dispatch, or the NPCI window. A rule encodes
exactly those four facts, so on that 40% it is not an approximation of the model —
it is the same function. Aggregate macro-F1 was dominated by cases where no model
was needed. On the hard remainder the model already led, 0.390 to the rule's 0.233.

**Root cause.** The comparison was being run where the two methods cannot differ.
The model's only possible edge is silent churn, which is defined by invariance over
repeated attempts — and a rule evaluating one attempt in isolation has no way to
express "nothing has ever fixed this". At 90 days there were too few attempts for
that edge to exist at all.

**Fix and what it traded away.** Nothing was tuned. Two real bugs were fixed first
(#10), and the horizon was swept. The gap then appeared and grew: +0.141 at 180d,
+0.181 at 270d, +0.201 at 360d. The trade is that the honest claim is narrow —
the model earns its keep on silent churn and on long histories, not in general.

**What it changed about the design.** A hand-written expert rule is now a permanent
baseline in `eval/evaluate.py`, reported on every split. It is the bar that matters:
majority-class and decline-code lookup are too weak to be informative, and without
the rule the model's 0.935 at 90 days would have read as a success.

---

## #10 — 2026-08-22 — Two policy bugs, and the smaller one was hiding behind the larger

**Symptom.** The model-driven recovery policy was *more efficient but less
effective* than a hand-written rule: at a 270-day horizon it recovered 52.3% of
at-risk rupees against the rule's 52.6%, paired delta −0.4pp [−1.2, +0.6]. It spent
fewer retries doing it, which made the result read like a deliberate trade rather
than a defect.

**First hypothesis.** One bug: `decide()` stopped whenever C4 was the argmax class,
so any C3 payment mistakenly leaning C4 was abandoned along with its full value.
Fixing the stop rule should close the gap.

**The diagnostic that disproved it — as the whole story.** Fixing the stop rule
alone, with the world generator untouched, moved recovery from 52.3% to 53.5% at
270 days: +1.26pp. Real, and enough to flip the model from 0.4pp behind the rule to
0.9pp ahead, but nowhere near the size of the effect. Meanwhile the *oracle* policy
— which knows the true cause — was itself capped at 54.7%. A ceiling that low with
perfect information is not a policy problem. It pointed at the data.

**Root cause (the larger bug).** The world generator kept issuing debit attempts
after a mandate had been explicitly revoked. In production a revoke kills the
mandate at the PSP and no further debit is ever presented, so those attempts were
invented failures that nothing could recover. They inflated C4 from 13% to 43% of
failures and dragged every recovery rate down, the oracle ceiling included. The
argmax stop rule looked catastrophic mainly because it was operating in a world
where nearly half of all failures genuinely were cancellations.

**Fix and what it traded away.** Two changes. (1) No attempt is generated at or
after an explicit revoke; silent churn is untouched, so those mandates keep failing
— that is the hard case and the point. (2) Stopping now requires
P(C4) ≥ ratio/(ratio+1) from a cost matrix in `src/config.ts`, defaulting to a
wrongful stop costing a full mandate against a wrongful retry costing 0.05 of one
(threshold 0.952, overridable with `--cost-ratio`); below the threshold the agent
acts on the best *retryable* cause instead of abandoning the money.

The trade was real. Fixing the revoke bug made `revoked_before_attempt` constant
and `hours_since_revoke` entirely NaN, which HistGradientBoosting cannot bin at all
— the pipeline crashed until degenerate columns were dropped at fit time and named
in `metrics.json`. It also deleted the expert rule's only route to C4, and with it
the C4 arm of the exception router's observable-conflict detector.

**What it changed about the design.** Three things. The stop rule is a shared
module (`src/decision.ts`) used by both the live agent and the offline comparison,
so the two cannot drift. The threshold sweep is printed on every policy run with a
net-value column priced from the same cost matrix, because recovery alone rises
monotonically across 0.50–0.95 and "pick the maximum" would be a corner rather than
a choice. And the horizon is a swept parameter, which immediately exposed that
`TIME_SPLIT_DAY` was a fixed day-60 boundary: the time split ran 67/33 at 90 days
and 17/83 at 360, so those columns were never comparable across horizons.

**What it did not fix.** The stated target was for the model to beat the rule on
rupees *and* retries at 180 days with a CI clear of zero. It does not. Across all
four horizons the money difference straddles zero (90d +0.11pp, 180d −0.24pp,
270d +0.14pp, 360d +0.38pp). The model is significantly cheaper from 180 days
(−0.078, −0.153, −0.190 retries per failure, all CIs excluding zero) and
significantly better at attribution (+0.141 to +0.201 macro-F1), but on recovered
revenue it ties. Per the acceptance rule agreed in advance, the rule stays the
production retry policy.

---

## #11 — 2026-08-22 — The idempotency check was on the wrong side of the effect

**Symptom.** None yet, which is the point. Putting a second `PspClient`
implementation behind the agent turned a design that was correct for a simulator
into one that would double-charge a real customer.

**First hypothesis.** The port was a pure refactor. `fire()` already guaranteed
exactly-once through a keyed ledger insert, so swapping the adjudicator for a PSP
call looked like changing what sits inside the same safe wrapper.

**The diagnostic that disproved it.** Reading `fire()` with a network call
substituted for the simulated one. The order was: run the effect, then
`INSERT OR IGNORE` the result. That is safe only because the effect was a pure
function of the world — re-running `attemptAt` twice costs nothing and returns the
same answer. A crash between a real `scheduleDebit` landing and the row committing
would, on resume, call `scheduleDebit` again. The ledger's uniqueness constraint
protects the *record*, never the money.

**Root cause.** Exactly-once was being provided by the ledger insert, when what
actually protected us was the purity of the effect. Those are different guarantees
and they had been conflated for three phases.

**Fix and what it traded away.** `fire()` now reads the ledger **before** calling
out and returns the stored result for a settled key, so a completed intervention is
never re-attempted. `idempotencyKey` was added to every `PspClient` method and is
passed through to the PSP. One window is left and cannot be closed from this side:
a crash between the call landing and the row committing still replays the call. The
simulator is pure so it does not matter there; a real PSP must dedupe on the key,
which is why the key is on the interface rather than hidden inside the adapter.
The trade is that our crash-safety claim is now conditional on the PSP honouring
idempotency, and that condition is written down instead of assumed.

**What it changed about the design.** The agent became async, and the transaction
ordering had to be re-read rather than re-run — the crash test passes at 30 kill
points, but it exercises a pure PSP, so it can only prove our half of the contract.
The other half belongs to whoever implements `PspClient`, and the interface doc now
says so in the place someone writing a new adapter will actually read.

---

## #12 — 2026-08-22 — The simulated PSP dispatched notices in the wrong decade

**Symptom.** Caught by reading, not by a failing test: all 57 tests passed with the
bug present.

**First hypothesis.** None — it was spotted while checking the new
`sendPreDebitNotification` against the interface, before it had a chance to
misbehave.

**The diagnostic.** `SimulatedPsp.sendPreDebitNotification` set the dispatch time
to `Date.now()`. The simulated world runs in 2026 calendar time seeded from
`START_MS`; the wall clock, on the day this was written, sits months past the
horizon. A notice "dispatched" at wall-clock now, for a debit scheduled at
simulated 2026-03-01, has a negative lead time, so the 24-hour NPCI rule would
reject every re-notified retry forever. The C2 recovery path would have quietly
gone to zero.

**Root cause.** Two clocks in one process, and no type distinguishing them. The
world's epoch-ms and the wall clock's epoch-ms have the same type and neither one
looks wrong at a call site.

**Fix and what it traded away.** The PSP no longer timestamps the notice when it is
requested. It records that a notice is *pending* for that mandate, and resolves it
inside `scheduleDebit` against the debit it precedes — dispatch at `at - 26h`,
delivery drawn from the bank's reliability with the idempotency key as seed. That
is also a more faithful model: a merchant sends a notice in order to make a
specific debit legal, not at an arbitrary moment. Nothing was traded; the previous
version was simply wrong.

**What it changed about the design.** Simulated time and wall-clock time may not
mix in the same module. `Date.now()` now appears in exactly two places in `src/`:
the progress timer in `render.ts`, which is genuinely about elapsed real seconds,
and nowhere in the world or the agent. The tests could not have caught this — the
fixture's assertions are about crash-safety and constraints, not about C2 recovery
rate — which is the more useful lesson: a green suite is evidence about what it
tests, and this was outside all of it.
