import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Observation } from "./types.ts";
import { observationFromPayment } from "./razorpay.ts";
import type { RazorpayPayment } from "./razorpay.ts";

/**
 * HMAC-SHA256 over the RAW body, compared in constant time.
 * Razorpay is explicit that the body must not be parsed or re-serialised before
 * signing, so this takes a Buffer and never a parsed object.
 */
export function verifySignature(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookEvent = {
  event: string;
  observation: Observation | null;
  /** Lifecycle signal with no decline code behind it — see razorpay-codes UNMAPPED. */
  lifecycle: "mandate.revoked" | null;
};

/** Razorpay event -> our types. Events we do not consume are returned, not dropped. */
export function mapEvent(body: {
  event?: string;
  payload?: { payment?: { entity?: RazorpayPayment }; subscription?: { entity?: { id?: string } } };
}): WebhookEvent {
  const event = body.event ?? "unknown";
  const payment = body.payload?.payment?.entity;
  return {
    event,
    observation: payment === undefined ? null : observationFromPayment(payment, new Map()),
    lifecycle:
      event === "subscription.cancelled" || event === "subscription.halted" ? "mandate.revoked" : null,
  };
}

/** ~40 lines, no framework. Verifies, maps, hands off; never trusts an unverified body. */
export function createWebhookReceiver(
  secret: string,
  onEvent: (e: WebhookEvent) => void,
): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const signature = req.headers["x-razorpay-signature"];
      if (typeof signature !== "string" || !verifySignature(raw, signature, secret)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      try {
        onEvent(mapEvent(JSON.parse(raw.toString("utf8"))));
        res.writeHead(200).end("ok");
      } catch {
        // 400, not 500: a body we cannot parse is the sender's problem, and a 5xx
        // would make Razorpay retry a message that will never succeed.
        res.writeHead(400).end("unparseable body");
      }
    });
  });
}
