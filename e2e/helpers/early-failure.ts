import { writeSync } from 'node:fs';

const MAX_LINE_BYTES = 2048;
const MAX_CASES = 20;
const PREFIX = 'FEE_DEMAND_FIRST_FAILURE ';
let emitted = 0;

// A code point is at most 2 UTF-16 units, so slice a bounded prefix before iterating; a cut trailing pair is beyond the limit and dropped.
const clip = (value: unknown, limit: number) => Array.from(typeof value === 'string' ? value.slice(0, limit * 2) : '').slice(0, limit).join('');

// Synchronously writes the first authored error of a failed test to stderr. Only
// title, status and message are kept; headers, env, bodies and DOM never enter.
export function reportFirstFailure(info: { title?: string; status?: string; expectedStatus?: string; errors?: ReadonlyArray<{ message?: string } | null> }): void {
  if (info.status === info.expectedStatus || emitted >= MAX_CASES) return;
  emitted++;
  const message = info.errors?.[0]?.message;
  let limit = 1024;
  let line = '';
  do { // escaping can expand text, so halve until the encoded line fits
    line = PREFIX + JSON.stringify({ title: clip(info.title, 128), status: clip(info.status, 32), message: clip(message, limit) }) + '\n';
    limit = Math.floor(limit / 2);
  } while (Buffer.byteLength(line) > MAX_LINE_BYTES && limit > 0);
  try { writeSync(2, line); } catch { /* diagnostic only: never mask the original failure */ }
}
