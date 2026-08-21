import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExceptionRecord } from "./exceptions.ts";
import type { Report } from "./report.ts";

const MODEL = "claude-opus-5";
const CACHE_PATH = "data/explanations-cache.json";

/**
 * The natural-language layer, and NOTHING ELSE.
 *
 * Attribution, routing and every number in the report are decided before this
 * file runs, by deterministic code. What keeps the model out of the scoring path
 * is not the prompt below — it is that the only thing this module returns is a
 * string, it is written to its own file, and no other module reads that file
 * back. An adversarial model that insisted on a different cause could not change
 * a single attribution, action or figure.
 *
 * `tests/explain.test.ts` enforces exactly that.
 */

const SYSTEM = `You write short plain-language notes for a payments operations team about failed UPI AutoPay debits.

The cause attribution you are given has ALREADY been decided by a deterministic classifier and a rules engine. It is not yours to revise. Do not second-guess it, do not propose a different cause, do not hedge about whether it is right, and do not invent facts that are not in the evidence you are given.

Write 2-3 sentences. State what happened, why that cause follows from the listed evidence, and what was done about it. Use plain English, no jargon, no bullet points, no preamble.`;

const DIGEST_SYSTEM = `You write a short weekly digest for a merchant about failed UPI AutoPay debit recovery.

Every figure you are given is final and was computed deterministically. Reproduce figures exactly as given; never recompute, round differently, or estimate. Do not invent numbers that are not present.

Write 4-6 short paragraphs covering: what happened this cycle, where the money went, what needed a human, and what to watch. Address the merchant directly. No bullet points, no headings.`;

export type Explainer = (system: string, prompt: string) => Promise<string>;

type Cache = Record<string, string>;

function loadCache(): Cache {
  return existsSync(CACHE_PATH) ? (JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache) : {};
}

function keyOf(system: string, prompt: string): string {
  return createHash("sha256").update(`${MODEL}\n${system}\n${prompt}`).digest("hex").slice(0, 32);
}

export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Live Claude explainer. Cached on disk so a rerun costs nothing and repeats. */
export function claudeExplainer(): Explainer {
  const client = new Anthropic();
  const cache = loadCache();

  return async (system, prompt) => {
    const key = keyOf(system, prompt);
    const hit = cache[key];
    if (hit !== undefined) return hit;

    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        // Opt-in refusal fallback: a decline would otherwise just stop the turn.
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
        messages: [{ role: "user", content: prompt }],
      });

      if (response.stop_reason === "refusal") {
        return `[explanation unavailable: model declined (${response.stop_details?.category ?? "unspecified"})]`;
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      cache[key] = text;
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
      return text;
    } catch (error) {
      // Most specific first; an explanation failing must never fail the pipeline.
      if (error instanceof Anthropic.AuthenticationError) return "[explanation unavailable: authentication failed]";
      if (error instanceof Anthropic.RateLimitError) return "[explanation unavailable: rate limited]";
      if (error instanceof Anthropic.APIError) return `[explanation unavailable: API error ${error.status}]`;
      throw error;
    }
  };
}

export type Attribution = {
  attempt_id: string;
  mandate_id: string;
  bank: string;
  timestamp: string;
  amount: number;
  cause: string;
  confidence: number;
  evidence: string[];
  action_taken: string;
  outcome: string;
};

function attributionPrompt(a: Attribution): string {
  return [
    `Mandate: ${a.mandate_id} (bank ${a.bank})`,
    `Failed debit: ₹${a.amount} at ${a.timestamp}`,
    `Attributed cause: ${a.cause} (confidence ${a.confidence.toFixed(2)})`,
    `Evidence:`,
    ...a.evidence.map((e) => `  - ${e}`),
    `Action taken: ${a.action_taken}`,
    `Outcome: ${a.outcome}`,
  ].join("\n");
}

function exceptionPrompt(e: ExceptionRecord): string {
  return [
    `Mandate: ${e.mandate_id} (bank ${e.bank})`,
    `Failed debit: ₹${e.amount} at ${e.timestamp}`,
    `This was NOT auto-attributed. It was routed for human review because:`,
    ...e.detail.map((d) => `  - ${d}`),
    `Competing hypotheses:`,
    ...e.hypotheses.map((h) => `  - ${h.cause} (p=${h.probability}): ${h.evidence.join("; ") || "no direct evidence"}`),
    `Evidence that would resolve it:`,
    ...e.resolving_evidence.map((r) => `  - ${r}`),
    ``,
    `Explain to the operations team what is uncertain here and what to go and check. Do not pick a cause.`,
  ].join("\n");
}

export async function explainAttributions(
  items: Attribution[],
  explain: Explainer,
): Promise<{ attempt_id: string; explanation: string }[]> {
  const out: { attempt_id: string; explanation: string }[] = [];
  for (const a of items) {
    out.push({ attempt_id: a.attempt_id, explanation: await explain(SYSTEM, attributionPrompt(a)) });
  }
  return out;
}

export async function explainExceptions(
  items: ExceptionRecord[],
  explain: Explainer,
): Promise<{ attempt_id: string; explanation: string }[]> {
  const out: { attempt_id: string; explanation: string }[] = [];
  for (const e of items) {
    out.push({ attempt_id: e.attempt_id, explanation: await explain(SYSTEM, exceptionPrompt(e)) });
  }
  return out;
}

export async function explainDigest(
  report: Report,
  digestLines: string[],
  explain: Explainer,
): Promise<string> {
  void report;
  return explain(
    DIGEST_SYSTEM,
    `Here is this cycle's deterministic summary. Every figure is final.\n\n${digestLines.join("\n")}`,
  );
}
