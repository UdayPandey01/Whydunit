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
