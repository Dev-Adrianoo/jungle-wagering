import { InvalidCursorError } from '../errors';

const SEQUENCE_PATTERN = /^\d{1,19}$/;
const MAX_BIGINT = 9223372036854775807n;

export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function decodeLedgerCursor(cursor: string): string {
  const parsed = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'));
  const seq = (parsed as { s?: unknown } | null | undefined)?.s;
  if (typeof seq !== 'string' || !SEQUENCE_PATTERN.test(seq) || BigInt(seq) > MAX_BIGINT) {
    throw new InvalidCursorError();
  }
  return seq;
}
