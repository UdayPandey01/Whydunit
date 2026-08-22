import snap from "@/data/snapshot.json";
import { Nav } from "@/components/Nav";
import { Reveal } from "@/components/Reveal";
import { inr, lakh, pct, pp, CAUSE_NAME, CAUSE_SHORT, POLICY_NAME } from "@/lib/format";

const REASON: Record<string, string> = {
  insufficient_history: "Too little history to judge",
  ambiguous_top_two: "Two causes equally likely",
  multi_cause_conflict: "Conflicting evidence",
  outside_training_support: "Unfamiliar bank or pattern",
};
const SHOWN = ["do_nothing", "naive_retry", "window_aware_retry", "rule_policy", "model_policy", "oracle_policy"];

export default function Dashboard() {
  const t = snap.totals;
  const model = snap.policies.find((p) => p.id === "model_policy")!;
  const queue = Object.entries(snap.queue as Record<string, number>).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <Nav />
      <section style={{ paddingBlock: "clamp(48px,7vh,76px)" }}>
        <div className="wrap">
          <Reveal><p className="eyebrow">Recovery report · seed {snap.provenance.seed} · {snap.provenance.horizon_days}-day horizon</p></Reveal>
          <Reveal delay={70}><h2 style={{ margin: "14px 0 10px" }}>
            Classified {pct(t.classified / t.failures)} at macro-F1 {t.macro_f1.toFixed(3)}
          </h2></Reveal>
          <Reveal delay={120}><p className="lede">
            One seeded run over {t.failures.toLocaleString("en-IN")} failed debits worth {inr(t.at_risk)}.
            Every number regenerates from the seed; CI fails if any of them moves.
          </p></Reveal>
          <Reveal delay={170}>
            <div className="kpis" style={{ marginTop: 34 }}>
              <div className="kpi"><div className="k">Failed debits</div>
                <div className="v">{t.failures.toLocaleString("en-IN")}</div><div className="s">this cycle</div></div>
              <div className="kpi"><div className="k">Money at risk</div>
                <div className="v">{lakh(t.at_risk)}</div><div className="s">{inr(t.at_risk)}</div></div>
              <div className="kpi"><div className="k">Auto-attributed</div>
                <div className="v good">{pct(t.classified / t.failures)}</div>
                <div className="s">{t.classified.toLocaleString("en-IN")} payments</div></div>
              <div className="kpi"><div className="k">Recovered</div>
                <div className="v gold">{pct(model.rate)}</div>
                <div className="s">{model.retries.toFixed(2)} retries per failure</div></div>
            </div>
          </Reveal>
        </div>
      </section>

      <section style={{ paddingTop: 0 }}>
        <div className="wrap" style={{ display: "grid", gap: 44 }}>
          <Reveal>
            <p className="eyebrow" style={{ marginBottom: 14 }}>Why payments are failing</p>
            <div className="scroll-x"><table>
              <thead><tr><th>Cause</th><th style={{ textAlign: "right" }}>Payments</th>
                <th style={{ textAlign: "right" }}>At risk</th><th style={{ textAlign: "right" }}>Attributed correctly</th></tr></thead>
              <tbody>
                {snap.causes.map((c) => (
                  <tr key={c.id}>
                    <td><span className="mono dim" style={{ fontSize: 10.5, marginRight: 11 }}>{CAUSE_SHORT[c.id]}</span>{CAUSE_NAME[c.id]}</td>
                    <td className="n">{c.n.toLocaleString("en-IN")}</td>
                    <td className="n">{inr(c.amount)}</td>
                    <td className="n">{pct(c.correct / c.n, 0)}</td>
                  </tr>
                ))}
                <tr><td className="gold"><span className="mono" style={{ fontSize: 10.5, marginRight: 11 }}>?</span>Human review</td>
                  <td className="n gold">{t.routed.toLocaleString("en-IN")}</td>
                  <td className="n gold">{inr(t.routed_amount)}</td><td className="n dim">—</td></tr>
              </tbody></table></div>
          </Reveal>

          <Reveal>
            <p className="eyebrow" style={{ marginBottom: 14 }}>Recovery by policy · same failures, same retry budget</p>
            <div className="scroll-x"><table>
              <thead><tr><th>Policy</th><th style={{ textAlign: "right" }}>Recovered</th>
                <th style={{ textAlign: "right" }}>Retries / failure</th>
                <th style={{ textAlign: "right" }}>Δ vs WhyDunit</th><th>Verdict</th></tr></thead>
              <tbody>
                {SHOWN.map((id) => {
                  const p = snap.policies.find((x) => x.id === id)!;
                  const d = (snap.deltas as Record<string, { delta: number; ci: number[] }>)[id];
                  const mine = id === "model_policy";
                  const ties = d ? d.ci[0] <= 0 && d.ci[1] >= 0 : false;
                  return (
                    <tr key={id} style={mine ? { background: "rgba(232,197,106,.05)" } : undefined}>
                      <td style={mine ? { color: "var(--gold)" } : undefined}>{POLICY_NAME[id]}</td>
                      <td className="n" style={mine ? { color: "var(--gold)" } : undefined}>{pct(p.rate)}</td>
                      <td className="n dim">{p.retries.toFixed(2)}</td>
                      <td className="n dim">{d ? pp(-d.delta) : "—"}</td>
                      <td style={{ fontSize: 13, color: !d ? "var(--gold)" : ties ? "var(--ink-2)" : "var(--danger)" }}>
                        {!d ? "baseline" : ties ? "ties" : "loses"}</td>
                    </tr>
                  );
                })}
              </tbody></table></div>
          </Reveal>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(296px,1fr))", gap: 20 }}>
            <Reveal>
              <p className="eyebrow" style={{ marginBottom: 14 }}>What needed a human</p>
              <div className="scroll-x"><table><tbody>
                {queue.map(([k, v]) => (
                  <tr key={k}><td className="dim">{REASON[k] ?? k}</td><td className="n">{v}</td></tr>
                ))}
              </tbody></table></div>
            </Reveal>
            <Reveal delay={80}>
              <p className="eyebrow" style={{ marginBottom: 14 }}>Model quality</p>
              <div className="scroll-x"><table><tbody>
                <tr><td className="dim">macro-F1, auto-classified</td><td className="n">{t.macro_f1.toFixed(3)}</td></tr>
                <tr><td className="dim">macro-F1, all failures</td><td className="n">{t.macro_f1_all.toFixed(3)}</td></tr>
                <tr><td className="dim">Calibration error (ECE)</td><td className="n">{t.ece.toFixed(3)}</td></tr>
                <tr><td className="dim">vs expert rule, out-of-fold</td><td className="n good">+{t.oof_vs_rule.delta.toFixed(3)}</td></tr>
              </tbody></table></div>
            </Reveal>
          </div>

          <Reveal>
            <p className="eyebrow" style={{ marginBottom: 14 }}>Stop-threshold sweep · the operating point was chosen, not tuned</p>
            <div className="scroll-x"><table>
              <thead><tr><th>P(C4) ≥</th><th style={{ textAlign: "right" }}>Recovered</th>
                <th style={{ textAlign: "right" }}>Retries</th><th style={{ textAlign: "right" }}>Net of retry cost</th></tr></thead>
              <tbody>{snap.sweep.map((s) => (
                <tr key={s.t} style={s.t >= 0.95 ? { background: "rgba(232,197,106,.05)" } : undefined}>
                  <td className="mono" style={{ fontSize: 12 }}>{s.t.toFixed(2)}</td>
                  <td className="n">{pct(s.rate)}</td>
                  <td className="n dim">{s.retries.toLocaleString("en-IN")}</td>
                  <td className="n dim">{lakh(s.net)}</td>
                </tr>
              ))}</tbody></table></div>
          </Reveal>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--line)", padding: "44px 0 72px", marginTop: 56 }}>
        <div className="wrap" style={{ color: "var(--ink-3)", fontSize: 13 }}>
          <p>Snapshot {snap.provenance.generated} · manifest {snap.provenance.manifest_sha} · regenerate with <span className="mono">npm run snapshot</span></p>
        </div>
      </footer>
    </>
  );
}
