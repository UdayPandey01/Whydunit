import pc from "picocolors";

export const W = 78;

export const good = pc.green;
export const bad = pc.red;
export const warn = pc.yellow;
export const dim = pc.dim;
export const head = (s: string) => pc.bold(pc.white(s));
export const key = pc.cyan;
export const white = pc.white;
export const c = pc;

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
export const vlen = (s: string): number => s.replace(ANSI, "").length;

export function pad(s: string, n: number, align: "l" | "r" = "l"): string {
  const gap = " ".repeat(Math.max(0, n - vlen(s)));
  return align === "r" ? gap + s : s + gap;
}

export const line = (s = ""): void => console.log(s);
export const blank = (): void => console.log();
export const note = (s: string): void => console.log(dim("  " + s));

export function rule(title?: string): void {
  blank();
  if (title === undefined) return line(dim("─".repeat(W)));
  const bar = "─".repeat(Math.max(0, W - vlen(title) - 3));
  line(dim("── ") + head(title) + " " + dim(bar));
}

export const money = (n: number): string => "₹" + Math.round(n).toLocaleString("en-IN");

export function moneyShort(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return money(n);
}

export const pct = (frac: number, dp = 1): string => `${(100 * frac).toFixed(dp)}%`;

export function withCI(v: string, lo: number, hi: number, dp = 3): string {
  return `${v} ${dim(`[${lo.toFixed(dp)}, ${hi.toFixed(dp)}]`)}`;
}

export function verdict(delta: number, lo: number, hi: number, lowerIsBetter = false): {
  tone: (s: string) => string;
  label: string;
} {
  if (lo <= 0 && hi >= 0) return { tone: warn, label: "ties" };
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return better ? { tone: good, label: "wins" } : { tone: bad, label: "loses" };
}

export function bar(frac: number, width = 12, tone: (s: string) => string = key): string {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return tone("█".repeat(n)) + dim("░".repeat(width - n));
}

const SPARK = "▁▂▃▄▅▆▇█";
export function spark(values: number[]): string {
  if (values.length === 0) return "";
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const span = hi - lo || 1;
  return values.map((v) => SPARK[Math.round(((v - lo) / span) * 7)]!).join("");
}

export type Align = "l" | "r";

export function table(headers: string[], rows: string[][], align: Align[] = []): void {
  const n = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(vlen(h), ...rows.map((r) => vlen(r[i] ?? ""))),
  );

  const total = () => widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  while (total() > W && Math.max(...widths) > 6) {
    widths[widths.indexOf(Math.max(...widths))]! -= 1;
  }
  const clip = (s: string, w: number) => (vlen(s) <= w ? s : s.slice(0, Math.max(0, w - 1)) + "…");
  const row = (cells: string[]) =>
    cells.map((s, i) => pad(clip(s, widths[i]!), widths[i]!, align[i] ?? "l")).join(dim(" │ "));

  blank();
  line(dim(row(headers.map((h) => h.toUpperCase()))));
  line(dim(widths.map((w) => "─".repeat(w)).join("─┼─")));
  for (const r of rows) line(row(r));
}

export function kv(pairs: [string, string][]): void {
  const w = Math.max(...pairs.map(([k]) => vlen(k)));
  blank();
  for (const [k, v] of pairs) line("  " + dim(pad(k, w)) + "  " + v);
}

export const OK = good("✓");
export const WARN = warn("!");
export const FAIL = bad("✗");
export const ARROW = key("→");

export function step(status: "ok" | "warn" | "fail", text: string): void {
  line(`  ${status === "ok" ? OK : status === "warn" ? WARN : FAIL} ${text}`);
}

export function progress(label: string): (done?: string) => void {
  const tty = process.stdout.isTTY === true;
  const started = Date.now();
  if (tty) process.stdout.write(dim(`  … ${label}`));
  else line(dim(`  … ${label}`));
  return (done?: string) => {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (tty) process.stdout.write("\r" + " ".repeat(W) + "\r");
    line(`  ${OK} ${done ?? label} ${dim(`(${secs}s)`)}`);
  };
}
