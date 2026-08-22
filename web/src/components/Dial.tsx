"use client";
import { useEffect, useRef, useState } from "react";

const CX = 200, CY = 200, R = 150;
const ang = (h: number) => (h / 24) * 360;
const pt = (a: number, r: number) => [
  CX + r * Math.sin((a * Math.PI) / 180),
  CY - r * Math.cos((a * Math.PI) / 180),
];

/**
 * 24-hour dial. The whole argument in one picture: a fixed-interval retry
 * advances the date and preserves the hour, so every retry lands on the same
 * spoke — inside the band NPCI blocks. Angles come from the real attempt time.
 */
export function Dial({ failHour, fixHour }: { failHour: number; fixHour: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setStep(5);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const marks = [200, 620, 1040, 1700, 2200];
      marks.forEach((ms, i) => setTimeout(() => setStep(i + 1), ms));
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const [ax, ay] = pt(ang(10), R);
  const [bx, by] = pt(ang(13), R);
  const failA = ang(failHour), fixA = ang(fixHour);

  return (
    <svg ref={ref} viewBox="0 0 400 400" className="dial" role="img"
      aria-label="A 24-hour dial. Three fixed-interval retries land on the same spoke inside the blocked 10:00 to 13:00 window; a fourth, rescheduled, clears it.">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--line)" />
      <circle cx={CX} cy={CY} r={R - 34} fill="none" stroke="var(--line)" opacity=".45" />

      {/* the blocked band */}
      <path d={`M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`} fill="none"
        stroke="var(--danger)" strokeWidth="42" opacity=".10" />
      <path d={`M ${ax} ${ay} A ${R} ${R} 0 0 1 ${bx} ${by}`} fill="none"
        stroke="var(--danger)" strokeWidth="2" opacity=".85" />

      {Array.from({ length: 24 }, (_, h) => {
        const major = h % 6 === 0;
        const [x1, y1] = pt(ang(h), major ? R - 13 : R - 7);
        const [x2, y2] = pt(ang(h), R);
        return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={major ? "var(--line-2)" : "var(--line)"} />;
      })}

      {["00", "06", "12", "18"].map((t, i) => {
        const [x, y] = pt(ang(i * 6), R + 22);
        return <text key={t} x={x} y={y + 4} textAnchor="middle" fontSize="10"
          fill="var(--ink-3)" fontFamily="Martian Mono, monospace" letterSpacing="1">{t}</text>;
      })}

      {/* three naive retries — identical angle, stacked */}
      {[0, 1, 2].map((i) => (
        <g key={i} style={{
          transform: `rotate(${failA}deg)`, transformOrigin: `${CX}px ${CY}px`,
          opacity: step > i ? 1 : 0, transition: "opacity .55s var(--ease)",
        }}>
          <line x1={CX} y1={CY} x2={CX} y2={CY - R + 46 + i * 15}
            stroke="var(--ink-3)" strokeWidth="1.2" />
          <circle cx={CX} cy={CY - R + 46 + i * 15} r="4.5" fill="var(--danger)" />
        </g>
      ))}

      {/* the reschedule, clear of the band */}
      <g style={{
        transform: `rotate(${step >= 5 ? fixA : failA}deg)`, transformOrigin: `${CX}px ${CY}px`,
        opacity: step >= 4 ? 1 : 0,
        transition: "transform 1.15s var(--ease), opacity .5s var(--ease)",
      }}>
        <line x1={CX} y1={CY} x2={CX} y2={CY - R + 46} stroke="var(--gold)" strokeWidth="1.4" />
        <circle cx={CX} cy={CY - R + 46} r="5.5"
          fill={step >= 5 ? "var(--success)" : "var(--gold)"}
          style={{ transition: "fill .6s var(--ease)" }} />
      </g>

      <circle cx={CX} cy={CY} r="3" fill="var(--ink-3)" />
    </svg>
  );
}
