import snap from "@/data/snapshot.json";
import { Nav } from "@/components/Nav";
import { Reveal, Counter } from "@/components/Reveal";
import { Dial } from "@/components/Dial";
import { VideoBeat } from "@/components/VideoBeat";
import { Eliminate } from "@/components/Eliminate";
import { Bars } from "@/components/Bars";
import { Replay } from "@/components/Replay";
import { inr, lakh, pct, pp } from "@/lib/format";

const HERO_FAIL_HOUR = 11 + 7 / 60;   // real: 2026-05-22T11:07 IST
const HERO_FIX_HOUR = 14 + 7 / 60;    // real: rescheduled to 14:07, recovered

export default function Home() {
  const t = snap.totals;
  const naive = snap.policies.find((p) => p.id === "naive_retry")!;
  const model = snap.policies.find((p) => p.id === "model_policy")!;
  const c1 = snap.causes.find((c) => c.id === "C1_EXECUTION_WINDOW")!;
  const dNaive = snap.deltas.naive_retry;
  const dRule = snap.deltas.rule_policy;
  const shown = ["do_nothing", "naive_retry", "window_aware_retry", "rule_policy", "model_policy", "oracle_policy"];
  const bars = shown.map((id) => snap.policies.find((p) => p.id === id)!);

  return (
    <>
      <Nav />

      {/* ── 00 hero ── */}
      <section style={{ paddingTop: "clamp(72px,14vh,150px)" }}>
        <div className="wrap narrow">
          <Reveal><p className="eyebrow">Razorpay AI Buildathon · Track 03</p></Reveal>
          <Reveal delay={70}>
            <h1 style={{ margin: "22px 0 26px" }}>
              A third of what merchants write off as churn <span className="gold">was never the customer.</span>
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="lede">
              It was a debit presented inside a window NPCI blocks. A pre-debit notice that never
              landed. A salary three days late. Retrying those on a timer recovers a third of the
              money and burns the rest on people who already left.
            </p>
          </Reveal>
          <Reveal delay={210}>
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap", marginTop: 44 }}>
              <div><div className="eyebrow">At risk</div>
                <div className="tnum" style={{ fontSize: 26, marginTop: 6 }}>{lakh(t.at_risk)}</div></div>
              <div><div className="eyebrow">Recovered</div>
                <div className="tnum good" style={{ fontSize: 26, marginTop: 6 }}>{pct(model.rate)}</div></div>
              <div><div className="eyebrow">Naive retry</div>
                <div className="tnum dim" style={{ fontSize: 26, marginTop: 6 }}>{pct(naive.rate)}</div></div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 01 the evidence ── */}
      <section>
        <div className="wrap">
          <div className="narrow">
            <Reveal><p className="eyebrow">01 — The evidence</p></Reveal>
            <Reveal delay={70}><h2 style={{ margin: "14px 0 34px" }}>The decline code tells you nothing.</h2></Reveal>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,440px) minmax(0,1fr)", gap: "clamp(28px,5vw,64px)", alignItems: "center" }}>
            <Reveal>
              <div className="receipt">
                <div className="hd">
                  <span className="mono dim" style={{ fontSize: 11 }}>{snap.hero.mandate}</span>
                  <span className="chip">FAILED</span>
                </div>
                <div className="rw"><span>Amount</span><span className="tnum">{inr(snap.hero.amount)}</span></div>
                <div className="rw"><span>Bank</span><span>{snap.hero.bank}</span></div>
                <div className="rw"><span>Attempted</span><span className="tnum">22 May 2026 · 11:07 IST</span></div>
                <div className="rw"><span>Decline code</span><span className="mono dngr">{snap.hero.error_code}</span></div>
                <div className="rw"><span>Notice delivered</span><span className="good">confirmed</span></div>
                <div className="rw"><span>Customer balance</span><span className="dim">not observable</span></div>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <p className="lede">
                <span className="mono">{snap.hero.error_code}</span> is returned for several different
                reasons. In this corpus no decline code is a reliable proxy for a cause — the most
                predictive one still misclassifies roughly a fifth of the time.
              </p>
              <p className="lede" style={{ marginTop: 18 }}>
                The bank told you it failed. It did not tell you why, and the one fact that would
                settle it — the customer&rsquo;s balance — is not something a merchant can see.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 02 suspects ── */}
      <section>
        <div className="wrap">
          <div className="narrow" style={{ marginBottom: 34 }}>
            <Reveal><p className="eyebrow">02 — Four suspects</p></Reveal>
            <Reveal delay={70}><h2 style={{ margin: "14px 0 14px" }}>Each one fails differently.</h2></Reveal>
            <Reveal delay={140}><p className="lede">
              Every cause moves with something and is invariant to the rest. That signature separates
              them — not the code the bank sent.
            </p></Reveal>
          </div>
          <Reveal>
            <Eliminate items={[
              { tag: "C1", name: "Execution window", keep: true,
                why: "Debited inside NPCI's 10:00–13:00 block. Moves with the hour; invariant to customer, bank and amount.",
                out: "", kept: "kept — the failure moves with the hour" },
              { tag: "C2", name: "Notification failure",
                why: "Pre-debit notice not delivered 24h ahead. Moves with the bank and with outage bursts.",
                out: "ruled out — notice confirmed", kept: "" },
              { tag: "C3", name: "Balance shortfall",
                why: "No funds at the moment of debit. Moves with the customer and the day of the month.",
                out: "ruled out — recovered same day", kept: "" },
              { tag: "C4", name: "Cancellation",
                why: "The customer has stopped paying. Moves with nothing at all. Nothing fixes it.",
                out: "ruled out — succeeded after", kept: "" },
            ]} />
          </Reveal>
        </div>
      </section>

      {/* ── 03 the dial — the argument ── */}
      <section style={{ background: "linear-gradient(180deg,var(--ground),var(--ground-deep) 45%,var(--ground))" }}>
        <div className="wrap">
          <div className="narrow" style={{ marginBottom: 46 }}>
            <Reveal><p className="eyebrow">03 — Why a timer can never fix it</p></Reveal>
            <Reveal delay={70}><h2 style={{ margin: "14px 0 14px" }}>T+24h keeps the hour.</h2></Reveal>
            <Reveal delay={140}><p className="lede">
              A fixed-interval retry advances the date and preserves the time of day. Against a rule
              written in hours, every retry lands on the same spoke.
            </p></Reveal>
          </div>
          <div className="clockgrid">
            <Reveal><Dial failHour={HERO_FAIL_HOUR} fixHour={HERO_FIX_HOUR} /></Reveal>
            <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
              <Reveal delay={80}>
                <p className="eyebrow">Naive retry · T+24h, T+72h, T+168h</p>
                <div className="figure dngr" style={{ marginTop: 12 }}>0.0%</div>
                <p className="dim" style={{ fontSize: 14.5, marginTop: 10 }}>
                  of execution-window failures recovered. Not fewer — none.
                </p>
              </Reveal>
              <Reveal delay={160}>
                <p className="eyebrow">WhyDunit · same day, 14:07</p>
                <div className="figure good" style={{ marginTop: 12 }}>
                  <Counter to={100 * (c1.correct / c1.n)} dp={1} />
                </div>
                <p className="dim" style={{ fontSize: 14.5, marginTop: 10 }}>
                  attribution accuracy on this class. <span className="mono">{snap.hero.mandate}</span> recovered
                  on the first retry, {pct(snap.hero.proba.C1_EXECUTION_WINDOW, 1)} confidence.
                </p>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 the replay — WhyDunit doing the thing ── */}
      <section>
        <div className="wrap">
          <div className="narrow" style={{ marginBottom: 38 }}>
            <Reveal><p className="eyebrow">04 — One customer, one year</p></Reveal>
            <Reveal delay={70}><h2 style={{ margin: "14px 0 14px" }}>
              Watch it recover, hesitate, and then give up.
            </h2></Reveal>
            <Reveal delay={140}><p className="lede">
              These are the agent&rsquo;s own audit rows for a single mandate, replayed as you scroll.
              Nothing here is staged — every line is read from the log the agent wrote while running.
            </p></Reveal>
          </div>
          <Reveal>
            <Replay rows={snap.replay.trail} amount={snap.replay.amount}
              mandate={snap.replay.mandate} bank={snap.replay.bank} />
          </Reveal>
          <Reveal delay={100}>
            <p className="lede" style={{ marginTop: 30 }}>
              Four cycles recovered. One held back because confidence fell to 0.54. Three retries in
              August that went nowhere. Then, in September, <span style={{ color: "var(--ink)" }}>P(cancelled)
              crossed 0.95 and it stopped</span> — the one decision a fixed-interval retry can never make,
              because a timer has no opinion about whether the customer is still there.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── 05 scale ── */}
      <section>
        <div className="wrap">
          <div className="narrow" style={{ marginBottom: 36 }}>
            <Reveal><p className="eyebrow">05 — At scale</p></Reveal>
            <Reveal delay={70}><h2 style={{ margin: "14px 0 14px" }}>
              {t.failures.toLocaleString("en-IN")} failures, one seeded run.
            </h2></Reveal>
            <Reveal delay={140}><p className="lede">
              Every policy gets the same three retries over the same failures. Deltas are paired
              bootstrap, 1,000 resamples clustered by mandate.
            </p></Reveal>
          </div>
          <Reveal><Bars rows={bars} /></Reveal>
          <Reveal delay={120}>
            <p className="lede" style={{ marginTop: 34 }}>
              <span style={{ color: "var(--ink)" }}>{pp(dNaive.delta)} against naive retry</span>{" "}
              <span className="mono dim" style={{ fontSize: 13 }}>
                [{(100 * dNaive.ci[0]).toFixed(1)}, {(100 * dNaive.ci[1]).toFixed(1)}]
              </span>, at <span style={{ color: "var(--ink)" }}>{model.retries.toFixed(2)} retries</span> per
              failure instead of {naive.retries.toFixed(2)}. Attribution: {pct(t.classified / t.failures)} auto-classified
              at macro-F1 {t.macro_f1.toFixed(3)}{" "}
              <span className="mono dim" style={{ fontSize: 13 }}>
                [{t.macro_f1_ci[0].toFixed(3)}, {t.macro_f1_ci[1].toFixed(3)}]
              </span>.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── 05 honest ── */}
      <section>
        <div className="wrap narrow">
          <Reveal><p className="eyebrow">06 — What it cannot do</p></Reveal>
          <Reveal delay={70}><h2 style={{ margin: "14px 0 30px" }}>The tie is the honest headline.</h2></Reveal>
          <Reveal delay={140}>
            <dl style={{ margin: 0, borderTop: "1px solid var(--line)" }}>
              <div className="limit"><dt>Ties the rule</dt><dd>
                Against a hand-written four-line expert rule the difference on rupees is{" "}
                <span className="mono">{pp(dRule.delta)} [{(100 * dRule.ci[0]).toFixed(1)}, {(100 * dRule.ci[1]).toFixed(1)}]</span> —
                it straddles zero. The rule stays the production retry policy. The model earns its
                place in attribution, where it leads by <span className="mono">+{t.oof_vs_rule.delta.toFixed(3)}</span> macro-F1.
              </dd></div>
              <div className="limit"><dt>Silent churn</dt><dd>
                Recall on cancellations with no webhook is <span className="mono">0.556</span> here and{" "}
                <span className="mono">0.000</span> at a 90-day horizon. Invariance needs repeated
                attempts before it can be seen at all.
              </dd></div>
              <div className="limit"><dt>Simulated corpus</dt><dd>
                A labelled corpus of UPI AutoPay failures with known ground truth does not exist
                outside a PSP. The simulator generates world state; labels are emergent, never assigned.
              </dd></div>
              <div className="limit"><dt>Adapter unproven</dt><dd>
                The Razorpay adapter is built against test mode and unit-tested, and has never run
                against live credentials. Only one of the four causes is inducible in test mode.
              </dd></div>
            </dl>
          </Reveal>
          <Reveal delay={200}>
            <p className="lede" style={{ marginTop: 32 }}>
              Every figure here comes from one seeded run — <span className="mono">seed {snap.provenance.seed}</span>,{" "}
              {snap.provenance.horizon_days}-day horizon. <span className="mono">npm run verify</span> regenerates
              the world and re-hashes ten artifacts against a committed manifest, on any CPU architecture.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 28 }}>
              <a className="btn" href="/dashboard">Open the dashboard →</a>
              <a className="btn" href="https://github.com" target="_blank" rel="noreferrer">Read the source</a>
            </div>
          </Reveal>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--line)", padding: "44px 0 72px" }}>
        <div className="wrap narrow" style={{ color: "var(--ink-3)", fontSize: 13 }}>
          <p>WhyDunit · snapshot {snap.provenance.generated} · manifest {snap.provenance.manifest_sha}</p>
        </div>
      </footer>
    </>
  );
}
