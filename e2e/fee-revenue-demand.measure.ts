import { expect, test, type Page } from './fixtures';
import { readFileSync, writeFileSync } from 'node:fs';
import { FEE_ADDRESS_A, FEE_ADDRESS_B, FEE_ADDRESS_INVALID, FEE_EARNINGS_PROXY_PATH, type FeeFixtureMode, type FeeFixtureSnapshot } from './helpers/fee-revenue-fixture';

const FIXTURE = process.env.FEE_DEMAND_FIXTURE_ORIGIN ?? '';
type Surface = Pick<Page, 'getByRole' | 'getByText' | 'locator' | 'evaluate'>;
const observations: Array<Record<string, unknown>> = [];
let passed = true;
let browserRequests: Record<string, number>;
let browserBytes: Record<string, number>;
let sizes: Promise<void>[];
let clocks: { fixture: number; browser: number; server: number };
async function control(path: string, body?: unknown) {
  const response = await fetch(FIXTURE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('fixture control failed: ' + path + ' ' + response.status);
  return response.json();
}
const snapshot = (): Promise<FeeFixtureSnapshot> => control('/-/snapshot');
const mode = (value: FeeFixtureMode) => control('/-/mode', { mode: value });
const disclosure = (page: Surface) => page.getByRole('button', { name: 'Fee Revenue', exact: true });
const feeKey = 'primary:' + FEE_EARNINGS_PROXY_PATH;
const independentKey = 'independent:' + FEE_EARNINGS_PROXY_PATH;
async function counts() {
  await Promise.all(sizes);
  const state = await snapshot();
  return { browserRequests: { ...browserRequests }, browserBytes: { ...browserBytes },
    attempts: state.attempts, bytesByKey: state.bytesByKey, total: state.total,
    upstreamBytes: state.upstreamBytes, pending: state.pending, unhandled: state.unhandled };
}
async function outcome(page: Surface) {
  return page.evaluate(() => {
    const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    return {
      route: location.pathname + location.search,
      summary: text(document.querySelector('[aria-label="Total Bonded summary"]')),
      health: text(document.querySelector('[aria-label="Portfolio source health"]')),
      checks: text(document.querySelector('[aria-label="Portfolio data checks"]')),
      diagnosis: text(document.querySelector('[aria-label="Address required diagnosis"]')),
      fees: [...document.querySelectorAll('p')].filter(node => ['24H Revenue','7D Revenue','30D Revenue'].includes(node.textContent ?? '')).map(node => text(node.parentElement)),
      errors: [...document.querySelectorAll('section')].flatMap(node => [...node.querySelectorAll('div')].filter(child => child.childElementCount === 0 && child.textContent === 'Failed to load fee revenue').map(child => text(child))),
      loading: document.querySelectorAll('section .animate-pulse').length,
    };
  });
}
async function observe(page: Page, id: string, action: () => Promise<unknown>) {
  const before = await counts();
  const http = await action();
  const after = await counts();
  const frame = page.frame({ name: 'independent' });
  observations.push({ id, population: /\/(stale|malformed|source-failure|rate-limit)-/.test(id) ? 'error' : 'happy',
    before, after, clocks, outcome: { ...await outcome(page), subscriber: frame ? await outcome(frame) : null, http: http ?? null } });
}
async function observeClocks(page: Page) {
  const fixture = Date.parse((await snapshot()).clock);
  let server = NaN;
  await expect.poll(async () => {
    const response = await fetch(new URL('/api/health', process.env.PLAYWRIGHT_BASE_URL));
    if (!response.ok) throw new Error('server clock observation failed: ' + response.status);
    server = Date.parse((await response.json()).timestamp);
    return server;
  }).toBe(fixture);
  const browser = await page.evaluate(() => Date.now());
  expect(browser).toBe(fixture);
  const subscriber = page.frame({ name: 'independent' });
  if (subscriber) expect(await subscriber.evaluate(() => Date.now())).toBe(fixture);
  clocks = { fixture, browser, server };
}
async function advance(page: Page, ms: number) {
  const next = await control('/-/advance', { ms });
  await page.clock.runFor(ms);
  expect(await page.evaluate(() => Date.now())).toBe(next.now);
  await observeClocks(page);
}
async function primary(page: Surface, address = FEE_ADDRESS_A) {
  const second = address === FEE_ADDRESS_B;
  const total = page.getByRole('group', { name: 'Total Bonded summary', exact: true });
  await expect(total).toContainText(second ? '\u16b17,500.00' : '\u16b112,500.00');
  await expect(total).toContainText(second ? '$11,250.00 USD' : '$18,750.00 USD');
  await expect(page.getByRole('group', { name: 'Portfolio source health' })).toContainText('Sources responding');
  const checks = page.getByRole('region', { name: 'Portfolio data checks', exact: true });
  await expect(checks).toContainText('Source-loaded');
  await expect(checks).toContainText('1 THORNode LP value row loaded for review');
  await expect(checks).not.toContainText('Source-backed');
}
async function required(page: Surface, invalid: boolean) {
  const diagnosis = page.getByRole('region', { name: 'Address required diagnosis', exact: true });
  await expect(diagnosis).toContainText(invalid ? 'Address rejected' : 'Address required');
  await expect(page.getByRole('heading', { name: invalid
    ? 'Malformed address ignored before loading dashboard data'
    : 'Choose a watched THORChain address to start triage', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Total Bonded summary', exact: true })).toHaveCount(0);
  await expect(disclosure(page)).toHaveCount(0);
}
async function revenue(page: Surface, zero = false) {
  for (const label of ['24H Revenue', '7D Revenue', '30D Revenue']) {
    const card = page.getByText(label, { exact: true }).locator('..');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(zero ? '\u16b10.00' : '\u16b11.00');
    await expect(card).toContainText(zero ? '$0' : '$2');
  }
}
async function hidden(page: Surface) {
  await expect(page.getByText('24H Revenue', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Protocol Fee Revenue', exact: true })).toHaveCount(0);
}
test.beforeEach(async ({ page }) => {
  await mode('ok'); await control('/-/release', {}); await control('/-/reset', {});
  browserRequests = {}; browserBytes = {}; sizes = [];
  const initial = await snapshot();
  await page.clock.install({ time: new Date(initial.clock) });
  await page.clock.pauseAt(new Date(Date.parse(initial.clock) + 1000));
  await control('/-/advance', { ms: 1000 });
  await observeClocks(page);
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? '').origin;
  await page.context().route(url => url.origin !== origin, route => route.abort('blockedbyclient'));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const label = request.frame().name() === 'independent' ? 'independent' : 'primary';
      const name = label + ':' + url.pathname;
      browserRequests[name] = (browserRequests[name] ?? 0) + 1;
    }
  });
  page.on('requestfinished', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const label = request.frame().name() === 'independent' ? 'independent' : 'primary';
      const name = label + ':' + url.pathname;
      sizes.push(request.sizes().then(size => { browserBytes[name] = (browserBytes[name] ?? 0) + size.responseBodySize + size.responseHeadersSize; }));
    }
  });
});
test.afterEach(async ({ page }, info) => {
  passed &&= info.status === info.expectedStatus;
  await control('/-/release', {});
  const state = await snapshot();
  expect(state.unhandled).toBe(0); expect(state.limitExceeded).toBe(false); expect(state.pending).toBe(0);
  if (!page.isClosed()) expect(await page.evaluate(() => Date.now())).toBe(Date.parse(state.clock));
});
test.afterAll(async () => {
  writeFileSync(process.env.FEE_DEMAND_RESULT_PATH ?? '', JSON.stringify({
    status: passed ? 'PASS' : 'FAIL',
    runtime: JSON.parse(readFileSync(process.env.FEE_RUNTIME_IDENTITY ?? '', 'utf8')), observations,
  }));
});
for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const [name, address] of [['valid', FEE_ADDRESS_A], ['absent', null], ['invalid', FEE_ADDRESS_INVALID]] as const) {
      test('closed/open/close/reopen ' + name, async ({ page }) => {
        const record = (action: string, run: () => Promise<unknown>) => observe(page, viewport.name + '/' + action, run);
        await record('closed-' + name, async () => {
          await page.goto('/dashboard/portfolio' + (address ? '?address=' + address : ''));
          if (name === 'valid') { await primary(page); await hidden(page); }
          else await required(page, name === 'invalid');
          await page.waitForLoadState('networkidle');
          if (name !== 'valid') {
            expect(browserRequests[feeKey] ?? 0).toBe(0);
            expect((await snapshot()).attempts['midgard:v2/history/earnings'] ?? 0).toBe(0);
          }
        });
        if (name !== 'valid') return;
        await record('open', async () => { await disclosure(page).click(); await revenue(page); await primary(page); });
        await record('close', async () => { await disclosure(page).click(); await hidden(page); await primary(page); });
        const before = await counts();
        await record('reopen', async () => { await disclosure(page).click(); await revenue(page); await primary(page); });
        expect((await counts()).attempts).toEqual(before.attempts);
      });
    }
    test('pending close, unmount, rapid toggles and opened recovery', async ({ page }) => {
      const record = (action: string, run: () => Promise<unknown>) => observe(page, viewport.name + '/' + action, run);
      await mode('pending');
      await record('pending-open', async () => {
        await page.goto('/dashboard/portfolio?address=' + FEE_ADDRESS_A); await primary(page);
        await disclosure(page).click();
        await expect.poll(async () => (await snapshot()).pending).toBeGreaterThan(0);
        await expect(page.locator('section .animate-pulse')).not.toHaveCount(0);
        await expect(page.getByText('24H Revenue', { exact: true })).toHaveCount(0);
      });
      await record('pending-close', async () => { await disclosure(page).click(); await hidden(page); await primary(page); });
      await record('pending-reopen', async () => { await disclosure(page).click(); await expect(page.locator('section .animate-pulse')).not.toHaveCount(0); });
      for (let i = 0; i < 6; i++) await record('toggle-' + i, async () => {
        await disclosure(page).click();
        if (i % 2 === 0) await hidden(page);
        else await expect(page.locator('section .animate-pulse')).not.toHaveCount(0);
        await primary(page);
      });
      await record('unmounted', async () => {
        await page.getByRole('link', { name: 'View Risk', exact: true }).click();
        await expect(page).toHaveURL(/\/dashboard\/risk\?/); await hidden(page);
      });
      await record('late-release', async () => { await control('/-/release', {}); await expect.poll(async () => (await snapshot()).pending).toBe(0); await hidden(page); });
      await record('pending-recovery', async () => {
        await page.goto('/dashboard/portfolio?address=' + FEE_ADDRESS_A);
        await disclosure(page).click(); await revenue(page); await primary(page);
      });
    });
    test('in-context A to B isolation and A recovery', async ({ page }) => {
      const record = (action: string, run: () => Promise<unknown>) => observe(page, viewport.name + '/' + action, run);
      await record('address-A', async () => { await page.goto('/dashboard/portfolio?address=' + FEE_ADDRESS_A); await primary(page); await disclosure(page).click(); await revenue(page); });
      const documentId = await page.evaluate(() => performance.timeOrigin);
      await record('address-B', async () => {
        await page.evaluate(address => window.history.pushState(null, '', '/dashboard/portfolio?address=' + address), FEE_ADDRESS_B);
        await primary(page, FEE_ADDRESS_B); await revenue(page);
        await expect(page.getByRole('group', { name: 'Total Bonded summary', exact: true })).not.toContainText('\u16b112,500.00');
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentId);
      });
      await record('address-invalid', async () => {
        await page.evaluate(address => window.history.pushState(null, '', '/dashboard/portfolio?address=' + address), FEE_ADDRESS_INVALID);
        await required(page, true);
      });
      await record('address-recovery', async () => {
        await page.getByRole('textbox', { name: 'THORChain address or THORName', exact: true }).fill(FEE_ADDRESS_A);
        await page.getByRole('button', { name: 'Lookup', exact: true }).click();
        await primary(page); await disclosure(page).click(); await revenue(page);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentId);
      });
    });
    test('attributed 300s focus reconnect manual/global refresh and independent Portfolio consumer', async ({ page, context }) => {
      const record = (action: string, run: () => Promise<unknown>) => observe(page, viewport.name + '/' + action, run);
      await page.goto('/dashboard/portfolio?address=' + FEE_ADDRESS_A); await primary(page); await disclosure(page).click(); await revenue(page);
      for (const action of ['refresh-300s', 'focus', 'reconnect', 'manual-global']) await record(action, async () => {
        const before = browserRequests[feeKey] ?? 0;
        await advance(page, action === 'refresh-300s' ? 300000 : 6000);
        if (action === 'focus') await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
        if (action === 'reconnect') { await context.setOffline(true); await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
        if (action === 'manual-global') await page.getByRole('button', { name: 'Refresh dashboard data', exact: true }).click();
        await expect.poll(() => browserRequests[feeKey] ?? 0).toBeGreaterThan(before);
        await revenue(page); await primary(page); await page.waitForLoadState('networkidle');
      });
      await record('subscriber-mount', async () => {
        await page.evaluate(address => { const frame = document.createElement('iframe'); frame.name = 'independent'; frame.title = 'Independent Portfolio fee consumer'; frame.src = '/dashboard/portfolio?address=' + address; document.body.append(frame); }, FEE_ADDRESS_B);
        const frame = page.frameLocator('iframe[title="Independent Portfolio fee consumer"]');
        await expect(frame.getByRole('group', { name: 'Total Bonded summary', exact: true })).toContainText('\u16b17,500.00');
        await frame.getByRole('button', { name: 'Fee Revenue', exact: true }).click();
        const subscriber = page.frame({ name: 'independent' }); if (!subscriber) throw new Error('independent consumer missing');
        await primary(subscriber, FEE_ADDRESS_B); await revenue(subscriber);
        expect(browserRequests[independentKey]).toBeGreaterThan(0);
      });
      await record('primary-close', async () => { await disclosure(page).click(); await hidden(page); await primary(page); });
      for (const action of ['subscriber-focus', 'subscriber-300s']) await record(action, async () => {
        const subscriber = page.frame({ name: 'independent' }); if (!subscriber) throw new Error('independent consumer missing');
        const before = browserRequests[independentKey] ?? 0;
        await advance(page, action === 'subscriber-300s' ? 300000 : 6000);
        if (action === 'subscriber-focus') await subscriber.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => browserRequests[independentKey] ?? 0).toBeGreaterThan(before);
        await revenue(subscriber); await primary(subscriber, FEE_ADDRESS_B); await hidden(page); await primary(page);
      });
      await record('subscriber-unmount', async () => { await page.locator('iframe[title="Independent Portfolio fee consumer"]').evaluate(frame => frame.remove()); expect(page.frame({ name: 'independent' })).toBeNull(); await hidden(page); await primary(page); });
      await record('primary-reopen', async () => { await disclosure(page).click(); await revenue(page); await primary(page); });
    });
    for (const failure of ['stale', 'malformed', 'source-failure', 'rate-limit'] as const) {
      test('owned stimulus ' + failure + ' and recovered values', async ({ page, allowApiErrors }) => {
        allowApiErrors([/^http:\/\/127\.0\.0\.1:\d+\/api\/(midgard|thorchain)\//]);
        const record = (action: string, run: () => Promise<unknown>) => observe(page, viewport.name + '/' + failure + '-' + action, run);
        await record('healthy', async () => { await page.goto('/dashboard/portfolio?address=' + FEE_ADDRESS_A); await primary(page); await disclosure(page).click(); await revenue(page); });
        await mode(failure);
        await record('direct', async () => {
          const direct = await fetch(FIXTURE + '/midgard-primary/v2/history/earnings'); const body = await direct.text();
          if (failure === 'rate-limit') { expect(direct.status).toBe(429); expect(direct.headers.get('retry-after')).toBe('2'); }
          return { status: direct.status, retryAfter: direct.headers.get('retry-after'), bytes: Buffer.byteLength(body) };
        });
        await record('failed', async () => {
          const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === FEE_EARNINGS_PROXY_PATH);
          await page.getByRole('button', { name: 'Refresh dashboard data', exact: true }).click();
          for (let i = 0; i < 12; i++) await advance(page, 1000);
          const response = await responsePromise;
          expect(response.status()).toBe(failure === 'stale' ? 200 : failure === 'rate-limit' ? 429 : 502);
          if (failure === 'stale') { await revenue(page, true); await expect(page.getByText('No revenue history available', { exact: true })).toBeVisible(); }
          else await expect(page.getByText('Failed to load fee revenue', { exact: true })).toHaveCount(2);
          return { status: response.status(), retryAfter: response.headers()['retry-after'] ?? null };
        });
        await record('recovered', async () => {
          await mode('ok'); await page.getByRole('button', { name: 'Refresh dashboard data', exact: true }).click();
          await advance(page, 60000); await revenue(page); await primary(page);
        });
      });
    }
  });
}
