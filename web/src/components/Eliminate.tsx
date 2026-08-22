"use client";
import { useEffect, useRef, useState } from "react";

type Item = { tag: string; name: string; why: string; out: string; keep?: boolean; kept: string };

/** Reveals the deduction: three suspects grey out, one holds. */
export function Eliminate({ items }: { items: Item[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Record<number, "out" | "keep">>({});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = Object.fromEntries(items.map((it, i) => [i, it.keep ? "keep" : "out"])) as
      Record<number, "out" | "keep">;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setState(done);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const losers = items.map((it, i) => (it.keep ? -1 : i)).filter((i) => i >= 0);
      losers.forEach((idx, n) =>
        setTimeout(() => setState((s) => ({ ...s, [idx]: "out" })), 420 + n * 430));
      const winner = items.findIndex((it) => it.keep);
      setTimeout(() => setState((s) => ({ ...s, [winner]: "keep" })), 420 + losers.length * 430 + 260);
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [items]);

  return (
    <div ref={ref} className="grid4">
      {items.map((it, i) => (
        <div key={it.tag} className="tile" data-state={state[i] ?? ""}>
          <div className="tag">{it.tag}</div>
          <h3>{it.name}</h3>
          <p>{it.why}</p>
          <div className="vd">{state[i] === "keep" ? it.kept : state[i] === "out" ? it.out : "—"}</div>
        </div>
      ))}
    </div>
  );
}
