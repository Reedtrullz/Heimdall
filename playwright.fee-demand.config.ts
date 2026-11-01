import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const fixturePort = process.env.FEE_FIXTURE_PORT ?? '4321';
const appPort = process.env.FEE_DEMAND_APP_PORT ?? '3101';
const fixtureOrigin = 'http://127.0.0.1:' + fixturePort;
const appOrigin = 'http://127.0.0.1:' + appPort;
const scratch = process.env.FEE_DEMAND_SCRATCH ?? 'test-results/fee-demand/unadmitted';
const inputFile = process.env.FEE_SERVER_INPUT;
const input: { artifact: string } | null = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : null;
const guard = path.resolve('e2e/helpers/fee-revenue-egress.cjs');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
process.env.PLAYWRIGHT_BASE_URL = appOrigin;
process.env.FEE_DEMAND_FIXTURE_ORIGIN = fixtureOrigin;

export default defineConfig({
  testDir: './e2e',
  testMatch: /fee-revenue-demand\.measure\.ts$/,
  outputDir: path.join(scratch, 'artifacts'),
  fullyParallel: false, forbidOnly: true, retries: 0, workers: 1, timeout: 30000,
  globalTimeout: 120000,
  reporter: [['list']],
  use: { baseURL: appOrigin, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'fee-demand', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: quote(process.execPath) + ' e2e/helpers/fee-revenue-fixture.ts',
      url: fixtureOrigin + '/-/ready', timeout: 10000, reuseExistingServer: false,
      env: { FEE_FIXTURE_AUTOSTART: '1', FEE_FIXTURE_PORT: fixturePort },
    },
    {
      command: input
        ? [process.execPath, '--require', guard, path.join(input.artifact, 'server.js')].map(quote).join(' ')
        : quote(process.execPath) + ' e2e/helpers/fee-revenue-egress.cjs --missing-frozen-input',
      url: appOrigin + '/api/health', timeout: 20000, reuseExistingServer: false,
      env: {
        PORT: appPort, HOSTNAME: '127.0.0.1',
        FEE_EGRESS_ALLOW: '127.0.0.1:' + fixturePort,
        THORNODE_API_URL: fixtureOrigin + '/thornode/thorchain',
        MIDGARD_API_URL: fixtureOrigin + '/midgard-primary',
        MIDGARD_FALLBACK_URL: fixtureOrigin + '/midgard-fallback',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
});
