import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

if (process.argv.includes('--test') || process.env.NODE_TEST_CONTEXT) {
  const helper = new URL('./early-failure.ts', import.meta.url).href;
  const measure = fs.readFileSync(new URL('../fee-revenue-demand.measure.ts', import.meta.url), 'utf8');
  const MAX = 2048;
  const failed = (extra = {}) => ({ title: 'desktop valid', status: 'failed', expectedStatus: 'passed', errors: [{ message: 'expect(received).toBe(expected)' }], ...extra });

  // Runs the helper in a child with a cleanup that blocks (hang) or throws after the diagnostic.
  function child(infos, cleanup) {
    const code = `const { reportFirstFailure } = await import(${JSON.stringify(helper)});
const hook = async info => { reportFirstFailure(info); ${cleanup} };
const { readFileSync } = await import('node:fs');
for (const info of JSON.parse(readFileSync(0, 'utf8'))) await hook(info).catch(() => {});`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: JSON.stringify(infos), timeout: 3000, killSignal: 'SIGKILL' });
  }

  test('measure.ts afterEach reports before its first await', () => {
    const body = measure.slice(measure.indexOf('test.afterEach('), measure.indexOf('test.afterAll('));
    const report = body.indexOf('reportFirstFailure(info)');
    assert.ok(report > 0, 'afterEach must call reportFirstFailure(info)');
    assert.ok(report < body.indexOf('await '), 'report must precede the first await');
  });

  test('failure bytes reach stderr before a blocked cleanup is killed', () => {
    const run = child([failed()], 'await new Promise(() => setInterval(() => {}, 1000));');
    assert.equal(run.error?.code, 'ETIMEDOUT');
    const line = run.stderr.toString('utf8');
    assert.match(line, /^FEE_DEMAND_FIRST_FAILURE /);
    assert.equal(JSON.parse(line.slice(line.indexOf('{'))).message, 'expect(received).toBe(expected)');
  });

  test('failure bytes reach stderr before a throwing cleanup; failed status is kept', () => {
    const run = child([failed()], "throw new Error('cleanup boom');");
    const parsed = JSON.parse(run.stderr.toString('utf8').replace('FEE_DEMAND_FIRST_FAILURE ', ''));
    assert.equal(parsed.status, 'failed');
  });

  test('passing, skipped-as-expected and expected failures emit nothing', () => {
    const run = child([failed({ status: 'passed' }), failed({ status: 'failed', expectedStatus: 'failed' })], '');
    assert.equal(run.stderr.length, 0);
    assert.equal(run.status, 0);
  });

  test('missing or malformed error data still yields one parseable line', () => {
    const infos = [failed({ errors: [] }), failed({ errors: undefined }), failed({ errors: [{}] }), failed({ errors: [null] }), failed({ title: undefined })];
    const run = child(infos, '');
    const lines = run.stderr.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, infos.length);
    for (const line of lines) assert.equal(JSON.parse(line.slice(line.indexOf('{'))).status, 'failed');
  });

  test('oversize, unicode and escape-heavy errors stay within the byte bound', () => {
    const messages = ['x'.repeat(1e6), '\u{1F600}'.repeat(5000), '\u0001'.repeat(5000), '"\\'.repeat(5000), '\ud800'.repeat(3000), 'é'.repeat(5000)];
    const run = child(messages.map(message => failed({ errors: [{ message }, { message: 'second' }], title: message })), '');
    const lines = run.stderr.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, messages.length);
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line + '\n') <= MAX, 'line bytes ' + Buffer.byteLength(line));
      const parsed = JSON.parse(line.slice(line.indexOf('{')));
      assert.ok(!parsed.message.includes('second'));
    }
  });

  test('at most 20 cases emit, so the aggregate is bounded', () => {
    const run = child(Array.from({ length: 30 }, () => failed({ errors: [{ message: 'y'.repeat(9999) }] })), '');
    assert.ok(run.stderr.length <= 20 * MAX);
    const lines = run.stderr.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, 20);
    for (const line of lines) assert.match(line, /^FEE_DEMAND_FIRST_FAILURE \{/);
  });

  test('clipping iterates only a bounded prefix of a huge message', () => {
    // Counts code points the String iterator yields; unbounded input would reach millions.
    const code = `const n = { v: 0 }; const it = String.prototype[Symbol.iterator];
String.prototype[Symbol.iterator] = function* () { for (const c of it.call(this)) { n.v++; yield c; } };
const { reportFirstFailure } = await import(${JSON.stringify(helper)});
reportFirstFailure({ title: 't', status: 'failed', expectedStatus: 'passed', errors: [{ message: '\\u{1F600}'.repeat(1e6) }] });
process.stdout.write(String(n.v));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 3000, killSignal: 'SIGKILL' });
    assert.ok(Number(run.stdout.toString()) < 10000, 'iterated ' + run.stdout);
  });
}
