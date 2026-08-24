import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Observation } from './types.ts';
import { observationFromPayment } from './razorpay.ts';
import type { RazorpayPayment } from './razorpay.ts';

export function verifySignature(
  raw: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookEvent = {
  event: string;
  observation: Observation | null;

  lifecycle: 'mandate.revoked' | null;
};

export function mapEvent(body: {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPayment };
    subscription?: { entity?: { id?: string } };
  };
}): WebhookEvent {
  const event = body.event ?? 'unknown';
  const payment = body.payload?.payment?.entity;
  return {
    event,
    observation:
      payment === undefined ? null : observationFromPayment(payment, new Map()),
    lifecycle:
      event === 'subscription.cancelled' || event === 'subscription.halted'
        ? 'mandate.revoked'
        : null,
  };
}

export function createWebhookReceiver(
  secret: string,
  onEvent: (e: WebhookEvent) => void,
): Server {
  return createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const signature = req.headers['x-razorpay-signature'];
      if (
        typeof signature !== 'string' ||
        !verifySignature(raw, signature, secret)
      ) {
        res.writeHead(401).end('bad signature');
        return;
      }
      try {
        onEvent(mapEvent(JSON.parse(raw.toString('utf8'))));
        res.writeHead(200).end('ok');
      } catch {
        res.writeHead(400).end('unparseable body');
      }
    });
  });
}
