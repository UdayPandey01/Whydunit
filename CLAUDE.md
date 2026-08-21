# Project: Debit Failure Causal Attribution

## What this is
An agent that takes failed UPI AutoPay debits, determines why each one actually
failed, and executes a bounded recovery action matched to that cause — with
stopping rules, an audit trail, and an honest exception list.

Built for the Razorpay AI Buildathon, Track 03 (AI Revenue Recovery).
Deadline: submit 3 September 2026.

## The four cause classes
- C1 EXECUTION_WINDOW  — debit attempted inside an NPCI-restricted window
- C2 NOTIFICATION_FAIL — pre-debit notification not delivered ≥24h before debit
- C3 BALANCE_SHORTFALL — customer had insufficient funds at attempt time
- C4 CANCELLATION      — customer has actually decided to stop

## The analytical spine
Each class has a different INVARIANCE signature. This is the core idea:

| Class | Varies with            | Invariant to               |
|-------|------------------------|----------------------------|
| C1    | hour of day            | customer, bank, amount     |
| C2    | bank, burst window     | customer, amount, hour     |
| C3    | customer, day-of-month | bank, hour                 |
| C4    | nothing                | everything                 |

C4 is identified by failure INVARIANCE — nothing fixes it. It is therefore
always the last conclusion, never the default.

## The one rule that must never break
Generate WORLD STATE. Derive OBSERVATIONS from it. Hide the world. Classify
from observations only.

The generator must NEVER take a label as input. Labels are emergent — they are
whichever world process blocked the debit first. If a feature encodes the
generating mechanism directly, that is leakage and the whole project is void.

## Stack — do not deviate without asking
- TypeScript, Node 20+, ESM
- Plain TypeScript. NO NestJS, no Express, no framework. This project has four
  entry points (generate, train, eval, run) — it is CLI-shaped, not server-shaped.
- JSONL files for generated data. SQLite (better-sqlite3) ONLY for agent runtime
  state, and only from Phase 3 onward. No database in Phase 1.
- Python 3.11 + scikit-learn for the classifier, as a SCRIPT not a service.
  It reads JSONL, writes model.pkl and metrics.json. No FastAPI, no HTTP.
- Seeded RNG everywhere. Every result must reproduce exactly.

## Simplicity rules — enforce these strictly
1. Rule of three: no abstraction until the same thing appears three times.
2. No interface or abstract class with exactly one implementation.
3. Functions over classes. Use a class only when there is real mutable state.
4. No dependency injection container. Pass arguments.
5. No custom error hierarchy. `throw new Error("clear message")`.
6. No logger library. `console.log` with a prefix is fine until Phase 4.
7. Comments explain WHY. Never what.

## DESIGN.md contract
`DESIGN.md` at repo root is the live map of the project. Update it at the end of
EVERY phase, before saying the phase is done. It contains, in this order:

1. **Current state** — what works right now, in three sentences
2. **Module map** — every source file, one line each on what it does
3. **Data flow** — text diagram of what calls what, and what shape moves between
4. **Key decisions** — each decision plus the reason, one line each
5. **Not built yet** — what is deliberately missing and which phase it lands in
6. **How to run** — exact commands

Keep it under 200 lines. If DESIGN.md is getting long, the CODE is too complex —
fix the code, not the doc. Treat its length as a complexity alarm.

## INCIDENTS.md
Every real failure gets an entry, written WHEN IT HAPPENS, never reconstructed:
symptom → first hypothesis → the diagnostic that disproved it → root cause →
the fix and what it traded away → what it changed about the design.

The buildathon asks "what broke at 2 AM and how you got out." This file is
that answer. Do not invent entries.

## Phases
- P1 world generator + observation layer          ← current
- P2 features, classifier, eval harness, baselines
- P3 agent: interventions, hard constraints, audit log, crash-resume
- P4 exception queue, merchant report, LLM explanation layer
- P5 hardening, README, video

Build only the current phase. Do not scaffold for future phases.

## Working style
- Explain the approach before writing code. I want to understand it, not just run it.
- If something I asked for is more complex than it needs to be, say so and
  propose the simpler version before building.
- Ask before adding any dependency.
- Small commits with clear messages.