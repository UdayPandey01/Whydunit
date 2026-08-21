/**
 * Terminal presentation primitives. PRESENTATION ONLY.
 *
 * Nothing in this file computes, derives or rounds a result. It receives values
 * that are already final and decides how they look. Keeping it dependency-free
 * and separate from every other module is what makes that claim checkable.
 */

export const W = 64; // interior width shared by every box, so sections line up

const ESC = String.fromCharCode(27);

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

const code = (n: string) => (s: string) => (useColor ? `${ESC}[${n}m${s}${ESC}[0m` : s);

export const c = {
  bold: code("1"),
  dim: code("2"),
  white: code("97"),
  gray: code("90"),
  green: code("32"),
  red: code("31"),
  yellow: code("33"),
  cyan: code("36"),
  greenBold: code("1;32"),
  cyanBold: code("1;36"),
  redBold: code("1;31"),
  yellowBold: code("1;33"),
  whiteBold: code("1;97"),
};

const ANSI_RE = new RegExp(ESC + "\\[[0-9;]*m", "g");

/** Visible width, ignoring ANSI escapes. Box maths must never count colour bytes. */
export function vlen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Truncate to a visible width without cutting an ANSI escape in half. Copies
 * escape sequences through verbatim and counts only printable characters, so a
 * coloured cell that overflows degrades to an ellipsis instead of tearing the box.
 */
export function clip(s: string, n: number): string {
  if (vlen(s) <= n) return s;
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < n - 1) {
    if (s[i] === ESC) {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += s[i];
    seen++;
    i++;
  }
  // Only re-arm the reset if we actually carried a colour code through; adding it
  // unconditionally prints a literal escape when colour is off (piped output).
  return out + "…" + (out.includes(ESC) ? ESC + "[0m" : "");
}

function pad(s: string, n: number): string {
  const t = clip(s, n);
  return t + " ".repeat(Math.max(0, n - vlen(t)));
}
function padLeft(s: string, n: number): string {
  const t = clip(s, n);
  return " ".repeat(Math.max(0, n - vlen(t))) + t;
}

export const ICON = {
  ok: c.green("✓"),
  warn: c.yellow("!"),
  err: c.red("✗"),
  arrow: c.cyan("→"),
  down: c.gray("↓"),
};

export function line(s = ""): void {
  console.log(s);
}
export function blank(): void {
  console.log();
}
export function note(s: string): void {
  console.log(c.gray("  " + s));
}

// ---------- boxes ----------

export function hero(title: string, right: string, subtitle: string, tagline: string): void {
  const row = (s: string) => c.cyan("│") + s + c.cyan("│");
  const gap = Math.max(1, W - 4 - vlen(title) - vlen(right));
  blank();
  line(c.cyan("╭" + "─".repeat(W) + "╮"));
  line(row("  " + pad(c.whiteBold(title) + " ".repeat(gap) + c.gray(right), W - 4) + "  "));
  line(row("  " + pad(c.gray(subtitle), W - 4) + "  "));
  line(row(" ".repeat(W)));
  line(row("  " + pad(c.cyan(tagline), W - 4) + "  "));
  line(c.cyan("╰" + "─".repeat(W) + "╯"));
}

export function section(title: string): void {
  blank();
  line(c.cyan("╭" + "─".repeat(W) + "╮"));
  line(c.cyan("│") + " " + pad(c.whiteBold(title), W - 2) + " " + c.cyan("│"));
  line(c.cyan("╰" + "─".repeat(W) + "╯"));
}

export function panel(title: string, body: string[]): void {
  blank();
  line(c.gray("┌" + "─".repeat(W) + "┐"));
  line(c.gray("│") + " " + pad(c.whiteBold(title), W - 2) + " " + c.gray("│"));
  line(c.gray("├" + "─".repeat(W) + "┤"));
  for (const b of body) line(c.gray("│") + " " + pad(b, W - 2) + " " + c.gray("│"));
  line(c.gray("└" + "─".repeat(W) + "┘"));
}

export function kvPanel(title: string, pairs: [string, string][], labelW = 22): void {
  const valW = W - labelW - 3;
  blank();
  line(c.gray("┌" + "─".repeat(W) + "┐"));
  line(c.gray("│") + " " + pad(c.whiteBold(title), W - 2) + " " + c.gray("│"));
  line(c.gray("├" + "─".repeat(labelW + 2) + "┬" + "─".repeat(valW) + "┤"));
  for (const [k, v] of pairs) {
    line(
      c.gray("│") + " " + pad(c.gray(k), labelW) + " " +
      c.gray("│") + " " + pad(v, valW - 2) + " " + c.gray("│"),
    );
  }
  line(c.gray("└" + "─".repeat(labelW + 2) + "┴" + "─".repeat(valW) + "┘"));
}

export type Align = "l" | "r";

export function table(
  title: string | null,
  headers: string[],
  rows: string[][],
  requested: number[],
  aligns: Align[],
): void {
  // Columns must total exactly W or the frame tears. Rather than trust every call
  // site to do the arithmetic, absorb any difference into the last column.
  const widths = [...requested];
  const target = W - 3 * widths.length + 1;
  const drift = target - widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] = Math.max(1, widths[widths.length - 1]! + drift);

  const segT = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const cell = (s: string, i: number) => (aligns[i] === "r" ? padLeft(s, widths[i]!) : pad(s, widths[i]!));
  const rowOf = (cells: string[]) =>
    c.gray("│") + cells.map((s, i) => " " + cell(s, i) + " ").join(c.gray("│")) + c.gray("│");

  blank();
  if (title !== null) {
    line(c.gray("┌" + "─".repeat(W) + "┐"));
    line(c.gray("│") + " " + pad(c.whiteBold(title), W - 2) + " " + c.gray("│"));
    line(c.gray(segT("├", "┬", "┤")));
  } else {
    line(c.gray(segT("┌", "┬", "┐")));
  }
  line(rowOf(headers.map((h) => c.gray(h))));
  line(c.gray(segT("├", "┼", "┤")));
  for (const r of rows) line(rowOf(r));
  line(c.gray(segT("└", "┴", "┘")));
}

// ---------- elements ----------

/** Draws an already-computed fraction. Does not calculate one. */
export function bar(frac: number, width = 10, colour: (s: string) => string = c.cyan): string {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return colour("█".repeat(filled)) + c.gray("░".repeat(width - filled));
}

export function step(status: "ok" | "warn" | "err" | "run", text: string): void {
  const icon =
    status === "ok" ? ICON.ok : status === "warn" ? ICON.warn : status === "err" ? ICON.err : c.cyan("•");
  line(`  ${icon} ${status === "run" ? c.white(text) : c.gray(text)}`);
}

export function flowArrow(): void {
  line(`  ${ICON.down}`);
}

/** Centre within W and pad out to exactly W, so it can sit inside a box row. */
export function centred(s: string): string {
  const t = clip(s, W);
  const left = Math.max(0, Math.floor((W - vlen(t)) / 2));
  return " ".repeat(left) + t + " ".repeat(Math.max(0, W - left - vlen(t)));
}

// ---------- number formatting (display only) ----------

export function inr(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

/** Lakh/crore short form for headline figures. Same number, shorter glyph. */
export function inrShort(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return "₹" + Math.round(n).toString();
}

export function pct1(frac: number): string {
  return `${(100 * frac).toFixed(1)}%`;
}

/** Pad to a visible width, ignoring ANSI. Exported for multi-column hero rows. */
export function pad2(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - vlen(s)));
}
