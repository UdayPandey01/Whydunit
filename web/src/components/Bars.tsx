"use client";
import { useEffect, useRef, useState } from "react";
import { pct, POLICY_NAME } from "@/lib/format";

export function Bars({ rows, max = 0.7 }:
  { rows: { id: string; rate: number }[]; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setOn(true);
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setOn(true); io.disconnect(); } },
      { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="bars">
      {rows.map((r, i) => {
        const mine = r.id === "model_policy";
        return (
          <div className="bar" key={r.id}>
            <span style={{ color: mine ? "var(--gold)" : "var(--ink-2)" }}>
              {POLICY_NAME[r.id] ?? r.id}
            </span>
            <span className="track">
              <i className="fill" style={{
                width: on ? `${(r.rate / max) * 100}%` : 0,
                transitionDelay: `${i * 90}ms`,
                background: mine
                  ? "linear-gradient(90deg,var(--gold-dim),var(--gold))"
                  : r.id === "naive_retry" ? "var(--danger)" : "var(--line-2)",
              }} />
            </span>
            <span className="val" style={{ color: mine ? "var(--gold)" : "var(--ink-2)" }}>
              {pct(r.rate)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
