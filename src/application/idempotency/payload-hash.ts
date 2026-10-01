import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money';

export type SubmittableKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** JSON with keys sorted at every level, no whitespace, undefined properties dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Picks the business fields explicitly and normalizes the amount to two decimals. */
export function canonicalWagerPayload(payload: WagerPayload): string {
  return canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

export function hashWagerPayload(payload: WagerPayload): string {
  return sha256Hex(canonicalWagerPayload(payload));
}
