import { CHURN_DAILY_HAZARD, CHURN_EVENT_EMIT_RATE } from "../config.ts";
import { DAY_MS, HOUR_MS } from "../time.ts";
import type { Rng } from "../rng.ts";

// C4. Hazard is drawn once over the mandate's live window; once it fires every
// later attempt fails no matter what else is true. That precedence is what gives
// C4 its "invariant to everything" signature.
export function drawChurn(
  hazardScale: number,
  fromMs: number,
  toMs: number,
  rng: Rng,
): { at: number; emits_event: boolean } | null {
  const u = rng();
  const emits_event = rng() < CHURN_EVENT_EMIT_RATE;
  const hourJitter = rng();

  const h = CHURN_DAILY_HAZARD * hazardScale;
  const days = Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
  if (days === 0 || h <= 0) return null;

  const survive = Math.pow(1 - h, days);
  if (u < survive) return null;

  // Invert the geometric CDF, conditioned on firing inside the window.
  const v = (u - survive) / (1 - survive);
  const d = Math.log(1 - v * (1 - survive)) / Math.log(1 - h);
  const at = fromMs + d * DAY_MS + Math.floor(hourJitter * 24) * HOUR_MS;
  return { at, emits_event };
}
