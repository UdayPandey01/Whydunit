"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Scroll-scrubbed video with a graceful floor.
 *
 * If `src` resolves, the clip is scrubbed by scroll position through the
 * section — no autoplay, no audio, the viewer drives it. If the file is absent
 * or the browser will not seek it (mobile Safari is unreliable here), the SVG
 * children remain and animate on their own. The page is complete without any
 * video file, which is why the fallback is the child rather than a poster.
 */
export function VideoBeat({
  src, children, className = "",
}: { src: string; children: React.ReactNode; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = wrap.current, v = vid.current;
    if (!el || !v) return;

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const span = r.height + innerHeight;
        const k = Math.min(1, Math.max(0, (innerHeight - r.top) / span));
        if (Number.isFinite(v.duration)) v.currentTime = k * v.duration;
      });
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [ready]);

  return (
    <div ref={wrap} className={`beat ${className}`}>
      <video
        ref={vid} src={src} muted playsInline preload="auto" aria-hidden
        className="beat-video" data-ready={ready ? "1" : "0"}
        onLoadedMetadata={(e) => { if (e.currentTarget.duration > 0) setReady(true); }}
        onError={() => setReady(false)}
      />
      <div className="beat-fallback" data-hidden={ready ? "1" : "0"}>{children}</div>
    </div>
  );
}
