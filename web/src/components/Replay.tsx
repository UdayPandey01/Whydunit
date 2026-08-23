"use client";
import { useEffect, useRef, useState } from "react";
import { inr, CAUSE_NAME, CAUSE_SHORT } from "@/lib/format";

type Row = {
  cycle: string; n: number; cause: string | null; confidence: number | null;
  action: string; scheduled_at: string | null; checks: number; skipped: number; outcome: string;
};

const MONTH = ["", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const label = (c: string) => MONTH[Number(c.slice(5, 7))];
const clock = (iso: string | null) => (iso ? iso.slice(11, 16) : "—");

const ACTION: Record<string, string> = {
  reschedule: "rescheduled",
  refire_notification_then_reschedule: "re-notified, rescheduled",
  escalate_to_human: "sent to a human",
  stop: "stopped",
};

export function Replay({ rows, amount, mandate, bank }:
  { rows: Row[]; amount: number; mandate: string; bank: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setLive(rows.length);

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();

        const start = innerHeight * 0.78, end = innerHeight * 0.3;
        const k = (start - r.top) / Math.max(1, r.height - (start - end));
        setLive(Math.round(Math.min(1, Math.max(0, k)) * rows.length));
      });
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [rows.length]);

  const recovered = rows.slice(0, live).filter((r) => r.outcome === "recovered").length * amount;
  const stopped = live >= rows.length;

  return (
    <div ref={ref} className="replay">
      <div className="replay-hd">
        <span className="mono" style={{ fontSize: 11 }}>{mandate}</span>
        <span className="dim" style={{ fontSize: 13 }}>{bank} · {inr(amount)} monthly · 2026</span>
      </div>

      <ol className="replay-rows">
        {rows.map((r, i) => {
          const on = i < live;
          const kind = r.action === "stop" ? "stop"
            : r.action === "escalate_to_human" ? "human"
            : r.outcome === "recovered" ? "won" : "lost";
          return (
            <li key={`${r.cycle}-${r.n}`} className="replay-row" data-on={on ? "1" : "0"}
              data-kind={kind} style={{ transitionDelay: `${Math.min(i, 3) * 40}ms` }}>
              <span className="mo mono">{label(r.cycle)}</span>
              <span className="tm mono">{clock(r.scheduled_at)}</span>
              <span className="cz">
                {r.cause
                  ? <><b className="mono">{CAUSE_SHORT[r.cause]}</b> {CAUSE_NAME[r.cause]}</>
                  : <span className="dim">no determination</span>}
                {r.n > 1 && <span className="dim"> · retry {r.n}/3</span>}
              </span>
              <span className="ac dim">{ACTION[r.action] ?? r.action}</span>
              <span className="ot">
                {kind === "won" ? "recovered" : kind === "human" ? "human review"
                  : kind === "stop" ? "no further retries" : "failed"}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="replay-ft">
        <div>
          <div className="eyebrow">Recovered on this mandate</div>
          <div className="tnum" style={{ fontSize: 30, marginTop: 6, letterSpacing: "-.03em" }}>
            {inr(recovered)}
          </div>
        </div>
        <div className={`verdict ${stopped ? "on" : ""}`}>
          {stopped
            ? <>Then it <b>stopped</b> — before spending a fifth cycle on a customer who had gone.</>
            : <span className="dim">Scroll to replay the year.</span>}
        </div>
      </div>
    </div>
  );
}
