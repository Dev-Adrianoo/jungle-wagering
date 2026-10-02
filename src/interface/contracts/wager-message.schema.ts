// The SQS envelope. `data` is validated with the same schema as the HTTP body, so both
// entry points accept and reject exactly the same payloads.
import { z } from 'zod';
import {
  canonicalJson,
  canonicalWagerPayload,
  sha256Hex,
  type WagerPayload,
} from '../../application/idempotency/payload-hash';
import { parseWith, RequestValidationError } from './parse';
import { idempotencyKeySchema, wagerPayloadSchema } from './wager-payload.schema';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().min(1).max(64),
  correlationId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
  data: z.record(z.string(), z.unknown()),
});

const keySchema = z.object({ idempotencyKey: idempotencyKeySchema });

export interface ParsedWagerMessage {
  messageId: string;
  correlationId: string;
  idempotencyKey: string;
  payload: WagerPayload;
  payloadHash: string;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestValidationError([{ path: '', message: 'body is not valid JSON' }]);
  }
}

export function parseWagerMessage(body: string): ParsedWagerMessage {
  const envelope = parseWith(envelopeSchema, parseJson(body));
  const { idempotencyKey } = parseWith(keySchema, envelope.data);
  const payload = parseWith(wagerPayloadSchema, envelope.data);
  return {
    messageId: envelope.messageId,
    correlationId: envelope.correlationId ?? envelope.messageId,
    idempotencyKey,
    payload,
    payloadHash: sha256Hex(
      canonicalJson({ idempotencyKey, payload: canonicalWagerPayload(payload) }),
    ),
  };
}
